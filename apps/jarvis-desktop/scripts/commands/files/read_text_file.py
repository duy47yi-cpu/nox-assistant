import argparse
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

LIMIT = 2000
ALLOWED_EXTENSIONS = {'.txt', '.md', '.csv', '.json', '.log'}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def read_head(path):
    try:
        with open(path, encoding='utf-8-sig') as f:
            text = f.read(LIMIT + 1)
    except UnicodeDecodeError:
        with open(path, encoding='cp1251', errors='replace') as f:
            text = f.read(LIMIT + 1)
    return text[:LIMIT], len(text) > LIMIT


def main():
    parser = Parser(description='Выводит первые 2000 символов файла .txt, .md, .csv, .json или .log')
    parser.add_argument('path', help='путь к файлу')
    args = parser.parse_args()

    target = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isfile(target):
        print(f'Ошибка: файл не найден: {target}', file=sys.stderr)
        return 1
    ext = os.path.splitext(target)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        allowed = ', '.join(sorted(ALLOWED_EXTENSIONS))
        print(f'Ошибка: формат {ext or "без расширения"} не поддерживается. Разрешены: {allowed}.', file=sys.stderr)
        return 1

    try:
        text, truncated = read_head(target)
    except OSError as exc:
        print(f'Ошибка чтения файла: {exc.strerror}', file=sys.stderr)
        return 1

    print(f'Файл: {target}')
    print(text)
    if truncated:
        print(f'... (текст обрезан, показаны первые {LIMIT} символов)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
