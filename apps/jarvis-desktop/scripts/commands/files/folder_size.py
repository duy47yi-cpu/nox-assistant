import argparse
import os
import stat
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

MB = 1024 * 1024


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def folder_size(root):
    total = 0
    count = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            try:
                st = os.lstat(os.path.join(dirpath, name))
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                total += st.st_size
                count += 1
    return total, count


def main():
    parser = Parser(description='Показывает размер папки в мегабайтах и число файлов в ней')
    parser.add_argument('path', nargs='?', default=os.path.expanduser('~'),
                        help='папка (по умолчанию домашняя)')
    args = parser.parse_args()

    root = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isdir(root):
        print(f'Ошибка: папка не найдена: {root}', file=sys.stderr)
        return 1
    total, count = folder_size(root)
    print(f'Размер папки {root}: {total / MB:.1f} МБ, файлов: {count}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
