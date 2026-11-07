import argparse
import os
import stat
import sys
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def main():
    parser = Parser(description='Показывает 10 последних файлов в Загрузках по дате изменения')
    parser.add_argument('path', nargs='?', default=os.path.join(os.path.expanduser('~'), 'Downloads'),
                        help='папка (по умолчанию Загрузки)')
    args = parser.parse_args()

    root = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isdir(root):
        print(f'Ошибка: папка не найдена: {root}', file=sys.stderr)
        return 1

    files = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                files.append((st.st_mtime, name))

    if not files:
        print(f'В папке {root} нет файлов.')
        return 0
    files.sort(reverse=True)
    items = [f'{name} ({datetime.fromtimestamp(mtime):%d.%m.%Y %H:%M})' for mtime, name in files[:10]]
    print('Последние файлы: ' + '; '.join(items))
    return 0


if __name__ == '__main__':
    sys.exit(main())
