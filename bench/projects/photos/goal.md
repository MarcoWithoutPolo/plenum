Clean up my photo folder. Years of phone backups and copies from old laptops have left me with one big folder full of
`IMG_4031.JPG`, `IMG_4031 (1).JPG`, `photo.png` and the same picture saved three times under different names. I'd like
a small command-line tool I can point at the folder that gets rid of the duplicate copies (moved aside, not deleted —
I want to look before I throw anything away) and gives every photo a name that sorts by when it was taken. I want to
see what it would do before it touches anything, and to keep a record of what it did.

Write it in Python (3.10 or newer) using only the standard library, so it runs anywhere Python does with nothing to
install.

**How it is run**

```
python organize.py <folder> [--dry-run] [--report <file.json>]
```

`organize.py` sits at the top of this repository.

**What counts as a photo**

- Files whose extension is `.jpg`, `.jpeg`, `.png` or `.heic`, in any letter case (`.JPG`, `.Jpeg`…).
- Only files directly inside `<folder>` are looked at. Subfolders (including `duplicates/`) and everything in them are
  left alone. Files that are not photos are never moved, renamed or changed.

**Duplicates**

- Two photos are duplicates when their contents are byte-for-byte identical (compare a content hash such as SHA-256;
  names don't matter).
- In each group of identical photos, the copy with the oldest modification time is kept (on a tie, the one whose
  file name sorts first). The other copies are moved into `<folder>/duplicates/` (created when needed), keeping their
  file names; if a file of that name is already there, add `_2`, `_3`… before the extension.

**Renaming**

- Every photo that is kept is renamed to `YYYY-MM-DD_HHMMSS.<ext>`, with the extension in lower case, e.g.
  `IMG_4031.JPG` → `2019-07-14_162005.jpg`.
- The date is when the photo was taken: for a JPEG (`.jpg`/`.jpeg`) that carries an EXIF `DateTimeOriginal` (tag
  `0x9003` in the Exif sub-IFD), use that. Read the EXIF yourself from the JPEG's APP1 segment (both byte orders,
  `II` and `MM`); don't use Pillow or any other package. For everything else (no EXIF, no `DateTimeOriginal`, a PNG
  or HEIC, or a file whose EXIF can't be read) use the file's modification time, in local time. A broken or truncated
  file must never crash the tool.
- When two photos would get the same name, the second gets `_2`, the third `_3`, and so on (`2019-07-14_162005.jpg`,
  `2019-07-14_162005_2.jpg`). A name is also taken when any other file in the folder already has it (compare names
  case-insensitively). Photos are given names in order of their current file name.
- A photo whose name is already its target name, or its target name with a `_N` suffix, is left as it is. So running
  the tool a second time on an organised folder changes nothing.
- Renaming and moving keep each file's modification time.

**Options and output**

- `--dry-run` prints the plan and changes nothing at all: no renames, no moves, no `duplicates/` folder. The plan has
  one line per action, and each line names the file and where it would go, e.g.
  `rename IMG_4031.JPG -> 2019-07-14_162005.jpg` and
  `duplicate IMG_4031 (1).JPG -> duplicates/IMG_4031 (1).JPG (same as IMG_4031.JPG)`.
  Without `--dry-run`, print the same lines for what was done.
- `--report <file.json>` writes a JSON report (also in a dry run, describing the plan) with exactly this shape:

  ```json
  {
    "renamed": [{ "from": "IMG_4031.JPG", "to": "2019-07-14_162005.jpg" }],
    "duplicates": [{ "file": "IMG_4031 (1).JPG", "duplicateOf": "IMG_4031.JPG" }],
    "skipped": ["notes.txt", "2018-01-01_120000.jpg"]
  }
  ```

  All names are plain file names as they were before the tool ran. `duplicateOf` is the kept copy.
  `skipped` lists every other file directly in the folder that was left where it is: files that aren't photos and
  photos that already had the right name.

- Exit code 0 on success. If `<folder>` doesn't exist or isn't a folder, print a clear message that names it to
  standard error and exit with code 2.

**Tests**

Write unit tests for the tool with Python's `unittest` (files named `test_*.py`). `npm test` runs them
(`python -m unittest`).
