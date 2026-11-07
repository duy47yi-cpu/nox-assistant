import sys
import argparse
import ctypes

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

UNKNOWN_BYTE = 255
UNKNOWN_TIME = 0xFFFFFFFF
NO_BATTERY_FLAG = 128
CHARGING_FLAG = 8


class SYSTEM_POWER_STATUS(ctypes.Structure):
    _fields_ = [
        ("ACLineStatus", ctypes.c_ubyte),
        ("BatteryFlag", ctypes.c_ubyte),
        ("BatteryLifePercent", ctypes.c_ubyte),
        ("SystemStatusFlag", ctypes.c_ubyte),
        ("BatteryLifeTime", ctypes.c_ulong),
        ("BatteryFullLifeTime", ctypes.c_ulong),
    ]


def describe(status):
    if status.BatteryFlag & NO_BATTERY_FLAG:
        return "Батарея не обнаружена (стационарный компьютер)."
    parts = []
    if status.BatteryLifePercent == UNKNOWN_BYTE:
        parts.append("заряд неизвестен")
    else:
        parts.append(f"заряд {status.BatteryLifePercent}%")
    if status.ACLineStatus == 1:
        parts.append("питание от сети")
    elif status.ACLineStatus == 0:
        parts.append("питание от батареи")
    if status.BatteryFlag & CHARGING_FLAG:
        parts.append("идёт зарядка")
    text = ", ".join(parts) + "."
    if status.ACLineStatus == 0 and status.BatteryLifeTime != UNKNOWN_TIME:
        hours, minutes = divmod(status.BatteryLifeTime // 60, 60)
        text += f" Осталось примерно {hours} ч {minutes} мин."
    return text


def main():
    parser = argparse.ArgumentParser(description='Показывает заряд и статус питания')
    parser.parse_args()
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    status = SYSTEM_POWER_STATUS()
    if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(status)):
        raise RuntimeError("не удалось получить состояние питания")
    print(describe(status))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
