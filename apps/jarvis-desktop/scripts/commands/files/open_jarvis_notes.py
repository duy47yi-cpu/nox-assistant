import argparse
import os
import sys

# Рабочую папку задаёт приложение (переменная окружения JARVIS_SANDBOX).
# Путь на диске в скрипте не зашит: у покупателя он другой.
SANDBOX = os.environ.get('JARVIS_SANDBOX')
if not SANDBOX:
    print('Ошибка: рабочая папка не задана.', file=sys.stderr)
    sys.exit(1)

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def main():
    parser = Parser(description='Открывает песочница workspace/notes в проводнике, создаёт папку, если её нет')
    parser.parse_args()
    folder = os.path.join(SANDBOX, 'notes')
    created = not os.path.isdir(folder)
    os.makedirs(folder, exist_ok=True)
    os.startfile(folder)
    suffix = ' (создана сейчас)' if created else ''
    print(f'Открыла папку заметок: {folder}{suffix}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
