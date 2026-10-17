// A dBASE III reader for the Natural Earth attribute tables (.dbf, UTF-8 per the .cpg). Character and numeric fields
// only, which is all Natural Earth uses.
import { readFileSync } from 'node:fs';

export function readDbf(path) {
  const buf = readFileSync(path);
  const nRecords = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recordLen = buf.readUInt16LE(10);
  const fields = [];
  for (let off = 32; off < headerLen - 1 && buf[off] !== 0x0d; off += 32) {
    const name = buf.subarray(off, off + 11).toString('latin1').replace(/\0.*$/s, '');
    fields.push({ name, type: String.fromCharCode(buf[off + 11]), length: buf[off + 16], decimals: buf[off + 17] });
  }
  const rows = [];
  for (let r = 0; r < nRecords; r++) {
    const base = headerLen + r * recordLen;
    if (buf[base] === 0x2a) continue; // deleted
    let off = base + 1;
    const row = {};
    for (const f of fields) {
      const raw = buf.subarray(off, off + f.length).toString('utf8').replace(/\0+/g, '').trim();
      off += f.length;
      if (f.type === 'N' || f.type === 'F') row[f.name] = raw === '' ? null : Number(raw);
      else row[f.name] = raw;
    }
    rows.push(row);
  }
  return { fields, rows };
}
