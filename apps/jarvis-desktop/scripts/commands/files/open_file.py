import argparse
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# Исполняемые и скриптовые файлы не открываем: os.startfile может их запустить.
BLOCKED_EXTENSIONS = {
    '.exe', '.bat', '.cmd', '.com', '.msi', '.msp', '.ps1', '.vbs', '.vbe',
    '.js', '.jse', '.wsf', '.wsh', '.hta', '.scr', '.lnk', '.reg', '.cpl', '.url',
}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def main():
    parser = Parser(description='Открывает файл программой по умолчанию; исполняемые файлы (.exe, .bat, .ps1 и др.) не запускает')
    parser.add_argument('path', help='путь к файлу')
    args = parser.parse_args()

    target = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isfile(target):
        print(f'Ошибка: файл не найден: {target}', file=sys.stderr)
        return 1
    ext = os.path.splitext(target)[1].lower()
    if ext in BLOCKED_EXTENSIONS:
        print(f'Ошибка: файлы {ext} этой командой не открываются (это может быть программа).', file=sys.stderr)
        return 1
    os.startfile(target)
    print(f'Открываю файл: {target}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
