#!/usr/bin/env python3
"""
MORT v1.1 — state-tracking OneDrive watcher.

Replaces the move-based folder_watcher.py. The watch folder IS a live
OneDrive-synced folder, so this watcher:

  * NEVER moves files (a move syncs back to the cloud and reorganises the
    crew's SharePoint) — it tracks state in a local SQLite manifest instead;
  * SKIPS OneDrive Files-On-Demand placeholders (reading their bytes would
    force-download or return corrupt content);
  * QUARANTINES conflict copies / Office locks / partial downloads;
  * FAILS CLOSED on deletion — a file missing locally is tombstoned and sent
    for review, never auto-purged, and the whole delete path halts if the
    folder looks offline / below a stable baseline (a paused sync makes
    present files look deleted);
  * detects RENAME (same checksum, new path) as a single move, not delete+create.

The pure planning logic (`plan_changes`) is separated from filesystem and
network I/O so it is unit-testable. See test_mort_watcher.py.

Config: env vars or CLI flags (flags win) — WATCH_FOLDER, INGEST_URL,
INGEST_API_KEY, plus POLL_INTERVAL, STABLE_SECONDS, MAX_MB, MIN_FRACTION.
Run with --once to scan and exit; omit to keep watching. --dry-run prints the
plan without sending.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sqlite3
import stat
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# What to ignore. The watcher leaves everything in place; these never send.
# ---------------------------------------------------------------------------
SKIP_DIRS = {"_processed", "_failed"}  # legacy dirs from the old mover, if present
SKIP_SUFFIXES = {".tmp", ".temp", ".part", ".crdownload", ".partial", ".laccdb"}
# OneDrive / Office / SharePoint conflict + lock markers → duplicate docs if sent.
QUARANTINE_MARKERS = ("(conflicted copy", "-DESKTOP-", "_conflict-")

# Windows FILE_ATTRIBUTE bits for OneDrive Files-On-Demand placeholders.
FILE_ATTRIBUTE_OFFLINE = 0x1000
FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x40000
FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000
_PLACEHOLDER_MASK = (
    FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS
)


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {msg}", flush=True)


def default_manifest_path(folder: Path) -> Path:
    """A local, NON-synced state dir so the manifest never uploads to OneDrive.
    Keyed by watch folder so multiple watchers don't collide."""
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "state")
    state = Path(base) / "mort-watcher"
    state.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(str(folder).encode()).hexdigest()[:12]
    return state / f"manifest-{key}.sqlite"


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# File classification (filesystem-facing; kept tiny and side-effect-free)
# ---------------------------------------------------------------------------
def is_quarantined(name: str) -> bool:
    lower = name.lower()
    if name.startswith(("~", ".", "~$")):
        return True
    if Path(name).suffix.lower() in SKIP_SUFFIXES:
        return True
    return any(m.lower() in lower for m in QUARANTINE_MARKERS)


def is_placeholder(st: os.stat_result) -> bool:
    """True for a OneDrive online-only placeholder (Windows). Elsewhere False.

    Reading a placeholder's bytes force-downloads it (defeats Files-On-Demand)
    or yields a partial read mid-hydration, so we skip until it's local.
    """
    attrs = getattr(st, "st_file_attributes", 0)  # Windows only
    return bool(attrs & _PLACEHOLDER_MASK)


def hydrate_file(path: Path) -> bool:
    """
    Pull an online-only (Files-On-Demand) file down from OneDrive.

    Touching a placeholder's data triggers a full recall; the read blocks until
    the whole file has landed, so afterwards the bytes are complete — never a
    partial mid-hydration read. Returns False if it couldn't be downloaded
    (OneDrive paused/offline), so the caller can leave it for the next scan.
    """
    try:
        with path.open("rb") as f:
            f.read(1)  # first byte triggers the recall of the entire file
        return not is_placeholder(path.stat())
    except OSError as e:
        log(f"HYDRATE-FAIL {path.name}: {e}")
        return False


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class FileSig:
    """Cheap signature gathered without hashing."""
    size: int
    mtime_ns: int


