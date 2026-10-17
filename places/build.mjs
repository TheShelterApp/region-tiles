// P2: build the place-names pack, two gzip'd SQLite files (schema 1, README "File format"):
//   places-core.sqlite.gz    countries (the regions bundle's outlines at 1e-5 deg), seas and oceans, neutral zones
//   places-detail.sqlite.gz  provinces (the bundle's outlines at 1e-4 deg) and GeoNames towns
// plus a candidate pointer (places-db.json) and a build report.
//
// Inputs, and nothing else (no network):
//   - the sources archive places-sources-<date>.tar.gz (sha256 pinned by places/sources.lock.json), or its unpacked
//     directory for local work;
//   - the regions bundle regions.sqlite.gz (sha256 pinned by regions-db.json);
//   - the curation tables under places/curation.
// The output depends only on those: rows are sorted, page_size 4096, rollback journal, VACUUM, a fixed gzip header and
// meta.generated from SOURCE_DATE_EPOCH (default: the sources' staging date).
//
// usage: node places/build.mjs --sources <archive or dir> --bundle <regions.sqlite.gz> --out <dir>
//                              [--version <semver, default places/VERSION>] [--min-population 5000]
import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonIso } from '../pipeline/lib/iso.mjs';
import { ensureDir, sha256, sha256File, readTsv, stableStringify, gzipDeterministic, gunzipChecked, untar } from './lib/io.mjs';
import {
  encodeGeometry, fromGeoJSON, quantise, countVertices, bboxOf, simplifyOuter, simplifyAll, polygonContains, distanceKm,
  haversineKm, cellOf,
} from './lib/geometry.mjs';
import { clean, isRussian, hasCyrillic, isAllCaps, hasNonLatinLetters, cleanRomanisation, appleStyle, isEnglishExonym, capitalizeFirst } from './lib/names.mjs';
import { keepTown } from './lib/places.mjs';
import { SOURCES } from './sources.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
export const SCHEMA = 1;
export const Q_COUNTRY = 100000;
export const Q_DETAIL = 10000;
const MARINE_DP = 0.01;
const ZONE_DP = 0.005;
// A town whose point falls outside every country and province outline (a coast the bundle's simplified outlines cut
// off: Aden, Cadiz, Dakhla) joins the nearest country within the coastal band. Natural Earth's own admin-0 needed 5 km
// (P3); the bundle's outlines are simplified harder, and the band is where the header names that country anyway.
const SNAP_KM = 22;
const SECTION_KM = 15;
export const ATTRIBUTION = SOURCES.attribution;

const log = (...m) => console.log('[build]', ...m);

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { version: readFileSync(join(HERE, 'VERSION'), 'utf8').trim(), 'min-population': '5000' };
  for (let i = 0; i < a.length; i += 2) o[a[i].replace(/^--/, '')] = a[i + 1];
  for (const k of ['sources', 'bundle', 'out']) if (!o[k]) throw new Error(`missing --${k}`);
  if (!/^\d+\.\d+\.\d+$/.test(o.version)) throw new Error(`--version must be semver: ${o.version}`);
  return { ...o, minPopulation: Number(o['min-population']) };
}

// ---- inputs -----------------------------------------------------------------------------------------------------------

function loadSources(path, work) {
  const lock = JSON.parse(readFileSync(join(HERE, 'sources.lock.json'), 'utf8'));
  if (path.endsWith('.tar.gz')) {
    const gz = readFileSync(path);
    const h = sha256(gz);
    if (h !== lock.archive.sha256) throw new Error(`sources archive sha256 ${h} != sources.lock.json ${lock.archive.sha256}`);
    const dir = join(work, 'sources');
    rmSync(dir, { recursive: true, force: true });
    ensureDir(dir);
    untar(gunzipChecked(gz), dir);
    const root = join(dir, readdirSync(dir)[0]);
    return { root, lock, archiveSha256: h };
  }
  // A directory: every file must match the lock's per-file hashes.
  for (const [rel, f] of Object.entries(lock.archive.files)) {
    const p = join(path, rel);
    if (!existsSync(p) || sha256File(p) !== f.sha256) throw new Error(`${rel} differs from sources.lock.json`);
  }
  return { root: path, lock, archiveSha256: lock.archive.sha256 };
}

function loadBundle(path, work) {
  const pointer = JSON.parse(readFileSync(join(ROOT, 'regions-db.json'), 'utf8'));
  const gz = readFileSync(path);
  const h = sha256(gz);
  if (h !== pointer.sha256) throw new Error(`regions bundle sha256 ${h} != regions-db.json ${pointer.sha256}`);
  const file = join(work, 'regions.sqlite');
  writeFileSync(file, gunzipChecked(gz));
  const db = new Database(file, { readonly: true, fileMustExist: true });
  return { db, sha256: h, version: pointer.version };
}

