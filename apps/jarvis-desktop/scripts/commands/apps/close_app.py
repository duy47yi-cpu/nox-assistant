import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import re
import subprocess

PROTECTED = {
    'explorer.exe', 'dwm.exe', 'csrss.exe', 'winlogon.exe', 'wininit.exe',
    'services.exe', 'lsass.exe', 'svchost.exe', 'smss.exe', 'sihost.exe',
    'fontdrvhost.exe', 'system', 'system.exe', 'system idle process',
}
NAME_RE = re.compile(r'^[A-Za-z0-9_.\- ]{1,100}$')


def main():
    parser = argparse.ArgumentParser(description='Закрывает программу по имени, только с --confirm')
    parser.add_argument('--name', required=True, help='имя программы, например chrome или notepad.exe')
    parser.add_argument('--confirm', action='store_true', help='подтвердить закрытие программы')
    args = parser.parse_args()

    name = args.name.strip()
    if not NAME_RE.match(name):
        print('Некорректное имя программы.', file=sys.stderr)
        return 1
    if not name.lower().endswith('.exe'):
        name += '.exe'
    if name.lower() in PROTECTED:
        print(f'Программа {name} системная, закрывать её нельзя.', file=sys.stderr)
        return 1

    if not args.confirm:
        print(f'План: закрыть программу {name} (без принудительного завершения). Для выполнения добавьте --confirm.')
        return 2

    try:
        result = subprocess.run(['taskkill', '/IM', name, '/T'], capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f'Не удалось выполнить закрытие: {exc}', file=sys.stderr)
        return 1
    if result.returncode != 0:
        print(f'Не удалось закрыть {name}: процесс не найден или у него нет окна.', file=sys.stderr)
        return 1
    print(f'Запрос на закрытие {name} отправлен.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
