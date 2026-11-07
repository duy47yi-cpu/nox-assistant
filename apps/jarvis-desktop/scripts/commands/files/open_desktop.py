import argparse
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def main():
    parser = Parser(description='Открывает папку Рабочий стол в проводнике (также если он в OneDrive)')
    parser.parse_args()
    home = os.path.expanduser('~')
    # Если рабочий стол перенесён в OneDrive, используем его папку.
    candidates = [
        os.path.join(home, 'Desktop'),
        os.path.join(home, 'OneDrive', 'Desktop'),
    ]
    folder = next((path for path in candidates if os.path.isdir(path)), None)
    if folder is None:
        print('Ошибка: папка Рабочий стол не найдена.', file=sys.stderr)
        return 1
    os.startfile(folder)
    print(f'Открыла папку Рабочий стол: {folder}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
