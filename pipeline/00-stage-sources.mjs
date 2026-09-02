// Phase 0 — stage sources.
// Snapshot the READ-ONLY NeoFeoda inputs into src-data/ (so the build is
// reproducible and self-contained, and NeoFeoda is never touched), then
// download Natural Earth admin-0 (public domain, not present in NeoFeoda cache).
import { cpSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import {
  NEOFEODA_ADM2_DIR, NEOFEODA_NE_ADMIN1, NE_ADMIN0_URL,
  SRC_DATA, SRC_ADM2, SRC_NE_ADMIN1, SRC_NE_ADMIN0,
} from '../config.mjs';
import { ensureDir, exists, log, fmtBytes } from './lib/util.mjs';

const FORCE = process.argv.includes('--force');

async function main() {
  ensureDir(SRC_DATA);

  // 1. ADM2 per-country files (geoBoundaries + OSM overrides).
  if (FORCE || !exists(SRC_ADM2)) {
    log('Copying ADM2 cache from NeoFeoda (read-only) ...');
    cpSync(NEOFEODA_ADM2_DIR, SRC_ADM2, { recursive: true });
  }
  const adm2Count = readdirSync(SRC_ADM2).filter((f) => f.endsWith('.geojson')).length;
  log(`ADM2: ${adm2Count} country files staged at src-data/adm2/`);

  // 2. Natural Earth admin-1 provinces.
  if (FORCE || !exists(SRC_NE_ADMIN1)) {
    log('Copying ne_admin1.json from NeoFeoda (read-only) ...');
    cpSync(NEOFEODA_NE_ADMIN1, SRC_NE_ADMIN1);
  }
  log(`ADM1: ne_admin1.json staged (${fmtBytes(statSync(SRC_NE_ADMIN1).size)})`);

  // 3. Natural Earth admin-0 countries — download fresh.
  if (FORCE || !exists(SRC_NE_ADMIN0)) {
    log(`Downloading Natural Earth admin-0 from ${NE_ADMIN0_URL} ...`);
    const res = await fetch(NE_ADMIN0_URL);
    if (!res.ok) throw new Error(`NE admin-0 download failed: ${res.status} ${res.statusText}`);
    const text = await res.text();
    // Validate it parses and looks like a FeatureCollection.
    const gj = JSON.parse(text);
    if (gj.type !== 'FeatureCollection' || !Array.isArray(gj.features)) {
      throw new Error('NE admin-0 download is not a FeatureCollection');
    }
    writeFileSync(SRC_NE_ADMIN0, text);
    log(`ADM0: ne_admin0.json downloaded (${gj.features.length} features, ${fmtBytes(text.length)})`);
  } else {
    log(`ADM0: ne_admin0.json already present (${fmtBytes(statSync(SRC_NE_ADMIN0).size)})`);
  }

  log('Stage complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
