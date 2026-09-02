// Acceptance checks for the SQLite bundle (contract of this task).
import Database from 'better-sqlite3';
import { gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { SQLITE_FILE, SQLITE_GZ, REGIONS_DB_JSON, DIST } from '../config.mjs';
import { pointInGeometry } from './lib/geojson.mjs';

let fails = 0;
const ok = (m) => console.log('  ✓', m);
const bad = (m) => { fails++; console.log('  ✗', m); };

const db = new Database(SQLITE_FILE, { readonly: true });

// 1. Counts by level.
const rows = db.prepare('SELECT level, count(*) c FROM regions GROUP BY level ORDER BY level').all();
const byLevel = Object.fromEntries(rows.map((r) => [r.level, r.c]));
console.log('== Counts ==');
(byLevel[0] === 255 ? ok : bad)(`ADM0 = ${byLevel[0]} (expect 255)`);
(byLevel[1] >= 4500 && byLevel[1] <= 4700 ? ok : bad)(`ADM1 = ${byLevel[1]} (expect ~4596)`);
(byLevel[2] >= 59000 && byLevel[2] <= 61000 ? ok : bad)(`ADM2 = ${byLevel[2]} (expect ~60000)`);

// meta present
const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
console.log('== meta ==', JSON.stringify(meta));
for (const k of ['version', 'generated', 'count_adm0', 'count_adm1', 'count_adm2', 'attribution']) {
  if (!(k in meta)) bad(`meta missing ${k}`); }
if (Number(meta.count_adm2) !== byLevel[2]) bad('meta.count_adm2 != row count');

// 2. R*Tree point query for Havana at level 2.
console.log('== R*Tree Havana (23.113, -82.366) level 2 ==');
const lat = 23.113, lng = -82.366;
const q = db.prepare(`
  SELECT r.id, r.name, r.geometry
  FROM regions_rtree rt JOIN regions r ON r.rowid = rt.rowid
  WHERE rt.min_lng <= ? AND rt.max_lng >= ? AND rt.min_lat <= ? AND rt.max_lat >= ? AND r.level = 2`);
const cands = q.all(lng, lng, lat, lat);
console.log(`  candidates: ${cands.length} ->`, cands.map((c) => c.id).join(', ') || '(none)');
(cands.length > 0 ? ok : bad)(`R*Tree returned ${cands.length} candidate(s)`);
const cubCands = cands.filter((c) => c.id.startsWith('CUB.'));
(cubCands.length > 0 ? ok : bad)(`includes a Cuban district (${cubCands.map((c) => c.id).join(', ') || 'none'})`);
// gunzip + validate + point-in-polygon
let container = null, allValid = true;
for (const c of cands) {
  let geom;
  try { geom = JSON.parse(gunzipSync(c.geometry).toString()); }
  catch { allValid = false; bad(`geometry for ${c.id} not valid gzip/JSON`); continue; }
  if (!geom.type || !geom.coordinates || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) {
    allValid = false; bad(`geometry for ${c.id} not a bare GeoJSON geometry`);
  }
  if (pointInGeometry(lng, lat, geom)) container = c.id;
}
(allValid ? ok : bad)('all candidate geometries gunzip to valid bare GeoJSON');
(container && container.startsWith('CUB.') ? ok : bad)(`point-in-polygon container = ${container} (a Cuban district)`);

db.close();

// 3. gz opens; manifest sha256/size match.
console.log('== regions.sqlite.gz + manifest ==');
const gz = readFileSync(SQLITE_GZ);
const sha = createHash('sha256').update(gz).digest('hex');
const manifest = JSON.parse(readFileSync(REGIONS_DB_JSON, 'utf8'));
(manifest.sha256 === sha ? ok : bad)(`manifest.sha256 matches regions.sqlite.gz (${sha.slice(0, 12)}…)`);
(manifest.sizeBytes === gz.length ? ok : bad)(`manifest.sizeBytes = ${manifest.sizeBytes} matches file (${gz.length})`);
// gz actually opens as a valid sqlite db
try {
  const tmp = join(DIST, '_verify_open.sqlite');
  writeFileSync(tmp, gunzipSync(gz));
  const d2 = new Database(tmp, { readonly: true });
  const n = d2.prepare('SELECT count(*) c FROM regions').get().c;
  d2.close();
  (n === byLevel[0] + byLevel[1] + byLevel[2] ? ok : bad)(`gunzipped db opens; ${n} regions`);
} catch (e) { bad(`gunzipped db failed to open: ${e.message}`); }

console.log(fails ? `\nSQLITE VERIFY FAILED (${fails})` : '\nSQLITE VERIFY PASSED');
process.exit(fails ? 1 : 0);