function curation(name) {
  return readTsv(join(HERE, 'curation', name)).rows;
}

/** sha256 over the curation tables (sorted names and contents): the curation part of the build's identity. */
function curationHash() {
  const dir = join(HERE, 'curation');
  const parts = readdirSync(dir).filter((f) => f.endsWith('.tsv')).sort().map((f) => `${f}\n${readFileSync(join(dir, f), 'utf8')}`);
  return sha256(Buffer.from(parts.join('\n\u0000\n')));
}

// ---- areas ------------------------------------------------------------------------------------------------------------

function area(fields) {
  const polys = fields.qpolys;
  const b = bboxOf(polys, fields.q);
  return {
    layer: fields.layer, key: fields.key, iso3: fields.iso3 ?? null, iso2: fields.iso2 ?? null, world: fields.world ?? null,
    parent: fields.parent ?? null, whole: fields.whole ?? null, globe: fields.globe ? 1 : 0, kind: fields.kind ?? null,
    rank: fields.rank ?? null, code: fields.code ?? null, iso_3166_2: fields.iso_3166_2 ?? null,
    name_en: fields.name_en, name_ru: fields.name_ru || null, short_en: fields.short_en || null, short_ru: fields.short_ru || null,
    min_lng: b[0], min_lat: b[1], max_lng: b[2], max_lat: b[3], q: fields.q, vertices: countVertices(polys),
    geometry: encodeGeometry(polys), _polys: polys,
  };
}

/** Drop consecutive duplicate vertices (after quantisation) and rings with fewer than 3 vertices. */
function tidy(qpolys) {
  const out = [];
  for (const poly of qpolys) {
    const rings = [];
    for (const ring of poly) {
      const r = [];
      for (let i = 0; i < ring.length; i += 2) {
        const n = r.length;
        if (n && r[n - 2] === ring[i] && r[n - 1] === ring[i + 1]) continue;
        r.push(ring[i], ring[i + 1]);
      }
      if (r.length >= 4 && r[0] === r[r.length - 2] && r[1] === r[r.length - 1]) r.splice(-2, 2);
      if (r.length >= 6) rings.push(Int32Array.from(r));
    }
    if (rings.length && rings[0]) out.push(rings);
  }
  return out;
}

function bundleRows(bundle, level) {
  return bundle.db.prepare('SELECT id, name, geometry FROM regions WHERE level = ? ORDER BY id').all(level)
    .map((r) => ({ id: r.id, name: r.name, geojson: JSON.parse(gunzipChecked(r.geometry).toString('utf8')) }));
}

/** The countries, vertex for vertex: the bundle stores 5 decimals, so 1e-5 deg quantisation is lossless. */
function buildCountries(bundle, cur) {
  const meta = new Map(cur.countries.map((r) => [r.id, r]));
  const shorts = new Map(cur.shortNames.map((r) => [r.key, r]));
  return bundleRows(bundle, 0).map((r) => {
    const m = meta.get(r.id);
    if (!m) throw new Error(`countries.tsv has no row for ${r.id}`);
    const polys = fromGeoJSON(r.geojson);
    for (const poly of polys) for (const ring of poly) for (const v of ring) {
      if (Math.abs(v * Q_COUNTRY - Math.round(v * Q_COUNTRY)) > 1e-6) throw new Error(`${r.id}: a coordinate finer than 1e-5 deg`);
    }
    const s = shorts.get(`adm0:${r.id}`);
    return area({
      layer: 0, key: `adm0:${r.id}`, iso3: r.id, iso2: m.iso2 || null, world: m.world, name_en: r.name,
      short_en: s?.short_en, short_ru: s?.short_ru, q: Q_COUNTRY, qpolys: quantise(polys, Q_COUNTRY),
    });
  });
}

/**
 * Provinces: the bundle numbers each country's Natural Earth admin-1 rows 1..n by adm1_code (pipeline/01-normalize.mjs),
 * so the same numbering over the same NE table joins the names. The bundle's own name must match row for row.
 */
