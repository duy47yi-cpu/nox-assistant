#!/usr/bin/env python3
"""Локальный сервер синтеза речи Silero для Jarvis.

Вход: по одной строке на запрос, JSON:
  {"id": "...", "text": "...", "speaker": "..."} — синтез, speaker необязателен;
  {"id": "...", "op": "voices"} — список голосов модели (нужен для выбора голоса в настройках).
Выход в stdout: одна строка JSON на запрос:
  {"id": "...", "ok": true, "file": "<абсолютный путь к wav>"}
  {"id": "...", "ok": true, "voices": ["...", "..."]}
  {"id": "...", "ok": false, "error": "..."}
Служебные сообщения и ошибки пишутся только в stderr.
Модель грузится лениво, при первом запросе. Облачных сервисов не используется.
Скорость и громкость меняет проигрыватель (src/voice/tts.js): сама модель их не принимает.
"""

import argparse
import array
import contextlib
import json
import os
import re
import sys
import wave

SAMPLE_RATE = 48000
MAX_TEXT = 500
MODEL_REPO = 'snakers4/silero-models'
MODEL_NAME = 'silero_tts'
MODEL_LANGUAGE = 'ru'
MODEL_VERSION = 'v5_cis_base'
# id попадает в имя файла, поэтому допускаем только безопасный набор символов.
ID_PATTERN = re.compile(r'[A-Za-z0-9_-]{1,64}')
DEFAULT_OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'voice-out')


def log(message):
    print(message, file=sys.stderr, flush=True)


def write_wav(path, samples):
    # Моно, 16 бит, без numpy: отсчёты собираем в array('h').
    pcm = array.array('h')
    for x in samples:
        pcm.append(int(max(-1.0, min(1.0, float(x))) * 32767))
    if sys.byteorder == 'big':
        pcm.byteswap()  # WAV хранит данные в little-endian
    with wave.open(path, 'wb') as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm.tobytes())


class Synth:
    """Ленивая загрузка модели и синтез. Одна модель на процесс."""

    def __init__(self, out_dir):
        self.out_dir = out_dir
        self.model = None
        self.default_speaker = None
        self.speakers = []

    def _load(self):
        if self.model is not None:
            return
        import torch  # импорт здесь, чтобы старт сервера не ждал торч
        log('silero: загрузка модели (первый запуск может скачать её)')
        # Всё, что печатает загрузчик, уходит в stderr: stdout должен содержать только JSON.
        with contextlib.redirect_stdout(sys.stderr):
            model, _ = torch.hub.load(
                repo_or_dir=MODEL_REPO,
                model=MODEL_NAME,
                language=MODEL_LANGUAGE,
                speaker=MODEL_VERSION,
            )
        speakers = [str(s) for s in (getattr(model, 'speakers', None) or [])]
        names = ', '.join(speakers) or 'не сообщены'
        log(f'silero: голоса модели: {names}')
        self.speakers = speakers
        self.default_speaker = speakers[0] if speakers else None
        self.model = model

    def voices(self):
        """Список голосов модели. Первый вызов загружает модель — это может быть долго."""
        self._load()
        return list(self.speakers)

    def synthesize(self, req_id, text, speaker):
        self._load()
        voice = speaker or self.default_speaker
        if not voice:
            raise RuntimeError('голос не задан, а модель не сообщила список голосов')
        # Чужое имя голоса — понятный отказ, а не падение внутри модели.
        if self.speakers and voice not in self.speakers:
            raise RuntimeError(f'голос «{voice}» не найден. Доступны: {", ".join(self.speakers)}')
        with contextlib.redirect_stdout(sys.stderr):
            audio = self.model.apply_tts(
                text=text,
                speaker=voice,
                sample_rate=SAMPLE_RATE,
                put_accent=True,
                put_yo=True,
            )
        path = os.path.join(self.out_dir, f'{req_id}.wav')
        write_wav(path, audio.tolist())
        return path


def handle_request(synth, line):
    req_id = None
    try:
        req = json.loads(line)
        if not isinstance(req, dict):
            raise ValueError('ожидался JSON-объект')
        req_id = req.get('id')
        if not isinstance(req_id, str) or not ID_PATTERN.fullmatch(req_id):
            raise ValueError('id: строка из латиницы, цифр, "-" и "_", до 64 символов')
        # Список голосов: нужен экрану настроек, чтобы владелец выбрал голос.
        if req.get('op') == 'voices':
            return {'id': req_id, 'ok': True, 'voices': synth.voices()}
        text = str(req.get('text') or '').strip()
        if not text:
            raise ValueError('пустой текст')
        text = text[:MAX_TEXT]
        speaker = req.get('speaker') or None
        file_path = synth.synthesize(req_id, text, speaker)
        return {'id': req_id, 'ok': True, 'file': file_path}
    except Exception as err:  # один плохой запрос не должен валить сервер
        message = str(err) or err.__class__.__name__
        log(f'ошибка синтеза (id={req_id!r}): {message}')
        return {'id': req_id, 'ok': False, 'error': message}


def main():
    parser = argparse.ArgumentParser(description='Silero TTS для Jarvis: JSON по строкам через stdin/stdout')
    parser.add_argument('--out-dir', default=DEFAULT_OUT_DIR, help='каталог для wav-файлов')
    args = parser.parse_args()

    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8', errors='replace')

    synth = Synth(out_dir)
    log(f'silero: сервер готов, каталог вывода: {out_dir}')
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        response = handle_request(synth, line)
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + '\n')
        sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
