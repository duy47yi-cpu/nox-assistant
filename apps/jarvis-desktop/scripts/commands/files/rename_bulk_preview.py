import argparse
import os
import sys
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

INVALID_CHARS = '\\/:*?"<>|'


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def main():
    parser = Parser(description='Показывает, как переименовались бы файлы по шаблону ({name} {ext} {n} {date}); ничего не переименовывает')
    parser.add_argument('pattern', help='шаблон, например {date}_{n:03}{ext}; поля: {name} {ext} {n} {date}')
    parser.add_argument('path', nargs='?', default=os.path.expanduser('~'),
                        help='папка (по умолчанию домашняя, только файлы верхнего уровня)')
    args = parser.parse_args()

    root = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isdir(root):
        print(f'Ошибка: папка не найдена: {root}', file=sys.stderr)
        return 1

    with os.scandir(root) as it:
        files = []
        for entry in it:
            try:
                if entry.is_file(follow_symlinks=False):
                    files.append(entry)
            except OSError:
                continue
    files.sort(key=lambda e: e.name.lower())
    if not files:
        print(f'В папке {root} нет файлов.')
        return 0

    existing = {e.name for e in files}
    previews = []
    conflicts = 0
    seen = set()
    for number, entry in enumerate(files, start=1):
        stem, ext = os.path.splitext(entry.name)
        date = datetime.fromtimestamp(entry.stat().st_mtime).strftime('%Y-%m-%d')
        try:
            new_name = args.pattern.format(name=stem, ext=ext, n=number, date=date)
        except (KeyError, IndexError, ValueError) as exc:
            print(f'Ошибка: неверный шаблон ({exc}). Доступные поля: name, ext, n, date.', file=sys.stderr)
            return 1
        if not new_name.strip() or any(c in new_name for c in INVALID_CHARS):
            print(f'Ошибка: шаблон даёт недопустимое имя «{new_name}».', file=sys.stderr)
            return 1
        clash = new_name.lower() in seen or (new_name != entry.name and new_name in existing)
        conflicts += int(clash)
        seen.add(new_name.lower())
        mark = ' (конфликт)' if clash else ''
        previews.append(f'{entry.name} -> {new_name}{mark}')

    warning = '' if '{ext}' in args.pattern else ' Внимание: в шаблоне нет {ext}, расширения пропадут.'
    print(f'Предпросмотр, ничего не переименовано: файлов {len(files)}, конфликтов: {conflicts}.{warning}')
    print('Примеры: ' + '; '.join(previews[:10]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
