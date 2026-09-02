// Phase 5 — acceptance + structural validation (contract §8).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  INDEX_DIR, GEO_DIR, BUILD, MAX_BYTES_PER_REGION, MAX_VERTICES_PER_REGION,
} from '../config.mjs';
import { log } from './lib/util.mjs';
import { resolveAll } from './lib/resolve.mjs';
import { eachPolygon, countVertices } from './lib/geojson.mjs';

let failures = 0;
const fail = (msg) => { failures++; console.log('  ✗', msg); };
const ok = (msg) => console.log('  ✓', msg);

// ---- 1. Acceptance point tests -------------------------------------------
// [lat, lng, expectedISO3 (null = don't assert country), label]
const POINTS = [
  [23.113, -82.366, 'CUB', 'Havana, Cuba (mainland)'],
  [20.30, -75.35, 'CUB', 'Guantánamo province (near CUB.7.3)'],
  [21.50, -79.50, 'CUB', 'Sea off south-central Cuba (offshore, nearest CUB)'],
  [19.44, -78.76, null, 'Deep Caribbean (between CUB/JAM/CYM) — resolves to nearest land'],
  [35.68, 139.69, 'JPN', 'Tokyo'],
  [51.507, -0.128, 'GBR', 'London'],
  [40.713, -74.006, 'USA', 'New York City'],
  [-23.55, -46.63, 'BRA', 'São Paulo'],
  [-33.87, 151.21, 'AUS', 'Sydney'],
  [30.044, 31.236, 'EGY', 'Cairo'],
  [55.75, 37.62, 'RUS', 'Moscow'],
  [28.61, 77.21, 'IND', 'New Delhi'],
  [64.18, -51.69, 'GRL', 'Nuuk, Greenland (ADM1-only -> ADM2 falls back)'],
  [-1.29, 36.82, 'KEN', 'Nairobi'],
  [19.43, -99.13, 'MEX', 'Mexico City'],
  [41.90, 12.50, 'ITA', 'Rome (OSM-override country)'],
  [-34.60, -58.38, 'ARG', 'Buenos Aires'],
  // Regression: MultiPolygon island parts must survive simplification (#4).
  [24.28, 153.98, 'JPN', 'Marcus Is./Minami-Torishima (island-drop regression)'],
  [48.62, -123.31, 'CAN', 'Canadian Gulf Islands (island-drop regression)'],
  [35.90, 14.40, 'MLT', 'Valletta, Malta (small-state)'],
];

function checkGeoExists(id, level) {
  const shard = id.split('.')[0];
  const f = level === 0 ? join(GEO_DIR, 'adm0', `${id}.geojson`)
    : join(GEO_DIR, `adm${level}`, shard, `${id}.geojson`);
  return existsSync(f);
}

log('== Acceptance: point -> region at all three levels ==');
for (const [lat, lng, iso, label] of POINTS) {
  const r = resolveAll(lat, lng);
  const parts = [];
  let good = true;
  if (!r.adm0) { good = false; parts.push('adm0=MISS'); } else parts.push(`adm0=${r.adm0}`);
  if (!r.adm1) { good = false; parts.push('adm1=MISS'); } else parts.push(`adm1=${r.adm1}`);
  if (!r.adm2) { good = false; parts.push('adm2=MISS'); } else parts.push(`adm2=${r.adm2}`);
  if (iso && r.adm0 !== iso) { good = false; parts.push(`(expected ${iso})`); }
  // geometry files for resolved ids must exist
  for (const [lv, id] of [[0, r.adm0], [1, r.adm1], [2, r.adm2]]) {
    if (id && !checkGeoExists(id, idLevel(id))) { good = false; parts.push(`no-geo:${id}`); }
  }
  (good ? ok : fail)(`${label}: ${parts.join(' ')}`);
}

// Determine the true level of an id by its dot-count (fallback may return a
// higher-level id at a lower-level query).
function idLevel(id) { return (id.match(/\./g) || []).length; }

// Regression: an ADM2 coverage gap inside a country must fall back UP to the
// covering province, not return a distant wrong-province district (#2).
log('== Regression: ADM2 coverage gap falls back up ==');
{
  const r = resolveAll(78.22, 15.65); // Longyearbyen, Svalbard — no districts
  (r.adm2 === 'NOR.5' && r.adm1 === 'NOR.5' ? ok : fail)(
    `Svalbard falls back to province NOR.5 (not a distant NOR.4.* district): adm1=${r.adm1} adm2=${r.adm2}`);
}

