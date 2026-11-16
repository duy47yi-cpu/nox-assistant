"""Persistent speech recognition worker. Audio is 16 kHz PCM16 over stdin."""
import base64
import json
import sys
from pathlib import Path

import librosa
import numpy as np
import onnxruntime as ort


class Recognizer:
    def __init__(self, folder):
        self.tokens = [line.split()[0] for line in
                       (folder / "v3_vocab.txt").read_text(encoding="utf-8").splitlines()]
        if len(self.tokens) != 34 or self.tokens[0] != "▁" or self.tokens[33] != "<blk>":
            raise ValueError("invalid vocabulary")
        self.window = librosa.filters.get_window("hann", 320, fftbins=True)
        self.mels = librosa.filters.mel(sr=16000, n_fft=320, n_mels=64, htk=True)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        self.model = ort.InferenceSession(str(folder / "v3_ctc.int8.onnx"),
                                          sess_options=options, providers=["CPUExecutionProvider"])

    def transcribe(self, samples):
        # Equivalent to librosa melspectrogram with the measured settings.
        padded = np.pad(samples, 160, mode="reflect")
        frames = np.lib.stride_tricks.sliding_window_view(padded, 320)[::160]
        spectrum = np.abs(np.fft.rfft(frames * self.window, axis=1)) ** 2
        mel = self.mels @ spectrum.astype(np.float32).T
        features = np.log(np.clip(mel, 1e-9, 1e9))[None, :, :]
        logits = self.model.run(["log_probs"], {
            "features": np.ascontiguousarray(features),
            "feature_lengths": np.array([features.shape[2]], dtype=np.int64),
        })[0][0]
        best = logits.argmax(axis=-1)
        starts = np.r_[True, best[1:] != best[:-1]]
        keep = starts & (best != 33)
        text = "".join(self.tokens[token] for token in best[keep]).replace("▁", " ")
        # Average greedy CTC token score. This is a heuristic, never an identity check.
        confidence = float(np.exp(logits[keep].max(axis=-1).mean())) if keep.any() else 0
        return {"text": " ".join(text.split()), "confidence": round(confidence, 3)}


def peak_mib():
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("page_faults", wintypes.DWORD),
                        ("peak", ctypes.c_size_t), ("rest", ctypes.c_size_t * 7)]

        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        ctypes.windll.kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        if ctypes.windll.psapi.GetProcessMemoryInfo(wintypes.HANDLE(handle),
                                                  ctypes.byref(counters), counters.cb):
            return round(counters.peak / 1048576, 1)
        return None
    import resource
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss /
                 (1048576 if sys.platform == "darwin" else 1024), 1)


def send(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)


def main():
    model = Recognizer(Path(sys.argv[1]))
    send({"ready": True})
    for line in sys.stdin:
        request = json.loads(line)
        try:
            pcm = base64.b64decode(request["pcm"], validate=True)
            samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768
            send({"id": request["id"], **model.transcribe(samples), "peakMiB": peak_mib()})
        except (ValueError, RuntimeError):
            send({"id": request["id"], "error": True})


if __name__ == "__main__":
    main()
