import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import os

URL = 'https://www.google.com/maps'


def main():
    parser = argparse.ArgumentParser(description='Открывает Google Карты в браузере')
    parser.parse_args()
    try:
        os.startfile(URL)
    except OSError as exc:
        print(f'Не удалось открыть страницу: {exc}', file=sys.stderr)
        return 1
    print('Открываю Google Карты в браузере.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
