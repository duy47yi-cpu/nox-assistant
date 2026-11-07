import sys
import argparse
import subprocess

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


def parse(output):
    rows = []
    in_table = False
    for line in output.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if set(stripped) == {"-"}:
            in_table = True
            continue
        if not in_table:
            continue
        parts = stripped.split(None, 3)
        if len(parts) == 4:
            rows.append((parts[3].strip(), parts[1]))
    return rows


def human(state):
    low = state.lower()
    if low.startswith(("connected", "подключ")):
        return "подключён"
    if low.startswith(("disconnected", "отключ")):
        return "отключён"
    return low


def main():
    parser = argparse.ArgumentParser(description='Показывает состояние сетевых адаптеров')
    parser.parse_args()
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    result = subprocess.run(
        ["netsh.exe", "interface", "show", "interface"],
        capture_output=True, encoding="oem", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip() or "netsh не сработал")
    rows = parse(result.stdout)
    if not rows:
        raise RuntimeError("сетевые адаптеры не найдены")
    print("Сетевые адаптеры: " + "; ".join(f"{name} — {human(state)}" for name, state in rows) + ".")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
