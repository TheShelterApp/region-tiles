// The lattice regression (final architecture section 3.3, check 7): the answers of a pack at a Fibonacci lattice of
// points on all three tiers in English and Russian, and the diff between two packs (normally the previous release,
// whose bytes are committed under places/dist/<version>/, and the candidate). Also the targeted sample of the iOS
// release gate: points where the chain is easiest to get wrong (near outlines at the band, gap and reach distances,
// zone ties, nested waters, town radii and ties, exact vertices, the antimeridian, the poles), answered by both
// resolvers and compared field by field (Scripts/check-place-pack.sh in the iOS repository).
//
// usage:
//   node places/lattice.mjs answers <core.gz> <detail.gz> --out <answers.tsv.gz> [--n 100000] [--points <points.tsv>]
//   node places/lattice.mjs points <core.gz> <detail.gz> --out <points.tsv> [--n 20000] [--seed 1] [--golden <golden.tsv>]
//   node places/lattice.mjs diff <old core.gz> <old detail.gz> <new core.gz> <new detail.gz> --report <diff.md>
//        [--n 100000] [--accepted places/accepted-diffs.md --version <candidate>] [--max-share 0.005]
// `answers` answers the Fibonacci lattice (the globe at its default metres per point), or with --points the points of a
// points file (lat, lon, mpp, kind; the coordinates are echoed as written). `points` writes a targeted sample of a pack.
// `diff` exits 1 when more than --max-share of the answers of any tier change without a matching line in the accepted
// file. An accepted line is a list item with a code span `tier old-key new-key`, where a key may be `*`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resolver, townRadiusKm, urbanReachKm } from './resolve.mjs';
import { fibonacci, rng, KM_PER_DEG } from './lib/geometry.mjs';
import { gzipDeterministic, ensureDir, readTsv } from './lib/io.mjs';
import { dirname } from 'node:path';

export const TIERS = ['globe', 'regional', 'city'];

const EMPTY = { key: '', en: '', ru: '', shortEn: '', shortRu: '', step: '' };

/** One point's answers per tier: the key, the names and short forms in both languages, and the chain step. */
export function answerRow(resolver, lat, lon, mpp = null) {
  const row = { lat, lon };
  for (const tier of TIERS) {
    const en = resolver.resolve({ lat, lon, tier, language: 'en', mpp });
    const ru = resolver.resolve({ lat, lon, tier, language: 'ru', mpp });
    row[tier] = en
      ? { key: en.key, en: en.name ?? '', ru: ru?.name ?? '', shortEn: en.shortName ?? '', shortRu: ru?.shortName ?? '', step: String(en.step) }
      : EMPTY;
  }
  return row;
}

/** Every lattice point's answer per tier: [{ lat, lon, globe: {key, en, ru, shortEn, shortRu, step}, regional: ..., city: ... }]. */
export function latticeAnswers(resolver, n) {
  return fibonacci(n).map(([lat, lon]) => answerRow(resolver, lat, lon));
}

/** The answers at the points of a points file ({ lat, lon, mpp, kind, text: [lat, lon, mpp] as written }). */
export function pointAnswers(resolver, points) {
  return points.map((p) => ({ ...answerRow(resolver, p.lat, p.lon, p.mpp), kind: p.kind, text: p.text }));
}

/**
 * The accepted lines of one release's section (`## <version>`) of accepted-diffs.md: a lattice change is a list item
 * with a code span `tier old-key new-key` (a key may be `*`); a part-parity difference (verify.mjs check 8) one with
 * `parity tier lat,lon core-key full-key`, the point as the report prints it. Only the candidate's own section counts,
 * so a line accepted for one release never waves a later change through.
 */
export function parseAccepted(path, version = null) {
  if (!path || !existsSync(path)) return [];
  const out = [];
  let section = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const h = line.match(/^##\s+(\S+)/);
    if (h) {
      section = h[1];
      continue;
    }
    if (version !== null && section !== version) continue;
    const m = line.match(/^\s*[-*]\s+`(globe|regional|city)\s+(\S+)\s+(\S+)`/);
    if (m) out.push({ tier: m[1], from: m[2], to: m[3] });
  }
  return out;
}

