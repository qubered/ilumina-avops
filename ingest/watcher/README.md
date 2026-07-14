# Folder watcher

A no-license alternative to a Power Automate *cloud* HTTP flow. Point **Power
Automate Desktop** at a local folder to download SharePoint documents into it;
this script watches that folder and sends each new file to the ingest server.

Runs anywhere with Python 3.9+ — typically the same Windows box as Power
Automate Desktop.

## Run

```bat
pip install -r requirements.txt

set INGEST_URL=https://ingest.qubered.com/ingest
set INGEST_API_KEY=<your INGEST_API_KEY>
set WATCH_FOLDER=C:\SharePointDownloads
python folder_watcher.py
```

It scans every few seconds; a file is sent once it's been untouched for a few
seconds (so partial downloads aren't sent early). Sent files move to
`_processed\` (mirroring subfolders); failures move to `_failed\`. Re-downloading
the same file updates its existing KB article (the relative path is the id).

- `--once` — process what's there and exit (e.g. from Task Scheduler) instead
  of watching continuously.
- Flags override the env vars: `--folder`, `--url`, `--key`, `--interval`,
  `--stable-seconds`, `--max-mb`.

## Run as a background service on Windows

Simplest: **Task Scheduler** → new task → trigger "At log on" (and/or a repeat
every few minutes with `--once`) → action `python C:\path\folder_watcher.py`.
Set the INGEST_* / WATCH_FOLDER as system environment variables, or pass flags.
