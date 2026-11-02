"""Tidy a folder of photos: move exact duplicates aside and name every photo by the date it was taken.

    python organize.py <folder> [--dry-run] [--report <file.json>]

Standard library only (Python 3.10+).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic"}
JPEG_EXTENSIONS = {".jpg", ".jpeg"}
DUPLICATES_DIR = "duplicates"
NAME_FORMAT = "%Y-%m-%d_%H%M%S"
TAG_EXIF_IFD = 0x8769
TAG_DATETIME_ORIGINAL = 0x9003


# --- EXIF ------------------------------------------------------------------------------------------


def exif_date_taken(path: Path) -> datetime | None:
    """DateTimeOriginal from a JPEG's EXIF, or None when it has none or it can't be read."""
    try:
        with path.open("rb") as f:
            tiff = _find_exif_tiff(f)
        return _date_time_original(tiff) if tiff else None
    except (OSError, ValueError, struct.error):
        return None


def _find_exif_tiff(f) -> bytes | None:
    """Walk the JPEG's segments up to the image data and return the TIFF block of its Exif APP1."""
    if f.read(2) != b"\xff\xd8":
        return None
    while True:
        if f.read(1) != b"\xff":
            return None
        marker = f.read(1)
        while marker == b"\xff":  # fill bytes
            marker = f.read(1)
        if not marker:
            return None
        m = marker[0]
        if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:  # markers without a length
            continue
        if m in (0xD9, 0xDA):  # end of image, start of scan: no more metadata
            return None
        raw = f.read(2)
        if len(raw) < 2:
            return None
        length = struct.unpack(">H", raw)[0]
        if length < 2:
            return None
        data = f.read(length - 2)
        if len(data) < length - 2:
            return None
        if m == 0xE1 and data.startswith(b"Exif\x00\x00"):
            return data[6:]


def _date_time_original(tiff: bytes) -> datetime | None:
    if len(tiff) < 8:
        return None
    order = {b"II": "<", b"MM": ">"}.get(tiff[:2])
    if order is None or struct.unpack(order + "H", tiff[2:4])[0] != 42:
        return None
    ifd0 = struct.unpack(order + "I", tiff[4:8])[0]
    exif_ifd = _entry(tiff, order, ifd0, TAG_EXIF_IFD)
    if exif_ifd is None:
        return None
    _, _, _, value = exif_ifd
    entry = _entry(tiff, order, value, TAG_DATETIME_ORIGINAL)
    if entry is None:
        return None
    _, typ, count, value_or_offset = entry
    if typ != 2 or count < 19:
        return None
    start = value_or_offset if count > 4 else None
    if start is None or start + 19 > len(tiff):
        return None
    text = tiff[start : start + 19].decode("ascii", errors="replace")
    try:
        return datetime.strptime(text, "%Y:%m:%d %H:%M:%S")
    except ValueError:
        return None


def _entry(tiff: bytes, order: str, ifd: int, tag: int):
    """(tag, type, count, value/offset) for `tag` in the IFD at `ifd`, or None."""
    if ifd + 2 > len(tiff):
        return None
    count = struct.unpack(order + "H", tiff[ifd : ifd + 2])[0]
    for i in range(count):
        at = ifd + 2 + i * 12
        if at + 12 > len(tiff):
            return None
        entry = struct.unpack(order + "HHII", tiff[at : at + 12])
        if entry[0] == tag:
            return entry
    return None


# --- Planning --------------------------------------------------------------------------------------


@dataclass
class Plan:
    renamed: list[tuple[str, str]] = field(default_factory=list)
    duplicates: list[tuple[str, str, str]] = field(default_factory=list)  # file, kept copy, destination
    skipped: list[str] = field(default_factory=list)

    def report(self) -> dict:
        return {
            "renamed": [{"from": a, "to": b} for a, b in self.renamed],
            "duplicates": [{"file": f, "duplicateOf": k} for f, k, _ in self.duplicates],
            "skipped": self.skipped,
        }

    def lines(self) -> list[str]:
        out = [f"duplicate {f} -> {DUPLICATES_DIR}/{d} (same as {k})" for f, k, d in self.duplicates]
        out += [f"rename {a} -> {b}" for a, b in self.renamed]
        return out