/** The accepted part-parity differences of one release: `tier lat,lon core-key full-key` strings. */
export function parseAcceptedParity(path, version) {
  if (!path || !existsSync(path)) return new Set();
  const out = new Set();
  let section = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const h = line.match(/^##\s+(\S+)/);
    if (h) {
      section = h[1];
      continue;
    }
    if (section !== version) continue;
    const m = line.match(/^\s*[-*]\s+`parity\s+(globe|regional)\s+(\S+)\s+(\S+)\s+(\S+)`/);
    if (m) out.add(`${m[1]} ${m[2]} ${m[3]} ${m[4]}`);
  }
  return out;
}

const matches = (acc, tier, from, to) => acc.some((a) => a.tier === tier && (a.from === '*' || a.from === from) && (a.to === '*' || a.to === to));

/** Compare two lattices: per tier the changed answers, grouped by (old key, new key), and the unaccepted share. */
export function diffLattices(oldRows, newRows, accepted = []) {
  const res = {};
  for (const tier of TIERS) {
    const groups = new Map();
    let changed = 0;
    let unaccepted = 0;
    let names = 0;
    for (let i = 0; i < oldRows.length; i++) {
      const a = oldRows[i][tier];
      const b = newRows[i][tier];
      const keyChange = a.key !== b.key;
      const nameChange = !keyChange && (a.en !== b.en || a.ru !== b.ru);
      if (!keyChange && !nameChange) continue;
      changed++;
      if (nameChange) names++;
      const from = keyChange ? a.key : `${a.key} "${a.en}" / "${a.ru}"`;
      const to = keyChange ? b.key : `"${b.en}" / "${b.ru}"`;
      const g = `${from}\u0000${to}`;
      if (!groups.has(g)) groups.set(g, { from, to, kind: keyChange ? kindOf(a.key, b.key) : 'name', n: 0, example: [oldRows[i].lat, oldRows[i].lon] });
      groups.get(g).n++;
      if (!matches(accepted, tier, a.key, b.key)) unaccepted++;
    }
    res[tier] = { points: oldRows.length, changed, nameOnly: names, unaccepted, unacceptedShare: unaccepted / oldRows.length,
      groups: [...groups.values()].sort((x, y) => y.n - x.n) };
  }
  return res;
}

function kindOf(a, b) {
  const t = (k) => (k || 'none').split(':')[0];
  return `${t(a)} -> ${t(b)}`;
}

export function diffMarkdown(diff, title) {
  const lines = [`# ${title}`, ''];
  for (const tier of TIERS) {
    const d = diff[tier];
    lines.push(`## ${tier}: ${d.changed} of ${d.points} answers changed (${(100 * d.changed / d.points).toFixed(3)} %), ` +
      `${d.nameOnly} by name only, ${d.unaccepted} not accepted (${(100 * d.unacceptedShare).toFixed(3)} %)`, '');
    if (!d.groups.length) {
      lines.push('No change.', '');
      continue;
    }
    lines.push('| Points | Kind | Old | New | Example (lat, lon) |', '|---|---|---|---|---|');
    for (const g of d.groups.slice(0, 400)) {
      lines.push(`| ${g.n} | ${g.kind} | ${g.from} | ${g.to} | ${g.example[0].toFixed(4)}, ${g.example[1].toFixed(4)} |`);
    }
    if (d.groups.length > 400) lines.push(`| ... | ${d.groups.length - 400} more groups | | | |`);
    lines.push('');
  }
  return lines.join('\n');
}

const TIER_COLUMNS = ['key', 'en', 'ru', 'short_en', 'short_ru', 'step'];

/**
 * The answers as TSV: lat, lon, mpp, kind, then per tier key, en, ru, short_en, short_ru and step. The iOS contract
 * runner writes the same columns for the same points, and the release gate compares the two files line by line.
 */
