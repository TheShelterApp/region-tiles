// Deep audit: (A) validate EVERY output geometry file; (B) cross-check the
// resolver against ground truth (a point known to be inside a specific district
// must resolve back to that district).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { GEO_DIR } from '../config.mjs';
import { eachPolygon, representativePoint, pointInGeometry } from './lib/geojson.mjs';
import { resolveRegion, clearCache } from './lib/resolve.mjs';

// ---- A. Full structural scan of every geo file ---------------------------
function scanFeatureFile(file, expectLevel, expectIso) {
  const f = JSON.parse(readFileSync(file, 'utf8'));
  const errs = [];
  if (f.type !== 'Feature') errs.push('not a Feature');
  const p = f.properties || {};
  if (p.level !== expectLevel) errs.push(`level ${p.level}!=${expectLevel}`);
  if (p.country !== expectIso) errs.push(`country ${p.country}!=${expectIso}`);
  if (!p.id) errs.push('no id');
  const g = f.geometry;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) {
    errs.push(`geom ${g?.type}`);
    return errs;
  }
  let rings = 0, degenerate = 0, badCoord = 0, unclosed = 0;
  eachPolygon(g, (poly) => {
    for (const ring of poly) {
      rings++;
      if (ring.length < 4) degenerate++;
      const a = ring[0], b = ring[ring.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) unclosed++;
      for (const [x, y] of ring) {
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < -180.0001 || x > 180.0001 || y < -90.0001 || y > 90.0001) badCoord++;
      }
    }
  });
  if (degenerate) errs.push(`${degenerate} rings <4 pts`);
  if (unclosed) errs.push(`${unclosed} unclosed rings`);
  if (badCoord) errs.push(`${badCoord} bad coords`);
  return errs;
}

function auditLevel(level) {
  const base = join(GEO_DIR, `adm${level}`);
  let files = 0, bad = 0, multipoly = 0;
  const examples = [];
  const walk = (dir, iso) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isDirectory()) walk(join(dir, name.name), name.name);
      else if (name.name.endsWith('.geojson')) {
        files++;
        const isoForFile = level === 0 ? name.name.replace('.geojson', '') : iso;
        const errs = scanFeatureFile(join(dir, name.name), level, isoForFile);
        const f = JSON.parse(readFileSync(join(dir, name.name), 'utf8'));
        if (f.geometry?.type === 'MultiPolygon') multipoly++;
        if (errs.length) { bad++; if (examples.length < 8) examples.push(`${name.name}: ${errs.join('; ')}`); }
      }
    }
  };
  walk(base, null);
  console.log(`ADM${level}: ${files} files, ${multipoly} MultiPolygon, ${bad} with issues`);
  examples.forEach((e) => console.log('    -', e));
  return { files, bad };
}

console.log('== A. Full geometry audit (every file) ==');
let totalBad = 0;
for (const lv of [0, 1, 2]) totalBad += auditLevel(lv).bad;

// ---- B. Ground-truth resolver cross-check --------------------------------
// For a spread of districts, a point inside the district must resolve to it.
console.log('\n== B. Resolver ground-truth cross-check ==');
clearCache();
const adm2Base = join(GEO_DIR, 'adm2');
const isoDirs = readdirSync(adm2Base).filter((d) => existsSync(join(adm2Base, d)));
// Deterministic spread: every Nth district across all countries.
let tested = 0, exactId = 0, sameCountry = 0, insideReturned = 0;
const mism = [];
const STEP = 17; // sample ~1/17 of districts (~3.5k)
for (const iso of isoDirs) {
  const files = readdirSync(join(adm2Base, iso)).filter((f) => f.endsWith('.geojson'));
  for (let i = 0; i < files.length; i += STEP) {
    const f = JSON.parse(readFileSync(join(adm2Base, iso, files[i]), 'utf8'));
    const id = f.properties.id;
    const [lng, lat] = representativePoint(f.geometry);
    const got = resolveRegion(lat, lng, 2);
    tested++;
    if (got === id) exactId++;
    if (got && got.split('.')[0] === iso) sameCountry++;
    // Is the point inside the region we returned? (acceptable even if id differs)
    if (got) {
      const shard = got.split('.')[0];
      const gf = join(adm2Base, shard, `${got}.geojson`);
      if (existsSync(gf)) {
        const rg = JSON.parse(readFileSync(gf, 'utf8'));
        if (pointInGeometry(lng, lat, rg.geometry)) insideReturned++;
      }
    }
    if (got !== id && mism.length < 12) mism.push(`${id} -> ${got}`);
  }
}
const pct = (n) => ((100 * n) / tested).toFixed(2) + '%';
console.log(`Tested ${tested} districts (rep-point inside each):`);
console.log(`  exact id match:      ${exactId} (${pct(exactId)})`);
console.log(`  same country:        ${sameCountry} (${pct(sameCountry)})`);
console.log(`  point inside result: ${insideReturned} (${pct(insideReturned)})`);
if (mism.length) console.log('  sample id mismatches (rep-point on shared border -> neighbor):', mism.join(', '));

console.log(`\nAudit ${totalBad === 0 ? 'clean (no geometry issues)' : `found ${totalBad} files with issues`}.`);
