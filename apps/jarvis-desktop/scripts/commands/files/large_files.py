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


def main():
    parser = Parser(description='Ищет файлы больше N мегабайт в папке и вложенных папках (по умолчанию 100 МБ)')
    parser.add_argument('path', nargs='?', default=os.path.expanduser('~'),
                        help='папка (по умолчанию домашняя)')
    parser.add_argument('min_mb', nargs='?', type=float, default=100.0,
                        help='минимальный размер в мегабайтах (по умолчанию 100)')
    args = parser.parse_args()

    if args.min_mb < 0:
        print('Ошибка: min_mb не может быть отрицательным.', file=sys.stderr)
        return 1
    root = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isdir(root):
        print(f'Ошибка: папка не найдена: {root}', file=sys.stderr)
        return 1

    limit = args.min_mb * MB
    found = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode) and st.st_size >= limit:
                found.append((st.st_size, full))

    if not found:
        print(f'Файлов больше {args.min_mb:g} МБ в {root} не найдено.')
        return 0
    found.sort(reverse=True)
    top = ', '.join(f'{os.path.relpath(path, root)} ({size / MB:.1f} МБ)' for size, path in found[:10])
    print(f'Файлов больше {args.min_mb:g} МБ: {len(found)}. Крупнейшие: {top}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
