// Hidden acceptance tests for photos. Never shown to any agent.
// They run `python organize.py` (from the folder under test) against fresh temp folders.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const { join } = require('node:path');

const dir = process.cwd();
const script = join(dir, 'organize.py');

/** `python` if it is Python 3.10+, else `python3`. */
const PYTHON = (() => {
  for (const cmd of ['python', 'python3']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info >= (3, 10))'], {
      encoding: 'utf8',
    });
    if (r.status === 0 && r.stdout.trim() === 'True') return cmd;
  }
  throw new Error('Python 3.10+ not found as python or python3');
})();

function organize(...args) {
  return spawnSync(PYTHON, [script, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
}
function ok(r) {
  assert.strictEqual(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}

/** A fresh folder to organise; removed after the test. */
function folder(t) {
  const d = fs.mkdtempSync(join(os.tmpdir(), 'photos-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
/** Write a file and set its modification time (local time components). */
function put(d, name, data, when = new Date(2021, 4, 6, 7, 8, 9)) {
  const p = join(d, name);
  fs.writeFileSync(p, data);
  fs.utimesSync(p, when, when);
  return p;
}
const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) =>
  `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`;
const files = (d) =>
  fs
    .readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
/** Every file under `d` with its content and mtime, to prove nothing changed. */
function snapshot(d) {
  const out = {};
  const walk = (p, rel) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = join(p, e.name);
      const key = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        out[`${key}/`] = 'dir';
        walk(full, key);
      } else {
        out[key] =
          `${fs.readFileSync(full).toString('base64')}@${Math.round(fs.statSync(full).mtimeMs / 1000)}`;
      }
    }
  };
  walk(d, '');
  return out;
}

// A real 1×1 JPEG (JFIF), to which the EXIF tests add an APP1 segment.
const PIXEL = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==',
  'base64',
);
const SOI = PIXEL.subarray(0, 2);
const AFTER_JFIF = PIXEL.subarray(2 + 2 + PIXEL.readUInt16BE(4)); // skip SOI and the APP0 segment

/**
 * An Exif APP1 segment. IFD0 holds DateTime (0x0132, the modify date, a decoy) and the Exif IFD
 * pointer (0x8769); the Exif IFD holds DateTimeOriginal (0x9003) unless `original` is null.
 */
function app1({ original, modified = '2001:01:01 01:01:01', bigEndian = false }) {
  const le = !bigEndian;
  const buf = Buffer.alloc(128);
  let at = 0;
  const u16 = (v) => (le ? buf.writeUInt16LE(v, at) : buf.writeUInt16BE(v, at), (at += 2));
  const u32 = (v) => (le ? buf.writeUInt32LE(v, at) : buf.writeUInt32BE(v, at), (at += 4));
  const str = (s) => (buf.write(`${s}\0`, at, 'ascii'), (at += s.length + 1));
  buf.write(le ? 'II' : 'MM', 0, 'ascii');
  at = 2;
  u16(42);
  u32(8);
  // IFD0 at 8: two entries.
  u16(2);
  (u16(0x0132), u16(2), u32(20), u32(38)); // DateTime -> 38
  (u16(0x8769), u16(4), u32(1), u32(58)); // Exif IFD -> 58
  u32(0);
  str(modified); // 38..58
  // Exif IFD at 58.
  if (original === null) {
    u16(1);
    (u16(0xa002), u16(4), u32(1), u32(1)); // PixelXDimension only
    u32(0);
  } else {
    u16(1);
    (u16(0x9003), u16(2), u32(20), u32(76)); // DateTimeOriginal -> 76
    u32(0);
    str(original); // 76..96
  }
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), buf.subarray(0, at)]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
/** A valid JPEG with EXIF: APP1 right after SOI, or after the JFIF APP0 (`keepJfif`). */
function exifJpeg(opts, keepJfif = false) {
  return keepJfif
    ? Buffer.concat([PIXEL.subarray(0, PIXEL.length - AFTER_JFIF.length), app1(opts), AFTER_JFIF])
    : Buffer.concat([SOI, app1(opts), AFTER_JFIF]);
}

