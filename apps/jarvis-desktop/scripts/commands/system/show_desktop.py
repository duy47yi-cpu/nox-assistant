import sys
import argparse
import ctypes

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

VK_LWIN = 0x5B
VK_D = 0x44
KEYEVENTF_KEYUP = 0x0002


def main():
    parser = argparse.ArgumentParser(description='Сворачивает все окна (Win+D)')
    parser.parse_args()
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    user32 = ctypes.windll.user32
    user32.keybd_event(VK_LWIN, 0, 0, 0)
    user32.keybd_event(VK_D, 0, 0, 0)
    user32.keybd_event(VK_D, 0, KEYEVENTF_KEYUP, 0)
    user32.keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, 0)
    print("Отправлено сочетание Win+D: окна свёрнуты, повторный вызов вернёт их.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
