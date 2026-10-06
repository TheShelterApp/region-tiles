// Assigns an epicentre to a country (ADM0 id) the way the app resolves an event's region, so the area-history card
// counts the events the app itself places in that country. Mirrors iOS `RegionTilesDatabase.resolve` /
// `nearestCountry` / `nearestAdm0` and `RegionGeometry` (MainFeature/Sources/RegionTiles):
//   1. level by magnitude: ADM2 below M4, ADM1 for 4 <= M < 6, ADM0 from M6; then walk up to ADM0. At each level the
//      first region whose bounding box AND polygon (exterior minus holes, planar even-odd) contain the epicentre wins;
//      its country is the id's first dotted part (`JPN.12` -> `JPN`).
//   2. offshore: the OFFSHORE_CANDIDATES countries nearest by bounding box (equirectangular, longitude scaled by
//      cos(latitude)) are re-ranked by the nearest VERTEX of their outer rings; the nearest one counts if it is within
//      OFFSHORE_MAX_DEGREES (squared distance <= 4.5^2, about 500 km), else the event belongs to no country.
// The polygons are the bundle's own (geo/adm0, geo/adm1 — the same simplified geometry as regions.sqlite).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { INDEX_DIR, GEO_DIR } from '../../config.mjs';
import { OFFSHORE_MAX_DEGREES, OFFSHORE_CANDIDATES } from './config.mjs';

const readJSON = (f) => JSON.parse(readFileSync(f, 'utf8'));

/** GeoJSON geometry → [{exterior, holes}] like the app's `RegionPolygon`. */
export function polygonsOf(geometry) {
  if (!geometry) return [];
  const make = (rings) => (rings.length ? { exterior: rings[0], holes: rings.slice(1) } : null);
  if (geometry.type === 'Polygon') return [make(geometry.coordinates)].filter(Boolean);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(make).filter(Boolean);
  return [];
}

/** iOS `RegionGeometry.pointInRing`: even-odd ray cast in planar lng/lat. */
export function pointInRing(ring, lng, lat) {
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i], pj = ring[j];
    if (pi.length < 2 || pj.length < 2) continue;
    const xi = pi[0], yi = pi[1], xj = pj[0], yj = pj[1];
    if ((yi > lat) !== (yj > lat)) {
      const crossing = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (lng < crossing) inside = !inside;
    }
  }
  return inside;
}

/** iOS `RegionGeometry.pointInPolygons`: inside an exterior and in none of its holes. */
export function pointInPolygons(polygons, lng, lat) {
  for (const p of polygons) {
    if (pointInRing(p.exterior, lng, lat) && !p.holes.some((h) => pointInRing(h, lng, lat))) return true;
  }
  return false;
}

/** iOS `RegionBBox.contains`. */
export const bboxContains = (b, lng, lat) => lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];

/** iOS `RegionBBox.distanceSq`. */
export function bboxDistanceSq(b, lng, lat) {
  const dx = Math.max(b[0] - lng, 0, lng - b[2]) * Math.cos((lat * Math.PI) / 180);
  const dy = Math.max(b[1] - lat, 0, lat - b[3]);
  return dx * dx + dy * dy;
}

/** iOS `RegionGeometry.nearestVertexDistanceSq` (outer rings only). */
export function nearestVertexDistanceSq(polygons, lng, lat) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const p of polygons) {
    for (const pt of p.exterior) {
      if (pt.length < 2) continue;
      const dx = (pt[0] - lng) * cosLat;
      const dy = pt[1] - lat;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return best;
}

/** iOS `RegionTilesDatabase.level(for:)`. */
export const levelForMagnitude = (m) => (m < 4 ? 2 : m < 6 ? 1 : 0);

// A 1-degree grid of bounding boxes, so a lookup tests only the boxes over the epicentre's cell.
class BoxGrid {
  constructor() { this.cells = new Map(); }
  static key(x, y) { return x * 1000 + y; }
  insert(entry) {
    const [minX, minY, maxX, maxY] = entry.bbox;
    for (let x = Math.floor(minX); x <= Math.floor(maxX); x++) {
      for (let y = Math.floor(minY); y <= Math.floor(maxY); y++) {
        const k = BoxGrid.key(x, y);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(entry);
      }
    }
  }
  query(lng, lat) {
    // A point on a cell edge can sit in a box that starts on that edge: look at the neighbouring cells too.
    const seen = new Set();
    const out = [];
    for (const x of [Math.floor(lng), Math.ceil(lng) - 1]) {
      for (const y of [Math.floor(lat), Math.ceil(lat) - 1]) {
        for (const e of this.cells.get(BoxGrid.key(x, y)) || []) {
          if (!seen.has(e) && bboxContains(e.bbox, lng, lat)) { seen.add(e); out.push(e); }
        }
      }
    }
    return out;
  }
}

/** Loads the bundle's countries and provinces (index + geometry) from the repo. */
export function loadRegions({ indexDir = INDEX_DIR, geoDir = GEO_DIR, offshoreMaxDegrees = OFFSHORE_MAX_DEGREES } = {}) {
  const adm0 = readJSON(join(indexDir, 'adm0.json')).map((e) => ({
    ...e,
    level: 0,
    polygons: polygonsOf(readJSON(join(geoDir, 'adm0', `${e.id}.geojson`)).geometry),
  }));
  const adm1 = [];
  for (const c of adm0) {
    const file = join(indexDir, 'adm1', `${c.id}.json`);
    if (!existsSync(file)) continue;
    for (const e of readJSON(file)) {
      const g = join(geoDir, 'adm1', c.id, `${e.id}.geojson`);
      if (!existsSync(g)) continue;
      adm1.push({ ...e, level: 1, polygons: polygonsOf(readJSON(g).geometry) });
    }
  }
  return makeAssigner({ adm0, adm1, offshoreMaxDegrees });
}

/** The assigner over loaded regions: `assign(lat, lng, magnitude)` → `{iso3, name, offshore}` or null (open ocean). */
export function makeAssigner({ adm0, adm1 = [], offshoreMaxDegrees = OFFSHORE_MAX_DEGREES }) {
  const grids = { 0: new BoxGrid(), 1: new BoxGrid() };
  for (const e of adm0) grids[0].insert(e);
  for (const e of adm1) grids[1].insert(e);
  const names = new Map(adm0.map((e) => [e.id, e.name]));
  const iso3Of = (id) => id.split('.')[0];
  const maxSq = offshoreMaxDegrees * offshoreMaxDegrees;

  function nearestAdm0(lng, lat) {
    const ranked = adm0
      .map((e) => ({ e, d: bboxDistanceSq(e.bbox, lng, lat) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, OFFSHORE_CANDIDATES);
    let best = null;
    for (const { e } of ranked) {
      const d = nearestVertexDistanceSq(e.polygons, lng, lat);
      if (best === null || d < best.d) best = { e, d };
    }
    return best;
  }

  function assign(lat, lng, magnitude) {
    let target = Math.min(levelForMagnitude(magnitude), 1); // the bundle's ADM2 is never needed from M4.5
    for (; target >= 0; target--) {
      for (const e of grids[target].query(lng, lat)) {
        if (pointInPolygons(e.polygons, lng, lat)) {
          const iso3 = iso3Of(e.id);
          return { iso3, name: names.get(iso3) ?? e.name, offshore: false };
        }
      }
    }
    const best = nearestAdm0(lng, lat);
    if (best && best.d <= maxSq) return { iso3: best.e.id, name: best.e.name, offshore: true };
    return null;
  }

  return { assign, countries: adm0.map((e) => ({ id: e.id, name: e.name })) };
}