function buildProvinces(bundle, srcRoot, cur) {
  const ne = readTsv(join(srcRoot, 'ne', 'ne_10m_admin_1_states_provinces.tsv')).rows;
  const byIso = new Map();
  for (const p of ne) {
    const iso = canonIso(p.adm0_a3 || p.sov_a3 || p.iso_a2);
    if (!iso) continue;
    const code = p.adm1_code || p.ne_id || clean(p.name).replace(/\W/g, '');
    if (!byIso.has(iso)) byIso.set(iso, []);
    byIso.get(iso).push({ ...p, code: String(code) });
  }
  const neById = new Map();
  for (const [iso, arr] of byIso) {
    arr.sort((x, y) => (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
    arr.forEach((p, i) => neById.set(`${iso}.${i + 1}`, p));
  }
  const over = new Map(cur.admin1Overrides.map((r) => [r.key, r]));
  const shorts = new Map(cur.shortNames.map((r) => [r.key, r]));
  const out = [];
  for (const r of bundleRows(bundle, 1)) {
    const p = neById.get(r.id);
    const bundleName = clean(r.name);
    if (!p) throw new Error(`no Natural Earth admin-1 row for ${r.id}`);
    const neName = clean(p.name || p.name_en || p.gn_name || p.code);
    if (neName !== bundleName) throw new Error(`${r.id}: bundle name "${bundleName}" != NE "${neName}" (numbering drift)`);
    const key = `adm1:${r.id}`;
    const o = over.get(key) || {};
    const s = shorts.get(key) || {};
    const iso3 = r.id.split('.')[0];
    const nameEn = clean(o.name_en || p.name_en || p.name || bundleName);
    const ruNe = clean(p.name_ru);
    out.push(area({
      layer: 1, key, iso3, parent: `adm0:${iso3}`, kind: p.type_en || null, code: p.code, iso_3166_2: p.iso_3166_2 || null,
      name_en: nameEn, name_ru: capitalizeFirst(clean(o.name_ru) || (isRussian(ruNe) ? ruNe : '')),
      short_en: o.short_en || s.short_en, short_ru: o.short_ru || s.short_ru,
      q: Q_DETAIL, qpolys: quantise(fromGeoJSON(r.geojson), Q_DETAIL),
    }));
  }
  return out;
}

function buildWaters(srcRoot, cur) {
  const gj = JSON.parse(readFileSync(join(srcRoot, 'ne', 'ne_10m_geography_marine_polys.geojson'), 'utf8'));
  const rows = cur.waters;
  const byNe = new Map();
  for (const r of rows) {
    const k = `${r.ne_id}\u0000${r.ne_name}`;
    if (byNe.has(k)) throw new Error(`waters.tsv: two rows for ne_id ${r.ne_id} "${r.ne_name}"`);
    byNe.set(k, r);
  }
  const used = new Set();
  const out = [];
  for (const f of gj.features) {
    const p = f.properties;
    const k = `${p.ne_id}\u0000${clean(p.name || '')}`;
    const r = byNe.get(k);
    if (!r) throw new Error(`waters.tsv has no row for Natural Earth marine feature ${p.ne_id} "${p.name}"`);
    if (used.has(k)) throw new Error(`waters.tsv: Natural Earth repeats ${p.ne_id} "${p.name}"`);
    used.add(k);
    const polys = tidy(quantise(simplifyOuter(fromGeoJSON(f.geometry), MARINE_DP), Q_DETAIL));
    out.push(area({
      layer: 2, key: r.key, parent: r.parent || null, whole: r.whole || null, globe: r.globe === '1', kind: r.class,
      rank: Number(r.rank), code: String(p.ne_id), name_en: r.name_en, name_ru: r.name_ru, short_en: r.short_en,
      short_ru: r.short_ru, q: Q_DETAIL, qpolys: polys,
    }));
  }
  for (const [k, r] of byNe) if (!used.has(k)) throw new Error(`waters.tsv row ${r.key} matches no Natural Earth feature`);
  return out;
}

function buildZones(srcRoot, bundle, cur) {
  const ne = JSON.parse(readFileSync(join(srcRoot, 'ne', 'ne_10m_admin_0_disputed_areas.geojson'), 'utf8'));
  const neByBrk = new Map(ne.features.map((f) => [f.properties.BRK_A3, f]));
  const adm1 = new Map(bundleRows(bundle, 1).map((r) => [r.id, r]));
  const out = [];
  for (const z of cur.zones) {
    if (z.policy !== 'area') continue; // 'country': the bundle's country row already names it (listed for review)
    const polys = [];
    for (const src of z.source.split(/\s+/).filter(Boolean)) {
      const [kind, id] = src.split(':');
      if (kind === 'adm1') {
        const r = adm1.get(id);
        if (!r) throw new Error(`zones.tsv ${z.key}: no bundle province ${id}`);
        polys.push(...quantise(fromGeoJSON(r.geojson), Q_DETAIL));
      } else if (kind === 'ne') {
        const f = neByBrk.get(id);
        if (!f) throw new Error(`zones.tsv ${z.key}: no Natural Earth disputed area ${id}`);
        polys.push(...tidy(quantise(simplifyAll(fromGeoJSON(f.geometry), ZONE_DP), Q_DETAIL)));
      } else {
        throw new Error(`zones.tsv ${z.key}: unknown source ${src}`);
      }
    }
    out.push(area({
      layer: 3, key: z.key, world: z.world, kind: z.policy, code: z.source, name_en: z.name_en, name_ru: z.name_ru,
      short_en: z.short_en, short_ru: z.short_ru, q: Q_DETAIL, qpolys: polys,
    }));
  }
  return out;
}

// ---- towns ------------------------------------------------------------------------------------------------------------

/** A grid of polygon boxes for point-in-polygon joins. */
function polyIndex(areas) {
  const cells = new Map();
  areas.forEach((a, ai) => {
    a._boxes = a._polys.map((poly) => bboxOf([poly], a.q));
    a._boxes.forEach((b, pi) => {
      for (let y = Math.floor(b[1]); y <= Math.floor(b[3]); y++) {
        for (let x = Math.floor(b[0]); x <= Math.floor(b[2]); x++) {
          const k = y * 1000 + x;
          if (!cells.has(k)) cells.set(k, []);
          cells.get(k).push([ai, pi]);
        }
      }
    });
  });
  const at = (lat, lon) => {
    const hits = new Set();
    for (const [ai, pi] of cells.get(Math.floor(lat) * 1000 + Math.floor(lon)) || []) {
      const a = areas[ai];
      const b = a._boxes[pi];
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (polygonContains(a._polys[pi], lon * a.q, lat * a.q)) hits.add(ai);
    }
    return [...hits].sort((x, y) => (areas[x].key < areas[y].key ? -1 : 1)).map((i) => areas[i]);
  };
  const nearest = (lat, lon, maxKm) => {
    let best = null;
    let bd = maxKm;
    for (const a of areas) {
      const b = [a.min_lng, a.min_lat, a.max_lng, a.max_lat];
      const pad = maxKm / 111 / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
      if (lon < b[0] - pad || lon > b[2] + pad || lat < b[1] - maxKm / 111 || lat > b[3] + maxKm / 111) continue;
      const d = distanceKm(a._polys, a._boxes, a.q, lon, lat, maxKm);
      if (d < bd || (d === bd && best && a.key < best.key)) {
        bd = d;
        best = a;
      }
    }
    return best ? { area: best, km: bd } : null;
  };
  return { at, nearest };
}

// Russian labels of administrative units and other things that are not a town's name.
const RU_UNIT_LABEL = new RegExp('^(\u0433\u043e\u0440\u043e\u0434\u0441\u043a\u043e\u0439 \u043e\u043a\u0440\u0443\u0433|' +
  '\u0433\u043e\u0440\u043e\u0434\u0441\u043a\u043e\u0435 \u043f\u043e\u0441\u0435\u043b\u0435\u043d\u0438\u0435|' +
  '\u0441\u0435\u043b\u044c\u0441\u043a\u043e\u0435 \u043f\u043e\u0441\u0435\u043b\u0435\u043d\u0438\u0435|' +
  '\u043c\u0443\u043d\u0438\u0446\u0438\u043f\u0430\u043b\u044c\u043d|\u0440\u0430\u0439\u043e\u043d |\u0438\u043c\u0435\u043d\u0438 |' +
  '\u043f\u043b\u043e\u0449\u0430\u0434\u044c |\u043f\u0430\u0440\u043a |\u0443\u043b\u0438\u0446\u0430 )', 'u');

/** An English town title: Dutch "'s-" / "'t " restored, a leading "gorod " (Russian for "city") dropped, a capital first. */
function englishTitle(s, cc) {
  let t = s;
  if ((cc === 'NL' || cc === 'BE') && /^(s-|t )/.test(t)) t = `'${t}`;
  if (cc === 'RU' || cc === 'BY' || cc === 'KZ') t = t.replace(/^gorod /i, '');
  return capitalizeFirst(t);
}

/** GeoNames' alternate in `lang`: preferred, then plain, then short; never colloquial, historic or time-limited. */
function pickAlternate(alts, lang, { preferredOnly = false } = {}) {
  const ok = alts.filter((a) => a.lang === lang && !a.colloquial && !a.historic && !a.from && !a.to);
  const order = preferredOnly ? [ok.filter((a) => a.preferred && !a.short)]
    : [ok.filter((a) => a.preferred && !a.short), ok.filter((a) => !a.preferred && !a.short), ok.filter((a) => a.short)];
  for (const group of order) {
    for (const a of group) {
      const s = clean(a.name);
      if (lang === 'ru' && !isRussian(s)) continue;
      if (lang === 'en' && hasCyrillic(s)) continue;
      return s;
    }
  }
  return '';
}

function buildTowns(srcRoot, countries, provinces, bundle, cur, minPopulation, report) {
  const overrides = new Map(cur.placesOverrides.map((r) => [r.geonameid, r]));
  const alts = new Map();
  for (const line of readFileSync(join(srcRoot, 'geonames', 'alternate-names-ru-en-wkdt.tsv'), 'utf8').split('\n')) {
    const c = line.split('\t');
    if (c.length < 4 || c[2] === 'wkdt') continue;
    if (!alts.has(c[1])) alts.set(c[1], []);
    alts.get(c[1]).push({ lang: c[2], name: c[3], preferred: c[4] === '1', short: c[5] === '1', colloquial: c[6] === '1', historic: c[7] === '1', from: c[8] || '', to: c[9] || '' });
  }
  const wd = new Map(cur.wikidata.filter((r) => r.key.startsWith('place:')).map((r) => [r.key.slice(6), r]));

  const towns = [];
  const seenOverride = new Set();
  for (const line of readFileSync(join(srcRoot, 'geonames', 'cities1000.txt'), 'utf8').split('\n')) {
    const c = line.split('\t');
    if (c.length < 19) continue;
    const id = c[0];
    const o = overrides.get(id);
    if (o) seenOverride.add(id);
    const pop = o?.population ? Number(o.population) : Number(c[14]) || 0;
    if (o?.drop === '1') continue;
    if (!(o?.keep === '1') && !keepTown(pop, c[7], minPopulation)) continue;
    const cc = c[8];
    const a = alts.get(id) || [];
    // GeoNames' name is Latin for all but a few dozen places (North Macedonian towns in Cyrillic): those take an
    // English alternate, else the ASCII name; a town still without a Latin name is dropped (build report).
    let name = clean(c[1]);
    if (hasNonLatinLetters(name)) name = pickAlternate(a, 'en') || clean(c[2]);
    if (!o?.name_en && hasNonLatinLetters(name)) {
      report.nonLatin = [...(report.nonLatin || []), { id: Number(id), name: c[1], cc }];
      continue;
    }
    const enAlt = pickAlternate(a, 'en', { preferredOnly: true });
    const nameEn = clean(o?.name_en) || englishTitle(appleStyle(cleanRomanisation(isEnglishExonym(name, enAlt) ? enAlt : name, cc), cc), cc);
    const w = wd.get(id);
    // A Wikidata label in capitals only ("TILBURY") or of an administrative unit ("gorodskoy okrug X", "rayon X": the
    // P1566 claim sits on the unit's item) is not the town's name: GeoNames' then.
    const wdRu = w?.ru && !isAllCaps(w.ru) && !RU_UNIT_LABEL.test(w.ru) ? w.ru : '';
    const nameRu = capitalizeFirst(clean(o?.name_ru) || wdRu || pickAlternate(a, 'ru'));
    towns.push({
      id: Number(id), lat: Math.round(Number(c[4]) * Q_DETAIL), lon: Math.round(Number(c[5]) * Q_DETAIL), pop, fcode: c[7], cc, a1: c[10],
      name_en: nameEn, name_ru: nameRu || null, short_en: o?.short_en || null, short_ru: o?.short_ru || null,
      ruVia: o?.name_ru ? 'override' : wdRu ? 'wikidata' : nameRu ? 'geonames' : 'none',
    });
  }
  for (const id of overrides.keys()) if (!seenOverride.has(id)) throw new Error(`places-overrides.tsv: geonameid ${id} is not in cities1000`);

  // Country and province by polygon (the bundle's outlines), not by GeoNames' country code.
  const ci = polyIndex(countries);
  const pi = polyIndex(provinces);
  const joined = [];
  const unjoined = [];
  let snapped = 0;
  for (const t of towns) {
    const lat = t.lat / Q_DETAIL;
    const lon = t.lon / Q_DETAIL;
    const c0 = ci.at(lat, lon)[0];
    const p1 = pi.at(lat, lon)[0];
    let adm0 = c0?.iso3 || p1?.iso3 || null;
    if (!adm0) {
      const n = ci.nearest(lat, lon, SNAP_KM);
      if (n) {
        adm0 = n.area.iso3;
        snapped++;
      }
    }
    if (!adm0) {
      unjoined.push({ id: t.id, name: t.name_en, cc: t.cc, lat, lon, pop: t.pop });
      continue;
    }
    joined.push({ ...t, adm0, adm1: p1 ? p1.key.slice(5) : null, metro: t.id });
  }
  report.towns = { candidates: towns.length, snapped, unjoined: unjoined.length };
  report.unjoinedTowns = unjoined;

  // Metro rules: metros.tsv (adm2:<district> folds every town inside the bundle district into a city; place:<id> folds
  // one town), then sections of a city (PPLX) take the nearest larger non-section town within 15 km of the same country.
  const byId = new Map(joined.map((t) => [t.id, t]));
  const adm2 = new Map(bundle.db.prepare('SELECT id, name, geometry FROM regions WHERE level = 2 AND id IN (' +
    cur.metros.filter((m) => m.rule.startsWith('adm2:')).map((m) => `'${m.rule.slice(5).replace(/'/g, '')}'`).join(',') + ')').all()
    .map((r) => [r.id, { name: r.name, polys: quantise(fromGeoJSON(JSON.parse(gunzipChecked(r.geometry).toString('utf8'))), Q_COUNTRY) }]));
  const folded = new Set();
  for (const m of cur.metros) {
    const metro = byId.get(Number(m.metro));
    if (!metro) throw new Error(`metros.tsv: metro ${m.metro} is not a kept town`);
    if (m.rule.startsWith('adm2:')) {
      const d = adm2.get(m.rule.slice(5));
      if (!d) throw new Error(`metros.tsv: no bundle district ${m.rule}`);
      if (m.check_name && d.name !== m.check_name) throw new Error(`metros.tsv: ${m.rule} is "${d.name}", expected "${m.check_name}"`);
      for (const t of joined) {
        const X = (t.lon / Q_DETAIL) * Q_COUNTRY;
        const Y = (t.lat / Q_DETAIL) * Q_COUNTRY;
        if (d.polys.some((poly) => polygonContains(poly, X, Y))) {
          t.metro = metro.id;
          folded.add(t.id);
        }
      }
    } else if (m.rule.startsWith('admin1:')) {
      // Every town of the GeoNames first-order division within `km` of the metro: a city-province's districts.
      const [cc, a1] = m.rule.slice(7).split('.');
      const km = Number(m.km);
      if (!(km > 0)) throw new Error(`metros.tsv: ${m.rule} needs km`);
      if (metro.cc !== cc || metro.a1 !== a1) throw new Error(`metros.tsv: metro ${m.metro} is not in ${m.rule}`);
      if (m.check_name && metro.name_en !== m.check_name) throw new Error(`metros.tsv: metro ${m.metro} is "${metro.name_en}", expected "${m.check_name}"`);
      for (const t of joined) {
        if (t === metro || t.cc !== cc || t.a1 !== a1) continue;
        if (haversineKm(t.lat / Q_DETAIL, t.lon / Q_DETAIL, metro.lat / Q_DETAIL, metro.lon / Q_DETAIL) > km) continue;
        t.metro = metro.id;
        folded.add(t.id);
      }
    } else if (m.rule.startsWith('place:')) {
      const t = byId.get(Number(m.rule.slice(6)));
      if (!t) throw new Error(`metros.tsv: ${m.rule} is not a kept town`);
      t.metro = metro.id;
      folded.add(t.id);
    } else {
      throw new Error(`metros.tsv: unknown rule ${m.rule}`);
    }
  }
  const mainTowns = joined.filter((t) => t.fcode !== 'PPLX');
  const grid = new Map();
  for (const t of mainTowns) {
    const k = cellOf(t.lat / Q_DETAIL, t.lon / Q_DETAIL);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(t);
  }
  let sections = 0;
  let sectionsAlone = 0;
  for (const t of joined) {
    if (t.fcode !== 'PPLX' || folded.has(t.id)) continue;
    const lat = t.lat / Q_DETAIL;
    const lon = t.lon / Q_DETAIL;
    let best = null;
    let bd = SECTION_KM;
    const la = Math.floor(lat) + 90;
    const lo = Math.floor(lon) + 180;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const y = la + dy;
        if (y < 0 || y > 179) continue;
        for (const m of grid.get(y * 360 + ((lo + dx + 360) % 360)) || []) {
          if (m.pop <= t.pop || m.adm0 !== t.adm0) continue;
          const d = haversineKm(lat, lon, m.lat / Q_DETAIL, m.lon / Q_DETAIL);
          if (d < bd || (d === bd && best && m.id < best.id)) {
            bd = d;
            best = m;
          }
        }
      }
    }
    if (best) {
      t.metro = best.id;
      sections++;
    } else {
      sectionsAlone++;
    }
  }
  // A metro must be shown as itself: follow chains once (a section of a folded ward town).
  for (const t of joined) {
    let m = byId.get(t.metro);
    let hops = 0;
    while (m && m.metro !== m.id && hops < 4) {
      m = byId.get(m.metro);
      hops++;
    }
    if (!m || m.metro !== m.id) throw new Error(`metro chain of ${t.id} does not end in a town shown as itself`);
    t.metro = m.id;
  }
  report.towns.aliases = { metroRules: folded.size, sections, sectionsWithoutLargerTown: sectionsAlone };
  report.towns.kept = joined.length;
  const ru = { wikidata: 0, geonames: 0, override: 0, none: 0 };
  for (const t of joined) ru[t.ruVia]++;
  report.towns.russianNames = ru;
  return joined;
}

