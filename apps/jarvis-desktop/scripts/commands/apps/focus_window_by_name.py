import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import os
import subprocess

PS_SCRIPT = (
    "$s = New-Object -ComObject WScript.Shell; "
    "if ($s.AppActivate($env:JARVIS_WIN_TITLE)) { 'OK' } else { 'FAIL' }"
)
MAX_TITLE = 200


def main():
    parser = argparse.ArgumentParser(description='Активирует окно по части заголовка')
    parser.add_argument('--title', required=True, help='часть заголовка окна')
    args = parser.parse_args()

    title = args.title.strip()
    if not title or len(title) > MAX_TITLE:
        print('Заголовок окна пустой или слишком длинный.', file=sys.stderr)
        return 1

    env = os.environ.copy()
    env['JARVIS_WIN_TITLE'] = title
    try:
        result = subprocess.run(
            ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT],
            capture_output=True,
            timeout=15,
            env=env,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f'Не удалось переключить окно: {exc}', file=sys.stderr)
        return 1

    if result.stdout.decode('utf-8', errors='replace').strip() == 'OK':
        print(f'Переключился на окно «{title}».')
        return 0
    print(f'Окно с заголовком «{title}» не найдено.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
