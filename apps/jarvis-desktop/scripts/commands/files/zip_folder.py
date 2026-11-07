import argparse
import os
import stat
import sys
import zipfile

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

MB = 1024 * 1024


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def main():
    parser = Parser(description='Создаёт .zip рядом с папкой; существующий архив не перезаписывает')
    parser.add_argument('path', help='папка для архивации')
    args = parser.parse_args()

    root = os.path.abspath(os.path.expanduser(args.path)).rstrip(os.sep)
    if not os.path.isdir(root):
        print(f'Ошибка: папка не найдена: {root}', file=sys.stderr)
        return 1
    parent, base = os.path.split(root)
    if not base:
        print('Ошибка: укажите папку, а не корень диска.', file=sys.stderr)
        return 1
    zip_path = os.path.join(parent, base + '.zip')
    if os.path.exists(zip_path):
        print(f'Ошибка: архив уже существует: {zip_path}', file=sys.stderr)
        return 1

    # Пишем во временный файл, чтобы не оставить битый архив при сбое.
    tmp_path = zip_path + '.part'
    count = 0
    skipped = 0
    try:
        with zipfile.ZipFile(tmp_path, 'w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for dirpath, _dirnames, filenames in os.walk(root):
                for name in filenames:
                    full = os.path.join(dirpath, name)
                    try:
                        if not stat.S_ISREG(os.lstat(full).st_mode):
                            skipped += 1
                            continue
                        zf.write(full, arcname=os.path.relpath(full, parent))
                        count += 1
                    except OSError:
                        skipped += 1
        os.replace(tmp_path, zip_path)
    except Exception as exc:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        print(f'Ошибка архивации: {exc}', file=sys.stderr)
        return 1

    size_mb = os.path.getsize(zip_path) / MB
    print(f'Архив создан: {zip_path} (файлов: {count}, пропущено: {skipped}, размер: {size_mb:.1f} МБ)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
