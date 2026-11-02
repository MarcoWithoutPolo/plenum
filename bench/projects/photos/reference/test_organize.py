import contextlib
import io
import json
import os
import struct
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

import organize


def exif_jpeg(taken: str, order: str = "<") -> bytes:
    """A JPEG header with an Exif APP1 carrying DateTimeOriginal `taken` ("YYYY:MM:DD HH:MM:SS")."""
    tiff = (b"II" if order == "<" else b"MM") + struct.pack(order + "HI", 42, 8)
    tiff += struct.pack(order + "H", 1) + struct.pack(order + "HHII", 0x8769, 4, 1, 26) + b"\0" * 4
    tiff += struct.pack(order + "H", 1) + struct.pack(order + "HHII", 0x9003, 2, 20, 44) + b"\0" * 4
    tiff += taken.encode() + b"\0"
    app1 = b"Exif\0\0" + tiff
    return b"\xff\xd8\xff\xe1" + struct.pack(">H", len(app1) + 2) + app1 + b"\xff\xd9"


class Folder(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def put(self, name: str, data: bytes = b"x", when: datetime = datetime(2020, 1, 2, 3, 4, 5)) -> Path:
        p = self.dir / name
        p.write_bytes(data)
        t = when.timestamp()
        os.utime(p, (t, t))
        return p

    def run_tool(self, *args: str) -> int:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return organize.main([str(self.dir), *args])

    def names(self) -> list[str]:
        return sorted(p.name for p in self.dir.iterdir() if p.is_file())


class ExifTests(Folder):
    def test_reads_both_byte_orders(self):
        for order in "<>":
            p = self.put("a.jpg", exif_jpeg("2019:07:14 16:20:05", order))
            self.assertEqual(organize.exif_date_taken(p), datetime(2019, 7, 14, 16, 20, 5))

    def test_broken_files_have_no_date(self):
        for data in (b"", b"\xff\xd8", b"not a jpeg", exif_jpeg("2019:07:14 16:20:05")[:30]):
            self.assertIsNone(organize.exif_date_taken(self.put("b.jpg", data)))


class OrganizeTests(Folder):
    def test_renames_by_mtime_and_lowercases_the_extension(self):
        self.put("IMG_1.JPG")
        self.assertEqual(self.run_tool(), 0)
        self.assertEqual(self.names(), ["2020-01-02_030405.jpg"])

    def test_exif_date_wins_for_jpegs(self):
        self.put("a.jpeg", exif_jpeg("2019:07:14 16:20:05"))
        self.run_tool()
        self.assertEqual(self.names(), ["2019-07-14_162005.jpeg"])

    def test_collisions_get_numbered(self):
        for n in "abc":
            self.put(f"{n}.png", n.encode())
        self.run_tool()
        self.assertEqual(
            self.names(),
            ["2020-01-02_030405.png", "2020-01-02_030405_2.png", "2020-01-02_030405_3.png"],
        )

    def test_duplicates_keep_the_oldest(self):
        self.put("new.jpg", b"same", datetime(2021, 1, 1))
        self.put("old.jpg", b"same", datetime(2020, 1, 1))
        self.run_tool()
        self.assertEqual(self.names(), ["2020-01-01_000000.jpg"])
        self.assertEqual(os.listdir(self.dir / "duplicates"), ["new.jpg"])

    def test_leaves_other_files_and_subfolders_alone(self):
        self.put("notes.txt")
        (self.dir / "sub").mkdir()
        (self.dir / "sub" / "x.jpg").write_bytes(b"x")
        self.run_tool()
        self.assertEqual(self.names(), ["notes.txt"])
        self.assertEqual(os.listdir(self.dir / "sub"), ["x.jpg"])

    def test_dry_run_and_report(self):
        self.put("a.jpg", b"1")
        self.put("b.jpg", b"1", datetime(2022, 1, 1))
        self.put("c.txt")
        report = self.dir.parent / (self.dir.name + "-report.json")
        try:
            self.run_tool("--dry-run", "--report", str(report))
            self.assertEqual(self.names(), ["a.jpg", "b.jpg", "c.txt"])
            self.assertEqual(
                json.loads(report.read_text()),
                {
                    "renamed": [{"from": "a.jpg", "to": "2020-01-02_030405.jpg"}],
                    "duplicates": [{"file": "b.jpg", "duplicateOf": "a.jpg"}],
                    "skipped": ["c.txt"],
                },
            )
        finally:
            report.unlink(missing_ok=True)

    def test_second_run_changes_nothing(self):
        for n in "abc":
            self.put(f"{n}.jpg", n.encode())
        self.put("d.jpg", b"a")
        self.run_tool()
        before = self.names()
        self.run_tool()
        self.assertEqual(self.names(), before)

    def test_missing_folder_exits_2(self):
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(organize.main([str(self.dir / "nope")]), 2)
        self.assertIn("nope", err.getvalue())


if __name__ == "__main__":
    unittest.main()
