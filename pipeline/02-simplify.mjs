// Phase 2 — simplify geometry for display.
//
// For each normalized per-country FeatureCollection, run mapshaper Visvalingam
// (weighted) with -explode + keep-shapes so EVERY MultiPolygon part (island)
// survives — then recombine parts by id. (keep-shapes alone protects only whole
// features, so small islands would otherwise be dropped.) Finally enforce the
// per-region contract caps (<= ~5k vertices, <= ~150 KB) by re-simplifying any
// individual over-cap feature harder (a handful of Arctic/archipelago giants).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mapshaper from 'mapshaper';
import {
  NORM_DIR, BUILD, SIMPLIFY, MAX_VERTICES_PER_REGION, MAX_BYTES_PER_REGION, COORD_PRECISION, LEVELS,
} from '../config.mjs';
import { ensureDir, rmrf, log } from './lib/util.mjs';
import { countVertices, polygonArea } from './lib/geojson.mjs';

const SIMPLE_DIR = join(BUILD, 'simplified');
const precision = 1 / 10 ** COORD_PRECISION;

// Recombine exploded single-part features back into per-id Polygon/MultiPolygon.
function recombine(fc) {
  const byId = new Map();
  const order = [];
  for (const f of fc.features) {
    const id = f.properties.id;
    if (!byId.has(id)) { byId.set(id, { props: f.properties, polys: [] }); order.push(id); }
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') byId.get(id).polys.push(g.coordinates);
    else if (g.type === 'MultiPolygon') for (const p of g.coordinates) byId.get(id).polys.push(p);
  }
  return {
    type: 'FeatureCollection',
    features: order.map((id) => {
      const { props, polys } = byId.get(id);
      const geometry = polys.length === 1
        ? { type: 'Polygon', coordinates: polys[0] }
        : { type: 'MultiPolygon', coordinates: polys };
      return { type: 'Feature', properties: props, geometry };
    }),
  };
}

async function simplifyString(geojsonStr, pct) {
  // -explode so keep-shapes protects EACH MultiPolygon part (island), not just
  // the whole feature; without it small islands are dropped, shrinking bboxes and
  // misattributing offshore/island epicenters. Parts are recombined by id after.
  // mapshaper accepts a percent string (e.g. "45%", "0.4%") for the keep fraction.
  const cmd = `-i in.json -explode -simplify visvalingam weighted percentage=${pct * 100}% keep-shapes ` +
    `-o out.json format=geojson precision=${precision}`;
  const out = await mapshaper.applyCommands(cmd, { 'in.json': geojsonStr });
  return recombine(JSON.parse(out['out.json'].toString()));
}

function featureBytes(feature) {
  return Buffer.byteLength(JSON.stringify({ type: 'FeatureCollection', features: [feature] }));
}

const overCap = (f) =>
  countVertices(f.geometry) > MAX_VERTICES_PER_REGION || featureBytes(f) > MAX_BYTES_PER_REGION;

// Last-resort: drop the smallest MultiPolygon parts (tiny islets) until the
// feature fits the byte cap, always keeping the largest part. Used only when
// simplification alone can't shrink a district with a huge number of parts
// (keep-shapes floors every part), e.g. an Arctic archipelago district.
function capByDroppingParts(feature, maxBytes) {
  const g = feature.geometry;
  if (g.type !== 'MultiPolygon') return feature;
  const overhead = Buffer.byteLength(JSON.stringify(
    { type: 'FeatureCollection', features: [{ type: 'Feature', properties: feature.properties, geometry: { type: 'MultiPolygon', coordinates: [] } }] }));
  const parts = g.coordinates
    .map((poly) => ({ poly, area: polygonArea(poly), bytes: Buffer.byteLength(JSON.stringify(poly)) }))
    .sort((a, b) => b.area - a.area);
  const kept = [];
  let total = overhead;
  for (const p of parts) {
    if (kept.length && total + p.bytes > maxBytes) break;
    kept.push(p.poly);
    total += p.bytes;
  }
  const mk = (polys) => ({
    ...feature,
    geometry: polys.length === 1
      ? { type: 'Polygon', coordinates: polys[0] }
      : { type: 'MultiPolygon', coordinates: polys },
  });
  // Exact trim: the greedy estimate ignores MultiPolygon array separators, so
  // pop the smallest kept parts until the ACTUAL serialized size fits.
  let f = mk(kept);
  while (kept.length > 1 && featureBytes(f) > maxBytes) { kept.pop(); f = mk(kept); }
  return f;
}

// Re-simplify a single over-cap feature until it fits, halving the percentage;
// if it still won't fit (many-part archipelago), drop the smallest parts.
async function capFeature(feature, startPct, stats) {
  let pct = startPct;
  let f = feature;
  let guard = 0;
  while (overCap(f) && pct > 0.004 && guard < 12) {
    pct *= 0.5;
    const fc = await simplifyString(JSON.stringify({ type: 'FeatureCollection', features: [feature] }), pct);
    f = fc.features[0];
    guard++;
  }
  // Part-drop is a last resort to meet the HARD byte cap only (150 KB is the
  // contract's file-size acceptance criterion). The vertex count is a soft
  // display target — a genuine many-island archipelago legitimately exceeds it,
  // so we don't drop real islands just to hit the vertex target.
  if (featureBytes(f) > MAX_BYTES_PER_REGION && f.geometry.type === 'MultiPolygon') {
    const before = f.geometry.coordinates.length;
    f = capByDroppingParts(f, MAX_BYTES_PER_REGION);
    const after = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.length : 1;
    if (stats) stats.dropped.push(`${f.properties.id}: kept ${after}/${before} parts`);
  }
  return f;
}

async function processLevel(level) {
  const inDir = join(NORM_DIR, `adm${level}`);
  const outDir = join(SIMPLE_DIR, `adm${level}`);
  ensureDir(outDir);
  const files = readdirSync(inDir).filter((f) => f.endsWith('.geojson'));
  const pct = SIMPLIFY[level].percent;
  let capped = 0, totalFeat = 0;
  const stats = { dropped: [] };

  for (const file of files) {
    const raw = readFileSync(join(inDir, file), 'utf8');
    const fc = await simplifyString(raw, pct);
    // Enforce per-feature caps.
    for (let i = 0; i < fc.features.length; i++) {
      const f = fc.features[i];
      if (overCap(f)) {
        fc.features[i] = await capFeature(f, pct, stats);
        capped++;
      }
    }
    totalFeat += fc.features.length;
    writeFileSync(join(outDir, file), JSON.stringify(fc));
  }
  log(`ADM${level}: simplified ${files.length} countries, ${totalFeat} features, ${capped} over-cap re-simplified` +
    (stats.dropped.length ? `; part-dropped: ${stats.dropped.join(', ')}` : ''));
}

async function main() {
  rmrf(SIMPLE_DIR);
  ensureDir(SIMPLE_DIR);
  for (const level of LEVELS) await processLevel(level);
  log('Simplify complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
