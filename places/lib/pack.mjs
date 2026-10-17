// Read a built part (places-core / places-detail, schema 1) and build the in-memory index the reference resolver uses.
// The iOS PlaceIndex holds the same data in flat arrays; this is its Node twin, written for clarity over speed.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { gunzipChecked } from './io.mjs';
import { decodeGeometry, bboxOf, polygonContains, distanceKm, haversineKm, KM_PER_DEG } from './geometry.mjs';

export const LAYER = { country: 0, province: 1, water: 2, zone: 3, assignment: 4 };
export const SUPPORTED_SCHEMAS = new Set([1]);

/** Open a part from a .sqlite.gz path or buffer, or a .sqlite path. Returns { meta, areas, places, raw }. */
export function openPart(input) {
  const buf = Buffer.isBuffer(input) ? input : readFileSync(input);
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipChecked(buf) : buf;
  if (raw.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw new Error('not an SQLite file');
  const db = new Database(raw, { readonly: true });
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  if (!SUPPORTED_SCHEMAS.has(Number(meta.schema))) throw new Error(`unsupported schema ${meta.schema}`);
  const areas = db.prepare('SELECT * FROM areas ORDER BY id').all().map((a) => {
    const polys = decodeGeometry(a.geometry);
    return withAdmins({ ...a, polys, boxes: polys.map((p) => bboxOf([p], a.q)) });
  });
  const hasPlaces = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'places'").get().n > 0;
  const places = hasPlaces ? db.prepare('SELECT * FROM places ORDER BY cell, id').all() : null;
  db.close();
  return { meta, areas, places, raw };
}

/** A zone's administering countries (`admin`, space-separated bundle ids) as a set, for the band's zone tie. */
export function withAdmins(a) {
  a.admins = new Set(String(a.admin || '').split(/\s+/).filter(Boolean));
  return a;
}

const cellKey = (la, lo) => la * 360 + lo; // la 0..179, lo 0..359

/** A 1-degree grid over polygon boxes for one layer. */
class AreaGrid {
  constructor(areas) {
    this.areas = areas;
    this.cells = new Map();
    areas.forEach((a, ai) => {
      a.boxes.forEach((b, pi) => {
        const y0 = Math.max(0, Math.floor(b[1]) + 90);
        const y1 = Math.min(179, Math.floor(b[3]) + 90);
        const x0 = Math.max(0, Math.floor(b[0]) + 180);
        const x1 = Math.min(359, Math.floor(b[2]) + 180);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const k = cellKey(y, x);
            let arr = this.cells.get(k);
            if (!arr) this.cells.set(k, (arr = []));
            arr.push(ai * 65536 + pi);
          }
        }
      });
    });
  }

  /** The areas whose polygon holds the point, sorted by key. */
  containing(lat, lon) {
    const la = Math.min(179, Math.max(0, Math.floor(lat) + 90));
    const lo = Math.min(359, Math.max(0, Math.floor(lon) + 180));
    const hits = [];
    for (const v of this.cells.get(cellKey(la, lo)) || []) {
      const ai = Math.floor(v / 65536);
      const pi = v % 65536;
      const a = this.areas[ai];
      const b = a.boxes[pi];
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (hits.includes(a)) continue;
      if (polygonContains(a.polys[pi], lon * a.q, lat * a.q)) hits.push(a);
    }
    return hits.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  }

  /** The nearest area (by point-to-segment distance) within maxKm that passes `filter`; ties go to the smaller key. */
  nearest(lat, lon, maxKm, filter = null) {
    const dLat = Math.ceil(maxKm / KM_PER_DEG) + 1;
    const k = Math.cos((lat * Math.PI) / 180);
    const dLon = k * KM_PER_DEG * 360 <= maxKm * 2 || k < 1e-3 ? 180 : Math.min(180, Math.ceil(maxKm / (KM_PER_DEG * k)) + 1);
    const la = Math.floor(lat) + 90;
    const lo = Math.floor(lon) + 180;
    const seen = new Set();
    for (let y = Math.max(0, la - dLat); y <= Math.min(179, la + dLat); y++) {
      for (let dx = -dLon; dx <= dLon; dx++) {
        const x = (((lo + dx) % 360) + 360) % 360;
        for (const v of this.cells.get(cellKey(y, x)) || []) seen.add(Math.floor(v / 65536));
        if (dLon === 180 && dx === 179) break;
      }
    }
    let best = null;
    let bestKm = Infinity;
    for (const ai of [...seen].sort((p, q) => p - q)) {
      const a = this.areas[ai];
      if (filter && !filter(a)) continue;
      const d = distanceKm(a.polys, a.boxes, a.q, lon, lat, Math.min(maxKm, bestKm));
      if (d > maxKm) continue;
      if (d < bestKm || (d === bestKm && best && a.key < best.key)) {
        bestKm = d;
        best = a;
      }
    }
    return best ? { area: best, km: bestKm } : null;
  }
}

/** Towns sorted by cell (the pack's primary key order), with a cell -> [start, end) map. */
class TownGrid {
  constructor(places) {
    this.places = places;
    this.byId = new Map(places.map((p) => [p.id, p]));
    this.start = new Map();
    places.forEach((p, i) => {
      const r = this.start.get(p.cell);
      if (!r) this.start.set(p.cell, [i, i + 1]);
      else r[1] = i + 1;
    });
  }

  /** Every town within maxKm (haversine), with its distance. The cell window is sized in km, not in cells. */
  within(lat, lon, maxKm) {
    const out = [];
    const dLat = Math.ceil(maxKm / KM_PER_DEG) + 1;
    const k = Math.cos((lat * Math.PI) / 180);
    const dLon = k < 1e-3 ? 180 : Math.min(180, Math.ceil(maxKm / (KM_PER_DEG * k)) + 1);
    const la = Math.floor(lat) + 90;
    const lo = Math.floor(lon) + 180;
    const xs = new Set();
    for (let dx = -dLon; dx <= dLon; dx++) xs.add((((lo + dx) % 360) + 360) % 360);
    for (let y = Math.max(0, la - dLat); y <= Math.min(179, la + dLat); y++) {
      for (const x of xs) {
        const r = this.start.get(cellKey(y, x));
        if (!r) continue;
        for (let i = r[0]; i < r[1]; i++) {
          const p = this.places[i];
          const d = haversineKm(lat, lon, p.lat / 10000, p.lon / 10000);
          if (d <= maxKm) out.push({ town: p, km: d });
        }
      }
    }
    return out;
  }
}

/** The index over one core part and an optional detail part. */
export class PlaceIndex {
  constructor(core, detail = null) {
    this.core = core;
    this.detail = detail;
    const byLayer = (part, layer) => (part ? part.areas.filter((a) => a.layer === layer) : []);
    this.countries = new AreaGrid(byLayer(core, LAYER.country));
    this.waters = new AreaGrid(byLayer(core, LAYER.water));
    this.zones = new AreaGrid(byLayer(core, LAYER.zone));
    this.assignments = new AreaGrid(byLayer(core, LAYER.assignment));
    this.provinces = new AreaGrid(byLayer(detail, LAYER.province));
    this.towns = detail ? new TownGrid(detail.places || []) : null;
    this.byKey = new Map();
    for (const part of [core, detail]) if (part) for (const a of part.areas) this.byKey.set(a.key, a);
    this.countryByIso3 = new Map(byLayer(core, LAYER.country).map((a) => [a.iso3, a]));
  }

  get readiness() {
    return this.detail ? 'full' : 'core';
  }
}