export function latticeTsv(rows) {
  const out = [['lat', 'lon', 'mpp', 'kind', ...TIERS.flatMap((t) => TIER_COLUMNS.map((c) => `${t}_${c}`))].join('\t')];
  for (const r of rows) {
    const lead = r.text ? [...r.text, r.kind] : [r.lat.toFixed(6), r.lon.toFixed(6), '', 'lattice'];
    out.push([...lead, ...TIERS.flatMap((t) => [r[t].key, r[t].en, r[t].ru, r[t].shortEn, r[t].shortRu, r[t].step])].join('\t'));
  }
  return out.join('\n') + '\n';
}

// ---- the targeted sample ------------------------------------------------------------------------------------------------

/** Metres per point at the globe tier, from its start (about 3,000 km camera distance) to the whole globe. */
export const SAMPLE_MPP = [500, 1500, 5000, 12000, 30000];

/** The kinds of the targeted sample and their shares of it. */
export const SAMPLE_KINDS = [
  ['country-edge', 0.26], ['zone-edge', 0.1], ['water-edge', 0.12], ['province-edge', 0.1], ['assignment-edge', 0.02], ['town', 0.14],
  ['town-pair', 0.06], ['vertex', 0.1], ['antimeridian', 0.04], ['polar', 0.02], ['uniform', 0.06],
];

/** Distances (km) from an outline at which the chain changes its answer, on both sides of it. */
const EDGE_KM = {
  'country-edge': [0.05, 0.5, 2, 8, 15, 21, 21.9, 22.1, 23, 30, 45, 49.5, 50.5, 80, 200, 499, 501],
  'zone-edge': [0.05, 0.3, 0.9, 1.1, 2, 10, 21.9, 22.1, 30],
  'water-edge': [0.01, 0.5, 3, 20, 49.5, 50.5],
  'province-edge': [0.01, 0.2, 2, 10],
  'assignment-edge': [0.01, 0.1, 0.5, 2],
};

/** A picker of a random edge of a layer's rings, weighted by edge count. */
function edgePicker(areas) {
  const rings = [];
  const cumulative = [];
  let total = 0;
  for (const a of areas) {
    for (const poly of a.polys) {
      for (const ring of poly) {
        if (ring.length < 6) continue;
        rings.push({ ring, q: a.q });
        total += ring.length / 2;
        cumulative.push(total);
      }
    }
  }
  return (rand) => {
    const r = rand() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] > r) hi = mid;
      else lo = mid + 1;
    }
    const { ring, q } = rings[lo];
    const n = ring.length / 2;
    const i = Math.floor(rand() * n);
    const j = (i + 1) % n;
    return { ax: ring[2 * i] / q, ay: ring[2 * i + 1] / q, bx: ring[2 * j] / q, by: ring[2 * j + 1] / q, yi: ring[2 * i + 1], xi: ring[2 * i], q };
  };
}

const clampLat = (lat) => Math.max(-89.9999, Math.min(89.9999, lat));
const wrapLon = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** The point east / north km from (lat, lon) in the local plane. */
function moved(lat, lon, eastKm, northKm) {
  const k = Math.max(Math.cos((lat * Math.PI) / 180), 1e-6);
  return [clampLat(lat + northKm / KM_PER_DEG), wrapLon(lon + eastKm / (KM_PER_DEG * k))];
}

/** A point at fraction t of an edge, moved d km along the edge's normal (d < 0: the other side). */
function offEdge(e, t, d) {
  const lon = e.ax + t * (e.bx - e.ax);
  const lat = e.ay + t * (e.by - e.ay);
  const ex = (e.bx - e.ax) * Math.cos((lat * Math.PI) / 180);
  const ey = e.by - e.ay;
  const length = Math.hypot(ex, ey);
  if (!(length > 0) || Math.abs(e.bx - e.ax) > 180) return null;
  return moved(lat, lon, (-ey / length) * d, (ex / length) * d);
}

