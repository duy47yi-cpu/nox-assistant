import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import os

HOME_PAGE = 'https://www.google.com'


def main():
    parser = argparse.ArgumentParser(description='Открывает браузер по умолчанию на странице Google')
    parser.parse_args()
    try:
        os.startfile(HOME_PAGE)
    except OSError as exc:
        print(f'Не удалось открыть браузер: {exc}', file=sys.stderr)
        return 1
    print('Открываю браузер по умолчанию.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
