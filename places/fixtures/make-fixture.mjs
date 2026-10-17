// A small fixture pack for the iOS contract runner (PlaceIndex and PlaceResolver over real data without the 4 MB
// pack): both parts of a built pack, cut to a few windows (Kanto, Istanbul and the Sea of Marmara, Cyprus and the
// Turkish coast, Crimea, Crete and the southern Aegean), plus the answers of the reference resolver inside them.
//
// Areas are clipped to each window grown by 1 degree (Sutherland-Hodgman per ring), so every answer inside a window,
// where every reach but the 500 km nearest-country rule is shorter than the margin, is the full pack's answer too; the
// generator checks that point for point and keeps only the points where it holds.
//
// The answers come from random points in each window and from the targeted sample of the release gate's parity run
// (lattice.mjs `targetedPoints`: off outlines at the band, tie and gap distances, around towns, exactly on vertices),
// each with its globe scale, chain step and short form, so `make contract` checks the arithmetic of the chain on real
// outlines without the pack.
//
// usage: node places/fixtures/make-fixture.mjs <dist/places/<version>> <out dir>
// Writes <out>/fixture-core.sqlite.gz, fixture-detail.sqlite.gz and fixture-golden.tsv, one point per line in the
// columns of `lattice.mjs answers` (lat, lon, mpp, kind = window[:sample kind], then per tier key, en, ru, short_en,
// short_ru, step); the coordinates as written are the ones answered.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openPart, PlaceIndex } from '../lib/pack.mjs';
import { Resolver } from '../resolve.mjs';
import { encodeGeometry, bboxOf, countVertices, rng } from '../lib/geometry.mjs';
import { writePart } from '../build.mjs';
import { targetedPoints, answerRow, latticeTsv, TIERS } from '../lattice.mjs';

export const WINDOWS = [
  { name: 'kanto', box: [138.8, 34.8, 140.9, 36.4] },
  { name: 'marmara', box: [26.0, 39.8, 30.5, 41.6] },
  { name: 'cyprus', box: [31.5, 34.4, 35.5, 37.0] },
  { name: 'crimea', box: [32.3, 44.2, 36.8, 46.3] },
  { name: 'crete', box: [23.0, 34.7, 27.0, 36.5] },
];
const MARGIN = 1;

function clipRing(ring, [x0, y0, x1, y1]) {
  // Sutherland-Hodgman against the four edges, in quantised units.
  let pts = [];
  for (let i = 0; i < ring.length; i += 2) pts.push([ring[i], ring[i + 1]]);
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1,
  ];
  const cut = [
    (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])],
    (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])],
    (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0],
    (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1],
  ];
  for (let e = 0; e < 4 && pts.length; e++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const inC = edges[e](cur);
      const inP = edges[e](prev);
      if (inC) {
        if (!inP) out.push(cut[e](prev, cur));
        out.push(cur);
      } else if (inP) {
        out.push(cut[e](prev, cur));
      }
    }
    pts = out;
  }
  const flat = [];
  for (const [x, y] of pts) {
    const qx = Math.round(x);
    const qy = Math.round(y);
    const n = flat.length;
    if (n && flat[n - 2] === qx && flat[n - 1] === qy) continue;
    flat.push(qx, qy);
  }
  if (flat.length >= 4 && flat[0] === flat[flat.length - 2] && flat[1] === flat[flat.length - 1]) flat.splice(-2, 2);
  return flat.length >= 6 ? Int32Array.from(flat) : null;
}

function clipArea(a, boxes) {
  const polys = [];
  for (const b of boxes) {
    const qb = b.map((v) => v * a.q);
    for (const poly of a.polys) {
      const outer = clipRing(poly[0], qb);
      if (!outer) continue;
      const rings = [outer];
      for (const hole of poly.slice(1)) {
        const h = clipRing(hole, qb);
        if (h) rings.push(h);
      }
      polys.push(rings);
    }
  }
  if (!polys.length) return null;
  const bb = bboxOf(polys, a.q);
  const { polys: _p, boxes: _b, id: _i, geometry: _g, ...rest } = a;
  return { ...rest, geometry: encodeGeometry(polys), vertices: countVertices(polys), min_lng: bb[0], min_lat: bb[1], max_lng: bb[2], max_lat: bb[3] };
}

const inBox = (b, lat, lon) => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];