// ---- writing ------------------------------------------------------------------------------------------------------------

const AREAS_DDL = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE areas(
  id INTEGER PRIMARY KEY,
  layer INTEGER NOT NULL,
  key TEXT NOT NULL UNIQUE,
  iso3 TEXT,
  iso2 TEXT,
  world TEXT,
  parent TEXT,
  whole TEXT,
  globe INTEGER NOT NULL DEFAULT 0,
  kind TEXT,
  rank INTEGER,
  code TEXT,
  iso_3166_2 TEXT,
  name_en TEXT NOT NULL,
  name_ru TEXT,
  short_en TEXT,
  short_ru TEXT,
  min_lng REAL NOT NULL,
  min_lat REAL NOT NULL,
  max_lng REAL NOT NULL,
  max_lat REAL NOT NULL,
  q INTEGER NOT NULL,
  vertices INTEGER NOT NULL,
  geometry BLOB NOT NULL
);
CREATE VIRTUAL TABLE areas_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);
`;
const PLACES_DDL = `
CREATE TABLE places(
  cell INTEGER NOT NULL,
  id INTEGER NOT NULL,
  lat INTEGER NOT NULL,
  lon INTEGER NOT NULL,
  pop INTEGER NOT NULL,
  adm0 TEXT NOT NULL,
  adm1 TEXT,
  metro INTEGER NOT NULL,
  name_en TEXT NOT NULL,
  name_ru TEXT,
  short_en TEXT,
  short_ru TEXT,
  PRIMARY KEY(cell, id)
) WITHOUT ROWID;
`;

export function writePart(file, part, areas, places, meta) {
  rmSync(file, { force: true });
  rmSync(`${file}-journal`, { force: true });
  const db = new Database(file);
  db.pragma('page_size = 4096');
  db.pragma('journal_mode = DELETE');
  db.exec(AREAS_DDL);
  if (places) db.exec(PLACES_DDL);
  const sorted = [...areas].sort((a, b) => a.layer - b.layer || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const ins = db.prepare(`INSERT INTO areas(id, layer, key, iso3, iso2, world, parent, whole, globe, kind, rank, code, iso_3166_2,
    name_en, name_ru, short_en, short_ru, min_lng, min_lat, max_lng, max_lat, q, vertices, geometry)
    VALUES (@id, @layer, @key, @iso3, @iso2, @world, @parent, @whole, @globe, @kind, @rank, @code, @iso_3166_2,
    @name_en, @name_ru, @short_en, @short_ru, @min_lng, @min_lat, @max_lng, @max_lat, @q, @vertices, @geometry)`);
  const rt = db.prepare('INSERT INTO areas_rtree(id, min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)');
  const insP = places && db.prepare(`INSERT INTO places(cell, id, lat, lon, pop, adm0, adm1, metro, name_en, name_ru, short_en, short_ru)
    VALUES (@cell, @id, @lat, @lon, @pop, @adm0, @adm1, @metro, @name_en, @name_ru, @short_en, @short_ru)`);
  const counts = { areas: sorted.length, countries: 0, provinces: 0, waters: 0, zones: 0, places: places ? places.length : 0 };
  db.transaction(() => {
    sorted.forEach((a, i) => {
      const { _polys, _boxes, ...row } = a;
      ins.run({ ...row, id: i + 1 });
      rt.run(i + 1, a.min_lng, a.max_lng, a.min_lat, a.max_lat);
      counts[['countries', 'provinces', 'waters', 'zones'][a.layer]]++;
    });
    if (places) {
      const rows = places.map((t) => ({
        cell: cellOf(t.lat / Q_DETAIL, t.lon / Q_DETAIL), id: t.id, lat: t.lat, lon: t.lon, pop: t.pop, adm0: t.adm0,
        adm1: t.adm1, metro: t.metro, name_en: t.name_en, name_ru: t.name_ru, short_en: t.short_en, short_ru: t.short_ru,
      })).sort((a, b) => a.cell - b.cell || a.id - b.id);
      for (const r of rows) insP.run(r);
    }
    const insM = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
    const all = { ...meta, part, schema: String(SCHEMA), geometry: 'varint-zigzag-delta-v1' };
    for (const [k, v] of Object.entries(counts)) all[`count_${k}`] = String(v);
    for (const k of Object.keys(all).sort()) insM.run(k, String(all[k]));
  })();
  db.exec('VACUUM');
  db.close();
  const raw = readFileSync(file);
  const gz = gzipDeterministic(raw);
  writeFileSync(`${file}.gz`, gz);
  return { name: part, inflated_bytes: raw.length, size_bytes: gz.length, sha256: sha256(gz), inflated_sha256: sha256(raw), counts };
}

export function pointerUrls(version, part) {
  const tag = `bundle-places-${version}`;
  const file = `places-${part}.sqlite.gz`;
  return [
    `https://cdn.jsdelivr.net/gh/TheShelterApp/region-tiles@${tag}/places/dist/${version}/${file}`,
    `https://github.com/TheShelterApp/region-tiles/releases/download/${tag}/${file}`,
    `https://raw.githubusercontent.com/TheShelterApp/region-tiles/${tag}/places/dist/${version}/${file}`,
  ];
}

