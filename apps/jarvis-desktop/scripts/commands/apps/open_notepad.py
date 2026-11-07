import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import subprocess


def main():
    parser = argparse.ArgumentParser(description='Запускает Блокнот Windows')
    parser.parse_args()
    try:
        subprocess.Popen(['notepad.exe'])
    except OSError as exc:
        print(f'Не удалось открыть Блокнот: {exc}', file=sys.stderr)
        return 1
    print('Открываю Блокнот.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
