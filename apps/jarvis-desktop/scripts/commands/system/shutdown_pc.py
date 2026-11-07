import sys
import argparse
import subprocess

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

DELAY_SECONDS = 60


def main():
    parser = argparse.ArgumentParser(description='Выключает компьютер через 60 секунд (нужен --confirm)')
    parser.add_argument("--confirm", action="store_true", help="подтвердить выключение")
    args = parser.parse_args()
    if not args.confirm:
        print(
            f"Компьютер будет выключен через {DELAY_SECONDS} секунд. "
            "Для выполнения добавьте --confirm. Отмена: команда cancel_shutdown."
        )
        return 2
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    result = subprocess.run(
        ["shutdown.exe", "/s", "/t", str(DELAY_SECONDS)],
        capture_output=True, encoding="oem", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip() or f"shutdown завершился с кодом {result.returncode}")
    print(f"Выключение запланировано через {DELAY_SECONDS} секунд. Отмена: команда cancel_shutdown.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
