import argparse
import mimetypes
import os
import sys
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def human_size(n):
    value = float(n)
    for unit in ['Б', 'КБ', 'МБ', 'ГБ']:
        if value < 1024 or unit == 'ГБ':
            return f'{value:.0f} Б' if unit == 'Б' else f'{value:.1f} {unit}'
        value /= 1024


def main():
    parser = Parser(description='Показывает размер, дату изменения и тип файла или папки')
    parser.add_argument('path', help='путь к файлу или папке')
    args = parser.parse_args()

    target = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.exists(target):
        print(f'Ошибка: путь не найден: {target}', file=sys.stderr)
        return 1
    st = os.stat(target)
    modified = datetime.fromtimestamp(st.st_mtime).strftime('%d.%m.%Y %H:%M')
    if os.path.isdir(target):
        print(f'Папка: {target}; изменена: {modified}')
        return 0
    ext = os.path.splitext(target)[1].lower() or 'без расширения'
    mime = mimetypes.guess_type(target)[0] or 'тип неизвестен'
    print(f'Файл: {os.path.basename(target)}; тип: {ext} ({mime}); размер: {human_size(st.st_size)}; '
          f'изменён: {modified}; путь: {target}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
