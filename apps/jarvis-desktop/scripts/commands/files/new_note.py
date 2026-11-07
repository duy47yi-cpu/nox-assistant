import argparse
import os
import re
import sys
from datetime import datetime

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
    parser = Parser(description='Создаёт заметку .md в песочница workspace/notes с датой в имени файла')
    parser.add_argument('text', nargs='+', help='текст заметки')
    args = parser.parse_args()

    text = ' '.join(args.text).strip()
    if not text:
        print('Ошибка: текст заметки пустой.', file=sys.stderr)
        return 1

    notes_dir = os.path.join(SANDBOX, 'notes')
    os.makedirs(notes_dir, exist_ok=True)

    now = datetime.now()
    slug = re.sub(r'\W+', '_', text)[:30].strip('_')
    base = f'{now:%Y-%m-%d_%H-%M-%S}' + (f'_{slug}' if slug else '')
    path = os.path.join(notes_dir, base + '.md')
    counter = 2
    while os.path.exists(path):
        path = os.path.join(notes_dir, f'{base}_{counter}.md')
        counter += 1

    with open(path, 'w', encoding='utf-8') as f:
        f.write(f'# Заметка {now:%Y-%m-%d %H:%M}\n\n{text}\n')
    print(f'Заметка сохранена: {path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
