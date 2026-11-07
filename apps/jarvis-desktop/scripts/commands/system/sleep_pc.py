import sys
import argparse
import subprocess

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description='Переводит компьютер в сон (нужен --confirm)')
    parser.add_argument("--confirm", action="store_true", help="подтвердить перевод в сон")
    args = parser.parse_args()
    if not args.confirm:
        print("Компьютер будет переведён в сон. Для выполнения добавьте --confirm.")
        return 2
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")
    result = subprocess.run(["rundll32.exe", "powrprof.dll,SetSuspendState", "0,1,0"])
    if result.returncode != 0:
        raise RuntimeError(f"rundll32 завершился с кодом {result.returncode}")
    print("Компьютер переведён в сон.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