export function loadCuration() {
  return {
    countries: curation('countries.tsv'),
    waters: curation('waters.tsv'),
    zones: curation('zones.tsv'),
    metros: curation('metros.tsv'),
    placesOverrides: curation('places-overrides.tsv'),
    admin1Overrides: curation('admin1-overrides.tsv'),
    shortNames: curation('short-names.tsv'),
    wikidata: curation('wikidata-labels.tsv'),
  };
}

async function main() {
  const opt = parseArgs();
  const outDir = join(opt.out, opt.version);
  const work = join(opt.out, '.work');
  ensureDir(outDir);
  ensureDir(work);
  const src = loadSources(opt.sources, work);
  const bundle = loadBundle(opt.bundle, work);
  const cur = loadCuration();
  const report = { version: opt.version, minPopulation: opt.minPopulation };

  const countries = buildCountries(bundle, cur);
  const provinces = buildProvinces(bundle, src.root, cur);
  const waters = buildWaters(src.root, cur);
  const zones = buildZones(src.root, bundle, cur);
  log(`areas: ${countries.length} countries, ${provinces.length} provinces, ${waters.length} waters, ${zones.length} zones`);
  const towns = buildTowns(src.root, countries, provinces, bundle, cur, opt.minPopulation, report);
  log(`towns: ${towns.length} kept (${report.towns.snapped} snapped to a coast, ${report.towns.unjoined} unjoined and dropped)`);

  const epoch = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) : Math.floor(Date.parse(`${src.lock.archive.release_tag.replace('places-sources-', '')}T00:00:00Z`) / 1000);
  const meta = {
    version: opt.version,
    generated: new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sources_sha256: src.archiveSha256,
    regions_bundle_sha256: bundle.sha256,
    regions_bundle_version: bundle.version,
    curation_sha256: curationHash(),
    attribution: ATTRIBUTION,
  };
  const core = writePart(join(outDir, 'places-core.sqlite'), 'core', [...countries, ...waters, ...zones], null, meta);
  const detail = writePart(join(outDir, 'places-detail.sqlite'), 'detail', provinces, towns,
    { ...meta, min_population: String(opt.minPopulation) });
  bundle.db.close();

  const pointer = {
    version: opt.version,
    schema: SCHEMA,
    parts: [core, detail].map((p) => ({
      name: p.name, size_bytes: p.size_bytes, inflated_bytes: p.inflated_bytes, sha256: p.sha256, urls: pointerUrls(opt.version, p.name),
    })),
  };
  writeFileSync(join(outDir, 'places-db.json'), stableStringify(pointer));
  report.parts = { core, detail };
  writeFileSync(join(outDir, 'build-report.json'), stableStringify(report));
  for (const p of [core, detail]) log(`${p.name}: ${p.inflated_bytes} B SQLite, ${p.size_bytes} B gzip, sha256 ${p.sha256}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.stack || String(e));
    process.exit(1);
  });
}
