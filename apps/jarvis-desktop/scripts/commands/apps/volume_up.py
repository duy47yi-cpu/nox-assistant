import sys
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import argparse
import ctypes

VK_KEY = 0xAF
KEYEVENTF_KEYUP = 0x0002
STEP_PERCENT = 2
MAX_STEPS = 50


def press_once():
    user32 = ctypes.windll.user32
    user32.keybd_event(VK_KEY, 0, 0, 0)
    user32.keybd_event(VK_KEY, 0, KEYEVENTF_KEYUP, 0)


def main():
    parser = argparse.ArgumentParser(description='Увеличивает громкость на несколько шагов (по умолчанию 5)')
    parser.add_argument('--steps', type=int, default=5, help='сколько шагов (1-50, по умолчанию 5)')
    args = parser.parse_args()
    if not 1 <= args.steps <= MAX_STEPS:
        print(f'Количество шагов должно быть от 1 до {MAX_STEPS}.', file=sys.stderr)
        return 1
    try:
        for _ in range(args.steps):
            press_once()
    except (AttributeError, OSError) as exc:
        print(f'Не удалось изменить громкость: {exc}', file=sys.stderr)
        return 1
    print(f'Громкость увеличена примерно на {args.steps * STEP_PERCENT}%.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
