import sys
import argparse
import ctypes

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


def gigabytes(value):
    return f"{value / 1024 ** 3:.1f} ГБ"


def main():
    parser = argparse.ArgumentParser(description='Показывает загрузку оперативной памяти')
    parser.parse_args()
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    status = MEMORYSTATUSEX()
    status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
        raise RuntimeError("не удалось получить состояние памяти")
    used = status.ullTotalPhys - status.ullAvailPhys
    print(
        f"ОЗУ загружена на {status.dwMemoryLoad}%: занято {gigabytes(used)} "
        f"из {gigabytes(status.ullTotalPhys)}, свободно {gigabytes(status.ullAvailPhys)}."
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
