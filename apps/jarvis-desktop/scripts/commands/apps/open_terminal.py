import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import subprocess


def main():
    parser = argparse.ArgumentParser(description='Открывает Windows Terminal, а если его нет, командную строку')
    parser.parse_args()
    try:
        subprocess.Popen(['wt.exe'])
        print('Открываю Windows Terminal.')
        return 0
    except OSError:
        pass
    try:
        subprocess.Popen(['cmd.exe'], creationflags=subprocess.CREATE_NEW_CONSOLE)
    except OSError as exc:
        print(f'Не удалось открыть терминал: {exc}', file=sys.stderr)
        return 1
    print('Windows Terminal не найден, открываю командную строку.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
