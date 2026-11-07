import os
import sys
import ctypes
import argparse
import datetime
import subprocess

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

CSIDL_PERSONAL = 0x0005  # папка «Документы»

PS_SCRIPT = (
    "Add-Type -AssemblyName System.Windows.Forms; "
    "Add-Type -AssemblyName System.Drawing; "
    "$area = [System.Windows.Forms.SystemInformation]::VirtualScreen; "
    "$bmp = New-Object System.Drawing.Bitmap -ArgumentList $area.Width, $area.Height; "
    "$gfx = [System.Drawing.Graphics]::FromImage($bmp); "
    "$gfx.CopyFromScreen($area.Location, [System.Drawing.Point]::Empty, $area.Size); "
    "$bmp.Save($env:JARVIS_SHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png); "
    "$gfx.Dispose(); $bmp.Dispose()"
)


def documents_dir():
    buf = ctypes.create_unicode_buffer(260)
    if ctypes.windll.shell32.SHGetFolderPathW(None, CSIDL_PERSONAL, None, 0, buf) != 0:
        raise RuntimeError("не удалось найти папку «Документы»")
    return buf.value


def main():
    parser = argparse.ArgumentParser(description='Сохраняет снимок экрана в Документы/Jarvis/screenshots')
    parser.parse_args()
    if sys.platform != "win32":
        raise RuntimeError("команда работает только в Windows")

    folder = os.path.join(documents_dir(), "Jarvis", "screenshots")
    os.makedirs(folder, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    path = os.path.join(folder, stamp + ".png")

    env = dict(os.environ, JARVIS_SHOT_PATH=path)
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT],
        env=env, capture_output=True, encoding="utf-8", errors="replace",
    )
    if result.returncode != 0 or not os.path.exists(path):
        details = (result.stderr or "").strip()[:200]
        raise RuntimeError("не удалось сохранить снимок экрана" + (f": {details}" if details else ""))
    print(f"Снимок экрана сохранён: {path}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"Ошибка: {exc}", file=sys.stderr)
        sys.exit(1)
