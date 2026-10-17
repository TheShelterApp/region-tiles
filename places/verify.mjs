// P3: verify a built pack (final architecture section 3.3; CI fails on any failed check) and write the review reports.
//
// usage: node places/verify.mjs --pack <dist/places/<version>> --sources <archive or dir> --bundle <regions.sqlite.gz>
//                               [--previous <dir with places-core/detail.sqlite.gz>] [--n 100000] [--rebuild]
//                               [--reports <dir>]
// --rebuild builds the pack again into a temporary directory and compares the sha256 (check 10).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openPart, PlaceIndex, LAYER } from './lib/pack.mjs';
import { Resolver } from './resolve.mjs';
import { decodeGeometry, encodeGeometry, fromGeoJSON, quantise, countVertices, bboxOf, fibonacci, polygonContains } from './lib/geometry.mjs';
import { gunzipChecked, sha256, readTsv, ensureDir, untar, stableStringify } from './lib/io.mjs';
import { nameProblems, isRussian } from './lib/names.mjs';
import { latticeAnswers, diffLattices, diffMarkdown, parseAccepted, latticeTsv, TIERS } from './lattice.mjs';
import { gzipDeterministic } from './lib/io.mjs';
import { writeReviewReports } from './reports.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WORLDS = new Set(['northAmerica', 'southAmerica', 'northAfrica', 'tropicalAfrica', 'antarctica', 'oceania', 'westernEurope',
  'easternEurope', 'centralAsia', 'eastAsia', 'southAsia', 'southEastAsia', 'westernAsia']);
// Waters whose chain may end in another ocean than the adjacency search finds: genuine boundary cases (reviewed).
const OCEAN_ALLOW = new Set(['Malacca Strait', 'Strait of Magellan', 'Drake Passage', 'Scotia Sea', 'Davis Strait']);
// Natural Earth features that overlap two oceans without being inside either: the strait wins by rank (reviewed).
const NESTING_ALLOW = new Set(['Drake Passage']);
// Rows whose Russian name may be non-Cyrillic (none today), and names that are acronyms written in capitals.
const RU_ALLOW = new Set();
const CAPS_ALLOW = new Set(['place:11888170']); // VNIISSOK, a settlement named after its research institute

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { n: '100000' };
  for (let i = 0; i < a.length; i++) {
    const k = a[i].replace(/^--/, '');
    if (k === 'rebuild') o.rebuild = true;
    else o[k] = a[++i];
  }
  for (const k of ['pack', 'sources', 'bundle']) if (!o[k]) throw new Error(`missing --${k}`);
  return o;
}

