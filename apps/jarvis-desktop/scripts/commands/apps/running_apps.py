import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import csv
import ctypes
import io
import subprocess

MAX_SHOWN = 15


def oem_encoding():
    try:
        return f'cp{ctypes.windll.kernel32.GetOEMCP()}'
    except (AttributeError, OSError):
        return 'cp866'


def main():
    parser = argparse.ArgumentParser(description='Показывает программы с открытыми окнами')
    parser.parse_args()
    try:
        result = subprocess.run(
            ['tasklist', '/V', '/FO', 'CSV', '/NH'],
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f'Не удалось получить список процессов: {exc}', file=sys.stderr)
        return 1
    if result.returncode != 0:
        print('tasklist вернул ошибку.', file=sys.stderr)
        return 1

    text = result.stdout.decode(oem_encoding(), errors='replace')
    names = {}
    for row in csv.reader(io.StringIO(text)):
        if len(row) >= 9:
            image, title = row[0], row[8].strip()
            if title and title != 'N/A':
                names[image] = True

    if not names:
        print('Программ с видимыми окнами не найдено.')
        return 0
    shown = ', '.join(list(names)[:MAX_SHOWN])
    print(f'Программ с окнами: {len(names)}. Например: {shown}.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