def is_photo(path: Path) -> bool:
    return path.suffix.lower() in PHOTO_EXTENSIONS


def file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def date_taken(path: Path) -> datetime:
    if path.suffix.lower() in JPEG_EXTENSIONS:
        taken = exif_date_taken(path)
        if taken is not None:
            return taken
    return datetime.fromtimestamp(path.stat().st_mtime)


def has_target_name(name: str, stem: str, ext: str) -> bool:
    return re.fullmatch(re.escape(stem) + r"(_[0-9]+)?" + re.escape(ext), name) is not None


def free_name(stem: str, ext: str, taken: set[str]) -> str:
    name, n = stem + ext, 1
    while name.lower() in taken:
        n += 1
        name = f"{stem}_{n}{ext}"
    return name


def make_plan(folder: Path) -> Plan:
    plan = Plan()
    files = sorted((p for p in folder.iterdir() if p.is_file()), key=lambda p: p.name)
    photos = [p for p in files if is_photo(p)]
    plan.skipped = [p.name for p in files if not is_photo(p)]

    # Duplicates: keep the oldest copy of each content.
    groups: dict[str, list[Path]] = {}
    for p in photos:
        groups.setdefault(file_hash(p), []).append(p)
    dup_dir = folder / DUPLICATES_DIR
    dup_taken = {p.name.lower() for p in dup_dir.iterdir()} if dup_dir.is_dir() else set()
    kept: list[Path] = []
    for group in groups.values():
        group.sort(key=lambda p: (p.stat().st_mtime, p.name))
        kept.append(group[0])
        for extra in group[1:]:
            dest = free_name(extra.stem, extra.suffix, dup_taken)
            dup_taken.add(dest.lower())
            plan.duplicates.append((extra.name, group[0].name, dest))
    plan.duplicates.sort()

    # Renames, in order of the current file name.
    taken = {p.name.lower() for p in folder.iterdir()}
    for p in sorted(kept, key=lambda p: p.name):
        stem, ext = date_taken(p).strftime(NAME_FORMAT), p.suffix.lower()
        if has_target_name(p.name, stem, ext):
            plan.skipped.append(p.name)
            continue
        target = free_name(stem, ext, taken)
        taken.add(target.lower())
        plan.renamed.append((p.name, target))
    plan.skipped.sort()
    return plan


def apply_plan(folder: Path, plan: Plan) -> None:
    if plan.duplicates:
        (folder / DUPLICATES_DIR).mkdir(exist_ok=True)
    for name, _, dest in plan.duplicates:
        os.rename(folder / name, folder / DUPLICATES_DIR / dest)
    for old, new in plan.renamed:
        os.rename(folder / old, folder / new)


# --- Command line ----------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Move duplicate photos aside and name every photo by the date it was taken."
    )
    parser.add_argument("folder", help="the folder of photos to organise")
    parser.add_argument("--dry-run", action="store_true", help="print the plan and change nothing")
    parser.add_argument("--report", metavar="FILE.json", help="write a JSON report of what was done")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")  # odd file names never crash the output

    folder = Path(args.folder)
    if not folder.is_dir():
        print(f"organize.py: folder not found: {args.folder}", file=sys.stderr)
        return 2

    plan = make_plan(folder)
    for line in plan.lines():
        print(line)
    if args.dry_run:
        print("Dry run: nothing was changed.")
    else:
        apply_plan(folder, plan)
        print(f"{len(plan.renamed)} renamed, {len(plan.duplicates)} duplicates moved.")
    if args.report:
        Path(args.report).write_text(json.dumps(plan.report(), indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
