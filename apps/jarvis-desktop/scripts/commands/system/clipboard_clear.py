import sys
import time
import ctypes
import argparse

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description='Очищает буфер обмена')
    parser.parse_args()
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    user32 = ctypes.windll.user32
    for _ in range(10):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise RuntimeError("буфер обмена занят другой программой")
    try:
        if not user32.EmptyClipboard():
            raise RuntimeError("не удалось очистить буфер обмена")
    finally:
        user32.CloseClipboard()
    print("Буфер обмена очищен.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