function main() {
  const [packDir, out] = process.argv.slice(2);
  if (!packDir || !out) throw new Error('usage: node places/fixtures/make-fixture.mjs <pack dir> <out dir>');
  mkdirSync(out, { recursive: true });
  const core = openPart(join(packDir, 'places-core.sqlite.gz'));
  const detail = openPart(join(packDir, 'places-detail.sqlite.gz'));
  const grown = WINDOWS.map((w) => [w.box[0] - MARGIN, w.box[1] - MARGIN, w.box[2] + MARGIN, w.box[3] + MARGIN]);
  const overlaps = (a) => grown.some((b) => !(a.max_lng < b[0] || a.min_lng > b[2] || a.max_lat < b[1] || a.min_lat > b[3]));
  const cut = (areas) => areas.filter(overlaps).map((a) => clipArea(a, grown.filter((b) => !(a.max_lng < b[0] || a.min_lng > b[2] || a.max_lat < b[1] || a.min_lat > b[3])))).filter(Boolean);
  // A water's parent and whole must stay resolvable: keep the rows they name (clipped to nothing, they keep an empty geometry).
  const coreAreas = cut(core.areas);
  const keys = new Set(coreAreas.map((a) => a.key));
  for (const a of [...coreAreas]) {
    for (const k of [a.parent, a.whole]) {
      let cur = k ? core.areas.find((x) => x.key === k) : null;
      while (cur && !keys.has(cur.key)) {
        const { polys: _p, boxes: _b, id: _i, ...rest } = cur;
        coreAreas.push({ ...rest, geometry: encodeGeometry([]), vertices: 0 });
        keys.add(cur.key);
        cur = cur.parent ? core.areas.find((x) => x.key === cur.parent) : null;
      }
    }
  }
  const detailAreas = cut(detail.areas);
  const towns = detail.places.filter((t) => grown.some((b) => inBox(b, t.lat / 1e4, t.lon / 1e4)));
  const ids = new Set(towns.map((t) => t.id));
  for (const t of detail.places) if (ids.has(t.id) && !ids.has(t.metro)) towns.push(detail.places.find((m) => m.id === t.metro));
  const meta = { ...Object.fromEntries(Object.entries(core.meta).filter(([k]) => !k.startsWith('count_') && !['part', 'schema', 'geometry'].includes(k))), fixture: '1' };
  const c = writePart(join(out, 'fixture-core.sqlite'), 'core', coreAreas, null, meta);
  const d = writePart(join(out, 'fixture-detail.sqlite'), 'detail', detailAreas, towns.map((t) => ({ ...t })), { ...meta, min_population: detail.meta.min_population });

  // Answers: 60 random points per window, then the targeted points inside the windows; a point is kept where the
  // fixture answers every tier in both languages exactly as the full pack does.
  const fullR = new Resolver(new PlaceIndex(core, detail));
  const fixR = new Resolver(new PlaceIndex(openPart(join(out, 'fixture-core.sqlite.gz')), openPart(join(out, 'fixture-detail.sqlite.gz'))));
  const rnd = rng(20261017);
  const rows = [];
  let kept = 0;
  let dropped = 0;
  const answer = (kind, latText, lonText, mpp) => {
    const a = answerRow(fullR, Number(latText), Number(lonText), mpp);
    const b = answerRow(fixR, Number(latText), Number(lonText), mpp);
    if (TIERS.some((t) => !b[t].key || JSON.stringify(a[t]) !== JSON.stringify(b[t]))) {
      dropped++;
      return;
    }
    rows.push({ ...b, kind, text: [latText, lonText, String(mpp)] });
    kept++;
  };
  for (const w of WINDOWS) {
    for (let i = 0; i < 60; i++) {
      const lat = w.box[1] + rnd() * (w.box[3] - w.box[1]);
      const lon = w.box[0] + rnd() * (w.box[2] - w.box[0]);
      answer(w.name, lat.toFixed(6), lon.toFixed(6), 5000);
    }
  }
  for (const p of targetedPoints(fixR, 1500, 20261017)) {
    const w = WINDOWS.find((x) => inBox(x.box, p.lat, p.lon));
    if (w && !['uniform', 'polar', 'antimeridian'].includes(p.kind)) answer(`${w.name}:${p.kind}`, String(p.lat), String(p.lon), p.mpp);
  }
  writeFileSync(join(out, 'fixture-golden.tsv'), latticeTsv(rows));
  console.log(`fixture core ${c.size_bytes} B gz, detail ${d.size_bytes} B gz; ${kept} points x 3 tiers x en/ru (${dropped} differ from the full pack and are left out)`);
}

main();
