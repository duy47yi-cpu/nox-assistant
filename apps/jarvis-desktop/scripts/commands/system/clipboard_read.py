import sys
import time
import ctypes
import argparse

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

CF_UNICODETEXT = 13


def read_text():
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    user32.GetClipboardData.restype = ctypes.c_void_p
    user32.GetClipboardData.argtypes = [ctypes.c_uint]
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [ctypes.c_void_p]
    kernel32.GlobalUnlock.argtypes = [ctypes.c_void_p]

    for _ in range(10):
        if user32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise RuntimeError("буфер обмена занят другой программой")
    try:
        if not user32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return ""
        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return ""
        pointer = kernel32.GlobalLock(handle)
        if not pointer:
            return ""
        try:
            return ctypes.wstring_at(pointer)
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


def main():
    parser = argparse.ArgumentParser(description='Показывает текст из буфера обмена')
    parser.add_argument("--limit", type=int, default=200, help="сколько символов показать (по умолчанию 200)")
    args = parser.parse_args()
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    if args.limit < 1:
        raise ValueError("--limit должен быть больше нуля")

    text = read_text()
    if not text:
        print("В буфере обмена нет текста.")
        return 0
    shown = " / ".join(line.strip() for line in text.splitlines() if line.strip())
    if len(shown) > args.limit:
        shown = shown[:args.limit] + "..."
    print(f"Буфер обмена: «{shown}»")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
