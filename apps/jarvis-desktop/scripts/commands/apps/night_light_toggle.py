import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import os


def main():
    parser = argparse.ArgumentParser(description='Открывает настройки ночного света Windows')
    parser.parse_args()
    try:
        os.startfile('ms-settings:nightlight')
    except OSError as exc:
        print(f'Не удалось открыть настройки ночного света: {exc}', file=sys.stderr)
        return 1
    print('Открываю настройки ночного света.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
