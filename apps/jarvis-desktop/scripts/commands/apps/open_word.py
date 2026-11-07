import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import os


def main():
    parser = argparse.ArgumentParser(description='Открывает Microsoft Word, если он установлен')
    parser.parse_args()
    try:
        os.startfile('winword.exe')
    except OSError as exc:
        print(f'Не удалось открыть Word, возможно он не установлен: {exc}', file=sys.stderr)
        return 1
    print('Открываю Word.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