@dataclass(frozen=True)
class KnownRow:
    size: int
    mtime_ns: int
    checksum: str
    status: str  # 'active' | 'tombstoned'


@dataclass
class ChangeSet:
    created: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    moved: list[tuple[str, str]] = field(default_factory=list)   # (old_rel, new_rel)
    deleted: list[str] = field(default_factory=list)             # tombstones (review, not purge)
    untombstoned: list[str] = field(default_factory=list)        # a "deleted" file came back
    touched: list[str] = field(default_factory=list)             # mtime moved, content identical
    checksums: dict[str, str] = field(default_factory=dict)      # rel_path -> new checksum
    halted: bool = False
    halt_reason: str = ""
    new_baseline: int = 0


# ---------------------------------------------------------------------------
# Pure planner — the heart of the watcher, fully unit-testable.
# ---------------------------------------------------------------------------
def plan_changes(
    current: dict[str, FileSig],
    known: dict[str, KnownRow],
    baseline: int,
    checksum_fn,
    *,
    min_fraction: float = 0.5,
    root_ok: bool = True,
) -> ChangeSet:
    """Diff the live folder (`current`, hydrated candidates only) against the
    manifest (`known`). `checksum_fn(rel_path)->str` is called only for new /
    content-changed / reappeared paths. Deletions are gated FAIL-CLOSED.
    """
    cs = ChangeSet()

    # --- Fail-closed gate: refuse to act on a folder that looks offline. ---
    present = len(current)
    if not root_ok:
        cs.halted, cs.halt_reason = True, "watch folder missing / not a directory"
        return cs
    if baseline > 0 and present == 0:
        cs.halted, cs.halt_reason = True, f"folder empty but baseline is {baseline} (sync offline?)"
        return cs
    if baseline > 0 and present < baseline * min_fraction:
        cs.halted, cs.halt_reason = (
            True,
            f"only {present} files vs baseline {baseline} (< {min_fraction:.0%}) — sync anomaly, halting",
        )
        return cs

    active = {p: r for p, r in known.items() if r.status == "active"}
    tombstoned = {p: r for p, r in known.items() if r.status == "tombstoned"}

    cur_paths = set(current)
    new_paths = cur_paths - set(known)
    both = cur_paths & set(active)
    missing = set(active) - cur_paths  # delete candidates

    # A previously-tombstoned path reappearing = a false-alarm delete; resurrect.
    for p in cur_paths & set(tombstoned):
        c = checksum_fn(p)
        cs.checksums[p] = c
        cs.untombstoned.append(p)
        if c != tombstoned[p].checksum:
            cs.updated.append(p)

    # Present in both: compare cheap sig, hash only when it moved.
    for p in both:
        row = active[p]
        sig = current[p]
        if sig.size == row.size and sig.mtime_ns == row.mtime_ns:
            continue  # unchanged, no hash
        c = checksum_fn(p)
        if c != row.checksum:
            cs.updated.append(p)
            cs.checksums[p] = c
        else:
            cs.touched.append(p)  # mtime bumped, content identical

    # Rename detection: a missing path whose checksum matches a new path.
    missing_by_ck = {active[p].checksum: p for p in missing}
    for np in sorted(new_paths):
        c = checksum_fn(np)
        cs.checksums[np] = c
        old = missing_by_ck.pop(c, None)
        if old is not None:
            cs.moved.append((old, np))
            missing.discard(old)
        else:
            cs.created.append(np)

    # Whatever is still missing is a genuine local disappearance → tombstone.
    cs.deleted.extend(sorted(missing))

    cs.new_baseline = max(baseline, present)
    return cs


