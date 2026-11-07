import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import os
import urllib.parse

PREFIX = 'https://www.google.com/search?q='
MAX_QUERY = 300


def main():
    parser = argparse.ArgumentParser(description='Открывает поиск Google по запросу')
    parser.add_argument('--query', required=True, help='что искать')
    args = parser.parse_args()

    query = args.query.strip()
    if not query or len(query) > MAX_QUERY:
        print('Запрос пустой или слишком длинный.', file=sys.stderr)
        return 1
    url = PREFIX + urllib.parse.quote(query, safe='')
    try:
        os.startfile(url)
    except OSError as exc:
        print(f'Не удалось открыть поиск: {exc}', file=sys.stderr)
        return 1
    print(f'Ищу в интернете: {query}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
