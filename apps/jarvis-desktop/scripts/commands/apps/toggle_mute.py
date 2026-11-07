import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import ctypes

VK_VOLUME_MUTE = 0xAD
KEYEVENTF_KEYUP = 0x0002


def main():
    parser = argparse.ArgumentParser(description='Переключает режим без звука')
    parser.parse_args()
    try:
        user32 = ctypes.windll.user32
        user32.keybd_event(VK_VOLUME_MUTE, 0, 0, 0)
        user32.keybd_event(VK_VOLUME_MUTE, 0, KEYEVENTF_KEYUP, 0)
    except (AttributeError, OSError) as exc:
        print(f'Не удалось переключить звук: {exc}', file=sys.stderr)
        return 1
    print('Переключил режим звука (вкл. или выкл.).')
    return 0


if __name__ == '__main__':
    sys.exit(main())