# ---------------------------------------------------------------------------
# SQLite manifest
# ---------------------------------------------------------------------------
class Manifest:
    def __init__(self, db_path: Path):
        self.db = sqlite3.connect(str(db_path))
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS files (
                 rel_path TEXT PRIMARY KEY,
                 size INTEGER, mtime_ns INTEGER, checksum TEXT,
                 status TEXT NOT NULL DEFAULT 'active',
                 last_sent_at REAL
               )"""
        )
        self.db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
        self.db.commit()

    def known(self) -> dict[str, KnownRow]:
        rows = self.db.execute("SELECT rel_path, size, mtime_ns, checksum, status FROM files").fetchall()
        return {r[0]: KnownRow(r[1], r[2], r[3], r[4]) for r in rows}

    def baseline(self) -> int:
        r = self.db.execute("SELECT value FROM meta WHERE key='baseline'").fetchone()
        return int(r[0]) if r else 0

    def set_baseline(self, n: int) -> None:
        self.db.execute(
            "INSERT INTO meta(key,value) VALUES('baseline',?) ON CONFLICT(key) DO UPDATE SET value=?",
            (str(n), str(n)),
        )
        self.db.commit()

    def upsert(self, rel: str, sig: FileSig, checksum: str, status: str = "active") -> None:
        self.db.execute(
            """INSERT INTO files(rel_path,size,mtime_ns,checksum,status,last_sent_at)
               VALUES(?,?,?,?,?,?)
               ON CONFLICT(rel_path) DO UPDATE SET
                 size=excluded.size, mtime_ns=excluded.mtime_ns, checksum=excluded.checksum,
                 status=excluded.status, last_sent_at=excluded.last_sent_at""",
            (rel, sig.size, sig.mtime_ns, checksum, status, time.time()),
        )
        self.db.commit()

    def rename(self, old: str, new: str, sig: FileSig, checksum: str) -> None:
        self.db.execute("DELETE FROM files WHERE rel_path=?", (old,))
        self.upsert(new, sig, checksum)

    def set_status(self, rel: str, status: str) -> None:
        self.db.execute("UPDATE files SET status=? WHERE rel_path=?", (status, rel))
        self.db.commit()


# ---------------------------------------------------------------------------
# Filesystem scan
# ---------------------------------------------------------------------------
@dataclass
class Scan:
    sigs: dict[str, FileSig]
    root_ok: bool
    seen: int = 0
    #: Cloud-only files. Still eligible — their size/mtime read fine without a
    #: download, so we only pull the bytes when Mort actually needs them.
    placeholders: set[str] = field(default_factory=set)
    skipped_placeholders: int = 0
    skipped_quarantine: int = 0
    skipped_settling: int = 0
    skipped_empty: int = 0
    skipped_large: int = 0
    errors: int = 0
    first_error: str = ""

    def summary(self) -> str:
        """Why the eligible count is what it is — silence is a terrible diagnostic."""
        bits = [f"{len(self.sigs)} eligible of {self.seen} file(s)"]
        if self.placeholders:
            bits.append(f"{len(self.placeholders)} online-only")
        if self.skipped_placeholders:
            bits.append(f"{self.skipped_placeholders} online-only, skipped (--no-hydrate)")
        if self.skipped_quarantine:
            bits.append(f"{self.skipped_quarantine} quarantined (conflict/lock/temp)")
        if self.skipped_settling:
            bits.append(f"{self.skipped_settling} still settling")
        if self.skipped_empty:
            bits.append(f"{self.skipped_empty} empty")
        if self.skipped_large:
            bits.append(f"{self.skipped_large} too big")
        if self.errors:
            bits.append(f"{self.errors} unreadable ({self.first_error})")
        return " · ".join(bits)


def scan_folder(root: Path, stable_seconds: float, max_mb: float) -> Scan:
    """Gather cheap signatures for eligible, hydrated, stable files."""
    if not root.is_dir():
        return Scan(sigs={}, root_ok=False)
    scan = Scan(sigs={}, root_ok=True)
    now = time.time()
    for path in root.rglob("*"):
        try:
            if not path.is_file():
                continue
            rel_parts = path.relative_to(root).parts
            if any(part in SKIP_DIRS for part in rel_parts):
                continue
            scan.seen += 1
            if is_quarantined(path.name):
                scan.skipped_quarantine += 1
                continue
            st = path.stat()
            rel = path.relative_to(root).as_posix()
            # A placeholder still reports its real size + mtime, so it can be
            # signature-compared without downloading anything. Note it and move on;
            # run_once pulls the bytes only if this file actually needs sending.
            if is_placeholder(st):
                scan.placeholders.add(rel)
            if st.st_size == 0:
                scan.skipped_empty += 1
                continue
            # Stability: no writes in the last `stable_seconds` (download settled).
            if (now - st.st_mtime) < stable_seconds:
                scan.skipped_settling += 1
                continue
            if st.st_size / 1_048_576 > max_mb:
                scan.skipped_large += 1
                log(f"SKIP  {rel} (> {max_mb} MB)")
                continue
            scan.sigs[rel] = FileSig(st.st_size, st.st_mtime_ns)
        except (FileNotFoundError, PermissionError, OSError) as e:
            # Don't swallow these silently — an unreadable folder looks identical
            # to an empty one otherwise.
            scan.errors += 1
            if not scan.first_error:
                scan.first_error = f"{type(e).__name__}: {e}"
            continue
    return scan


def config() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="MORT state-tracking OneDrive watcher.")
    p.add_argument("--folder", default=os.environ.get("WATCH_FOLDER"))
    p.add_argument("--url", default=os.environ.get("INGEST_URL"))
    p.add_argument("--key", default=os.environ.get("INGEST_API_KEY"))
    p.add_argument("--db", default=os.environ.get("MANIFEST_DB"),
                   help="manifest DB path (default: a local non-synced state dir, off OneDrive)")
    p.add_argument("--interval", type=float, default=float(os.environ.get("POLL_INTERVAL", "5")))
    p.add_argument("--stable-seconds", type=float, default=float(os.environ.get("STABLE_SECONDS", "5")))
    p.add_argument("--max-mb", type=float, default=float(os.environ.get("MAX_MB", "95")))
    p.add_argument("--min-fraction", type=float, default=float(os.environ.get("MIN_FRACTION", "0.5")))
    p.add_argument("--once", action="store_true")
    p.add_argument("--dry-run", action="store_true", help="print the plan, send nothing")
    # OneDrive Files-On-Demand: download a cloud-only file when (and only when)
    # Mort needs its bytes. Without this the watcher can't read them at all.
    p.add_argument(
        "--hydrate",
        dest="hydrate",
        action="store_true",
        default=os.environ.get("HYDRATE", "1").lower() not in ("0", "false", "no"),
        help="download online-only files on demand (default)",
    )
    p.add_argument(
        "--no-hydrate",
        dest="hydrate",
        action="store_false",
        help="skip online-only files instead of downloading them",
    )
    args = p.parse_args()
    missing = [n for n, v in (("--folder", args.folder), ("--url", args.url), ("--key", args.key)) if not v]
    if missing and not args.dry_run:
        p.error("missing required config: " + ", ".join(missing))
    return args


_reported_scan = False


def _needs_bytes(rel: str, sig: FileSig, known: dict[str, KnownRow]) -> bool:
    """True if we'd have to read this file's content — new, changed, or returning
    from a tombstone. Unchanged files are settled by (size, mtime) alone."""
    row = known.get(rel)
    return row is None or row.status == "tombstoned" or row.size != sig.size or row.mtime_ns != sig.mtime_ns


def run_once(root: Path, manifest: Manifest, args: argparse.Namespace) -> ChangeSet:
    global _reported_scan
    scan = scan_folder(root, args.stable_seconds, args.max_mb)
    current = scan.sigs

    # Report what the scan saw: on the first pass, on --once/--dry-run, and any
    # time nothing is eligible (the case that's otherwise silent and baffling).
    if not _reported_scan or args.once or args.dry_run or not current:
        log(f"scan: {scan.summary()}")
        _reported_scan = True

    known = manifest.known()

    # --- On-demand hydration -------------------------------------------------
    # OneDrive Files-On-Demand leaves files in the cloud. Their size + mtime read
    # fine without downloading, so pull the bytes ONLY for the files Mort actually
    # needs to read (new / changed / returning). Anything already ingested and
    # unchanged stays in the cloud — so this can't become a re-download loop.
    def defer(rel: str) -> None:
        """
        Leave a file exactly as the manifest already has it: don't send it, and
        crucially don't let it look DELETED. A file we can't read is unknown, not
        gone — otherwise a paused OneDrive would tombstone real KB docs.
        """
        row = known.get(rel)
        if row is not None and row.status == "active":
            current[rel] = FileSig(row.size, row.mtime_ns)  # reads as unchanged → no-op
        else:
            current.pop(rel, None)  # never ingested and unreadable → just ignore it

    if scan.placeholders:
        if not args.hydrate:
            for rel in list(scan.placeholders):
                defer(rel)
            scan.skipped_placeholders = len(scan.placeholders)
        elif not args.dry_run:
            need = [r for r in sorted(scan.placeholders) if r in current and _needs_bytes(r, current[r], known)]
            if need:
                log(f"hydrating {len(need)} online-only file(s) from OneDrive — this downloads them")
                for rel in need:
                    if not hydrate_file(root / rel):
                        defer(rel)  # still cloud-only; retry next scan, don't call it deleted

    def checksum(rel: str) -> str:
        # A dry run must never trigger a download, so cloud-only files get a
        # sentinel instead of a real hash (they still report as CREATE).
        if args.dry_run and rel in scan.placeholders:
            return f"cloud-not-downloaded:{rel}"
        return sha256(root / rel)

    cs = plan_changes(
        current,
        known,
        manifest.baseline(),
        checksum_fn=checksum,
        min_fraction=args.min_fraction,
        root_ok=scan.root_ok,
    )
    if cs.halted:
        log(f"HALT  {cs.halt_reason} — no changes sent (fail-closed).")
        return cs

    ops = (
        len(cs.created) + len(cs.updated) + len(cs.moved) + len(cs.deleted) + len(cs.untombstoned)
    )
    if ops:
        log(
            f"plan: +{len(cs.created)} ~{len(cs.updated)} mv{len(cs.moved)} "
            f"tomb{len(cs.deleted)} back{len(cs.untombstoned)}"
        )
    elif current:
        # Eligible files, but nothing to do — they're already sent (unchanged).
        log(f"nothing to do — {len(current)} file(s) already up to date")
    if args.dry_run:
        for p in cs.created: log(f"  CREATE {p}")
        for p in cs.updated: log(f"  UPDATE {p}")
        for o, n in cs.moved: log(f"  MOVE   {o} -> {n}")
        for p in cs.deleted: log(f"  TOMB   {p} (review)")
        for p in cs.untombstoned: log(f"  BACK   {p}")
        return cs

    # Send + persist. Network send is imported lazily so tests/dry-run need no deps.
    from mort_send import send_delete, send_file  # noqa: WPS433 (local import by design)

    for rel in cs.created + cs.updated:
        sig = current[rel]
        if send_file(root / rel, rel, args, op="upsert"):
            manifest.upsert(rel, sig, cs.checksums.get(rel) or sha256(root / rel))
    for old, new in cs.moved:
        if send_file(root / new, new, args, op="move", old_source_id=old):
            manifest.rename(old, new, current[new], cs.checksums[new])
    for rel in cs.untombstoned:
        manifest.set_status(rel, "active")
    for rel in cs.deleted:
        if send_delete(rel, args):  # server queues review; we tombstone locally
            manifest.set_status(rel, "tombstoned")

    manifest.set_baseline(cs.new_baseline)
    return cs


def main() -> int:
    args = config()
    root = Path(args.folder).expanduser().resolve() if args.folder else Path.cwd()
    db_path = Path(args.db).expanduser().resolve() if args.db else default_manifest_path(root)
    if _is_within(db_path, root):
        log(
            f"WARNING: manifest {db_path} is inside the watch folder — it will sync to "
            f"OneDrive. Set --db / MANIFEST_DB to a path outside the synced folder."
        )
    manifest = Manifest(db_path)
    log(f"Watching {root} (manifest {db_path}){' [dry-run]' if args.dry_run else ''}")
    if args.once or args.dry_run:
        run_once(root, manifest, args)
        return 0
    try:
        while True:
            run_once(root, manifest, args)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log("Stopped.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
