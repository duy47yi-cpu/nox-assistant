import sys
import argparse
import ctypes

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

SHERB_NOCONFIRMATION = 0x00000001
SHERB_NOPROGRESSUI = 0x00000002
SHERB_NOSOUND = 0x00000004


def main():
    parser = argparse.ArgumentParser(description='Очищает корзину на всех дисках (нужен --confirm)')
    parser.add_argument("--confirm", action="store_true", help="подтвердить очистку корзины")
    args = parser.parse_args()
    if not args.confirm:
        print("Корзина будет очищена на всех дисках без возможности восстановления. Для выполнения добавьте --confirm.")
        return 2
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    shell32 = ctypes.windll.shell32
    shell32.SHEmptyRecycleBinW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint32]
    shell32.SHEmptyRecycleBinW.restype = ctypes.c_long
    flags = SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND
    hresult = shell32.SHEmptyRecycleBinW(None, None, flags)
    if hresult != 0:
        raise RuntimeError(f"не удалось очистить корзину (код {hresult & 0xFFFFFFFF:#x})")
    print("Корзина очищена.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
