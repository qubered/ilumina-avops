#!/usr/bin/env python3
"""
DEPRECATED — do not run this. Use `mort_watcher.py` (see run-watcher.bat).

This version MOVES each processed file into `_processed/`. Against a live
OneDrive-synced folder that is destructive: the move syncs back to the cloud and
reorganises the crew's SharePoint, and any edited file lands in `_processed/`
where this script skips it — so edits and deletions are never re-sent. Kept for
reference only; the instructions below are historical.

Watch a folder and send new files to the ILUMINA ingest server.

Power Automate Desktop downloads SharePoint documents into a folder; this
script notices each new file, base64-encodes it, and POSTs it to the ingest
endpoint (which AI-normalises it into an Outline KB article). Processed files
move to `_processed/`, failures to `_failed/`, so nothing is sent twice.

Setup (historical — see mort_watcher.py instead):
    pip install requests
    set INGEST_URL=https://ilumina-ingest.qubered.com/ingest
    set INGEST_API_KEY=<your INGEST_API_KEY>
    set WATCH_FOLDER=C:\\SharePointDownloads
    python folder_watcher.py

Config can be environment variables or CLI flags (flags win). Run with --once
to process what's there and exit (e.g. from Task Scheduler); omit it to keep
watching.
"""
from __future__ import annotations

import argparse
import base64
import mimetypes
import os
import shutil
import sys
import time
from pathlib import Path

import requests

PROCESSED_DIR = "_processed"
FAILED_DIR = "_failed"
SKIP_DIRS = {PROCESSED_DIR, FAILED_DIR}
# Partial-download markers PAD / browsers use while still writing a file.
SKIP_SUFFIXES = {".tmp", ".temp", ".part", ".crdownload", ".partial"}
MAX_RETRIES = 4


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}", flush=True)


def config() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Watch a folder and send files to the ingest server.")
    p.add_argument("--folder", default=os.environ.get("WATCH_FOLDER"), help="Folder to watch")
    p.add_argument("--url", default=os.environ.get("INGEST_URL"), help="Ingest endpoint, e.g. https://ingest.example/ingest")
    p.add_argument("--key", default=os.environ.get("INGEST_API_KEY"), help="INGEST_API_KEY bearer token")
    p.add_argument("--interval", type=float, default=float(os.environ.get("POLL_INTERVAL", "5")), help="Seconds between scans")
    p.add_argument("--stable-seconds", type=float, default=float(os.environ.get("STABLE_SECONDS", "5")), help="A file must be untouched this long before sending")
    p.add_argument("--max-mb", type=float, default=float(os.environ.get("MAX_MB", "95")), help="Skip files larger than this (stay under the ~100 MB tunnel/Outline ceiling)")
    p.add_argument("--once", action="store_true", help="Process current files and exit")
    args = p.parse_args()
    missing = [n for n, v in (("--folder/WATCH_FOLDER", args.folder), ("--url/INGEST_URL", args.url), ("--key/INGEST_API_KEY", args.key)) if not v]
    if missing:
        p.error("missing required config: " + ", ".join(missing))
    return args


def candidates(root: Path):
    """Files eligible to send: not in the processed/failed dirs, not partial/hidden."""
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.relative_to(root).parts):
            continue
        name = path.name
        if name.startswith(("~", ".")) or path.suffix.lower() in SKIP_SUFFIXES:
            continue
        yield path


def is_stable(path: Path, stable_seconds: float) -> bool:
    """No writes in the last `stable_seconds` — i.e. the download has finished."""
    try:
        st = path.stat()
    except FileNotFoundError:
        return False
    return st.st_size > 0 and (time.time() - st.st_mtime) >= stable_seconds


def move_into(path: Path, root: Path, subdir: str) -> None:
    rel = path.relative_to(root)
    dest = root / subdir / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest = dest.with_name(f"{dest.stem}-{int(time.time())}{dest.suffix}")
    shutil.move(str(path), str(dest))


def send(path: Path, root: Path, args: argparse.Namespace) -> bool:
    rel = path.relative_to(root).as_posix()
    size_mb = path.stat().st_size / 1_048_576
    if size_mb > args.max_mb:
        log(f"SKIP  {rel} ({size_mb:.1f} MB > {args.max_mb} MB limit)")
        move_into(path, root, FAILED_DIR)
        return False

    data = path.read_bytes()
    payload = {
        "fileName": path.name,
        "contentType": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        "contentBase64": base64.b64encode(data).decode("ascii"),
        # Relative path is a stable id per document, so re-downloads update the
        # existing article instead of creating duplicates.
        "sourceId": rel,
        "folderPath": path.parent.relative_to(root).as_posix() or None,
    }
    headers = {"Authorization": f"Bearer {args.key}", "Content-Type": "application/json"}

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            # Generous timeout: the server may wait out provider rate limits.
            resp = requests.post(args.url, json=payload, headers=headers, timeout=300)
        except requests.RequestException as e:
            log(f"RETRY {rel} (network error: {e}) [{attempt}/{MAX_RETRIES}]")
            time.sleep(min(30, 3 * attempt))
            continue

        if resp.ok:
            action = _action(resp)
            log(f"OK    {rel} -> {action}")
            move_into(path, root, PROCESSED_DIR)
            return True
        if 400 <= resp.status_code < 500:
            log(f"FAIL  {rel} (HTTP {resp.status_code}: {resp.text[:200]})")
            move_into(path, root, FAILED_DIR)
            return False
        # 5xx — server-side, worth retrying.
        log(f"RETRY {rel} (HTTP {resp.status_code}) [{attempt}/{MAX_RETRIES}]")
        time.sleep(min(30, 3 * attempt))

    log(f"FAIL  {rel} (gave up after {MAX_RETRIES} attempts)")
    move_into(path, root, FAILED_DIR)
    return False


def _action(resp: requests.Response) -> str:
    try:
        return resp.json().get("action", "sent")
    except ValueError:
        return "sent"


def scan(root: Path, args: argparse.Namespace) -> int:
    sent = 0
    for path in candidates(root):
        if is_stable(path, args.stable_seconds):
            if send(path, root, args):
                sent += 1
    return sent


def main() -> int:
    args = config()
    root = Path(args.folder).expanduser().resolve()
    if not root.is_dir():
        log(f"Watch folder does not exist: {root}")
        return 1

    log(f"Watching {root} -> {args.url}")
    if args.once:
        scan(root, args)
        return 0

    try:
        while True:
            scan(root, args)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log("Stopped.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
