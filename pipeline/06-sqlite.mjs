// Phase 6 (bundle) — build the offline SQLite database `regions.sqlite` from the
// published per-region GeoJSON (index/ + geo/), plus regions.sqlite.gz and the
// regions-db.json pointer. This is an ADDITION to the CDN (per-tile stays the
// fallback); it changes nothing in index/ or geo/.
//
// Schema is fixed (iOS depends on it exactly):
//   regions(id TEXT PK, level INT, name TEXT, min_lng, min_lat, max_lng, max_lat, geometry BLOB)
//   idx_regions_level on regions(level)
//   regions_rtree USING rtree(rowid, min_lng, max_lng, min_lat, max_lat)  -- rowid = regions.rowid
//   meta(key TEXT PK, value TEXT)
// geometry BLOB = gzip of the BARE GeoJSON geometry object ({"type":...,"coordinates":...}),
// [lng,lat] WGS84, the same simplified polygons as geo/.
import Database from 'better-sqlite3';
import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  INDEX_DIR, GEO_DIR, DIST, SQLITE_FILE, SQLITE_GZ, REGIONS_DB_JSON,
  ATTRIBUTION, BUNDLE_VERSION, BUNDLE_TAG, CDN,
} from '../config.mjs';
import { ensureDir, rmrf, log, fmtBytes } from './lib/util.mjs';

const shardOf = (id) => id.split('.')[0];
const geoFile = (level, id) =>
  level === 0 ? join(GEO_DIR, 'adm0', `${id}.geojson`)
    : join(GEO_DIR, `adm${level}`, shardOf(id), `${id}.geojson`);

// Iterate every index entry across all three levels: {level, id, name, bbox}.
function* indexEntries() {
  for (const e of JSON.parse(readFileSync(join(INDEX_DIR, 'adm0.json'), 'utf8'))) {
    yield { level: 0, ...e };
  }
  for (const lv of [1, 2]) {
    const dir = join(INDEX_DIR, `adm${lv}`);
    for (const jf of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      for (const e of JSON.parse(readFileSync(join(dir, jf), 'utf8'))) yield { level: lv, ...e };
    }
  }
}

const SCHEMA = `
CREATE TABLE regions (
  id       TEXT PRIMARY KEY,
  level    INTEGER NOT NULL,
  name     TEXT NOT NULL,
  min_lng  REAL NOT NULL, min_lat REAL NOT NULL,
  max_lng  REAL NOT NULL, max_lat REAL NOT NULL,
  geometry BLOB NOT NULL
);
CREATE INDEX idx_regions_level ON regions(level);
CREATE VIRTUAL TABLE regions_rtree USING rtree(rowid, min_lng, max_lng, min_lat, max_lat);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

function buildDb() {
  rmrf(SQLITE_FILE); rmrf(`${SQLITE_FILE}-wal`); rmrf(`${SQLITE_FILE}-shm`);
  ensureDir(DIST);
  const db = new Database(SQLITE_FILE);
  db.pragma('journal_mode = MEMORY');
  db.pragma('synchronous = OFF');
  db.exec(SCHEMA);

  const insRegion = db.prepare(
    `INSERT INTO regions (id, level, name, min_lng, min_lat, max_lng, max_lat, geometry)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  // rtree column order is (min_lng, max_lng, min_lat, max_lat) — paired per axis.
  const insRtree = db.prepare(
    `INSERT INTO regions_rtree (rowid, min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)`);

  const counts = { 0: 0, 1: 0, 2: 0 };
  let rawBytes = 0, gzBytes = 0;

  const run = db.transaction(() => {
    for (const e of indexEntries()) {
      const [minLng, minLat, maxLng, maxLat] = e.bbox;
      const feat = JSON.parse(readFileSync(geoFile(e.level, e.id), 'utf8'));
      const bare = JSON.stringify(feat.geometry); // strip Feature wrapper
      const blob = gzipSync(Buffer.from(bare), { level: 9 });
      rawBytes += bare.length; gzBytes += blob.length;
      const info = insRegion.run(e.id, e.level, e.name, minLng, minLat, maxLng, maxLat, blob);
      insRtree.run(info.lastInsertRowid, minLng, maxLng, minLat, maxLat);
      counts[e.level]++;
    }
  });
  run();

  const generated = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString();
  const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
  const setMeta = db.transaction((rows) => { for (const [k, v] of rows) meta.run(k, String(v)); });
  setMeta([
    ['version', BUNDLE_VERSION],
    ['generated', generated],
    ['count_adm0', counts[0]],
    ['count_adm1', counts[1]],
    ['count_adm2', counts[2]],
    ['attribution', ATTRIBUTION],
  ]);

  db.exec('VACUUM'); // compact into a tight single file
  db.close();
  log(`DB rows: ADM0=${counts[0]} ADM1=${counts[1]} ADM2=${counts[2]}; geometry ${fmtBytes(rawBytes)} raw -> ${fmtBytes(gzBytes)} gzipped (in BLOBs)`);
  return counts;
}

function publishArtifacts() {
  const sqliteBuf = readFileSync(SQLITE_FILE);
  const gz = gzipSync(sqliteBuf, { level: 9 });
  writeFileSync(SQLITE_GZ, gz);
  const sha256 = createHash('sha256').update(gz).digest('hex');
  const sizeBytes = gz.length;
  log(`regions.sqlite ${fmtBytes(sqliteBuf.length)} -> regions.sqlite.gz ${fmtBytes(sizeBytes)} (sha256 ${sha256.slice(0, 12)}…)`);

  const url = `https://github.com/${CDN.org}/${CDN.repo}/releases/download/${BUNDLE_TAG}/regions.sqlite.gz`;
  const manifest = { version: BUNDLE_VERSION, url, sizeBytes, sha256 };
  writeFileSync(REGIONS_DB_JSON, JSON.stringify(manifest, null, 2) + '\n');
  log(`regions-db.json written -> ${url}`);
  return { sha256, sizeBytes, url };
}

const counts = buildDb();
publishArtifacts();
writeFileSync(join(DIST, 'sqlite-counts.json'), JSON.stringify(counts));
log('SQLite bundle complete. Publish with: gh release create ' + BUNDLE_TAG + ' dist/regions.sqlite.gz');
