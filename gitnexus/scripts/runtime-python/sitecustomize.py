"""GitNexus runtime activity probe, auto-loaded through PYTHONPATH.

Enabled only when GITNEXUS_RUNTIME_ENABLED=1. Uses sys.setprofile to count
Python function calls in the traced repository and ships compact batches to
GitNexus. Calls are aggregated per sampling window to avoid flooding the UI.
"""

from __future__ import annotations

import atexit
import json
import os
import queue
import sys
import threading
import time
import urllib.request
from pathlib import Path

if os.environ.get("GITNEXUS_RUNTIME_ENABLED") == "1":
    ENDPOINT = os.environ.get("GITNEXUS_RUNTIME_ENDPOINT", "")
    REPO = os.environ.get("GITNEXUS_RUNTIME_REPO", "")
    ROOT_RAW = os.environ.get("GITNEXUS_RUNTIME_ROOT", "")
    DEBUG = os.environ.get("GITNEXUS_RUNTIME_DEBUG") == "1"
    try:
        INTERVAL = max(0.05, min(5.0, int(os.environ.get("GITNEXUS_RUNTIME_INTERVAL_MS", "100")) / 1000.0))
    except ValueError:
        INTERVAL = 0.1

    ROOT = Path(ROOT_RAW).resolve() if ROOT_RAW else None
    STOP = threading.Event()
    LOCK = threading.Lock()
    COUNTS: dict[tuple[str, str, int, int], list[float]] = {}
    STARTS: dict[int, int] = {}

    def _debug(*parts: object) -> None:
        if DEBUG:
            print("[gitnexus python runtime]", *parts, file=sys.stderr)

    def _inside_root(filename: str) -> str | None:
        if ROOT is None or not filename or filename.startswith("<"):
            return None
        try:
            candidate = Path(filename).resolve()
            relative = candidate.relative_to(ROOT)
        except (OSError, ValueError):
            return None
        text = relative.as_posix()
        lowered = f"/{text.lower()}/"
        if any(part in lowered for part in ("/node_modules/", "/.git/", "/.gitnexus/", "/__pycache__/", "/.venv/", "/venv/")):
            return None
        return text

    def _profile(frame, event: str, arg):
        if event not in ("call", "return", "exception"):
            return _profile
        rel = _inside_root(frame.f_code.co_filename)
        if rel is None:
            return _profile

        frame_id = id(frame)
        now_ns = time.perf_counter_ns()
        if event == "call":
            STARTS[frame_id] = now_ns
            key = (rel, frame.f_code.co_name or "<anonymous>", int(frame.f_code.co_firstlineno or 0), threading.get_ident())
            with LOCK:
                row = COUNTS.setdefault(key, [0.0, 0.0])
                row[0] += 1.0
        elif event in ("return", "exception"):
            started = STARTS.pop(frame_id, None)
            if started is not None:
                elapsed_ms = (now_ns - started) / 1_000_000.0
                key = (rel, frame.f_code.co_name or "<anonymous>", int(frame.f_code.co_firstlineno or 0), threading.get_ident())
                with LOCK:
                    row = COUNTS.setdefault(key, [0.0, 0.0])
                    row[1] += elapsed_ms
        return _profile

    def _post(events: list[dict]) -> None:
        if not ENDPOINT or not REPO or not events:
            return
        payload = json.dumps({"repo": REPO, "events": events}, separators=(",", ":")).encode("utf-8")
        request = urllib.request.Request(
            ENDPOINT,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=2.0) as response:
                response.read(1)
        except Exception as exc:  # noqa: BLE001 - debug probe must never crash the app
            _debug("ingest failed:", exc)

    def _drain() -> list[dict]:
        with LOCK:
            items = list(COUNTS.items())
            COUNTS.clear()
        now = int(time.time() * 1000)
        events: list[dict] = []
        for (file_path, function_name, line, thread_id), (calls, total_duration_ms) in items[:500]:
            if calls <= 0:
                continue
            events.append(
                {
                    "ts": now,
                    "runtime": "python",
                    "kind": "function",
                    "pid": os.getpid(),
                    "filePath": file_path,
                    "functionName": function_name,
                    "line": line,
                    "calls": int(calls),
                    "durationMs": total_duration_ms,
                    "threadId": int(thread_id),
                }
            )
        return events

    def _sender() -> None:
        _post(
            [
                {
                    "ts": int(time.time() * 1000),
                    "runtime": "python",
                    "kind": "process-start",
                    "pid": os.getpid(),
                    "detail": " ".join(sys.argv[:8]),
                }
            ]
        )
        while not STOP.wait(INTERVAL):
            _post(_drain())
        _post(_drain())
        _post(
            [
                {
                    "ts": int(time.time() * 1000),
                    "runtime": "python",
                    "kind": "process-exit",
                    "pid": os.getpid(),
                }
            ]
        )

    if ENDPOINT and REPO and ROOT is not None:
        worker = threading.Thread(target=_sender, name="gitnexus-runtime-sender", daemon=True)
        worker.start()
        sys.setprofile(_profile)
        threading.setprofile(_profile)

        def _shutdown() -> None:
            sys.setprofile(None)
            threading.setprofile(None)
            STOP.set()
            worker.join(timeout=0.5)

        atexit.register(_shutdown)
