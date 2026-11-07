import argparse
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

INVALID_CHARS = '\\/:*?"<>|'


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def main():
    parser = Parser(description='Создаёт новую папку в указанной папке (по умолчанию домашней); существующую не трогает')
    parser.add_argument('name', help='имя новой папки (без слешей)')
    parser.add_argument('path', nargs='?', default=os.path.expanduser('~'),
                        help='родительская папка (по умолчанию домашняя)')
    args = parser.parse_args()

    name = args.name.strip()
    if not name or name in ('.', '..') or any(c in name for c in INVALID_CHARS):
        print(f'Ошибка: недопустимое имя папки «{args.name}».', file=sys.stderr)
        return 1
    parent = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isdir(parent):
        print(f'Ошибка: родительская папка не найдена: {parent}', file=sys.stderr)
        return 1
    target = os.path.join(parent, name)
    if os.path.exists(target):
        print(f'Ошибка: уже существует: {target}', file=sys.stderr)
        return 1

    os.mkdir(target)
    print(f'Папка создана: {target}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