test('renames a photo by its modification time to YYYY-MM-DD_HHMMSS with the extension in lower case', (t) => {
  const d = folder(t);
  const when = new Date(2021, 4, 6, 7, 8, 9);
  put(d, 'IMG_0001.JPG', PIXEL, when);
  ok(organize(d));
  assert.deepStrictEqual(files(d), ['2021-05-06_070809.jpg']);
  assert.ok(fs.readFileSync(join(d, '2021-05-06_070809.jpg')).equals(PIXEL), 'content unchanged');
  assert.strictEqual(
    Math.round(fs.statSync(join(d, '2021-05-06_070809.jpg')).mtimeMs / 1000),
    Math.round(when.getTime() / 1000),
    'modification time kept',
  );
});

test('recognises .jpg .jpeg .png .heic in any letter case', (t) => {
  const d = folder(t);
  put(d, 'a.Jpeg', 'a', new Date(2020, 0, 1, 10, 0, 0));
  put(d, 'b.PNG', 'b', new Date(2020, 0, 2, 11, 0, 0));
  put(d, 'c.HeIc', 'c', new Date(2020, 0, 3, 12, 0, 0));
  put(d, 'd.jpg', 'd', new Date(2020, 0, 4, 13, 0, 0));
  ok(organize(d));
  assert.deepStrictEqual(files(d), [
    '2020-01-01_100000.jpeg',
    '2020-01-02_110000.png',
    '2020-01-03_120000.heic',
    '2020-01-04_130000.jpg',
  ]);
});

test('photos with the same date get _2, _3 in order of their file name', (t) => {
  const d = folder(t);
  const when = new Date(2022, 10, 12, 13, 14, 15);
  put(d, 'c.jpg', 'third', when);
  put(d, 'a.jpg', 'first', when);
  put(d, 'b.jpg', 'second', when);
  ok(organize(d));
  const base = stamp(when);
  assert.deepStrictEqual(files(d), [`${base}.jpg`, `${base}_2.jpg`, `${base}_3.jpg`]);
  assert.strictEqual(fs.readFileSync(join(d, `${base}.jpg`), 'utf8'), 'first');
  assert.strictEqual(fs.readFileSync(join(d, `${base}_2.jpg`), 'utf8'), 'second');
  assert.strictEqual(fs.readFileSync(join(d, `${base}_3.jpg`), 'utf8'), 'third');
});

test('a name already used by another file counts as taken', (t) => {
  const d = folder(t);
  const when = new Date(2022, 1, 3, 4, 5, 6);
  put(d, `${stamp(when)}.jpg`, 'other file, already named', new Date(2019, 0, 1));
  put(d, 'new.JPG', 'new photo', when);
  // The first file's own mtime gives it another name, but it occupies this one until moved;
  // whatever happens, nothing may be overwritten.
  ok(organize(d));
  const all = files(d);
  assert.strictEqual(all.length, 2, all.join(', '));
  const contents = all.map((f) => fs.readFileSync(join(d, f), 'utf8')).sort();
  assert.deepStrictEqual(contents, ['new photo', 'other file, already named']);
  assert.ok(all.includes(`${stamp(when)}_2.jpg`) || all.includes(`${stamp(when)}.jpg`));
});

test('exact duplicates are moved into duplicates/ and reported', (t) => {
  const d = folder(t);
  const report = join(folder(t), 'report.json');
  put(d, 'IMG_1.jpg', 'same bytes', new Date(2020, 5, 1, 9, 0, 0));
  put(d, 'IMG_1 (1).jpg', 'same bytes', new Date(2020, 5, 2, 9, 0, 0));
  put(d, 'other.jpg', 'different', new Date(2020, 5, 3, 9, 0, 0));
  ok(organize(d, '--report', report));
  assert.deepStrictEqual(files(d), ['2020-06-01_090000.jpg', '2020-06-03_090000.jpg']);
  assert.deepStrictEqual(files(join(d, 'duplicates')), ['IMG_1 (1).jpg']);
  assert.strictEqual(fs.readFileSync(join(d, 'duplicates', 'IMG_1 (1).jpg'), 'utf8'), 'same bytes');
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.deepStrictEqual(r.duplicates, [{ file: 'IMG_1 (1).jpg', duplicateOf: 'IMG_1.jpg' }]);
});

