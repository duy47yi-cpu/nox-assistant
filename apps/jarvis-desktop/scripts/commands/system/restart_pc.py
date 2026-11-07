import sys
import argparse
import subprocess

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

DELAY_SECONDS = 30


def main():
    parser = argparse.ArgumentParser(description='Перезагружает компьютер через 30 секунд (нужен --confirm)')
    parser.add_argument("--confirm", action="store_true", help="подтвердить перезагрузку")
    args = parser.parse_args()
    if not args.confirm:
        print(
            f"Компьютер будет перезагружен через {DELAY_SECONDS} секунд. "
            "Для выполнения добавьте --confirm. Отмена: команда cancel_shutdown."
        )
        return 2
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    result = subprocess.run(
        ["shutdown.exe", "/r", "/t", str(DELAY_SECONDS)],
        capture_output=True, encoding="oem", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip() or f"shutdown завершился с кодом {result.returncode}")
    print(f"Перезагрузка запланирована через {DELAY_SECONDS} секунд. Отмена: команда cancel_shutdown.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
