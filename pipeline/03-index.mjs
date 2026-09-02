// Phase 3 — emit per-region geometry files + country-keyed bbox indexes.
//
// Layout (contract §5, variant B):
//   geo/adm0/<ISO3>.geojson                 (Feature)
//   geo/adm1/<ISO3>/<id>.geojson            (Feature)
//   geo/adm2/<ISO3>/<id>.geojson            (Feature)
//   index/adm0.json                         [{id,name,bbox}] for all countries
//   index/adm1/<ISO3>.json                  [{id,name,bbox}] per country
//   index/adm2/<ISO3>.json                  [{id,name,bbox}] per country (where ADM2 exists)
//
// iOS: bbox-prefilter the index -> fetch the few candidate geo files -> point-in-
// polygon -> draw. Shard for adm1/adm2 = id.split('.')[0].
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILD, GEO_DIR, INDEX_DIR, LEVELS, BBOX_PRECISION, MAX_BYTES_PER_REGION, MAX_VERTICES_PER_REGION,
} from '../config.mjs';
import { ensureDir, rmrf, writeJSON, log, fmtBytes } from './lib/util.mjs';
import { bbox, countVertices } from './lib/geojson.mjs';

const SIMPLE_DIR = join(BUILD, 'simplified');
const bf = 10 ** BBOX_PRECISION;
const roundBbox = (b) => b.map((v) => Math.round(v * bf) / bf);

const shardOf = (id) => id.split('.')[0]; // ISO3 prefix

async function processLevel(level, report) {
  const inDir = join(SIMPLE_DIR, `adm${level}`);
  const geoBase = join(GEO_DIR, `adm${level}`);
  ensureDir(geoBase);
  const files = readdirSync(inDir).filter((f) => f.endsWith('.geojson'));

  const adm0Index = []; // only used for level 0

  for (const file of files) {
    const iso = file.replace('.geojson', '');
    const fc = JSON.parse(readFileSync(join(inDir, file), 'utf8'));
    const entries = [];

    // Per-ISO3 shard dir for adm1/adm2.
    let shardDir = geoBase;
    if (level > 0) { shardDir = join(geoBase, iso); ensureDir(shardDir); }

    for (const feat of fc.features) {
      const id = feat.properties.id;
      const bb = roundBbox(bbox(feat.geometry));
      const entry = { id, name: feat.properties.name, bbox: bb };

      // Write the per-region Feature file.
      const outFile = level === 0
        ? join(geoBase, `${iso}.geojson`)
        : join(shardDir, `${id}.geojson`);
      const body = JSON.stringify(feat);
      writeFileSync(outFile, body);

      // Track cap violations (should be zero after phase 2).
      const bytes = Buffer.byteLength(body);
      const verts = countVertices(feat.geometry);
      if (bytes > MAX_BYTES_PER_REGION) report.overBytes.push(`${id} (${fmtBytes(bytes)})`);
      if (verts > MAX_VERTICES_PER_REGION) report.overVerts.push(`${id} (${verts}v)`);
      report.maxBytes = Math.max(report.maxBytes, bytes);

      if (level === 0) adm0Index.push(entry);
      else entries.push(entry);
    }

    // Per-country index for adm1/adm2.
    if (level > 0 && entries.length) {
      entries.sort((a, b) => (a.id < b.id ? -1 : 1));
      writeJSON(join(INDEX_DIR, `adm${level}`, `${iso}.json`), entries);
    }
    report.counts[level] += fc.features.length;
  }

  if (level === 0) {
    adm0Index.sort((a, b) => (a.id < b.id ? -1 : 1));
    writeJSON(join(INDEX_DIR, 'adm0.json'), adm0Index);
  }
  log(`ADM${level}: wrote ${report.counts[level]} region files + index`);
}

async function main() {
  rmrf(GEO_DIR);
  rmrf(INDEX_DIR);
  ensureDir(GEO_DIR);
  ensureDir(INDEX_DIR);

  const report = { counts: { 0: 0, 1: 0, 2: 0 }, overBytes: [], overVerts: [], maxBytes: 0 };
  for (const level of LEVELS) await processLevel(level, report);

  log(`Largest region file: ${fmtBytes(report.maxBytes)} (cap ${fmtBytes(MAX_BYTES_PER_REGION)})`);
  if (report.overBytes.length) log(`WARN over-byte-cap (${report.overBytes.length}): ${report.overBytes.slice(0, 10).join(', ')}`);
  if (report.overVerts.length) log(`WARN over-vertex-cap (${report.overVerts.length}): ${report.overVerts.slice(0, 10).join(', ')}`);
  if (!report.overBytes.length && !report.overVerts.length) log('All region files within caps.');

  writeJSON(join(BUILD, 'index-report.json'), {
    counts: report.counts, maxBytes: report.maxBytes,
    overBytes: report.overBytes, overVerts: report.overVerts,
  }, { pretty: true });
  log('Index complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
