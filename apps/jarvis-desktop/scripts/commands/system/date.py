import sys
import argparse
import datetime

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]
MONTHS = [
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
]


def main():
    parser = argparse.ArgumentParser(description='Показывает сегодняшнюю дату и день недели')
    parser.parse_args()
    today = datetime.date.today()
    print(
        f"Сегодня {WEEKDAYS[today.weekday()]}, {today.day} "
        f"{MONTHS[today.month - 1]} {today.year} года."
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
