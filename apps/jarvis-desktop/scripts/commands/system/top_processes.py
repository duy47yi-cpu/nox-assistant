import io
import sys
import csv
import argparse
import subprocess

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


def parse(output):
    totals = {}
    for row in csv.reader(io.StringIO(output)):
        if len(row) < 5:
            continue
        name = row[0].strip()
        digits = "".join(ch for ch in row[4] if ch.isdigit())
        if not name or not digits:
            continue
        kb, count = totals.get(name, (0, 0))
        totals[name] = (kb + int(digits), count + 1)
    return sorted(totals.items(), key=lambda item: item[1][0], reverse=True)[:10]


def fmt(kb):
    mb = kb / 1024
    return f"{mb / 1024:.1f} ГБ" if mb >= 1024 else f"{mb:.0f} МБ"


def main():
    parser = argparse.ArgumentParser(description='Показывает 10 процессов с наибольшим потреблением памяти')
    parser.parse_args()
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    result = subprocess.run(
        ["tasklist.exe", "/FO", "CSV", "/NH"],
        capture_output=True, encoding="oem", errors="replace",
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout).strip() or "tasklist не сработал")
    top = parse(result.stdout)
    if not top:
        raise RuntimeError("список процессов пуст")
    items = []
    for name, (kb, count) in top:
        suffix = f" ({count} шт.)" if count > 1 else ""
        items.append(f"{name}{suffix} — {fmt(kb)}")
    print("Топ-10 процессов по памяти: " + "; ".join(items) + ".")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
