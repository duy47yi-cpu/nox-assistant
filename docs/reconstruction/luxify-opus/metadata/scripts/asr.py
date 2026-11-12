# Local ASR (faster-whisper small, cached) with word timestamps; no network.
import os, json, subprocess
import numpy as np
os.environ['HF_HUB_OFFLINE'] = '1'
from faster_whisper import WhisperModel
L = 'C:/Users/abdut/Downloads/luxify'
O = 'D:/nox-release/docs/reconstruction/luxify-opus/metadata'
VIDS = {'V02': 'cJzcvVmmUYlRCD2Why9OEg', 'V03': 'yPGB7_7OcWSnDvYaFLOREg', 'V04': '6eY2h5i9vrl6Dw_2ejg8yA',
        'V05': 'video_2026-11-10_22-11-08', 'V06': 'video_2026-11-10_22-11-27', 'V08': 'video_2026-11-10_22-12-47'}
m = WhisperModel('small', device='cpu', compute_type='int8')
for tag, name in VIDS.items():
    # installed PyAV rejects faster-whisper's decode kwargs, so decode with ffmpeg ourselves
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', f'{L}/{name}.mp4', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], capture_output=True, check=True).stdout
    audio = np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0
    segs, info = m.transcribe(audio, language='ru', word_timestamps=True, vad_filter=True, beam_size=5)
    out = []
    for s in segs:
        out.append({'start': round(s.start, 2), 'end': round(s.end, 2), 'text': s.text.strip(),
                    'no_speech_prob': round(s.no_speech_prob, 3), 'avg_logprob': round(s.avg_logprob, 3),
                    'words': [[round(w.start, 2), round(w.end, 2), w.word, round(w.probability, 2)] for w in (s.words or [])]})
    json.dump({'video': name, 'model': 'faster-whisper small int8 cpu', 'language_forced': 'ru', 'vad_filter': True,
               'duration': info.duration, 'duration_after_vad': info.duration_after_vad, 'segments': out},
              open(f'{O}/{tag}-asr.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(tag, len(out), 'segments', flush=True)
    for s in out: print(f"  {s['start']:6.2f}-{s['end']:6.2f} ns={s['no_speech_prob']} {s['text']}", flush=True)
