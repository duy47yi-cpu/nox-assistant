import argparse
import ctypes
import os
import stat
import sys
import tempfile
import time
from ctypes import wintypes

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

MB = 1024 * 1024
MAX_AGE_DAYS = 7
# Файлы крупнее этого порога не отправляем в корзину: при переполнении корзины Windows может удалить их без неё.
MAX_SIZE = 200 * MB
CHUNK = 100

FO_DELETE = 3
FOF_SILENT = 0x0004
FOF_NOCONFIRMATION = 0x0010
FOF_ALLOWUNDO = 0x0040
FOF_NOERRORUI = 0x0400


class SHFILEOPSTRUCTW(ctypes.Structure):
    _fields_ = [
        ('hwnd', wintypes.HWND),
        ('wFunc', wintypes.UINT),
        ('pFrom', wintypes.LPCWSTR),
        ('pTo', wintypes.LPCWSTR),
        ('fFlags', wintypes.WORD),
        ('fAnyOperationsAborted', wintypes.BOOL),
        ('hNameMappings', ctypes.c_void_p),
        ('lpszProgressTitle', wintypes.LPCWSTR),
    ]


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def recycle(paths):
    """Отправляет файлы в корзину через SHFileOperationW (FOF_ALLOWUNDO). Возвращает 0 при успехе."""
    source = ''.join(os.path.abspath(p) + '\0' for p in paths) + '\0'
    op = SHFILEOPSTRUCTW()
    op.hwnd = None
    op.wFunc = FO_DELETE
    op.pFrom = source
    op.pTo = None
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT
    op.fAnyOperationsAborted = False
    op.hNameMappings = None
    op.lpszProgressTitle = None
    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    return -1 if op.fAnyOperationsAborted else result


def recycle_many(paths):
    """Возвращает (сколько отправлено в корзину, список неудачных путей)."""
    done = 0
    failed = []
    for i in range(0, len(paths), CHUNK):
        chunk = paths[i:i + CHUNK]
        if recycle(chunk) == 0:
            done += len(chunk)
            continue
        # Пакет не прошёл: повторяем по одному только для файлов, которые ещё существуют.
        for path in chunk:
            if os.path.exists(path):
                recycle([path])
            if os.path.exists(path):
                failed.append(path)
            else:
                done += 1
    return done, failed


def main():
    parser = Parser(description='Отправляет в корзину файлы из TEMP старше 7 дней. Без --confirm только план')
    parser.add_argument('--confirm', action='store_true', help='выполнить очистку')
    args = parser.parse_args()

    temp = os.environ.get('TEMP') or os.environ.get('TMP') or tempfile.gettempdir()
    if not os.path.isdir(temp):
        print(f'Ошибка: папка TEMP не найдена: {temp}', file=sys.stderr)
        return 1

    cutoff = time.time() - MAX_AGE_DAYS * 86400
    candidates = []
    too_big = 0
    for dirpath, _dirnames, filenames in os.walk(temp):
        for name in filenames:
            full = os.path.join(dirpath, name)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode) or st.st_mtime >= cutoff:
                continue
            if st.st_size > MAX_SIZE:
                too_big += 1
                continue
            candidates.append((full, st.st_size))

    total_mb = sum(size for _path, size in candidates) / MB
    if not candidates:
        print(f'В {temp} нет файлов старше {MAX_AGE_DAYS} дней.')
        return 0

    if not args.confirm:
        print(f'План: отправить в корзину {len(candidates)} файлов старше {MAX_AGE_DAYS} дней из {temp} '
              f'(около {total_mb:.1f} МБ). Пропущено (больше 200 МБ): {too_big}. Для выполнения добавь --confirm.')
        return 2

    done, failed = recycle_many([path for path, _size in candidates])
    print(f'Отправлено в корзину: {done} файлов из {len(candidates)} (около {total_mb:.1f} МБ). '
          f'Пропущено (больше 200 МБ): {too_big}.')
    if failed:
        print(f'Не удалось: {len(failed)} файлов (возможно, заняты другими программами).', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
