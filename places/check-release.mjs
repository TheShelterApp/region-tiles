// A release PR's committed bytes (places/dist/<version>/*.sqlite.gz) against the pointer (places-db.json) and a fresh
// build. The committed .gz must match the pointer's sha256 and sizes; its inflated SQLite must equal the built SQLite
// byte for byte (the deflate stream may differ between Node builds, the SQLite file may not).
//
// usage: node places/check-release.mjs --committed places/dist/<version> --built dist/places/<version> --pointer places-db.json
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipChecked, sha256 } from './lib/io.mjs';

const a = process.argv.slice(2);
const o = {};
for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
const pointer = JSON.parse(readFileSync(o.pointer, 'utf8'));
let bad = 0;
for (const part of pointer.parts) {
  const file = `places-${part.name}.sqlite.gz`;
  const committed = readFileSync(join(o.committed, file));
  const built = gunzipChecked(readFileSync(join(o.built, file)));
  const inflated = gunzipChecked(committed);
  const problems = [];
  if (sha256(committed) !== part.sha256) problems.push('sha256 differs from the pointer');
  if (committed.length !== part.size_bytes) problems.push('size differs from the pointer');
  if (inflated.length !== part.inflated_bytes) problems.push('inflated size differs from the pointer');
  if (!inflated.equals(built)) problems.push('the committed SQLite differs from a fresh build');
  if (!part.urls?.length || part.urls.some((u) => !u.startsWith('https://'))) problems.push('urls');
  console.log(`${problems.length ? 'FAIL' : 'ok'} ${part.name}${problems.length ? `: ${problems.join('; ')}` : ''}`);
  bad += problems.length;
}
if (bad) process.exit(1);
