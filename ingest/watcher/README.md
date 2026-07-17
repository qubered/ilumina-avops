# Folder watcher

Watches a local folder that OneDrive Desktop syncs the SharePoint documentation
into, and sends each file to the ingest server.

Runs anywhere with Python 3.9+ — typically the same Windows box running OneDrive.

## Two watchers

- **`mort_watcher.py`** — the current, state-tracking watcher (MORT v1.1). Use
  this. It leaves files in place, tracks state in a local SQLite manifest, skips
  OneDrive online-only placeholders and conflict copies, detects renames, and
  **fails closed on deletion** (a file missing locally is tombstoned for review,
  never auto-purged — and the delete path halts entirely if the folder looks
  offline). Correct for a **live OneDrive-synced folder**, where moving files
  would sync the move back to the cloud.
- **`folder_watcher.py`** — DEPRECATED. The original mover: it relocates each
  processed file into `_processed\`, which is wrong for a live OneDrive folder
  (it reorganises SharePoint and drops edits into `_processed` where they're
  never re-sent). Kept only for reference; do not deploy against a synced folder.

## Run (Windows)

```bat
pip install -r requirements.txt
```

Edit `run-watcher.bat` (folder / URL / key), then:

```bat
run-watcher.bat --dry-run    :: prints the plan, sends NOTHING — do this first
run-watcher.bat              :: watch continuously
run-watcher.bat --once       :: scan once and exit
```

> **Set the OneDrive folder to "Always keep on this device."** Online-only
> (Files On-Demand) placeholders are skipped by design — reading them would
> force-download or return partial bytes — so an un-hydrated folder ingests
> nothing. If a dry-run reports lots of `ph` skips, that's why.

It scans every few seconds; a file is sent once untouched for a few seconds (so
partial downloads aren't sent early). State lives in a SQLite manifest — the
file→checksum record used to detect changes, renames, and deletions. Re-sending
the same relative path updates its KB article; a rename becomes a single `move`.

**The manifest defaults to a local, non-synced state dir** (`%LOCALAPPDATA%\mort-watcher\`
on Windows, `~/.local/state/mort-watcher/` otherwise), keyed by watch folder, so
it never uploads to OneDrive. Override with `--db` / `MANIFEST_DB` if you want it
elsewhere — but keep it **outside** the synced folder (the watcher warns if you
point it inside one).

- `--once` — scan and exit (e.g. from Task Scheduler).
- `--dry-run` — print the plan, send nothing (no `requests` needed).
- Flags override env vars: `--folder`, `--url`, `--key`, `--db`, `--interval`,
  `--stable-seconds`, `--max-mb`, `--min-fraction` (fail-closed threshold).

**Deletion is fail-closed:** if the watch folder is missing/empty or drops below
`--min-fraction` of a stable baseline (a paused/offline sync), the watcher halts
and sends nothing, rather than mistaking absent files for deletions.

## Tests

```sh
python3 -m unittest test_mort_watcher -v
```

Covers the planner's create/update/move/tombstone logic, fail-closed halts, and
quarantine patterns — no network or live folder needed.

## Run as a background service on Windows

**Task Scheduler** → new task → trigger "At log on" → action
`C:\path\ingest\watcher\run-watcher.bat`. For a periodic sweep instead of a
resident process, use a repeating trigger with the argument `--once`.
