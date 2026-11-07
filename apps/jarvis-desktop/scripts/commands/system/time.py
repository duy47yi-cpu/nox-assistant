import sys
import argparse
import datetime

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description='Показывает текущее время')
    parser.parse_args()
    now = datetime.datetime.now()
    print(f"Сейчас {now:%H:%M:%S}.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