/**
 * A deterministic targeted sample of a pack (n points, seeded): where an answer changes. Each point carries a globe
 * metres-per-point value from SAMPLE_MPP; the golden points come first when a golden file is given.
 */
export function targetedPoints(resolver, n, seed = 1, goldenPath = null) {
  const rand = rng(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const ix = resolver.ix;
  const pickers = {
    'country-edge': edgePicker(ix.countries.areas),
    'zone-edge': edgePicker(ix.zones.areas),
    'water-edge': edgePicker(ix.waters.areas),
    'province-edge': edgePicker(ix.provinces.areas),
    'assignment-edge': edgePicker(ix.assignments.areas),
  };
  const vertexPickers = [pickers['country-edge'], pickers['province-edge'], pickers['water-edge'], pickers['zone-edge']];
  const towns = ix.towns ? ix.towns.places : [];
  const out = [];
  const push = (lat, lon, kind, mpp = pick(SAMPLE_MPP)) => {
    if (Number.isFinite(lat) && Number.isFinite(lon)) out.push({ lat, lon, mpp, kind });
  };
  if (goldenPath) {
    // One point per golden id and globe scale (a golden id has a row per tier).
    const seen = new Set();
    for (const g of readTsv(goldenPath).rows) {
      const mpp = g.mpp ? Number(g.mpp) : 5000;
      const id = `${g.lat}|${g.lon}|${mpp}`;
      if (!seen.has(id)) push(Number(g.lat), Number(g.lon), 'golden', mpp);
      seen.add(id);
    }
  }
  for (const [kind, share] of SAMPLE_KINDS) {
    const count = Math.round(n * share);
    for (let made = 0, tries = 0; made < count && tries < count * 20; tries++) {
      const before = out.length;
      if (EDGE_KM[kind] && kind === 'assignment-edge' && !ix.assignments.areas.length) {
        break;
      } else if (EDGE_KM[kind]) {
        const p = offEdge(pickers[kind](rand), rand(), pick(EDGE_KM[kind]) * (rand() < 0.5 ? -1 : 1));
        if (p) push(p[0], p[1], kind);
      } else if (kind === 'town' && towns.length) {
        const t = towns[Math.floor(rand() * towns.length)];
        const R = townRadiusKm(t.pop);
        const U = urbanReachKm(t.pop);
        const d = pick([0.05, 1, U - 0.02, U + 0.02, R / 2, R, 2 * R, 10, 20, 30, 49.95, 50.05]);
        const bearing = rand() * 2 * Math.PI;
        if (d > 0) {
          const [lat, lon] = moved(t.lat / 1e4, t.lon / 1e4, d * Math.sin(bearing), d * Math.cos(bearing));
          push(lat, lon, kind);
        }
      } else if (kind === 'town-pair' && towns.length) {
        const a = towns[Math.floor(rand() * towns.length)];
        const near = ix.towns.within(a.lat / 1e4, a.lon / 1e4, 40).filter((x) => x.town.id !== a.id);
        if (near.length) {
          const b = near[Math.floor(rand() * near.length)].town;
          const ra = townRadiusKm(a.pop);
          const f = ra / (ra + townRadiusKm(b.pop)); // d_a / R_a = d_b / R_b along the segment from a to b
          const lat = a.lat / 1e4 + f * (b.lat - a.lat) / 1e4;
          const lon = a.lon / 1e4 + f * (b.lon - a.lon) / 1e4;
          const [plat, plon] = moved(lat, lon, (rand() - 0.5) * 0.04, (rand() - 0.5) * 0.04);
          push(plat, plon, kind);
        }
      } else if (kind === 'vertex') {
        const e = pick(vertexPickers)(rand);
        const mode = Math.floor(rand() * 4);
        if (mode === 0) push(e.yi / e.q, e.xi / e.q, kind); // the vertex itself
        else if (mode === 1) push(e.yi / e.q, wrapLon(e.ax + (rand() - 0.5) * 0.1), kind); // the ray through a vertex
        else if (mode === 2) push((e.ay + e.by) / 2, (e.ax + e.bx) / 2, kind); // an edge's midpoint
        else {
          const p = offEdge(e, rand(), (rand() - 0.5) * 2); // a golden-style point: 4 decimals near an outline
          if (p) push(Number(p[0].toFixed(4)), Number(p[1].toFixed(4)), kind);
        }
      } else if (kind === 'antimeridian') {
        const lat = -75 + 150 * rand();
        const r = rand();
        push(lat, r < 0.05 ? -180 : r < 0.1 ? 180 : r < 0.55 ? 179 + rand() : -180 + rand(), kind);
      } else if (kind === 'polar') {
        const south = rand() < 0.5;
        const r = rand();
        const lat = r < 0.05 ? 90 : 80 + 10 * rand();
        push(south ? -lat : lat, -180 + 360 * rand(), kind);
      } else if (kind === 'uniform') {
        push((Math.asin(2 * rand() - 1) * 180) / Math.PI, -180 + 360 * rand(), kind);
      }
      if (out.length > before) made++;
    }
  }
  return out;
}

export function pointsTsv(points) {
  return ['lat\tlon\tmpp\tkind', ...points.map((p) => [String(p.lat), String(p.lon), String(p.mpp), p.kind].join('\t'))].join('\n') + '\n';
}

export function readPoints(path) {
  return readTsv(path).rows.map((r) => ({
    lat: Number(r.lat), lon: Number(r.lon), mpp: r.mpp ? Number(r.mpp) : null, kind: r.kind, text: [r.lat, r.lon, r.mpp],
  }));
}

function opts(argv) {
  const pos = [];
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, o };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, o } = opts(rest);
  const n = Number(o.n || 100000);
  if (cmd === 'answers') {
    const resolver = Resolver.fromParts(pos[0], pos[1]);
    const rows = o.points ? pointAnswers(resolver, readPoints(o.points)) : latticeAnswers(resolver, n);
    ensureDir(dirname(o.out));
    writeFileSync(o.out, gzipDeterministic(Buffer.from(latticeTsv(rows))));
    console.log(`${o.points ? 'points' : 'lattice'}: ${rows.length} points x 3 tiers -> ${o.out}`);
  } else if (cmd === 'points') {
    const points = targetedPoints(Resolver.fromParts(pos[0], pos[1]), Number(o.n || 20000), Number(o.seed || 1), o.golden || null);
    ensureDir(dirname(o.out));
    writeFileSync(o.out, pointsTsv(points));
    const kinds = {};
    for (const p of points) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
    console.log(`points: ${points.length} (${Object.entries(kinds).map(([k, v]) => `${k} ${v}`).join(', ')}) -> ${o.out}`);
  } else if (cmd === 'diff') {
    const t0 = Date.now();
    const oldRows = latticeAnswers(Resolver.fromParts(pos[0], pos[1]), n);
    const newRows = latticeAnswers(Resolver.fromParts(pos[2], pos[3]), n);
    const diff = diffLattices(oldRows, newRows, parseAccepted(o.accepted, o.version ?? null));
    const md = diffMarkdown(diff, `Lattice diff (${n} points, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    if (o.report) {
      ensureDir(dirname(o.report));
      writeFileSync(o.report, md);
    }
    const max = Number(o['max-share'] || 0.005);
    let fail = false;
    for (const tier of TIERS) {
      const d = diff[tier];
      console.log(`${tier}: ${d.changed} changed, ${d.unaccepted} not accepted (${(100 * d.unacceptedShare).toFixed(3)} %)`);
      if (d.unacceptedShare > max) fail = true;
    }
    if (fail) {
      console.error(`FAIL: more than ${(100 * max).toFixed(2)} % of a tier's answers changed without a line in the accepted diffs`);
      process.exit(1);
    }
  } else {
    console.error('usage: lattice.mjs answers|points|diff ...');
    process.exit(2);
  }
}
