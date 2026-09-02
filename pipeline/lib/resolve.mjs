// Reference implementation of the client-side (iOS) point->region resolver
// for the country-keyed bbox + point-in-polygon lookup variant.
//
// This is the canonical algorithm TheShelter iOS mirrors:
//   1. Country: bbox-prefilter index/adm0.json, PIP the candidate
//      geo/adm0/<ISO3>.geojson files; nearest-edge fallback if none contain it.
//   2. Province (ADM1): PIP the country's provinces; nearest-edge fallback.
//   3. District (ADM2): PIP the country's districts anywhere (exact); if none
//      contains the point, scope the nearest-district fallback to the resolved
//      PROVINCE — and if that province has no districts at all (coverage gap,
//      e.g. Svalbard), fall back UP to the province id. This keeps the returned
//      district consistent with the resolved province and never returns a distant
//      wrong-province district.
// Distances use an equirectangular (cos-lat) metric so longitude gaps are not
// over-weighted at mid/high latitude.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { INDEX_DIR, GEO_DIR } from '../../config.mjs';
import { pointInGeometry, bboxContains, bboxDist2, nearestEdgeDist2, latScale } from './geojson.mjs';

// How many bbox-nearest candidates to refine with true edge distance in the
// nearest fallback. Covers scattered-territory countries (e.g. UMI) whose bbox
// spans the globe and would otherwise win at bbox distance 0.
const NEAREST_SHORTLIST = 20;

const cache = new Map();
function loadJSON(file) {
  if (cache.has(file)) return cache.get(file);
  const v = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  cache.set(file, v);
  return v;
}
export function clearCache() { cache.clear(); }

const shardOf = (id) => id.split('.')[0];
const parentId = (id) => id.split('.').slice(0, -1).join('.');

function geoFile(level, id) {
  if (level === 0) return join(GEO_DIR, 'adm0', `${id}.geojson`);
  return join(GEO_DIR, `adm${level}`, shardOf(id), `${id}.geojson`);
}

// First entry whose polygon actually contains the point (bbox-prefiltered).
function pipHit(entries, lng, lat, level) {
  if (!entries) return null;
  for (const e of entries) {
    if (!bboxContains(e.bbox, lng, lat)) continue;
    const f = loadJSON(geoFile(level, e.id));
    if (f && pointInGeometry(lng, lat, f.geometry)) return e.id;
  }
  return null;
}

// Nearest entry by true polygon-edge distance (equirectangular), shortlisted by
// bbox distance first for speed.
function nearestEntry(entries, lng, lat, level, kx) {
  if (!entries || !entries.length) return null;
  const shortlist = entries
    .map((e) => ({ e, d: bboxDist2(e.bbox, lng, lat, kx) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, NEAREST_SHORTLIST);
  let best = null, bestD = Infinity;
  for (const { e } of shortlist) {
    const f = loadJSON(geoFile(level, e.id));
    if (!f) continue;
    const d = nearestEdgeDist2(lng, lat, f.geometry, kx);
    if (d < bestD) { bestD = d; best = e.id; }
  }
  return best ?? shortlist[0]?.e.id ?? null;
}

/** Resolve the country (ISO3) containing or nearest to (lat,lng). */
export function resolveCountry(lat, lng) {
  const adm0 = loadJSON(join(INDEX_DIR, 'adm0.json'));
  return pipHit(adm0, lng, lat, 0) ?? nearestEntry(adm0, lng, lat, 0, latScale(lat));
}

/**
 * Resolve a region id at `level` (0/1/2) for (lat,lng), falling back up the
 * hierarchy when the requested level has no data covering the point.
 */
export function resolveRegion(lat, lng, level) {
  const iso = resolveCountry(lat, lng);
  if (!iso) return null;
  if (level === 0) return iso;
  const kx = latScale(lat);

  // ADM1 (province) — needed for level 1 and to scope level 2.
  const adm1idx = loadJSON(join(INDEX_DIR, 'adm1', `${iso}.json`));
  let adm1id = null;
  if (adm1idx && adm1idx.length) {
    adm1id = pipHit(adm1idx, lng, lat, 1) ?? nearestEntry(adm1idx, lng, lat, 1, kx);
  }
  if (level === 1) return adm1id ?? iso;

  // ADM2 (district).
  const adm2idx = loadJSON(join(INDEX_DIR, 'adm2', `${iso}.json`));
  if (!adm2idx || !adm2idx.length) return adm1id ?? iso; // country has no districts

  // Exact containment anywhere in the country wins.
  const hit = pipHit(adm2idx, lng, lat, 2);
  if (hit) return hit;

  // No district contains the point: scope the nearest fallback to the resolved
  // province, so we never return a district in a different province.
  if (adm1id) {
    const scoped = adm2idx.filter((e) => parentId(e.id) === adm1id);
    if (scoped.length) return nearestEntry(scoped, lng, lat, 2, kx);
    return adm1id; // province has no districts (coverage gap) -> fall back up
  }
  return nearestEntry(adm2idx, lng, lat, 2, kx);
}

/** Resolve all three levels at once (for testing / debugging). */
export function resolveAll(lat, lng) {
  return {
    adm0: resolveRegion(lat, lng, 0),
    adm1: resolveRegion(lat, lng, 1),
    adm2: resolveRegion(lat, lng, 2),
  };
}
