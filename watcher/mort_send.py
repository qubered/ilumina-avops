#!/usr/bin/env python3
"""
Network side of the MORT watcher — kept separate so the planner and its tests
need no `requests` dependency. Sends create/update/move to POST /ingest and
tombstones to POST /ingest/delete.
"""
from __future__ import annotations

import base64
import mimetypes
import time
from pathlib import Path

import requests  # only imported when actually sending

MAX_RETRIES = 4


def _log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}", flush=True)


def _post(url: str, payload: dict, key: str, label: str) -> bool:
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            # Generous: the server may wait out provider rate limits before 202.
            resp = requests.post(url, json=payload, headers=headers, timeout=300)
        except requests.RequestException as e:
            _log(f"RETRY {label} (network: {e}) [{attempt}/{MAX_RETRIES}]")
            time.sleep(min(30, 3 * attempt))
            continue
        if resp.ok:
            _log(f"OK    {label} -> {resp.status_code}")
            return True
        if 400 <= resp.status_code < 500:
            _log(f"FAIL  {label} (HTTP {resp.status_code}: {resp.text[:200]})")
            return False
        _log(f"RETRY {label} (HTTP {resp.status_code}) [{attempt}/{MAX_RETRIES}]")
        time.sleep(min(30, 3 * attempt))
    _log(f"FAIL  {label} (gave up)")
    return False


def send_file(path: Path, rel: str, args, *, op: str = "upsert", old_source_id: str | None = None) -> bool:
    data = path.read_bytes()
    payload = {
        "fileName": path.name,
        "contentType": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        "contentBase64": base64.b64encode(data).decode("ascii"),
        "sourceId": rel,
        "folderPath": (str(Path(rel).parent) if Path(rel).parent != Path(".") else None),
        "op": op,
    }
    if old_source_id:
        payload["oldSourceId"] = old_source_id
    return _post(args.url, payload, args.key, f"{op} {rel}")


def send_delete(rel: str, args) -> bool:
    """Tombstone signal — the server queues review, never auto-purges (v1)."""
    delete_url = args.url.rstrip("/") + "/delete"
    return _post(delete_url, {"sourceId": rel, "op": "tombstone"}, args.key, f"tombstone {rel}")
