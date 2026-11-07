import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import os

URL = 'https://github.com'


def main():
    parser = argparse.ArgumentParser(description='Открыть GitHub')
    parser.parse_args()
    try:
        os.startfile(URL)
    except OSError as exc:
        print(f'Не удалось открыть страницу: {exc}', file=sys.stderr)
        return 1
    print('Открываю GitHub в браузере.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
