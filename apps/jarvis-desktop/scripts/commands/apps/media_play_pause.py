import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import ctypes

VK_KEY = 0xB3
KEYEVENTF_KEYUP = 0x0002


def main():
    parser = argparse.ArgumentParser(description='Нажимает клавишу Play/Pause для текущего плеера')
    parser.parse_args()
    try:
        user32 = ctypes.windll.user32
        user32.keybd_event(VK_KEY, 0, 0, 0)
        user32.keybd_event(VK_KEY, 0, KEYEVENTF_KEYUP, 0)
    except (AttributeError, OSError) as exc:
        print(f'Не удалось отправить медиа клавишу: {exc}', file=sys.stderr)
        return 1
    print('Переключаю воспроизведение (пауза или продолжить).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
