import argparse
import os
import stat
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def count_files(root, recursive):
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        if not recursive:
            dirnames[:] = []
        for name in filenames:
            try:
                if stat.S_ISREG(os.lstat(os.path.join(dirpath, name)).st_mode):
                    total += 1
            except OSError:
                continue
    return total


def main():
    parser = Parser(description='Считает файлы в папке; путь необязателен (по умолчанию домашняя папка), --recursive включает вложенные')
    parser.add_argument('path', nargs='?', default=os.path.expanduser('~'),
                        help='папка (по умолчанию домашняя)')
    parser.add_argument('--recursive', action='store_true',
                        help='считать и файлы во вложенных папках')
    args = parser.parse_args()

    root = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isdir(root):
        print(f'Ошибка: папка не найдена: {root}', file=sys.stderr)
        return 1
    total = count_files(root, args.recursive)
    scope = ' (включая вложенные папки)' if args.recursive else ''
    print(f'В папке {root} файлов: {total}{scope}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
