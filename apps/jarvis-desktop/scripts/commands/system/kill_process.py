import re
import sys
import argparse
import subprocess

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# Системные процессы, завершение которых ломает Windows. Запрещены всегда.
PROTECTED = {
    "system.exe", "idle.exe", "registry.exe", "smss.exe", "csrss.exe", "wininit.exe",
    "winlogon.exe", "services.exe", "lsass.exe", "svchost.exe", "explorer.exe",
    "dwm.exe", "fontdrvhost.exe",
}


def normalize(name):
    name = name.strip().lower()
    if not re.fullmatch(r"[a-z0-9_.\-]+", name):
        raise ValueError("некорректное имя процесса: допустимы латинские буквы, цифры, точка, дефис и подчёркивание")
    if "." not in name:
        name += ".exe"
    return name


def main():
    parser = argparse.ArgumentParser(description='Завершает процесс по имени (нужен --confirm)')
    parser.add_argument("--name", required=True, help="имя процесса, например chrome или notepad.exe")
    parser.add_argument("--force", action="store_true", help="принудительное завершение (taskkill /F)")
    parser.add_argument("--confirm", action="store_true", help="подтвердить завершение процесса")
    args = parser.parse_args()

    name = normalize(args.name)
    if name in PROTECTED:
        raise ValueError(f"процесс {name} системный, завершение запрещено")

    mode = " принудительно" if args.force else ""
    if not args.confirm:
        print(f"Будет завершён процесс {name}{mode} (все его экземпляры). Для выполнения добавьте --confirm.")
        return 2
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")

    command = ["taskkill.exe", "/IM", name]
    if args.force:
        command.append("/F")
    result = subprocess.run(command, capture_output=True, encoding="oem", errors="replace")
    if result.returncode == 0:
        print(f"Процесс {name} завершён.")
        return 0
    if result.returncode == 128:
        raise RuntimeError(f"процесс {name} не запущен")
    raise RuntimeError((result.stderr or result.stdout).strip() or f"taskkill завершился с кодом {result.returncode}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
