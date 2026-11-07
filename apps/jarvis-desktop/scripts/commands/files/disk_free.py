import argparse
import os
import shutil
import sys

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

GB = 1024 ** 3


class Parser(argparse.ArgumentParser):
    def error(self, message):
        print(f'Ошибка аргументов: {message}', file=sys.stderr)
        sys.exit(1)


def main():
    parser = Parser(description='Показывает свободное и занятое место на диске')
    parser.add_argument('path', nargs='?', default=os.path.expanduser('~'),
                        help='любой путь на нужном диске (по умолчанию домашняя папка)')
    args = parser.parse_args()

    root = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.exists(root):
        print(f'Ошибка: путь не найден: {root}', file=sys.stderr)
        return 1
    usage = shutil.disk_usage(root)
    drive = os.path.splitdrive(root)[0] or root
    used_pct = (usage.total - usage.free) / usage.total * 100 if usage.total else 0
    print(f'Диск {drive}: свободно {usage.free / GB:.1f} ГБ из {usage.total / GB:.1f} ГБ, занято {used_pct:.0f}%')
    return 0


if __name__ == '__main__':
    sys.exit(main())
