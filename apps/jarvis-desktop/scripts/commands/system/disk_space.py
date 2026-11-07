import os
import sys
import shutil
import argparse

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


def gigabytes(value):
    return f"{value / 1024 ** 3:.1f} ГБ"


def main():
    parser = argparse.ArgumentParser(description='Показывает свободное место на дисках')
    parser.add_argument("--drive", help="буква диска, например C (по умолчанию все диски)")
    args = parser.parse_args()

    if args.drive:
        letter = args.drive.strip().rstrip(":").upper()
        if len(letter) != 1 or not letter.isalpha():
            raise ValueError("укажите одну букву диска, например C")
        letters = [letter]
    else:
        letters = [chr(code) for code in range(ord("C"), ord("Z") + 1)]

    parts = []
    for letter in letters:
        root = f"{letter}:\\"
        if not os.path.exists(root):
            continue
        try:
            usage = shutil.disk_usage(root)
        except OSError:
            continue
        parts.append(f"{letter}: свободно {gigabytes(usage.free)} из {gigabytes(usage.total)}")

    if not parts:
        raise RuntimeError("диски не найдены")
    print("; ".join(parts) + ".")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
