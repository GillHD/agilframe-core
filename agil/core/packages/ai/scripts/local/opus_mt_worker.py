#!/usr/bin/env python3
"""OPUS-MT / MarianMT translation worker for AgilFrame (JSON lines).

Started lazily by `@agil/ai` `OpusMtTranslator` only when translation is enabled.
Models are loaded per direction on first use and kept in memory.

Protocol:
  stdout line 1: {"ready": true, "engine": "opus-mt", "modelDir": "..."}
  request:      {"id": 1, "text": "hello", "source": "en", "target": "ru"}
  response:     {"id": 1, "ok": true, "translation": "привет"}

Model layouts:
  --model-dir models/opus-mt   -> ru-en/ and en-ru/ HuggingFace snapshots

Install (NOT bundled):
  python -m pip install torch transformers sentencepiece sacremoses

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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", default="opus-mt", choices=["opus-mt", "marian"])
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda", "auto"])
    args = parser.parse_args()

    try:
        import torch
        from transformers import MarianMTModel, MarianTokenizer
    except Exception as error:  # pragma: no cover - environment dependent
        emit({"ready": False, "error": f"transformers/torch import failed: {error}"})
        return 1

    device = args.device
    if device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda" and not torch.cuda.is_available():
        device = "cpu"

    cache: dict[str, tuple[object, object]] = {}

    def load_pair(source: str, target: str):
        key = f"{source}-{target}"
        if key in cache:
            return cache[key]
        directory = os.path.join(args.model_dir, key)
        if not os.path.isdir(directory):
            raise FileNotFoundError(f"missing model directory: {key}")
        with open(os.path.join(directory, "config.json"), encoding="utf-8") as config:
            if json.load(config).get("model_type") != "marian":
                raise ValueError(f"{key} requires a local Marian/OPUS-MT model")
        tokenizer = MarianTokenizer.from_pretrained(directory, local_files_only=True)
        model = MarianMTModel.from_pretrained(directory, local_files_only=True)
        model.to(device)
        model.eval()
        cache[key] = (tokenizer, model)
        return tokenizer, model

    def translate(text: str, source: str, target: str) -> str:
        tokenizer, model = load_pair(source, target)
        encoded = tokenizer([text], return_tensors="pt", padding=True, truncation=True).to(device)
        with torch.inference_mode():
            generated = model.generate(
                **encoded,
                max_length=max(64, min(512, len(text.split()) * 4 + 32)),
                num_beams=1,
            )
        return tokenizer.batch_decode(generated, skip_special_tokens=True)[0].strip()

    emit(
        {
            "ready": True,
            "engine": args.engine,
            "modelDir": args.model_dir,
            "device": device,
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
            text = (request.get("text") or "").strip()
            if not text:
                emit({"id": request_id, "ok": True, "translation": ""})
                continue
            source = request.get("source") or "en"
            target = request.get("target") or "ru"
            if source == target:
                emit({"id": request_id, "ok": True, "translation": text})
                continue
            translation = translate(text, source, target)
            emit({"id": request_id, "ok": True, "translation": translation})
        except Exception as error:  # noqa: BLE001 - report every failure to the adapter
            emit({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