test('the oldest copy is kept, whatever its name', (t) => {
  const d = folder(t);
  put(d, 'a_newest.png', 'pic', new Date(2023, 2, 3, 3, 3, 3));
  put(d, 'b_oldest.png', 'pic', new Date(2018, 7, 8, 8, 8, 8));
  put(d, 'c_middle.png', 'pic', new Date(2020, 1, 1, 1, 1, 1));
  ok(organize(d));
  assert.deepStrictEqual(files(d), ['2018-08-08_080808.png']);
  assert.deepStrictEqual(files(join(d, 'duplicates')), ['a_newest.png', 'c_middle.png']);
});

test('the EXIF DateTimeOriginal of a JPEG wins over its modification time (little-endian)', (t) => {
  const d = folder(t);
  put(d, 'DSC_0042.JPG', exifJpeg({ original: '2019:07:14 16:20:05' }), new Date(2024, 0, 1));
  ok(organize(d));
  assert.deepStrictEqual(files(d), ['2019-07-14_162005.jpg']);
});

test('the EXIF DateTimeOriginal is read in big-endian files after a JFIF header too', (t) => {
  const d = folder(t);
  put(
    d,
    'scan.jpeg',
    exifJpeg({ original: '2015:12:31 23:59:58', bigEndian: true }, true),
    new Date(2024, 0, 1),
  );
  ok(organize(d));
  assert.deepStrictEqual(files(d), ['2015-12-31_235958.jpeg']);
});

test('no DateTimeOriginal, a PNG, or a broken file: the modification time is used, no crash', (t) => {
  const d = folder(t);
  put(d, 'a.jpg', exifJpeg({ original: null }), new Date(2021, 0, 1, 1, 1, 1));
  put(d, 'b.png', exifJpeg({ original: '2010:10:10 10:10:10' }), new Date(2021, 0, 2, 2, 2, 2));
  put(
    d,
    'c.jpg',
    exifJpeg({ original: '2010:10:10 10:10:10' }).subarray(0, 40),
    new Date(2021, 0, 3, 3, 3, 3),
  );
  put(d, 'd.jpg', 'not a jpeg at all', new Date(2021, 0, 4, 4, 4, 4));
  put(d, 'e.jpg', '', new Date(2021, 0, 5, 5, 5, 5));
  ok(organize(d));
  assert.deepStrictEqual(files(d), [
    '2021-01-01_010101.jpg',
    '2021-01-02_020202.png',
    '2021-01-03_030303.jpg',
    '2021-01-04_040404.jpg',
    '2021-01-05_050505.jpg',
  ]);
});

test('--dry-run changes nothing and prints the plan', (t) => {
  const d = folder(t);
  put(d, 'IMG_7.JPG', 'seven', new Date(2020, 2, 4, 5, 6, 7));
  put(d, 'IMG_7 copy.JPG', 'seven', new Date(2020, 3, 4, 5, 6, 7));
  put(d, 'notes.txt', 'hello');
  const before = snapshot(d);
  const r = ok(organize(d, '--dry-run'));
  assert.deepStrictEqual(snapshot(d), before, 'folder unchanged (and no duplicates/ folder)');
  const line = (re) => r.stdout.split(/\r?\n/).some((l) => re.every((s) => l.includes(s)));
  assert.ok(line(['IMG_7.JPG', '2020-03-04_050607.jpg']), `rename in the plan:\n${r.stdout}`);
  assert.ok(line(['IMG_7 copy.JPG', 'duplicates']), `duplicate in the plan:\n${r.stdout}`);
});

