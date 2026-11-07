import sys
import argparse
import subprocess

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

ERROR_NO_SHUTDOWN_IN_PROGRESS = 1116


def main():
    parser = argparse.ArgumentParser(description='Отменяет запланированное выключение или перезагрузку')
    parser.parse_args()
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    result = subprocess.run(["shutdown.exe", "/a"], capture_output=True, encoding="oem", errors="replace")
    if result.returncode == 0:
        print("Запланированное выключение или перезагрузка отменены.")
        return 0
    if result.returncode == ERROR_NO_SHUTDOWN_IN_PROGRESS:
        raise RuntimeError("нет запланированного выключения или перезагрузки")
    raise RuntimeError((result.stderr or result.stdout).strip() or f"shutdown завершился с кодом {result.returncode}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
