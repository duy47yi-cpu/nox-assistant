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
    parser = Parser(description='Открывает папку Документы в проводнике')
    parser.parse_args()
    folder = os.path.join(os.path.expanduser('~'), 'Documents')
    if not os.path.isdir(folder):
        print(f'Ошибка: папка не найдена: {folder}', file=sys.stderr)
        return 1
    os.startfile(folder)
    print(f'Открыла папку Документы: {folder}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
