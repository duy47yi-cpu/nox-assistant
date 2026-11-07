import argparse
import os
import sys
import zipfile

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def main():
    parser = Parser(description='Распаковывает .zip в папку рядом с архивом (имя папки совпадает с именем архива)')
    parser.add_argument('path', help='путь к .zip файлу')
    args = parser.parse_args()

    archive = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isfile(archive) or not archive.lower().endswith('.zip'):
        print(f'Ошибка: нужен существующий .zip файл: {archive}', file=sys.stderr)
        return 1
    if not zipfile.is_zipfile(archive):
        print(f'Ошибка: файл повреждён или не является zip-архивом: {archive}', file=sys.stderr)
        return 1

    parent = os.path.dirname(archive)
    stem = os.path.splitext(os.path.basename(archive))[0]
    target = os.path.join(parent, stem)
    if os.path.exists(target):
        print(f'Ошибка: папка уже существует, распаковка отменена: {target}', file=sys.stderr)
        return 1

    real_target = os.path.realpath(target)
    with zipfile.ZipFile(archive) as zf:
        infos = zf.infolist()
        # Защита от zip-slip: ни один файл не должен выйти за пределы целевой папки.
        for info in infos:
            dest = os.path.realpath(os.path.join(real_target, info.filename))
            if dest != real_target and not dest.startswith(real_target + os.sep):
                print(f'Ошибка: небезопасный путь в архиве: {info.filename}', file=sys.stderr)
                return 1
        try:
            os.makedirs(target)
            zf.extractall(target)
        except (OSError, RuntimeError, zipfile.BadZipFile) as exc:
            print(f'Ошибка распаковки: {exc}', file=sys.stderr)
            return 1

    files = sum(1 for info in infos if not info.is_dir())
    print(f'Распаковано в {target} (файлов: {files})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
