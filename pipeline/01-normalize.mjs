// Phase 1 — normalize + derive hierarchy.
//
// Produces, per level, one FeatureCollection per country under .build/norm/,
// with clean properties {id, name, level, country} and full-resolution geometry,
// plus a master regions.jsonl (identity + hierarchy). The dotted id scheme
// (CUB / CUB.7 / CUB.7.3) is derived here:
//   - ADM0 id = ISO3               (from Natural Earth admin-0)
//   - ADM1 id = <ISO3>.<n>          (NE admin-1, n = stable 1-based per country)
//   - ADM2 id = <ISO3>.<n>.<m>      (geoBoundaries ADM2, parent n via point-in-poly)
//
// NeoFeoda carries no hierarchy, so ADM2->ADM1 parenting is computed fresh via a
// representative-point-in-polygon join (bbox-prefiltered, nearest-ADM1 fallback so
// no district is ever left unparented).
import { readdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import {
  SRC_ADM2, SRC_NE_ADMIN1, SRC_NE_ADMIN0, NORM_DIR, REGIONS_JSONL, BUILD,
} from '../config.mjs';
import { ensureDir, rmrf, log } from './lib/util.mjs';
import { canonIso, iso3FromAdmin0, nameFromAdmin0 } from './lib/iso.mjs';
import {
  bbox, bboxContains, bboxDist2, representativePoint, pointInGeometry, countVertices, latScale,
} from './lib/geojson.mjs';

const isPoly = (g) => g && (g.type === 'Polygon' || g.type === 'MultiPolygon');

function cleanName(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Load ADM0 (Natural Earth admin-0), keyed by canonical ISO3.
// ---------------------------------------------------------------------------
function loadAdm0() {
  log('Loading Natural Earth admin-0 ...');
  const gj = JSON.parse(readFileSync(SRC_NE_ADMIN0, 'utf8'));
  const byIso = new Map();
  for (const f of gj.features) {
    if (!isPoly(f.geometry)) continue;
    const iso = iso3FromAdmin0(f.properties);
    if (!iso || iso === '-99' || iso === '-1') continue;
    const name = cleanName(nameFromAdmin0(f.properties));
    const existing = byIso.get(iso);
    if (existing) {
      // Merge duplicate country features into one MultiPolygon.
      existing.geometry = mergeGeoms(existing.geometry, f.geometry);
    } else {
      byIso.set(iso, { iso, name, geometry: f.geometry });
    }
  }
  log(`ADM0: ${byIso.size} countries loaded`);
  return byIso;
}

// Concatenate two Polygon/MultiPolygon geometries into a MultiPolygon.
function mergeGeoms(a, b) {
  const polys = [];
  for (const g of [a, b]) {
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else for (const p of g.coordinates) polys.push(p);
  }
  return { type: 'MultiPolygon', coordinates: polys };
}

// ---------------------------------------------------------------------------
// Load ADM1 (Natural Earth admin-1), grouped by canonical ISO3, with stable
// per-country ordinals and precomputed bbox for the ADM2 join.
// ---------------------------------------------------------------------------
function loadAdm1() {
  log('Loading Natural Earth admin-1 ...');
  const gj = JSON.parse(readFileSync(SRC_NE_ADMIN1, 'utf8'));
  const byIso = new Map(); // iso -> array of {code, name, geometry}
  for (const f of gj.features) {
    if (!isPoly(f.geometry)) continue;
    const p = f.properties;
    const iso = canonIso(p.adm0_a3 || p.sov_a3 || p.iso_a2);
    if (!iso) continue;
    const code = p.adm1_code || p.ne_id || cleanName(p.name).replace(/\W/g, '');
    const name = cleanName(p.name || p.name_en || p.gn_name || code);
    if (!byIso.has(iso)) byIso.set(iso, []);
    byIso.get(iso).push({ code: String(code), name, geometry: f.geometry });
  }
  // Stable ordinal per country: sort by adm1_code string.
  let total = 0;
  for (const [iso, arr] of byIso) {
    arr.sort((x, y) => (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
    arr.forEach((a, i) => {
      a.n = i + 1;
      a.id = `${iso}.${a.n}`;
      a.bbox = bbox(a.geometry);
    });
    total += arr.length;
  }
  log(`ADM1: ${total} provinces across ${byIso.size} countries`);
  return byIso;
}

// ---------------------------------------------------------------------------
// Assign an ADM2 feature's representative point to a parent ADM1 ordinal.
// ---------------------------------------------------------------------------
function assignParent(repPt, adm1List) {
  const [x, y] = repPt;
  // 1. Point-in-polygon over bbox-matching candidates.
  for (const a of adm1List) {
    if (bboxContains(a.bbox, x, y) && pointInGeometry(x, y, a.geometry)) return a;
  }
  // 2. Nearest ADM1 by bbox distance (equirectangular; guaranteed non-null when
  //    the list is non-empty).
  const kx = latScale(y);
  let best = null, bestD = Infinity;
  for (const a of adm1List) {
    const d = bboxDist2(a.bbox, x, y, kx);
    if (d < bestD) { bestD = d; best = a; }
  }
  return best;
}

// Write a FeatureCollection of one region-level for one country.
function writeCollection(level, iso, features) {
  const dir = join(NORM_DIR, `adm${level}`);
  ensureDir(dir);
  writeFileSync(join(dir, `${iso}.geojson`), JSON.stringify({ type: 'FeatureCollection', features }));
}

async function main() {
  rmrf(BUILD);
  ensureDir(BUILD);
  ensureDir(NORM_DIR);

  const adm0 = loadAdm0();
  const adm1 = loadAdm1();

  const regionsOut = createWriteStream(REGIONS_JSONL);
  const emit = (r) => regionsOut.write(JSON.stringify(r) + '\n');
  const counts = { adm0: 0, adm1: 0, adm2: 0 };

  // ISO3 set that will actually appear (countries that have ADM2 files, plus all
  // ADM0/ADM1 countries so higher-level fallbacks always resolve).
  const adm2Files = readdirSync(SRC_ADM2).filter((f) => f.endsWith('.geojson'));
  const adm2Isos = new Set(adm2Files.map((f) => f.replace('.geojson', '')));

  // Union of every country we know about.
  const allIsos = new Set([...adm0.keys(), ...adm1.keys(), ...adm2Isos]);

  // ---- ADM0 + ADM1 emission (for every country) --------------------------
  const synthAdm0 = [];
  for (const iso of allIsos) {
    // ADM0 geometry: prefer NE admin-0; else synthesize from the country's ADM1.
    let a0 = adm0.get(iso);
    if (!a0) {
      const list = adm1.get(iso);
      if (list && list.length) {
        let geom = list[0].geometry;
        for (let i = 1; i < list.length; i++) geom = mergeGeoms(geom, list[i].geometry);
        a0 = { iso, name: list[0].name.split(',')[0] || iso, geometry: geom };
        synthAdm0.push(iso);
      }
    }
    if (a0) {
      const name = a0.name || iso;
      writeCollection(0, iso, [{
        type: 'Feature',
        properties: { id: iso, name, level: 0, country: iso },
        geometry: a0.geometry,
      }]);
      emit({ id: iso, level: 0, name, country: iso, parent: null });
      counts.adm0++;
    }

    // ADM1 provinces.
    const list = adm1.get(iso);
    if (list && list.length) {
      const feats = list.map((a) => ({
        type: 'Feature',
        properties: { id: a.id, name: a.name, level: 1, country: iso },
        geometry: a.geometry,
      }));
      writeCollection(1, iso, feats);
      for (const a of list) emit({ id: a.id, level: 1, name: a.name, country: iso, parent: iso, src: a.code });
      counts.adm1 += list.length;
    }
  }
  if (synthAdm0.length) log(`ADM0 synthesized (no NE admin-0 match) for: ${synthAdm0.join(', ')}`);

  // ---- ADM2 emission (per country file) ----------------------------------
  let noAdm1Countries = 0;
  let nearestFallbacks = 0;
  for (const file of adm2Files) {
    const iso = file.replace('.geojson', '');
    const gj = JSON.parse(readFileSync(join(SRC_ADM2, file), 'utf8'));
    let adm1List = adm1.get(iso);

    // Guard: country has ADM2 but no ADM1 -> synthesize a single ADM1 covering it.
    if (!adm1List || !adm1List.length) {
      noAdm1Countries++;
      const a0 = adm0.get(iso);
      const geom = a0 ? a0.geometry : { type: 'MultiPolygon', coordinates: [] };
      adm1List = [{ id: `${iso}.1`, n: 1, name: (a0?.name || iso), code: `${iso}-SYN1`, geometry: geom, bbox: bbox(geom) }];
      // Emit the synthesized ADM1 so the level resolves.
      writeCollection(1, iso, [{
        type: 'Feature',
        properties: { id: `${iso}.1`, name: adm1List[0].name, level: 1, country: iso },
        geometry: geom,
      }]);
      emit({ id: `${iso}.1`, level: 1, name: adm1List[0].name, country: iso, parent: iso, src: 'synth' });
      counts.adm1 += 1;
    }

    // Assign parent for each district.
    const staged = [];
    for (const f of gj.features) {
      if (!isPoly(f.geometry)) continue;
      const p = f.properties || {};
      const name = cleanName(p.shapeName || p.name || '');
      const shapeId = String(p.shapeID || p.shapeId || `${iso}-${name}`);
      const repPt = representativePoint(f.geometry);
      const parent = assignParent(repPt, adm1List);
      if (parent && !pointInGeometry(repPt[0], repPt[1], parent.geometry)) nearestFallbacks++;
      staged.push({ name, shapeId, parentN: parent ? parent.n : 1, geometry: f.geometry });
    }

    // Order within parent by shapeID (stable) -> assign m.
    staged.sort((a, b) => (a.parentN - b.parentN) || (a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0));
    const mCounter = new Map();
    const feats = [];
    for (const s of staged) {
      const m = (mCounter.get(s.parentN) || 0) + 1;
      mCounter.set(s.parentN, m);
      const id = `${iso}.${s.parentN}.${m}`;
      feats.push({
        type: 'Feature',
        properties: { id, name: s.name, level: 2, country: iso },
        geometry: s.geometry,
      });
      emit({ id, level: 2, name: s.name, country: iso, parent: `${iso}.${s.parentN}`, src: s.shapeId });
    }
    writeCollection(2, iso, feats);
    counts.adm2 += feats.length;
  }

  await new Promise((res) => regionsOut.end(res));

  log(`ADM2: ${counts.adm2} districts; ${noAdm1Countries} countries needed a synthesized ADM1; ${nearestFallbacks} districts used nearest-ADM1 fallback`);
  log(`Counts: ADM0=${counts.adm0} ADM1=${counts.adm1} ADM2=${counts.adm2}`);
  writeFileSync(join(BUILD, 'counts.json'), JSON.stringify(counts, null, 2));
  log('Normalize complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
