import argparse
import hashlib
import os
import stat
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

MB = 1024 * 1024
SKIP_DIRS = {'AppData', 'node_modules', '$RECYCLE.BIN', 'System Volume Information'}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def keep_dir(name):
    return not name.startswith('.') and name not in SKIP_DIRS


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(MB), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = Parser(description='Находит одинаковые файлы в папке: сравнивает размер, затем sha256')
    parser.add_argument('path', nargs='?', default=os.path.expanduser('~'),
                        help='папка (по умолчанию домашняя; AppData и скрытые папки пропускаются)')
    args = parser.parse_args()

    root = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isdir(root):
        print(f'Ошибка: папка не найдена: {root}', file=sys.stderr)
        return 1

    # Шаг 1: группируем по размеру, чтобы не хешировать заведомо разные файлы.
    by_size = defaultdict(list)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if keep_dir(d)]
        for name in filenames:
            full = os.path.join(dirpath, name)
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode) and st.st_size > 0:
                by_size[st.st_size].append(full)

    # Шаг 2: внутри групп одинакового размера сравниваем sha256.
    groups = []
    for size, paths in by_size.items():
        if len(paths) < 2:
            continue
        by_hash = defaultdict(list)
        for path in paths:
            try:
                by_hash[file_sha256(path)].append(path)
            except OSError:
                continue
        for same in by_hash.values():
            if len(same) > 1:
                groups.append((size, same))

    if not groups:
        print(f'Одинаковых файлов не найдено в {root}.')
        return 0

    extra = sum(len(paths) - 1 for _size, paths in groups)
    freed = sum((len(paths) - 1) * size for size, paths in groups)
    examples = ' | '.join(' = '.join(os.path.relpath(p, root) for p in paths) for _size, paths in groups[:3])
    print(f'Групп дубликатов: {len(groups)}, лишних копий: {extra}, можно освободить: {freed / MB:.1f} МБ.')
    print(f'Примеры: {examples}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