test('--report writes JSON with exactly renamed, duplicates and skipped', (t) => {
  const d = folder(t);
  const report = join(folder(t), 'out.json');
  put(d, 'A.jpg', 'pic A', new Date(2020, 0, 1, 0, 0, 1));
  put(d, 'A again.jpg', 'pic A', new Date(2020, 0, 1, 0, 0, 2));
  put(d, '2019-02-03_040506.png', 'already named', new Date(2019, 1, 3, 4, 5, 6));
  put(d, 'readme.md', 'not a photo');
  ok(organize(d, '--report', report));
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.deepStrictEqual(Object.keys(r).sort(), ['duplicates', 'renamed', 'skipped']);
  assert.deepStrictEqual(r.renamed, [{ from: 'A.jpg', to: '2020-01-01_000001.jpg' }]);
  assert.deepStrictEqual(r.duplicates, [{ file: 'A again.jpg', duplicateOf: 'A.jpg' }]);
  assert.deepStrictEqual([...r.skipped].sort(), ['2019-02-03_040506.png', 'readme.md']);
});

test('the report describes the plan in a dry run too', (t) => {
  const d = folder(t);
  const report = join(folder(t), 'plan.json');
  put(d, 'x.heic', 'x', new Date(2020, 6, 7, 8, 9, 10));
  ok(organize(d, '--dry-run', '--report', report));
  assert.deepStrictEqual(files(d), ['x.heic']);
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.deepStrictEqual(r.renamed, [{ from: 'x.heic', to: '2020-07-07_080910.heic' }]);
  assert.deepStrictEqual(r.duplicates, []);
});

test('files that are not photos, and subfolders, are left untouched', (t) => {
  const d = folder(t);
  put(d, 'notes.txt', 'a');
  put(d, 'clip.mov', 'b');
  put(d, 'photo.jpg.bak', 'c');
  put(d, 'raw.CR2', 'c');
  fs.mkdirSync(join(d, 'Album'));
  put(join(d, 'Album'), 'IMG_9.jpg', 'in a subfolder');
  put(d, 'IMG_9.jpg', 'in a subfolder', new Date(2022, 0, 1, 0, 0, 0)); // same bytes, other folder
  const keep = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'IMG_9.jpg'));
  const before = keep(snapshot(d));
  ok(organize(d));
  const after = snapshot(d);
  assert.ok(after['2022-01-01_000000.jpg'], 'the top-level photo is renamed');
  delete after['2022-01-01_000000.jpg'];
  assert.deepStrictEqual(after, before);
});

test('a missing folder exits with code 2 and a message naming it', (t) => {
  const missing = join(folder(t), 'no-such-folder');
  const r = organize(missing);
  assert.strictEqual(r.status, 2, `exit ${r.status}`);
  assert.match(r.stderr, /no-such-folder/);
  assert.doesNotMatch(r.stderr, /Traceback/);
});

test('running twice is stable: the second run changes nothing', (t) => {
  const d = folder(t);
  const when = new Date(2021, 8, 9, 10, 11, 12);
  put(d, 'a.jpg', 'one', when);
  put(d, 'b.jpg', 'two', when);
  put(d, 'c.JPG', 'three', when);
  put(d, 'c copy.JPG', 'three', new Date(2022, 0, 1));
  put(d, 'd.png', exifJpeg({ original: '2010:10:10 10:10:10' }), new Date(2021, 8, 9, 10, 11, 13));
  put(d, 'e.jpg', exifJpeg({ original: '2011:11:11 11:11:11' }), new Date(2024, 1, 1));
  put(d, 'notes.txt', 'x');
  ok(organize(d));
  const first = snapshot(d);
  const report = join(folder(t), 'second.json');
  ok(organize(d, '--report', report));
  assert.deepStrictEqual(snapshot(d), first);
  const r = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.deepStrictEqual([r.renamed, r.duplicates], [[], []]);
});