// ---- 2. Structural validation --------------------------------------------
log('== Structural: index <-> geo consistency, coords, caps ==');

function validateFeatureBody(body, id, level) {
  const f = JSON.parse(body);
  if (f.type !== 'Feature') return `bad type (${f.type})`;
  const p = f.properties || {};
  if (p.id !== id) return `props.id ${p.id} != ${id}`;
  if (p.level !== level) return `props.level ${p.level} != ${level}`;
  if (!p.name && p.name !== '') return 'missing name';
  if (!p.country) return 'missing country';
  const g = f.geometry;
  if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return `bad geometry (${g?.type})`;
  let bad = null;
  eachPolygon(g, (poly) => {
    for (const ring of poly) for (const [x, y] of ring) {
      if (x < -180.001 || x > 180.001 || y < -90.001 || y > 90.001) bad = `coord out of range [${x},${y}]`;
    }
  });
  if (bad) return bad;
  // Byte cap is the hard acceptance criterion (contract §8). Vertex count is a
  // soft display target (§4, "~4-5k"); a genuine many-island archipelago may
  // exceed it, so it is not a validation failure — 03-index WARNs on it.
  if (Buffer.byteLength(body) > MAX_BYTES_PER_REGION) return `over byte cap (${Buffer.byteLength(body)}B)`;
  return null;
}

function validateLevel(level, sampleEvery) {
  let entries = 0, missing = 0, badGeom = 0, checked = 0;
  const errs = [];
  if (level === 0) {
    const idx = JSON.parse(readFileSync(join(INDEX_DIR, 'adm0.json'), 'utf8'));
    entries = idx.length;
    idx.forEach((e, i) => {
      const f = join(GEO_DIR, 'adm0', `${e.id}.geojson`);
      if (!existsSync(f)) { missing++; return; }
      if (i % sampleEvery === 0) {
        checked++;
        const err = validateFeatureBody(readFileSync(f, 'utf8'), e.id, 0);
        if (err) { badGeom++; if (errs.length < 5) errs.push(`${e.id}: ${err}`); }
      }
    });
  } else {
    const dir = join(INDEX_DIR, `adm${level}`);
    const isoFiles = readdirSync(dir).filter((f) => f.endsWith('.json'));
    let gi = 0;
    for (const jf of isoFiles) {
      const iso = jf.replace('.json', '');
      const idx = JSON.parse(readFileSync(join(dir, jf), 'utf8'));
      entries += idx.length;
      for (const e of idx) {
        const f = join(GEO_DIR, `adm${level}`, iso, `${e.id}.geojson`);
        if (!existsSync(f)) { missing++; continue; }
        if (gi++ % sampleEvery === 0) {
          checked++;
          const err = validateFeatureBody(readFileSync(f, 'utf8'), e.id, level);
          if (err) { badGeom++; if (errs.length < 5) errs.push(`${e.id}: ${err}`); }
        }
      }
    }
  }
  const line = `ADM${level}: ${entries} index entries, ${missing} missing geo, ${checked} validated, ${badGeom} invalid`;
  if (missing || badGeom) { fail(line); errs.forEach((e) => console.log('      -', e)); }
  else ok(line);
  return entries;
}

const c0 = validateLevel(0, 1);   // all
const c1 = validateLevel(1, 1);   // all
const c2 = validateLevel(2, 20);  // 1-in-20 sample of the 60k (existence checked for all)

// ---- 3. Count cross-check vs regions.jsonl -------------------------------
const declared = JSON.parse(readFileSync(join(BUILD, 'counts.json'), 'utf8'));
if (c0 !== declared.adm0 || c1 !== declared.adm1 || c2 !== declared.adm2) {
  fail(`count mismatch: index[${c0},${c1},${c2}] vs normalize[${declared.adm0},${declared.adm1},${declared.adm2}]`);
} else ok(`counts consistent: ADM0=${c0} ADM1=${c1} ADM2=${c2}`);

// ---- Result ---------------------------------------------------------------
log(failures ? `VALIDATION FAILED (${failures} issue(s))` : 'VALIDATION PASSED');
process.exit(failures ? 1 : 0);
