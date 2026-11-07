#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
speakd.py —— 常驻的 MOSS-TTS-Nano 语音合成服务（模型只加载一次）。

由 dsh-feiyu-voice 插件按需拉起，也可以手动运行：

    <ttsHome>\\venv\\Scripts\\python(w).exe speakd.py --tts-home <ttsHome> [--port 18084]

依赖 <ttsHome> 里已经装好的环境：
    venv/                      Python 环境（torch / onnxruntime / sentencepiece / soundfile）
    _src/MOSS-TTS-Nano-main/   MOSS-TTS-Nano 源码，models/ 里是 ONNX 权重

接口：
    GET  /health   → {"ok":true,"busy":false}
    POST /say      → {"text":"...","ref":"<wav 路径或 refs 下的名字>","max_frames":375}
                     返回 audio/wav（X-Elapsed / X-Duration）
    POST /shutdown → 关闭
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_lock = threading.Lock()
_runtime = None
_busy = False
_tts_home: Path | None = None
_out_dir: Path | None = None


def resolve_ref(value: str) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("ref 不能为空（传 wav 路径或 refs 目录下的名字）")
    p = Path(raw).expanduser()
    if p.is_file():
        return p
    if _tts_home is not None:
        candidate = _tts_home / "refs" / (raw if raw.lower().endswith(".wav") else raw + ".wav")
        if candidate.is_file():
            return candidate
    raise ValueError(f"参考音频不存在：{raw}")


def load_runtime(repo: Path, threads: int, max_frames: int):
    sys.path.insert(0, str(repo))
    from onnx_tts_runtime import OnnxTtsRuntime  # noqa: PLC0415

    return OnnxTtsRuntime(
        model_dir=None,
        thread_count=threads,
        max_new_frames=max_frames,
        do_sample=True,
        sample_mode="fixed",
        execution_provider="cpu",
    )


def synthesize(text: str, ref: str, max_frames: int | None, seed: int | None):
    global _busy
    if not text.strip():
        raise ValueError("text 不能为空")
    ref_path = resolve_ref(ref)
    out = Path(_out_dir) / f"say-{int(time.time() * 1000)}.wav"
    with _lock:
        _busy = True
        started = time.time()
        try:
            _runtime.synthesize(
                text=text,
                voice="",
                prompt_audio_path=str(ref_path),
                output_audio_path=str(out),
                sample_mode="fixed",
                do_sample=True,
                streaming=True,
                max_new_frames=int(max_frames or 375),
                voice_clone_max_text_tokens=75,
                enable_wetext=False,
                enable_normalize_tts_text=True,
                seed=seed,
            )
            elapsed = time.time() - started
        finally:
            _busy = False
    if not out.is_file():
        raise RuntimeError("合成没有产出文件")
    data = out.read_bytes()
    duration = 0.0
    try:
        import soundfile as sf

        duration = float(sf.info(str(out)).duration)
    except Exception:
        pass
    try:
        out.unlink()
    except OSError:
        pass
    return data, elapsed, duration


class Handler(BaseHTTPRequestHandler):
    server_version = "feiyu-speakd/1.0"

    def log_message(self, fmt, *args):
        if args and str(args[0]).startswith(("4", "5")):
            logging.warning("%s - %s", self.address_string(), fmt % args)

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": _runtime is not None, "busy": _busy, "ttsHome": str(_tts_home)})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 1_000_000:
            self._json(413, {"error": "payload too large"})
            return
        raw = self.rfile.read(length) if length else b""
        if self.path == "/shutdown":
            self._json(200, {"ok": True})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path != "/say":
            self._json(404, {"error": "not found"})
            return
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._json(400, {"error": "invalid json"})
            return
        try:
            data, elapsed, duration = synthesize(
                str(payload.get("text") or ""),
                str(payload.get("ref") or ""),
                payload.get("max_frames"),
                payload.get("seed"),
            )
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001
            logging.error("synthesize failed: %s\n%s", exc, traceback.format_exc(limit=3))
            self._json(500, {"error": str(exc)})
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Elapsed", f"{elapsed:.2f}")
        self.send_header("X-Duration", f"{duration:.2f}")
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    global _runtime, _tts_home, _out_dir
    ap = argparse.ArgumentParser(description="常驻 MOSS-TTS-Nano 合成服务")
    ap.add_argument("--tts-home", default=os.environ.get("DSH_FEIYU_TTS_HOME", str(Path.home() / ".dsh" / "tts")))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=18084)
    ap.add_argument("--threads", type=int, default=max(1, os.cpu_count() or 2))
    ap.add_argument("--max-frames", type=int, default=375)
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    _tts_home = Path(args.tts_home).expanduser().resolve()
    _out_dir = _tts_home / "out"
    _out_dir.mkdir(parents=True, exist_ok=True)
    repo = _tts_home / "_src" / "MOSS-TTS-Nano-main"
    if not (repo / "infer_onnx.py").is_file():
        logging.error("找不到 MOSS-TTS-Nano 源码：%s", repo)
        return 1

    logging.info("正在加载 ONNX 模型（首次约 20–60 秒）…")
    t0 = time.time()
    try:
        _runtime = load_runtime(repo, args.threads, args.max_frames)
    except Exception:
        logging.exception("模型加载失败")
        return 1
    logging.info("模型就绪，用时 %.1fs；监听 http://%s:%d（ttsHome=%s）", time.time() - t0, args.host, args.port, _tts_home)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        logging.info("已停止")
    return 0


if __name__ == "__main__":
    sys.exit(main())
