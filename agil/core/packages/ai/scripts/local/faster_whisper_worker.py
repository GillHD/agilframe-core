#!/usr/bin/env python3
"""faster-whisper worker for AgilFrame local STT (newline-delimited JSON).

Started lazily by `@agil/ai` `FasterWhisperEngine` only when a transcription
request arrives. The model is loaded on the first request and stays in memory,
so consecutive caption chunks do not pay the load cost again.

Protocol:
  stdout line 1: {"ready": true, "engine": "faster-whisper", "model": "..."}
  request:      {"id": 1, "audio": "/tmp/x.wav", "language": "ru|null",
                 "offsetSec": 0, "prompt": ""}
  response:     {"id": 1, "ok": true, "language": "ru", "durationSec": 4.2,
                 "segments": [{"start": 0.0, "end": 1.4, "text": "..."}]}

Install (NOT bundled):
  python -m pip install faster-whisper

This file contains no model weights; see scripts/local/download-models.mjs.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys

logging.basicConfig(level=logging.WARNING, stream=sys.stderr)


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def transcribe(model, audio, language=None, offset=0.0, prompt=None) -> dict:
    segments, info = model.transcribe(
        audio,
        language=language,
        task="transcribe",
        beam_size=int(os.environ.get("FASTER_WHISPER_BEAM", "1")),
        vad_filter=False,
        condition_on_previous_text=False,
        initial_prompt=prompt,
    )
    output = []
    for segment in segments:
        text = (segment.text or "").strip()
        if text:
            output.append({
                "start": round(float(segment.start) + offset, 3),
                "end": round(float(segment.end) + offset, 3),
                "text": text,
            })
    return {
        "language": getattr(info, "language", None),
        "durationSec": float(getattr(info, "duration", 0.0) or 0.0),
        "segments": output,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda", "auto"])
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument(
        "--local-files-only",
        action="store_true",
        help="Never contact HuggingFace: load only already-downloaded weights.",
    )
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel  # noqa: F401
    except Exception as error:  # pragma: no cover - environment dependent
        emit({"ready": False, "error": f"faster_whisper import failed: {error}"})
        return 1

    model_holder = {"model": None}

    def get_model():
        if model_holder["model"] is None:
            device = args.device
            if device == "auto":
                try:
                    import torch

                    device = "cuda" if torch.cuda.is_available() else "cpu"
                except Exception:
                    device = "cpu"
            model_holder["model"] = WhisperModel(
                args.model,
                device=device,
                compute_type=args.compute_type,
                local_files_only=args.local_files_only,
            )
        return model_holder["model"]

    emit(
        {
            "ready": True,
            "engine": "faster-whisper",
            "model": args.model,
            "device": args.device,
            "localFilesOnly": args.local_files_only,
        }
    )

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            audio = request.get("audio")
            if not audio or not os.path.isfile(audio):
                raise ValueError("audio file is missing")
            language = request.get("language") or None
            offset = float(request.get("offsetSec") or 0)
            prompt = (request.get("prompt") or "").strip() or None
            emit({"id": request_id, "ok": True, **transcribe(get_model(), audio, language, offset, prompt)})
        except Exception as error:  # noqa: BLE001 - report every failure to the adapter
            emit({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
