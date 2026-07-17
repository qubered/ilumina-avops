@echo off
REM Fill these in, then double-click (or: run-watcher.bat --dry-run).
REM Don't commit this file with a real key in it.

set WATCH_FOLDER=C:\Users\you\OneDrive - Org\Documentation
set INGEST_URL=https://ingest.qubered.com/ingest
set INGEST_API_KEY=replace-me

python "%~dp0mort_watcher.py" %*
pause
