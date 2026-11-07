import os
import sys
import argparse

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description='Открывает параметры Windows')
    parser.parse_args()
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    os.startfile("ms-settings:")
    print("Открываю параметры Windows.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
