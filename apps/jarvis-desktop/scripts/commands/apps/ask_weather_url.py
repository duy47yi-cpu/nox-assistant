import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import os
import urllib.parse

MAX_CITY = 100


def main():
    parser = argparse.ArgumentParser(description='Открывает погоду в браузере через поиск')
    parser.add_argument('--city', default='', help='город (необязательно)')
    args = parser.parse_args()

    city = args.city.strip()
    if len(city) > MAX_CITY:
        print('Название города слишком длинное.', file=sys.stderr)
        return 1
    query = f'погода {city}'.strip()
    url = 'https://www.google.com/search?q=' + urllib.parse.quote(query, safe='')
    try:
        os.startfile(url)
    except OSError as exc:
        print(f'Не удалось открыть погоду: {exc}', file=sys.stderr)
        return 1
    print(f'Открываю погоду: {query}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
