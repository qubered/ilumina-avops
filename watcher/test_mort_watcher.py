"""
Tests for the MORT watcher planner — the load-bearing, safety-critical logic.
Pure (no network, no live OneDrive): run with `python3 -m unittest`.
"""
import tempfile
import unittest
from pathlib import Path

from mort_watcher import (
    FileSig,
    KnownRow,
    Manifest,
    is_quarantined,
    plan_changes,
    scan_folder,
)


def ck_from(mapping):
    """A checksum_fn backed by a dict; fails loudly if an unexpected path is hashed."""
    def fn(rel):
        if rel not in mapping:
            raise AssertionError(f"unexpected checksum() for {rel}")
        return mapping[rel]
    return fn


class TestPlanner(unittest.TestCase):
    def test_new_file_created(self):
        cs = plan_changes(
            current={"a.docx": FileSig(10, 100)},
            known={},
            baseline=0,
            checksum_fn=ck_from({"a.docx": "CK1"}),
        )
        self.assertEqual(cs.created, ["a.docx"])
        self.assertEqual(cs.checksums["a.docx"], "CK1")
        self.assertFalse(cs.deleted or cs.updated or cs.moved)

    def test_unchanged_no_hash_no_op(self):
        # Same size+mtime → planner must NOT even call checksum_fn.
        def boom(rel):
            raise AssertionError("should not hash an unchanged file")

        cs = plan_changes(
            current={"a.docx": FileSig(10, 100)},
            known={"a.docx": KnownRow(10, 100, "CK1", "active")},
            baseline=1,
            checksum_fn=boom,
        )
        self.assertEqual(cs.created, [])
        self.assertEqual(cs.updated, [])
        self.assertEqual(cs.touched, [])

    def test_content_change_updated(self):
        cs = plan_changes(
            current={"a.docx": FileSig(20, 200)},
            known={"a.docx": KnownRow(10, 100, "CK1", "active")},
            baseline=1,
            checksum_fn=ck_from({"a.docx": "CK2"}),
        )
        self.assertEqual(cs.updated, ["a.docx"])
        self.assertEqual(cs.checksums["a.docx"], "CK2")

    def test_mtime_bump_same_content_is_touch(self):
        cs = plan_changes(
            current={"a.docx": FileSig(10, 999)},  # mtime moved, size same
            known={"a.docx": KnownRow(10, 100, "CK1", "active")},
            baseline=1,
            checksum_fn=ck_from({"a.docx": "CK1"}),  # identical content
        )
        self.assertEqual(cs.touched, ["a.docx"])
        self.assertEqual(cs.updated, [])

    def test_rename_is_move_not_delete_create(self):
        cs = plan_changes(
            current={"new.docx": FileSig(10, 300)},
            known={"old.docx": KnownRow(10, 100, "CK1", "active")},
            baseline=1,
            checksum_fn=ck_from({"new.docx": "CK1"}),  # same checksum as old
        )
        self.assertEqual(cs.moved, [("old.docx", "new.docx")])
        self.assertEqual(cs.created, [])
        self.assertEqual(cs.deleted, [])

    def test_genuine_delete_tombstones(self):
        cs = plan_changes(
            current={"a.docx": FileSig(10, 100)},
            known={
                "a.docx": KnownRow(10, 100, "CK1", "active"),
                "gone.docx": KnownRow(5, 50, "CKX", "active"),
            },
            baseline=2,
            checksum_fn=ck_from({}),
        )
        self.assertEqual(cs.deleted, ["gone.docx"])
        self.assertFalse(cs.halted)

    def test_mass_disappearance_halts_no_deletes(self):
        # baseline 10, only 2 present → sync anomaly → halt, emit nothing.
        known = {f"f{i}.docx": KnownRow(1, i, f"CK{i}", "active") for i in range(10)}
        cs = plan_changes(
            current={"f0.docx": FileSig(1, 0), "f1.docx": FileSig(1, 1)},
            known=known,
            baseline=10,
            checksum_fn=ck_from({}),
        )
        self.assertTrue(cs.halted)
        self.assertEqual(cs.deleted, [])
        self.assertIn("baseline", cs.halt_reason)

    def test_empty_folder_with_baseline_halts(self):
        cs = plan_changes({}, {"a": KnownRow(1, 1, "C", "active")}, baseline=5, checksum_fn=ck_from({}))
        self.assertTrue(cs.halted)

    def test_root_missing_halts(self):
        cs = plan_changes({}, {}, baseline=0, checksum_fn=ck_from({}), root_ok=False)
        self.assertTrue(cs.halted)
        self.assertIn("missing", cs.halt_reason)

    def test_tombstoned_reappears_same_content_resurrects(self):
        cs = plan_changes(
            current={"a.docx": FileSig(10, 100)},
            known={"a.docx": KnownRow(10, 100, "CK1", "tombstoned")},
            baseline=1,
            checksum_fn=ck_from({"a.docx": "CK1"}),
        )
        self.assertEqual(cs.untombstoned, ["a.docx"])
        self.assertEqual(cs.created, [])
        self.assertEqual(cs.updated, [])

    def test_tombstoned_reappears_changed_content_resurrects_and_updates(self):
        cs = plan_changes(
            current={"a.docx": FileSig(20, 200)},
            known={"a.docx": KnownRow(10, 100, "CK1", "tombstoned")},
            baseline=1,
            checksum_fn=ck_from({"a.docx": "CK2"}),
        )
        self.assertEqual(cs.untombstoned, ["a.docx"])
        self.assertEqual(cs.updated, ["a.docx"])


class TestQuarantine(unittest.TestCase):
    def test_quarantine_patterns(self):
        for name in [
            "Report (conflicted copy 2024-01-01).docx",
            "Report-DESKTOP-AB12CD.docx",
            "~$Report.docx",
            ".hidden",
            "download.crdownload",
            "notes.tmp",
        ]:
            self.assertTrue(is_quarantined(name), name)

    def test_normal_files_pass(self):
        for name in ["E2 Camera Patching.docx", "patch-sheet.xlsx", "show.gz", "photo.jpg"]:
            self.assertFalse(is_quarantined(name), name)


class TestScanIntegration(unittest.TestCase):
    def test_scan_and_manifest_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "sub").mkdir()
            (root / "sub" / "a.docx").write_text("hello")
            (root / "Report (conflicted copy).docx").write_text("x")  # quarantined
            scan = scan_folder(root, stable_seconds=0, max_mb=95)
            self.assertIn("sub/a.docx", scan.sigs)
            self.assertNotIn("Report (conflicted copy).docx", scan.sigs)
            self.assertEqual(scan.skipped_quarantine, 1)

            mdb = Manifest(root / ".manifest.sqlite")
            cs = plan_changes(
                scan.sigs, mdb.known(), mdb.baseline(),
                checksum_fn=lambda rel: "CK", root_ok=scan.root_ok,
            )
            self.assertEqual(cs.created, ["sub/a.docx"])
            mdb.upsert("sub/a.docx", scan.sigs["sub/a.docx"], "CK")
            mdb.set_baseline(cs.new_baseline)
            # Second scan: nothing new.
            cs2 = plan_changes(
                scan_folder(root, 0, 95).sigs, mdb.known(), mdb.baseline(),
                checksum_fn=lambda rel: "CK",
            )
            self.assertEqual(cs2.created, [])
            self.assertEqual(cs2.new_baseline, 1)


if __name__ == "__main__":
    unittest.main()
