import sys
import socket
import argparse

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')


def local_ip():
    # connect() у UDP-сокета не отправляет пакетов: ОС только выбирает исходный адрес для маршрута.
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("10.255.255.255", 1))
        return sock.getsockname()[0]
    except OSError:
        return socket.gethostbyname(socket.gethostname())
    finally:
        sock.close()


def main():
    parser = argparse.ArgumentParser(description='Показывает локальный IP-адрес без выхода в интернет')
    parser.parse_args()
    print(f"Локальный IP-адрес: {local_ip()}.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