const results = [];
function check(id, name, fn) {
  const t0 = Date.now();
  let ok = false;
  let detail = '';
  try {
    const r = fn();
    ok = r.ok;
    detail = r.detail || '';
  } catch (e) {
    detail = `error: ${e.stack || e.message}`;
  }
  results.push({ id, name, ok, detail, ms: Date.now() - t0 });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}. ${name}${detail ? `: ${detail.split('\n')[0]}` : ''}`);
}

function loadBundle(path) {
  const pointer = JSON.parse(readFileSync(join(ROOT, 'regions-db.json'), 'utf8'));
  const gz = readFileSync(path);
  const h = sha256(gz);
  if (h !== pointer.sha256) throw new Error(`regions bundle sha256 ${h} != regions-db.json`);
  return { db: new Database(gunzipChecked(gz), { readonly: true }), sha256: h };
}

function sourcesRoot(path, work) {
  if (!path.endsWith('.tar.gz')) return path;
  const dir = join(work, 'sources');
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
  untar(gunzipChecked(readFileSync(path)), dir);
  return join(dir, readdirSync(dir)[0]);
}

async function main() {
  const opt = parseArgs();
  const packDir = opt.pack;
  const reports = opt.reports || join(packDir, 'reports');
  ensureDir(reports);
  const work = join(packDir, '..', '.work-verify');
  ensureDir(work);
  const corePath = join(packDir, 'places-core.sqlite.gz');
  const detailPath = join(packDir, 'places-detail.sqlite.gz');
  const core = openPart(corePath);
  const detail = openPart(detailPath);
  const bundle = loadBundle(opt.bundle);
  const srcRoot = sourcesRoot(opt.sources, work);
  const full = new Resolver(new PlaceIndex(core, detail));
  const coreOnly = new Resolver(new PlaceIndex(core, null));
  const n = Number(opt.n);
  const pointer = JSON.parse(readFileSync(join(packDir, 'places-db.json'), 'utf8'));

  // 0. meta: schema, part, version and counts, as the app checks them before a swap.
  check(0, 'meta matches the pointer and the tables', () => {
    const bad = [];
    for (const [part, p] of [['core', core], ['detail', detail]]) {
      const m = p.meta;
      if (m.schema !== '1') bad.push(`${part} schema ${m.schema}`);
      if (m.part !== part) bad.push(`${part} part ${m.part}`);
      if (m.version !== pointer.version) bad.push(`${part} version ${m.version} != pointer ${pointer.version}`);
      if (Number(m.count_areas) !== p.areas.length) bad.push(`${part} count_areas`);
      if (Number(m.count_places) !== (p.places ? p.places.length : 0)) bad.push(`${part} count_places`);
      for (const [k, layer] of [['countries', 0], ['provinces', 1], ['waters', 2], ['zones', 3]]) {
        if (Number(m[`count_${k}`]) !== p.areas.filter((a) => a.layer === layer).length) bad.push(`${part} count_${k}`);
      }
      const ptr = pointer.parts.find((x) => x.name === part);
      const gz = readFileSync(join(packDir, `places-${part}.sqlite.gz`));
      if (!ptr || ptr.sha256 !== sha256(gz) || ptr.size_bytes !== gz.length || ptr.inflated_bytes !== p.raw.length) bad.push(`${part} pointer`);
      const qc = new Database(p.raw, { readonly: true }).pragma('quick_check', { simple: true });
      if (qc !== 'ok') bad.push(`${part} quick_check ${qc}`);
    }
    return { ok: !bad.length, detail: bad.join('; ') };
  });

  // 1. Round trip: every geometry decodes and re-encodes to the same bytes; counts and boxes match the stored ones.
  check(1, 'round trip of every geometry', () => {
    const bad = [];
    for (const p of [core, detail]) {
      for (const a of p.areas) {
        const db = new Database(p.raw, { readonly: true });
        const blob = db.prepare('SELECT geometry FROM areas WHERE id = ?').get(a.id).geometry;
        db.close();
        if (!encodeGeometry(decodeGeometry(blob)).equals(blob)) bad.push(`${a.key} re-encode`);
        if (countVertices(a.polys) !== a.vertices) bad.push(`${a.key} vertices`);
        const b = bboxOf(a.polys, a.q);
        if (Math.abs(b[0] - a.min_lng) > 1e-9 || Math.abs(b[1] - a.min_lat) > 1e-9 || Math.abs(b[2] - a.max_lng) > 1e-9 || Math.abs(b[3] - a.max_lat) > 1e-9) bad.push(`${a.key} bbox`);
        for (const poly of a.polys) for (const ring of poly) if (ring.length < 6) bad.push(`${a.key} ring < 3 vertices`);
        if (bad.length > 20) break;
      }
    }
    return { ok: !bad.length, detail: bad.slice(0, 10).join('; ') };
  });

  // 2. Outlines identical to the bundle.
  check(2, 'country and province outlines equal the regions bundle', () => {
    const bad = [];
    if (core.meta.regions_bundle_sha256 !== bundle.sha256 || detail.meta.regions_bundle_sha256 !== bundle.sha256) bad.push('meta.regions_bundle_sha256');
    const rows = bundle.db.prepare('SELECT id, level, geometry FROM regions WHERE level <= 1').all();
    const byKey = new Map([...core.areas, ...detail.areas].map((a) => [a.key, a]));
    let n0 = 0;
    let n1 = 0;
    for (const r of rows) {
      const a = byKey.get(`adm${r.level}:${r.id}`);
      if (!a) {
        bad.push(`missing adm${r.level}:${r.id}`);
        continue;
      }
      const src = fromGeoJSON(JSON.parse(gunzipChecked(r.geometry).toString('utf8')));
      if (src.length !== a.polys.length) {
        bad.push(`${a.key} polygons`);
        continue;
      }
      for (let p = 0; p < src.length; p++) {
        if (src[p].length !== a.polys[p].length) {
          bad.push(`${a.key} rings`);
          break;
        }
        for (let k = 0; k < src[p].length; k++) {
          const s = src[p][k];
          const q = a.polys[p][k];
          if (s.length !== q.length) {
            bad.push(`${a.key} vertices`);
            break;
          }
          for (let i = 0; i < s.length; i++) {
            const err = Math.abs(q[i] / a.q - s[i]);
            if (r.level === 0 ? q[i] !== Math.round(s[i] * a.q) : err > 0.5 / a.q + 1e-9) {
              bad.push(`${a.key} vertex ${i}`);
              break;
            }
          }
        }
      }
      if (r.level === 0) n0++;
      else n1++;
    }
    if (n0 !== core.areas.filter((a) => a.layer === 0).length) bad.push('country count');
    if (n1 !== detail.areas.filter((a) => a.layer === 1).length) bad.push('province count');
    return { ok: !bad.length, detail: `${n0} countries vertex for vertex, ${n1} provinces within half a quantum${bad.length ? `; ${bad.slice(0, 8).join('; ')}` : ''}` };
  });

  // 3. The marine layer is a partition, except Natural Earth 5.2's nested features: every overlap must be a water inside
  //    one of its own ancestors (the resolver picks the deepest). Gaps <= 0.2 % of water points.
  const lattice = fibonacci(n);
  let partition = null;
  check(3, 'the marine layer is a partition (nesting only along parent chains)', () => {
    const ix = full.ix;
    const byKey = ix.byKey;
    const ancestors = (w) => {
      const out = new Set();
      let cur = w.parent ? byKey.get(w.parent) : null;
      for (let i = 0; cur && i < 20; i++) {
        out.add(cur.key);
        if (cur.whole) out.add(cur.whole);
        cur = cur.parent ? byKey.get(cur.parent) : null;
      }
      return out;
    };
    let water = 0;
    let gaps = 0;
    let nested = 0;
    const conflicts = [];
    const pairs = new Map();
    for (const [lat, lon] of lattice) {
      if (full.land(lat, lon).isLand) continue;
      water++;
      const hits = ix.waters.containing(lat, lon);
      if (hits.length === 0) gaps++;
      if (hits.length < 2) continue;
      const top = [...hits].sort((a, b) => full.depth(b) - full.depth(a) || b.rank - a.rank || (a.key < b.key ? -1 : 1))[0];
      const anc = ancestors(top);
      const ok = NESTING_ALLOW.has(top.name_en) || hits.every((h) => h === top || anc.has(h.key));
      if (ok) nested++;
      else conflicts.push(`${lat.toFixed(3)},${lon.toFixed(3)} ${hits.map((h) => `${h.name_en} (${h.rank})`).join(' + ')}`);
      const pk = hits.map((h) => h.name_en).sort().join(' + ');
      pairs.set(pk, (pairs.get(pk) || 0) + 1);
    }
    partition = { water, gaps, nested, conflicts: conflicts.length };
    writeFileSync(join(reports, 'water-nesting.txt'), [`nested (a water inside its ancestor): ${nested} lattice points; conflicts: ${conflicts.length}`,
      ...[...pairs].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}\t${k}`), '', ...conflicts].join('\n') + '\n');
    const share = gaps / water;
    return { ok: conflicts.length === 0 && share <= 0.002, detail: `${water} water points, ${nested} in nested features (reports/water-nesting.txt), ${conflicts.length} conflicting overlaps, ${gaps} gaps (${(100 * share).toFixed(3)} %)${conflicts.length ? `; ${conflicts.slice(0, 4).join('; ')}` : ''}` };
  });

  // 4. Parents: every non-landlocked chain ends in an ocean, no cycles; the chain's ocean agrees with Natural Earth's
  //    oceanbasin and with the adjacency of the unsimplified polygons outside the allow-list.
  check(4, 'water parents end in an ocean and agree with Natural Earth and adjacency', () => {
    const waters = core.areas.filter((a) => a.layer === 2);
    const byKey = new Map(waters.map((w) => [w.key, w]));
    const shown = (w) => (w.whole ? byKey.get(w.whole) : w);
    const oceanOf = (w) => {
      let cur = w;
      for (let i = 0; i < 20 && cur; i++) {
        if (cur.kind === 'ocean') return shown(cur).key;
        cur = cur.parent ? byKey.get(cur.parent) : null;
      }
      return cur ? 'cycle' : null;
    };
    const bad = [];
    const landlocked = new Set(['Caspian Sea', 'Garabogaz Bay']);
    for (const w of waters) {
      if (w.parent && !byKey.has(w.parent)) bad.push(`${w.key} parent ${w.parent} missing`);
      if (w.whole && !byKey.has(w.whole)) bad.push(`${w.key} whole missing`);
      const o = oceanOf(w);
      if (o === 'cycle') bad.push(`${w.key} parent cycle`);
      else if (!o && !landlocked.has(w.name_en)) bad.push(`${w.name_en} has no ocean`);
    }
    // Natural Earth's oceanbasin where it names an ocean, and adjacency (shared vertices of the source polygons).
    const gj = JSON.parse(readFileSync(join(srcRoot, 'ne', 'ne_10m_geography_marine_polys.geojson'), 'utf8'));
    const oceanByNe = new Map();
    for (const w of waters) if (w.kind === 'ocean') oceanByNe.set(w.code, shown(w).key);
    const neOcean = { 'Arctic Ocean': '1159115017', 'Indian Ocean': '1159115123', 'INDIAN OCEAN': '1159115123', 'North Atlantic Ocean': '1159115057',
      'South Atlantic Ocean': '1159115149', 'North Pacific Ocean': '1159115079', 'South Pacific Ocean': '1159115099', 'Southern Ocean': '1159115037' };
    const seenNe = new Map();
    const featureWater = gj.features.map((f) => {
      const id = String(f.properties.ne_id);
      const k = (seenNe.get(id) || 0) + 1;
      seenNe.set(id, k);
      return byKey.get(k === 1 ? `sea:${id}` : `sea:${id}-${k}`) || null;
    });
    const mismatchBasin = [];
    gj.features.forEach((f, i) => {
      const w = featureWater[i];
      const ob = neOcean[f.properties.oceanbasin];
      if (!w || !ob || landlocked.has(w.name_en)) return;
      const chain = oceanOf(w);
      const expect = oceanByNe.get(ob);
      if (chain !== expect && !OCEAN_ALLOW.has(w.name_en)) mismatchBasin.push(`${w.name_en}: chain ${chain}, NE ${f.properties.oceanbasin}`);
    });
    // Adjacency BFS from the oceans over shared vertices (1e-3 deg) of the source polygons (R1's method).
    const owners = new Map();
    gj.features.forEach((f, i) => {
      for (const poly of fromGeoJSON(f.geometry)) for (const ring of poly) for (let k = 0; k < ring.length; k += 2) {
        const v = `${Math.round(ring[k] * 1000)},${Math.round(ring[k + 1] * 1000)}`;
        if (!owners.has(v)) owners.set(v, new Set());
        owners.get(v).add(i);
      }
    });
    const adj = gj.features.map(() => new Map());
    for (const s of owners.values()) if (s.size > 1) for (const a of s) for (const b of s) if (a !== b) adj[a].set(b, (adj[a].get(b) || 0) + 1);
    const bfsOcean = new Array(gj.features.length).fill(null);
    let frontier = [];
    gj.features.forEach((f, i) => {
      if (f.properties.featurecla === 'ocean') {
        bfsOcean[i] = oceanByNe.get(String(f.properties.ne_id));
        frontier.push(i);
      }
    });
    while (frontier.length) {
      const next = [];
      for (const i of frontier) {
        for (const [j] of [...adj[i]].sort((x, y) => y[1] - x[1])) {
          if (bfsOcean[j] == null && adj[j].get(i) >= 2) {
            bfsOcean[j] = bfsOcean[i];
            next.push(j);
          }
        }
      }
      frontier = next;
    }
    const mismatchAdj = [];
    gj.features.forEach((f, i) => {
      const w = featureWater[i];
      if (!w || landlocked.has(w.name_en) || !bfsOcean[i]) return;
      if (oceanOf(w) !== bfsOcean[i] && !OCEAN_ALLOW.has(w.name_en)) mismatchAdj.push(`${w.name_en}: chain ${oceanOf(w)}, adjacency ${bfsOcean[i]}`);
    });
    writeFileSync(join(reports, 'water-parents.txt'), [`chain vs Natural Earth oceanbasin (${mismatchBasin.length}):`, ...mismatchBasin,
      '', `chain vs adjacency (${mismatchAdj.length}, informational: the adjacency search reaches an ocean through any neighbour):`, ...mismatchAdj].join('\n') + '\n');
    const ok = !bad.length && !mismatchBasin.length;
    return { ok, detail: `${waters.length} waters; ${bad.length} chain errors, ${mismatchBasin.length} disagree with NE oceanbasin, ${mismatchAdj.length} with adjacency (reports/water-parents.txt)${bad.length ? `; ${bad.slice(0, 5).join('; ')}` : ''}${mismatchBasin.length ? `; ${mismatchBasin.slice(0, 5).join('; ')}` : ''}` };
  });

  // 5. Names.
  check(5, 'name hygiene', () => {
    const bad = [];
    const areas = [...core.areas, ...detail.areas];
    for (const a of areas) {
      if (!a.name_en) bad.push(`${a.key} no name_en`);
      if ((a.layer === 2 || a.layer === 3) && !a.name_ru) bad.push(`${a.key} no name_ru`);
      for (const [lang, v] of [['en', a.name_en], ['ru', a.name_ru], ['en', a.short_en], ['ru', a.short_ru]]) {
        if (!v) continue;
        const pr = nameProblems(v, { language: lang }).filter((p) => !(p === 'not-russian' && RU_ALLOW.has(a.key)));
        if (pr.length) bad.push(`${a.key} ${lang} "${v}": ${pr.join(',')}`);
      }
    }
    for (const t of detail.places) {
      for (const [lang, v] of [['en', t.name_en], ['ru', t.name_ru], ['en', t.short_en], ['ru', t.short_ru]]) {
        if (!v) continue;
        const pr = nameProblems(v, { language: lang }).filter((p) => !(p === 'all-caps' && CAPS_ALLOW.has(`place:${t.id}`)));
        if (pr.length) bad.push(`place:${t.id} ${lang} "${v}": ${pr.join(',')}`);
      }
      if (!t.name_en) bad.push(`place:${t.id} no name_en`);
    }
    writeFileSync(join(reports, 'name-problems.txt'), bad.join('\n') + '\n');
    return { ok: !bad.length, detail: `${areas.length} areas and ${detail.places.length} towns${bad.length ? `; ${bad.length} problems (reports/name-problems.txt): ${bad.slice(0, 4).join('; ')}` : ''}` };
  });

  // 6. Golden points through the reference resolver.
  check(6, 'golden points', () => {
    const { rows } = readTsv(join(HERE, 'fixtures', 'golden.tsv'));
    const out = [];
    const fails = [];
    for (const g of rows) {
      const q = { lat: Number(g.lat), lon: Number(g.lon), tier: g.tier, mpp: g.mpp ? Number(g.mpp) : null };
      const en = full.resolve({ ...q, language: 'en' });
      const ru = full.resolve({ ...q, language: 'ru' });
      const ok = en && en.key === g.key && (!g.name_en || en.name === g.name_en) && (!g.name_ru || ru.name === g.name_ru);
      out.push({ ...g, got_key: en?.key ?? '', got_en: en?.name ?? '', got_ru: ru?.name ?? '', step: en?.step ?? '', result: ok ? 'ok' : 'FAIL' });
      if (!ok) fails.push(`${g.id} ${g.tier}: want ${g.key}${g.name_en ? ` "${g.name_en}"` : ''}${g.name_ru ? ` / "${g.name_ru}"` : ''}, got ${en?.key} "${en?.name}" / "${ru?.name}"`);
    }
    const head = ['id', 'lat', 'lon', 'tier', 'mpp', 'key', 'name_en', 'name_ru', 'got_key', 'got_en', 'got_ru', 'step', 'result', 'note'];
    writeFileSync(join(reports, 'golden-results.tsv'), [head.join('\t'), ...out.map((r) => head.map((h) => r[h] ?? '').join('\t'))].join('\n') + '\n');
    return { ok: !fails.length, detail: `${rows.length - fails.length}/${rows.length}${fails.length ? `; ${fails.slice(0, 6).join('; ')}` : ''}` };
  });

  // 7. Lattice regression against the previous release (when given).
  const t7 = Date.now();
  const latticeRows = latticeAnswers(full, n);
  writeFileSync(join(reports, 'lattice.tsv.gz'), gzipDeterministic(Buffer.from(latticeTsv(latticeRows))));
  check(7, 'lattice regression against the previous release', () => {
    if (!opt.previous) return { ok: true, detail: `no previous release given (first release); ${n} points x 3 tiers written to reports/lattice.tsv.gz (${((Date.now() - t7) / 1000).toFixed(0)} s)` };
    const prev = new Resolver(new PlaceIndex(openPart(join(opt.previous, 'places-core.sqlite.gz')), openPart(join(opt.previous, 'places-detail.sqlite.gz'))));
    const diff = diffLattices(latticeAnswers(prev, n), latticeRows, parseAccepted(join(HERE, 'accepted-diffs.md')));
    writeFileSync(join(reports, 'lattice-diff.md'), diffMarkdown(diff, `Lattice diff against ${opt.previous}`));
    const worst = Math.max(...TIERS.map((t) => diff[t].unacceptedShare));
    return { ok: worst <= 0.005, detail: TIERS.map((t) => `${t} ${diff[t].changed} changed, ${diff[t].unaccepted} unaccepted`).join('; ') + ' (reports/lattice-diff.md)' };
  });

  // 8. Part parity: core alone gives the same globe and regional answers as core + detail, except where land is known
  //    only by a province outline (Sevastopol, Kunashir: the province rings cover gaps of the country rings).
  check(8, 'part parity (core alone vs core + detail)', () => {
    const diffs = [];
    let explained = 0;
    lattice.forEach(([lat, lon], i) => {
      for (const tier of ['globe', 'regional']) {
        const a = coreOnly.resolve({ lat, lon, tier });
        const b = latticeRows[i][tier];
        if ((a?.key ?? '') === b.key) continue;
        const provinceOnly = full.ix.provinces.containing(lat, lon).length > 0 && full.ix.countries.containing(lat, lon).length === 0;
        if (provinceOnly) explained++;
        else diffs.push(`${tier} ${lat.toFixed(4)},${lon.toFixed(4)}: core ${a?.key}, full ${b.key}`);
      }
    });
    writeFileSync(join(reports, 'part-parity.txt'), [`explained (land only by a province outline): ${explained}`, ...diffs].join('\n') + '\n');
    return { ok: diffs.length === 0, detail: `${explained} differences where land is known only by a province outline; ${diffs.length} others${diffs.length ? `: ${diffs.slice(0, 5).join('; ')}` : ''}` };
  });

  // 9. Zones and parts of the world.
  check(9, 'zones and countries have a part of the world', () => {
    const bad = [];
    for (const a of core.areas) {
      if ((a.layer === 0 || a.layer === 3) && !WORLDS.has(a.world)) bad.push(`${a.key} world "${a.world}"`);
    }
    const zones = readTsv(join(HERE, 'curation', 'zones.tsv')).rows;
    for (const z of zones) if (!WORLDS.has(z.world)) bad.push(`zones.tsv ${z.key} world`);
    return { ok: !bad.length, detail: `${core.areas.filter((a) => a.layer === 3).length} zones${bad.length ? `; ${bad.join('; ')}` : ''}` };
  });

  // 10. Reproducibility: a second build gives the same bytes.
  check(10, 'reproducibility (a second build, same sha256)', () => {
    if (!opt.rebuild) return { ok: true, detail: 'skipped (run with --rebuild)' };
    const tmp = join(work, 'rebuild');
    rmSync(tmp, { recursive: true, force: true });
    execFileSync(process.execPath, [join(HERE, 'build.mjs'), '--sources', opt.sources, '--bundle', opt.bundle, '--out', tmp,
      '--version', pointer.version, '--min-population', detail.meta.min_population], { stdio: 'pipe' });
    const again = JSON.parse(readFileSync(join(tmp, pointer.version, 'places-db.json'), 'utf8'));
    const same = again.parts.every((p) => pointer.parts.find((x) => x.name === p.name)?.sha256 === p.sha256);
    return { ok: same, detail: again.parts.map((p) => `${p.name} ${p.sha256.slice(0, 12)}`).join(', ') };
  });

  // 11. Budgets.
  check(11, 'size and row budgets', () => {
    const c = pointer.parts.find((p) => p.name === 'core');
    const d = pointer.parts.find((p) => p.name === 'detail');
    const minPop = Number(detail.meta.min_population);
    const dMax = minPop >= 5000 ? 5e6 : 8e6;
    const ok = c.size_bytes <= 1e6 && d.size_bytes <= dMax && detail.places.length <= 200000;
    return { ok, detail: `core ${c.size_bytes} B gz (<= 1,000,000), detail ${d.size_bytes} B gz (<= ${dMax}), ${detail.places.length} towns (<= 200,000)` };
  });

  // 12. Licences.
  check(12, 'licences and attribution', () => {
    const bad = [];
    for (const p of [core, detail]) if (!p.meta.attribution || !/GeoNames/.test(p.meta.attribution) || !/CC BY 4\.0/.test(p.meta.attribution)) bad.push(`${p.meta.part} attribution`);
    const lic = readFileSync(join(ROOT, 'LICENSES.md'), 'utf8');
    if (!/^## Place names pack/m.test(lic)) bad.push('LICENSES.md has no "Place names pack" section');
    const lock = readFileSync(join(HERE, 'sources.lock.json'), 'utf8');
    for (const banned of [/openstreetmap/i, /neofeoda/i, /geoboundaries/i, /osm\./i]) if (banned.test(lock)) bad.push(`sources.lock.json mentions ${banned}`);
    const l = JSON.parse(lock);
    if (!l.upstream?.length || !l.archive?.sha256 || !l.regions_bundle?.sha256) bad.push('sources.lock.json incomplete');
    return { ok: !bad.length, detail: bad.join('; ') };
  });

  writeReviewReports({ core, detail, full, reports, srcRoot, partition });
  writeFileSync(join(reports, 'verify.json'), stableStringify({ version: pointer.version, results }));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; reports in ${reports}`);
  bundle.db.close();
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
