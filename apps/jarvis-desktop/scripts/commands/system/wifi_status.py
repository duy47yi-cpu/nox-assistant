import sys
import argparse
import subprocess

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


def parse(output):
    info = {}
    for line in output.splitlines():
        key, sep, value = line.partition(":")
        if not sep:
            continue
        key = key.strip()
        value = value.strip()
        if key in ("State", "Состояние") and "state" not in info:
            info["state"] = value
        elif key == "SSID" and "ssid" not in info:
            info["ssid"] = value
        elif key in ("Signal", "Сигнал") and "signal" not in info:
            info["signal"] = value
    return info


def main():
    parser = argparse.ArgumentParser(description='Показывает, подключён ли Wi-Fi и к какой сети')
    parser.parse_args()
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    result = subprocess.run(
        ["netsh.exe", "wlan", "show", "interfaces"],
        capture_output=True, encoding="oem", errors="replace",
    )
    if result.returncode != 0:
        message = (result.stdout + result.stderr).strip()
        raise RuntimeError(message or "netsh не смог получить состояние Wi-Fi")
    info = parse(result.stdout)
    if not info:
        print("Wi-Fi адаптер не найден.")
        return 0
    state = info.get("state", "неизвестно")
    if state.lower().startswith(("connected", "подключ")):
        text = f"Wi-Fi подключён к сети «{info.get('ssid', '?')}»"
        if "signal" in info:
            text += f", сигнал {info['signal']}"
        print(text + ".")
    else:
        print(f"Wi-Fi не подключён (состояние: {state}).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
