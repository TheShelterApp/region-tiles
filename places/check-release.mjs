// A release's committed bytes (places/dist/<version>/*.sqlite.gz) against the committed pointer (places-db.json) and,
// in CI, a fresh build. The pointer must be the one this version publishes: its version is places/VERSION, schema 1,
// the parts core then detail, and every part's URLs exactly the mirrors pointerUrls(version, part) builds (a pointer
// left at an older version's URLs would send every install to bytes that fail their sha256). The committed .gz must
// match the pointer's sha256 and sizes, its SQLite's meta the version and part; with --built, its inflated SQLite must
// equal the fresh build byte for byte (the deflate stream may differ between Node builds, the SQLite file may not).
//
// usage: node places/check-release.mjs --committed places/dist/<version> --pointer places-db.json [--built dist/places/<version>]
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipChecked, sha256 } from './lib/io.mjs';
import { openPart } from './lib/pack.mjs';
import { pointerUrls, SCHEMA } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PART_ORDER = ['core', 'detail'];

/** Every problem of a committed release directory and its pointer (empty: fine). */
export function releaseProblems({ committed, pointerPath, built = null, version = readFileSync(join(HERE, 'VERSION'), 'utf8').trim() }) {
  const problems = [];
  if (!existsSync(pointerPath)) return [`no pointer at ${pointerPath}`];
  if (!existsSync(committed)) return [`no committed release directory ${committed}`];
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  if (pointer.version !== version) problems.push(`pointer version ${pointer.version} != places/VERSION ${version}`);
  if (basename(committed) !== version) problems.push(`the committed directory ${basename(committed)} is not places/dist/${version}`);
  if (pointer.schema !== SCHEMA) problems.push(`pointer schema ${pointer.schema} != ${SCHEMA}`);
  const names = (pointer.parts || []).map((p) => p.name);
  if (JSON.stringify(names) !== JSON.stringify(PART_ORDER)) problems.push(`pointer parts ${JSON.stringify(names)} != ${JSON.stringify(PART_ORDER)}`);
  for (const part of pointer.parts || []) {
    const file = `places-${part.name}.sqlite.gz`;
    const path = join(committed, file);
    if (!existsSync(path)) {
      problems.push(`${part.name}: ${path} is missing`);
      continue;
    }
    const gz = readFileSync(path);
    const inflated = gunzipChecked(gz);
    if (sha256(gz) !== part.sha256) problems.push(`${part.name}: sha256 differs from the pointer`);
    if (gz.length !== part.size_bytes) problems.push(`${part.name}: size differs from the pointer`);
    if (inflated.length !== part.inflated_bytes) problems.push(`${part.name}: inflated size differs from the pointer`);
    const want = pointerUrls(version, part.name);
    if (JSON.stringify(part.urls) !== JSON.stringify(want)) problems.push(`${part.name}: urls ${JSON.stringify(part.urls)} != ${JSON.stringify(want)}`);
    const meta = openPart(inflated).meta;
    if (meta.version !== version) problems.push(`${part.name}: meta.version ${meta.version} != ${version}`);
    if (meta.part !== part.name) problems.push(`${part.name}: meta.part ${meta.part}`);
    if (Number(meta.schema) !== SCHEMA) problems.push(`${part.name}: meta.schema ${meta.schema}`);
    if (built) {
      const fresh = gunzipChecked(readFileSync(join(built, file)));
      if (!inflated.equals(fresh)) problems.push(`${part.name}: the committed SQLite differs from a fresh build`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
  const problems = releaseProblems({ committed: o.committed, pointerPath: o.pointer, built: o.built || null });
  for (const p of problems) console.log(`FAIL ${p}`);
  if (problems.length) process.exit(1);
  console.log(`ok: ${o.committed} matches ${o.pointer}${o.built ? ` and the fresh build ${o.built}` : ''}`);
}
