// File helpers for the place-names pack: TSV tables, sha256, a deterministic gzip and a deterministic tar writer.
//
// The gzip and tar writers exist so the pack's bytes never depend on the host: no timestamps, no owner names, no OS
// byte that differs between macOS and Linux builds of zlib. The deflate stream itself comes from Node's zlib at level 9,
// so two builds on the same Node give the same bytes (verify.mjs check 10). CI compares the inflated SQLite files,
// which do not depend on the deflate implementation (README, "Reproducibility").
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { deflateRawSync, inflateRawSync, crc32 } from 'node:zlib';

export const ensureDir = (dir) => mkdirSync(dir, { recursive: true });

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sha256File(path) {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  const chunk = Buffer.alloc(1 << 20);
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      h.update(n === chunk.length ? chunk : chunk.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

// ---- TSV ------------------------------------------------------------------------------------------------------------
// A curation table: UTF-8, tab-separated, one header line, '#' lines are comments. Fields never contain tabs or
// newlines (the hygiene check refuses them), so no quoting is needed.

export function readTsv(path) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  let header = null;
  const rows = [];
  lines.forEach((line, i) => {
    if (line === '' || line.startsWith('#')) return;
    const cells = line.split('\t');
    if (!header) {
      header = cells;
      return;
    }
    if (cells.length !== header.length) {
      throw new Error(`${path}:${i + 1}: ${cells.length} fields, the header has ${header.length}`);
    }
    const row = { _line: i + 1 };
    header.forEach((h, k) => {
      row[h] = cells[k];
    });
    rows.push(row);
  });
  if (!header) throw new Error(`${path}: no header line`);
  return { header, rows };
}

export function writeTsv(path, header, rows, comments = []) {
  const out = [];
  for (const c of comments) out.push(`# ${c}`);
  out.push(header.join('\t'));
  for (const r of rows) {
    out.push(header.map((h) => {
      const v = r[h] ?? '';
      const s = String(v);
      if (/[\t\n\r]/.test(s)) throw new Error(`${path}: a tab or newline in ${h}: ${JSON.stringify(s)}`);
      return s;
    }).join('\t'));
  }
  ensureDir(dirname(path));
  writeFileSync(path, out.join('\n') + '\n');
}

// ---- JSON -------------------------------------------------------------------------------------------------------------

/** JSON with sorted object keys, so a file's bytes depend on its content only. */
export function stableStringify(value, indent = 2) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value), null, indent) + '\n';
}

// ---- gzip -------------------------------------------------------------------------------------------------------------

/**
 * gzip with a fixed header (no file name, mtime 0, XFL 2 = maximum compression, OS 3 = Unix), the same shape as
 * `gzip -n -9`. The payload is Node's raw deflate at level 9.
 */
export function gzipDeterministic(buf) {
  const head = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x02, 0x03]);
  const body = deflateRawSync(buf, { level: 9, memLevel: 9 });
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(crc32(buf) >>> 0, 0);
  tail.writeUInt32LE(buf.length >>> 0, 4);
  return Buffer.concat([head, body, tail]);
}

/** Inflate a single-member gzip file, checking the magic, the CRC and ISIZE (the checks the app makes). */
export function gunzipChecked(buf) {
  if (buf.length < 18 || buf[0] !== 0x1f || buf[1] !== 0x8b || buf[2] !== 0x08) throw new Error('not a gzip file');
  const flags = buf[3];
  let off = 10;
  if (flags & 0x04) off += 2 + buf.readUInt16LE(off); // FEXTRA
  if (flags & 0x08) while (buf[off++] !== 0); // FNAME
  if (flags & 0x10) while (buf[off++] !== 0); // FCOMMENT
  if (flags & 0x02) off += 2; // FHCRC
  const out = inflateRawSync(buf.subarray(off, buf.length - 8));
  const crc = buf.readUInt32LE(buf.length - 8);
  const isize = buf.readUInt32LE(buf.length - 4);
  if ((crc32(out) >>> 0) !== crc) throw new Error('gzip CRC mismatch');
  if ((out.length >>> 0) !== isize) throw new Error(`gzip ISIZE ${isize} != ${out.length}`);
  return out;
}

// ---- tar --------------------------------------------------------------------------------------------------------------

/** All regular files under `dir`, as sorted paths relative to it (POSIX separators). */
export function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * A ustar archive of `files` (paths relative to `root`, stored under `prefix/`), with mode 0644, uid/gid 0, empty
 * owner names and mtime `mtime` (seconds). Sorted input gives the same bytes on every host.
 */
export function tarDeterministic(root, files, prefix, mtime) {
  const blocks = [];
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  for (const rel of files) {
    const data = readFileSync(join(root, rel));
    const name = `${prefix}/${rel}`;
    if (Buffer.byteLength(name) > 100) throw new Error(`tar: path too long: ${name}`);
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write(octal(0o644, 8), 100, 'latin1');
    h.write(octal(0, 8), 108, 'latin1');
    h.write(octal(0, 8), 116, 'latin1');
    h.write(octal(data.length, 12), 124, 'latin1');
    h.write(octal(mtime, 12), 136, 'latin1');
    h.write('        ', 148, 'latin1');
    h.write('0', 156, 'latin1');
    h.write('ustar\0', 257, 'latin1');
    h.write('00', 263, 'latin1');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(octal(sum, 7) + ' ', 148, 'latin1');
    blocks.push(h, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** Extract a ustar archive written by `tarDeterministic` (regular files only) into `dir`. Returns the paths. */
export function untar(buf, dir) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('latin1').replace(/\0.*$/s, '').trim(), 8);
    const type = String.fromCharCode(h[156] || 0x30);
    off += 512;
    if (type === '0') {
      if (name.includes('..') || name.startsWith('/')) throw new Error(`tar: unsafe path ${name}`);
      const p = join(dir, name);
      ensureDir(dirname(p));
      writeFileSync(p, buf.subarray(off, off + size));
      out.push(name);
    }
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

export function fmtBytes(n) {
  return `${n.toLocaleString('en-US')} B`;
}
