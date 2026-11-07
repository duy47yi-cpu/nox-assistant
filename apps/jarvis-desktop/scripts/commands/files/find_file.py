import argparse
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

SKIP_DIRS = {'AppData', 'node_modules', '$RECYCLE.BIN', 'System Volume Information'}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def keep_dir(name):
    return not name.startswith('.') and name not in SKIP_DIRS


def main():
    parser = Parser(description='Ищет файлы по части имени в домашней папке или указанной папке, глубина и число результатов ограничены')
    parser.add_argument('name', help='часть имени файла')
    parser.add_argument('path', nargs='?', default=os.path.expanduser('~'),
                        help='где искать (по умолчанию домашняя папка)')
    parser.add_argument('--max-depth', type=int, default=4,
                        help='на сколько уровней вложенности заходить (по умолчанию 4)')
    parser.add_argument('--limit', type=int, default=20,
                        help='сколько путей показать (по умолчанию 20)')
    args = parser.parse_args()

    needle = args.name.strip().lower()
    if not needle:
        print('Ошибка: пустое имя для поиска.', file=sys.stderr)
        return 1
    if args.max_depth < 0 or args.limit < 1:
        print('Ошибка: max-depth должен быть >= 0, limit >= 1.', file=sys.stderr)
        return 1
    root = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isdir(root):
        print(f'Ошибка: папка не найдена: {root}', file=sys.stderr)
        return 1

    base_depth = root.rstrip(os.sep).count(os.sep)
    total = 0
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        depth = dirpath.rstrip(os.sep).count(os.sep) - base_depth
        if depth >= args.max_depth:
            dirnames[:] = []
        else:
            dirnames[:] = [d for d in dirnames if keep_dir(d)]
        for name in filenames:
            if needle in name.lower():
                total += 1
                if len(found) < args.limit:
                    found.append(os.path.join(dirpath, name))

    if total == 0:
        print(f'Файлы с «{args.name}» в {root} не найдены.')
        return 0
    shown = f' (показаны первые {args.limit})' if total > args.limit else ''
    print(f'Найдено файлов: {total}{shown}')
    print('; '.join(found))
    return 0


if __name__ == '__main__':
    sys.exit(main())
