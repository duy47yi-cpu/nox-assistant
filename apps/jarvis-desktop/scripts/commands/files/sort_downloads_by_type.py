import argparse
import os
import shutil
import sys
from collections import Counter

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

CATEGORIES = [
    ('Картинки', {'.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.heic', '.tif', '.tiff', '.ico'}),
    ('Документы', {'.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt', '.xls', '.xlsx', '.ods', '.csv',
                   '.ppt', '.pptx', '.odp', '.json', '.epub'}),
    ('Архивы', {'.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz'}),
    ('Видео', {'.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.flv', '.m4v'}),
]
OTHER = 'Прочее'
# Незавершённые загрузки и системные файлы не трогаем.
PARTIAL_EXTENSIONS = {'.crdownload', '.part', '.tmp', '.download'}
SYSTEM_NAMES = {'desktop.ini', 'thumbs.db'}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def category_for(ext):
    for category, extensions in CATEGORIES:
        if ext in extensions:
            return category
    return OTHER


def main():
    parser = Parser(description='Раскладывает файлы Загрузок по папкам: картинки, документы, архивы, видео, прочее. Без --confirm только план'
                                'Без --confirm только показывает план.')
    parser.add_argument('path', nargs='?', default=os.path.join(os.path.expanduser('~'), 'Downloads'),
                        help='папка (по умолчанию Загрузки)')
    parser.add_argument('--confirm', action='store_true', help='выполнить перемещение')
    args = parser.parse_args()

    root = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isdir(root):
        print(f'Ошибка: папка не найдена: {root}', file=sys.stderr)
        return 1

    with os.scandir(root) as it:
        entries = [e for e in it if _is_regular_file(e)]

    moves = []
    skipped = 0
    for entry in entries:
        name = entry.name
        ext = os.path.splitext(name)[1].lower()
        if name.startswith('.') or name.startswith('~$') or name.lower() in SYSTEM_NAMES \
                or ext in PARTIAL_EXTENSIONS:
            continue
        category = category_for(ext)
        dst_dir = os.path.join(root, category)
        dst = os.path.join(dst_dir, name)
        if os.path.exists(dst):
            skipped += 1
            continue
        moves.append((entry.path, dst_dir, dst, category))

    if not moves:
        print(f'В {root} нечего раскладывать (пропущено, т.к. уже есть такой файл: {skipped}).')
        return 0

    counts = Counter(category for _src, _dir, _dst, category in moves)
    order = [c for c, _ in CATEGORIES] + [OTHER]
    summary = ', '.join(f'{c}: {counts[c]}' for c in order if counts[c])

    if not args.confirm:
        print(f'План: переместить {len(moves)} файлов в {root} ({summary}). '
              f'Пропущено (уже есть): {skipped}. Для выполнения добавь --confirm.')
        return 2

    moved = 0
    failed = []
    for src, dst_dir, dst, _category in moves:
        try:
            os.makedirs(dst_dir, exist_ok=True)
            if os.path.exists(dst):
                skipped += 1
                continue
            shutil.move(src, dst)
            moved += 1
        except OSError as exc:
            failed.append(f'{os.path.basename(src)} ({exc.strerror})')

    print(f'Перемещено файлов: {moved} из {len(moves)} ({summary}). Пропущено: {skipped}.')
    if failed:
        print(f'Не удалось переместить {len(failed)}: ' + '; '.join(failed[:5]), file=sys.stderr)
        return 1
    return 0


def _is_regular_file(entry):
    try:
        return entry.is_file(follow_symlinks=False)
    except OSError:
        return False


if __name__ == '__main__':
    sys.exit(main())
