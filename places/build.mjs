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
import {
  clean, isRussian, hasCyrillic, isAllCaps, hasNonLatinLetters, cleanRomanisation, appleStyle, isEnglishExonym, capitalizeFirst,
  stripAdminSuffix, nameSkeleton, nameSimilarity,
} from './lib/names.mjs';
import { keepTown } from './lib/places.mjs';
import { PlaceIndex, withAdmins } from './lib/pack.mjs';
import { Resolver } from './resolve.mjs';
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
    admin: fields.admin || null, national: fields.national ? 1 : 0,
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
      short_ru: r.short_ru, national: r.national === '1', q: Q_DETAIL, qpolys: polys,
    }));
  }
  for (const [k, r] of byNe) if (!used.has(k)) throw new Error(`waters.tsv row ${r.key} matches no Natural Earth feature`);
  return out;
}

/**
 * The outlines of a curated area: `adm1:<bundle province>=<its bundle name>` (the bundle's rings, vertex for vertex; the
 * name guards against a renumbered bundle) or `ne:<BRK_A3>` (Natural Earth 10m admin_0_disputed_areas, Douglas-Peucker
 * `dp` deg), separated by spaces.
 */
function curatedOutlines(table, key, sources, ctx, dp = ZONE_DP) {
  const polys = [];
  for (const src of sources.split(/\s+/).filter(Boolean)) {
    const [kind, rest] = src.split(/:(.*)/s);
    if (kind === 'adm1') {
      const [id, raw] = rest.split('=');
      const name = raw?.replace(/_/g, ' ');
      const r = ctx.adm1.get(id);
      if (!r) throw new Error(`${table} ${key}: no bundle province ${id}`);
      if (!name) throw new Error(`${table} ${key}: adm1:${id} needs its bundle name (adm1:${id}=${r.name.replace(/ /g, '_')})`);
      if (clean(r.name) !== name) throw new Error(`${table} ${key}: bundle province ${id} is "${r.name}", expected "${name}"`);
      polys.push(...quantise(fromGeoJSON(r.geojson), Q_DETAIL));
    } else if (kind === 'ne') {
      const f = ctx.neByBrk.get(rest);
      if (!f) throw new Error(`${table} ${key}: no Natural Earth disputed area ${rest}`);
      polys.push(...tidy(quantise(simplifyAll(fromGeoJSON(f.geometry), dp), Q_DETAIL)));
    } else {
      throw new Error(`${table} ${key}: unknown source ${src}`);
    }
  }
  return polys;
}

function outlineContext(srcRoot, bundle) {
  const ne = JSON.parse(readFileSync(join(srcRoot, 'ne', 'ne_10m_admin_0_disputed_areas.geojson'), 'utf8'));
  return {
    neByBrk: new Map(ne.features.map((f) => [f.properties.BRK_A3, f])),
    adm1: new Map(bundleRows(bundle, 1).map((r) => [r.id, r])),
  };
}

function buildZones(ctx, countries, cur) {
  const ids = new Set(countries.map((c) => c.iso3));
  const out = [];
  for (const z of cur.zones) {
    if (z.policy !== 'area') continue; // 'country': the bundle's country row already names it (listed for review)
    const admin = (z.admin || '').split(/\s+/).filter(Boolean);
    if (!admin.length) throw new Error(`zones.tsv ${z.key}: no administering country (admin)`);
    for (const a of admin) if (!ids.has(a)) throw new Error(`zones.tsv ${z.key}: admin ${a} is not a bundle country`);
    out.push(area({
      layer: 3, key: z.key, world: z.world, kind: z.policy, code: z.source, name_en: z.name_en, name_ru: z.name_ru,
      short_en: z.short_en, short_ru: z.short_ru, admin: admin.join(' '), q: Q_DETAIL,
      qpolys: curatedOutlines('zones.tsv', z.key, z.source, ctx),
    }));
  }
  return out;
}

/**
 * Assignment areas (layer 4): land whose country the coarse outlines get wrong where a policy draws the line (owner
 * decision Q2: East Jerusalem and the West Bank are Palestine, the rest of the Jerusalem district is Israel). The first
 * by `rank` holding a point gives its country, before the country and province outlines. Small features: DP 0.001 deg.
 */
function buildAssignments(ctx, countries, cur) {
  const ids = new Set(countries.map((c) => c.iso3));
  return cur.assignments.map((r) => {
    if (!ids.has(r.country)) throw new Error(`assignments.tsv ${r.key}: ${r.country} is not a bundle country`);
    if (!/^assign:[a-z0-9-]+$/.test(r.key)) throw new Error(`assignments.tsv: bad key ${r.key}`);
    return area({
      layer: 4, key: r.key, iso3: r.country, rank: Number(r.rank), kind: 'assignment', code: r.source, name_en: r.name_en,
      q: Q_DETAIL, qpolys: curatedOutlines('assignments.tsv', r.key, r.source, ctx, 0.001),
    });
  });
}

// ---- towns ------------------------------------------------------------------------------------------------------------

/** Build-time areas as a part the reference resolver reads (its index and land function, no towns). */
function asPart(areas, places = null) {
  return {
    areas: areas.map((a) => withAdmins({ ...a, polys: a._polys, boxes: a._polys.map((poly) => bboxOf([poly], a.q)) })),
    places,
  };
}

// Russian labels of administrative units and other things that are not a town's name.
const RU_UNIT_LABEL = new RegExp('^(\u0433\u043e\u0440\u043e\u0434\u0441\u043a\u043e\u0439 \u043e\u043a\u0440\u0443\u0433|' +
  '\u0433\u043e\u0440\u043e\u0434\u0441\u043a\u043e\u0435 \u043f\u043e\u0441\u0435\u043b\u0435\u043d\u0438\u0435|' +
  '\u0441\u0435\u043b\u044c\u0441\u043a\u043e\u0435 \u043f\u043e\u0441\u0435\u043b\u0435\u043d\u0438\u0435|' +
  '\u043c\u0443\u043d\u0438\u0446\u0438\u043f\u0430\u043b\u044c\u043d|\u0440\u0430\u0439\u043e\u043d |\u0438\u043c\u0435\u043d\u0438 |' +
  '\u043f\u043b\u043e\u0449\u0430\u0434\u044c |\u043f\u0430\u0440\u043a |\u0443\u043b\u0438\u0446\u0430 )', 'u');
// ... anywhere in the label: an agglomeration, a district ("raion", "okrug"), an ordinal ("2-y okrug Liona").
const RU_NOT_A_TOWN = new RegExp('\u0430\u0433\u043b\u043e\u043c\u0435\u0440\u0430\u0446\u0438|' +
  '\\s\u0440\u0430\u0439\u043e\u043d(\\s|$)|\\s\u043e\u043a\u0440\u0443\u0433(\\s|$)|^\\d', 'iu');
// A qualifier the town's own name must carry ("Staryy Oskol" may be "Stary Oskol", Delhi may not be "Old Delhi").
const RU_QUALIFIER = new RegExp('^(\u0421\u0442\u0430\u0440|\u0411\u043e\u043b\u044c\u0448|\u041d\u043e\u0432)', 'u');
const LATIN_QUALIFIER = /^(old|star|bol|great|new|nov|nuev|neu|nou|nieuw|ny)/;
// Words of an English Wikidata label that make it another thing than the town (unless the town's name has them).
const EN_NOT_A_TOWN = /\b(old|greater|metropolitan|agglomeration|district|municipal|municipality|okrug|arrondissement|subdistrict|county|governorate|region|province|township|commune|department|prefecture|rail|terminal|station|university|base|island|encampment)\b/gi;

/**
 * A Wikidata label is the town's name only when the item is the town's: its English label is alike one of the town's
 * GeoNames names (not "Old Delhi" for Delhi, "Baixada Santista" for Santos, "Yiyang" for Heshan), and its Russian label
 * is no administrative unit or agglomeration and carries no qualifier the town's name lacks.
 */
export function wikidataRussian(w, names) {
  if (!w?.ru || isAllCaps(w.ru) || RU_UNIT_LABEL.test(w.ru) || RU_NOT_A_TOWN.test(w.ru)) return '';
  const own = names.map((n) => nameSkeleton(n));
  if (RU_QUALIFIER.test(w.ru) && !own.some((n) => LATIN_QUALIFIER.test(n))) return '';
  if (w.en) {
    const en = w.en.replace(/,.*$/, '');
    const extra = (en.match(EN_NOT_A_TOWN) || []).filter((word) => !names.some((n) => new RegExp(`\\b${word}\\b`, 'i').test(n)));
    if (extra.length) return '';
    const stripped = en.replace(EN_NOT_A_TOWN, ' ');
    if (Math.max(...names.map((n) => nameSimilarity(n, stripped))) < 0.5) return '';
  }
  return w.ru;
}

/** An English town title: Dutch "'s-" / "'t " restored, a leading "gorod " (Russian for "city") dropped, a capital first. */
function englishTitle(s, cc) {
  let t = stripAdminSuffix(s, cc);
  if ((cc === 'NL' || cc === 'BE') && /^(s-|t )/.test(t)) t = `'${t}`;
  if (cc === 'RU' || cc === 'BY' || cc === 'KZ') t = t.replace(/^gorod /i, '');
  return capitalizeFirst(t);
}

/** GeoNames' alternates in `lang` that a title may use: never colloquial, historic or time-limited. */
function usableAlternates(alts, lang) {
  return alts.filter((a) => a.lang === lang && !a.colloquial && !a.historic && !a.from && !a.to)
    .map((a) => ({ ...a, name: clean(a.name) }))
    .filter((a) => (lang === 'ru' ? isRussian(a.name) : !hasCyrillic(a.name)));
}

/** GeoNames' English alternate: preferred, then plain, then short (`preferredOnly`: preferred ones only). */
function pickAlternate(alts, lang, { preferredOnly = false } = {}) {
  const ok = usableAlternates(alts, lang);
  const order = preferredOnly ? [ok.filter((a) => a.preferred && !a.short)]
    : [ok.filter((a) => a.preferred && !a.short), ok.filter((a) => !a.preferred && !a.short), ok.filter((a) => a.short)];
  for (const group of order) if (group.length) return group[0].name;
  return '';
}

/**
 * GeoNames' Russian name: the preferred one; else a plain name only when it is the only one (two different plain names,
 * "Kalkutta" and "Kozhikode" for Kozhikode, "Zarya" and "Zaria" for Zaria, are a guess: none then, and the Latin name
 * shows); else a short name, also only when it is the only one. Spellings of one name (they differ by "yo", or are at
 * least 75 % alike: "Kayani" and "Kayaani") count as one, the first listed.
 */
export function pickRussian(alts) {
  const ok = usableAlternates(alts, 'ru');
  const preferred = ok.filter((a) => a.preferred && !a.short);
  if (preferred.length) return { name: preferred[0].name, via: 'geonames-preferred' };
  const distinct = (list) => {
    const out = [];
    const key = (n) => n.replace(/\u0451/g, '\u0435').replace(/\u0401/g, '\u0415').toLowerCase();
    for (const a of list) if (!out.some((n) => key(n) === key(a.name) || nameSimilarity(n, a.name) >= 0.75)) out.push(a.name);
    return out;
  };
  for (const [list, via] of [[ok.filter((a) => !a.preferred && !a.short), 'geonames'], [ok.filter((a) => a.short), 'geonames-short']]) {
    const names = distinct(list);
    if (names.length === 1) return { name: names[0], via };
    if (names.length > 1) return { name: '', via: 'ambiguous', candidates: names };
  }
  return { name: '', via: 'none' };
}

/** A curated policy pair: a town GeoNames files under `cc` that stays in its outline's country (town-countries.tsv). */
function policyFor(rows, cc, country, L) {
  return rows.find((r) => r.cc === cc && r.country === country
    && (!r.within || r.within === L.zone?.key || r.within === L.assignment?.key)) || null;
}

function buildTowns(srcRoot, countries, provinces, zones, assignments, cur, minPopulation, report) {
  const overrides = new Map(cur.placesOverrides.map((r) => [r.geonameid, r]));
  const countryIds = new Set(countries.map((c) => c.iso3));
  for (const o of overrides.values()) {
    for (const k of ['adm0', 'alt']) if (o[k] && !countryIds.has(o[k])) throw new Error(`places-overrides.tsv ${o.geonameid}: ${k} ${o[k]} is not a bundle country`);
  }
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
  const ruReview = [];
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
    const latinNames = [c[1], c[2], ...(c[3] ? c[3].split(',') : []).filter((n) => !hasNonLatinLetters(n)), ...usableAlternates(a, 'en').map((x) => x.name)];
    const wdRu = wikidataRussian(w, latinNames);
    const gnRu = pickRussian(a);
    const nameRu = capitalizeFirst(clean(o?.name_ru) || wdRu || gnRu.name);
    const ruVia = o?.name_ru ? 'override' : wdRu ? 'wikidata' : gnRu.via;
    const lat = o?.lat ? Math.round(Number(o.lat) * Q_DETAIL) : Math.round(Number(c[4]) * Q_DETAIL);
    const lon = o?.lon ? Math.round(Number(o.lon) * Q_DETAIL) : Math.round(Number(c[5]) * Q_DETAIL);
    towns.push({
      id: Number(id), lat, lon, pop, fcode: c[7], cc, a1: c[10], a2: c[11],
      name_en: nameEn, name_ru: nameRu || null, short_en: o?.short_en || null, short_ru: o?.short_ru || null, ruVia, o,
    });
    if (pop >= 100000) {
      ruReview.push({ id: Number(id), cc, name_en: nameEn, name_ru: nameRu || '', via: ruVia, wikidata: w?.ru || '', wikidata_en: w?.en || '',
        wikidata_used: !!wdRu, geonames: (gnRu.candidates || (gnRu.name ? [gnRu.name] : [])).join(' | ') });
    }
  }
  for (const id of overrides.keys()) if (!seenOverride.has(id)) throw new Error(`places-overrides.tsv: geonameid ${id} is not in cities1000`);

  // The town's country: GeoNames' (its cc as the bundle's country), unless a curated policy pair keeps the outline's
  // country (Crimea, Northern Cyprus, Somaliland, the West Bank, the overseas departments the bundle's France holds;
  // town-countries.tsv) or an override sets it. Its outline's country (the land function at the town: an assignment area,
  // the country and province outlines; else the nearest country or province outline within 22 km, a coast the
  // simplified outlines cut off) is kept as `adm0_alt` when it differs, so rule E still names the town on the land the
  // outlines give it (El Paso, inside Mexico's simplified outline). A town farther than 22 km from every outline is
  // dropped (build report).
  const iso2to3 = new Map(cur.countries.filter((r) => r.iso2).map((r) => [r.iso2, r.id]));
  const res = new Resolver(new PlaceIndex(asPart([...countries, ...zones, ...assignments]), asPart(provinces, [])));
  const joined = [];
  const unjoined = [];
  const unmapped = [];
  const via = { agree: 0, policy: 0, geonames: 0, override: 0 };
  let snapped = 0;
  for (const t of towns) {
    const lat = t.lat / Q_DETAIL;
    const lon = t.lon / Q_DETAIL;
    const L = res.land(lat, lon);
    let outline = L.country?.iso3 || null;
    if (!outline) {
      const n = res.nearestCountry(lat, lon, SNAP_KM);
      if (n) {
        outline = n.country.iso3;
        snapped++;
      } else if (L.zone?.admins.size) {
        outline = [...L.zone.admins][0];
      }
    }
    if (!outline) {
      unjoined.push({ id: t.id, name: t.name_en, cc: t.cc, lat, lon, pop: t.pop });
      continue;
    }
    const gn = iso2to3.get(t.cc) || null;
    let adm0;
    let how;
    if (t.o?.adm0) [adm0, how] = [t.o.adm0, 'override'];
    else if (gn === outline) [adm0, how] = [gn, 'agree'];
    else if (policyFor(cur.townCountries, t.cc, outline, L)) [adm0, how] = [outline, 'policy'];
    else if (gn) [adm0, how] = [gn, 'geonames'];
    else {
      unmapped.push(`${t.id} ${t.name_en} (${t.cc}, outline ${outline})`);
      continue;
    }
    via[how]++;
    const alt = t.o?.alt || (outline !== adm0 ? outline : null);
    const p1 = res.ix.provinces.containing(lat, lon)[0];
    joined.push({ ...t, adm0, adm0_alt: alt !== adm0 ? alt : null, outline, adm1: p1 ? p1.key.slice(5) : null, metro: t.id });
  }
  if (unmapped.length) {
    throw new Error(`GeoNames country codes without a bundle country or a town-countries.tsv row (${unmapped.length}): ${unmapped.slice(0, 12).join('; ')}`);
  }
  report.towns = { candidates: towns.length, snapped, unjoined: unjoined.length, countries: via };
  report.unjoinedTowns = unjoined;

  // Metro rules: metros.tsv (admin2:<cc>.<admin1>.<admin2> folds every town of a GeoNames second-order division within
  // km of the metro: a Tokyo special ward; admin1:<cc>.<admin1> every town of a first-order division within km: a
  // city-province's districts; place:<id> one town), then sections of a city (PPLX) fold into their municipality.
  const byId = new Map(joined.map((t) => [t.id, t]));
  const folded = new Set();
  const wardChecks = [];
  const dist = (a, b) => haversineKm(a.lat / Q_DETAIL, a.lon / Q_DETAIL, b.lat / Q_DETAIL, b.lon / Q_DETAIL);
  for (const m of cur.metros) {
    const metro = byId.get(Number(m.metro));
    if (!metro) throw new Error(`metros.tsv: metro ${m.metro} is not a kept town`);
    if (m.rule.startsWith('admin2:')) {
      // A GeoNames second-order division (a Tokyo special ward), every town of it within km of the metro. A town of the
      // division farther out is a misplaced record (drop it in places-overrides.tsv).
      const [cc, a1, a2] = m.rule.slice(7).split('.');
      const km = Number(m.km);
      if (!(km > 0) || !a2 || !m.check_name) throw new Error(`metros.tsv: ${m.rule} needs <cc>.<admin1>.<admin2>, km and check_name`);
      if (metro.cc !== cc || metro.a1 !== a1) throw new Error(`metros.tsv: metro ${m.metro} is not in ${cc}.${a1}`);
      const far = [];
      let count = 0;
      for (const t of joined) {
        if (t === metro || t.cc !== cc || t.a1 !== a1 || t.a2 !== a2) continue;
        if (dist(t, metro) > km) {
          far.push(`${t.id} ${t.name_en} ${dist(t, metro).toFixed(0)} km`);
          continue;
        }
        t.metro = metro.id;
        folded.add(t.id);
        count++;
      }
      if (far.length) throw new Error(`metros.tsv ${m.rule}: towns of the division farther than ${km} km from the metro: ${far.join('; ')}`);
      if (!count) throw new Error(`metros.tsv ${m.rule}: the division has no town (renumbered?)`);
      wardChecks.push({ rule: m.rule, cc, a1, name: m.check_name, metro: metro.id });
    } else if (m.rule.startsWith('admin1:')) {
      // Every town of the GeoNames first-order division within `km` of the metro: a city-province's districts.
      const [cc, a1] = m.rule.slice(7).split('.');
      const km = Number(m.km);
      if (!(km > 0)) throw new Error(`metros.tsv: ${m.rule} needs km`);
      if (metro.cc !== cc || metro.a1 !== a1) throw new Error(`metros.tsv: metro ${m.metro} is not in ${m.rule}`);
      if (m.check_name && metro.name_en !== m.check_name) throw new Error(`metros.tsv: metro ${m.metro} is "${metro.name_en}", expected "${m.check_name}"`);
      for (const t of joined) {
        if (t === metro || t.cc !== cc || t.a1 !== a1) continue;
        if (dist(t, metro) > km) continue;
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
  // A town named after a ward: in the metro's prefecture it must be folded (wherever GeoNames files it: its "Toshima"
  // record sits in Kita's division); elsewhere one of 100,000 people or more is listed for review (a ward's record with
  // the ward's population at a wrong place, such as "Suginami" at Ishioka, wins rule E far from Tokyo).
  report.wardNamesElsewhere = [];
  for (const w of wardChecks) {
    const same = joined.filter((t) => t.cc === w.cc && nameSkeleton(t.name_en) === nameSkeleton(w.name));
    const loose = same.filter((t) => t.a1 === w.a1 && t.metro !== w.metro && t.id !== w.metro);
    if (loose.length) throw new Error(`metros.tsv ${w.rule}: towns named "${w.name}" in the prefecture are not folded: ${loose.map((t) => `${t.id} (${t.a1}.${t.a2})`).join(', ')}`);
    for (const t of same) if (t.a1 !== w.a1 && t.pop >= 100000) report.wardNamesElsewhere.push({ ward: w.name, id: t.id, name: t.name_en, a1: t.a1, pop: t.pop });
  }

  // Sections of a city (PPLX), each ranking with its own population so it cannot swallow a neighbouring city:
  //   1. into the nearest non-section town within 15 km of a shared country with at least its population, never one of
  //      another municipality (both with a GeoNames admin2: the Sao Paulo districts are not Diadema, Ichikawa's record
  //      is not Matsudo). Where GeoNames gives a city 0 people and its figure to a section, an override gives the city
  //      its population back (Funabashi, Mitaka) and the section folds into it;
  //   2. else it is shown as itself (often the city's own record: Ichikawa, Navi Mumbai), its population capped at the
  //      largest non-section town within 15 km, so a record carrying a whole district's or city's figure does not win
  //      rule E far beyond its place (New Territories, Teni); an override's keep 1 exempts it. Listed in the build report.
  const mainTowns = joined.filter((t) => t.fcode !== 'PPLX');
  const grid = new Map();
  for (const t of mainTowns) {
    const k = cellOf(t.lat / Q_DETAIL, t.lon / Q_DETAIL);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(t);
  }
  const near = (t) => {
    const out = [];
    const la = Math.floor(t.lat / Q_DETAIL) + 90;
    const lo = Math.floor(t.lon / Q_DETAIL) + 180;
    for (let dy = -1; dy <= 1; dy++) {
      const y = la + dy;
      if (y < 0 || y > 179) continue;
      for (let dx = -1; dx <= 1; dx++) {
        for (const m of grid.get(y * 360 + ((lo + dx + 360) % 360)) || []) {
          const d = dist(t, m);
          if (d <= SECTION_KM) out.push({ m, d });
        }
      }
    }
    return out.sort((x, y) => x.d - y.d || x.m.id - y.m.id);
  };
  const shares = (a, b) => [a.adm0, a.adm0_alt].some((c) => c && (c === b.adm0 || c === b.adm0_alt));
  const sectionStats = { folded: 0, alone: 0, capped: 0 };
  const alone = [];
  for (const t of joined) {
    if (t.fcode !== 'PPLX' || folded.has(t.id)) continue;
    const around = near(t);
    const target = around.find(({ m }) => m.pop >= t.pop && shares(t, m) && !(t.a2 && m.a2 && (m.a1 !== t.a1 || m.a2 !== t.a2)));
    if (target) {
      t.metro = target.m.id;
      sectionStats.folded++;
      continue;
    }
    const biggest = around.filter(({ m }) => shares(t, m)).reduce((best, x) => Math.max(best, x.m.pop), 0);
    const cap = t.o?.keep !== '1' && biggest > 0 && biggest < t.pop ? biggest : null;
    alone.push({ id: t.id, name: t.name_en, cc: t.cc, pop: t.pop, cappedTo: cap });
    if (cap !== null) {
      t.pop = cap;
      sectionStats.capped++;
    }
    sectionStats.alone++;
  }
  const kept = joined;
  const keptById = byId;
  // A metro must be shown as itself: follow chains once (a section of a folded ward town).
  for (const t of kept) {
    let m = keptById.get(t.metro);
    let hops = 0;
    while (m && m.metro !== m.id && hops < 4) {
      m = keptById.get(m.metro);
      hops++;
    }
    if (!m || m.metro !== m.id) throw new Error(`metro chain of ${t.id} does not end in a town shown as itself`);
    t.metro = m.id;
  }
  report.towns.aliases = { metroRules: folded.size, sections: sectionStats };
  report.sectionsShownAsThemselves = alone.sort((x, y) => y.pop - x.pop);
  report.towns.kept = kept.length;
  const ru = {};
  for (const t of kept) ru[t.ruVia] = (ru[t.ruVia] || 0) + 1;
  report.towns.russianNames = ru;
  report.russianReview = ruReview.filter((r) => keptById.has(r.id) && keptById.get(r.id).metro === r.id)
    .sort((x, y) => x.cc.localeCompare(y.cc) || x.name_en.localeCompare(y.name_en));
  return kept;
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
  admin TEXT,
  national INTEGER NOT NULL DEFAULT 0,
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
  adm0_alt TEXT,
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
    name_en, name_ru, short_en, short_ru, admin, national, min_lng, min_lat, max_lng, max_lat, q, vertices, geometry)
    VALUES (@id, @layer, @key, @iso3, @iso2, @world, @parent, @whole, @globe, @kind, @rank, @code, @iso_3166_2,
    @name_en, @name_ru, @short_en, @short_ru, @admin, @national, @min_lng, @min_lat, @max_lng, @max_lat, @q, @vertices, @geometry)`);
  const rt = db.prepare('INSERT INTO areas_rtree(id, min_lng, max_lng, min_lat, max_lat) VALUES (?, ?, ?, ?, ?)');
  const insP = places && db.prepare(`INSERT INTO places(cell, id, lat, lon, pop, adm0, adm1, adm0_alt, metro, name_en, name_ru, short_en, short_ru)
    VALUES (@cell, @id, @lat, @lon, @pop, @adm0, @adm1, @adm0_alt, @metro, @name_en, @name_ru, @short_en, @short_ru)`);
  const counts = { areas: sorted.length, countries: 0, provinces: 0, waters: 0, zones: 0, assignments: 0, places: places ? places.length : 0 };
  db.transaction(() => {
    sorted.forEach((a, i) => {
      const { _polys, _boxes, ...row } = a;
      ins.run({ admin: null, national: 0, ...row, id: i + 1 });
      rt.run(i + 1, a.min_lng, a.max_lng, a.min_lat, a.max_lat);
      counts[['countries', 'provinces', 'waters', 'zones', 'assignments'][a.layer]]++;
    });
    if (places) {
      const rows = places.map((t) => ({
        cell: cellOf(t.lat / Q_DETAIL, t.lon / Q_DETAIL), id: t.id, lat: t.lat, lon: t.lon, pop: t.pop, adm0: t.adm0,
        adm1: t.adm1, adm0_alt: t.adm0_alt ?? null, metro: t.metro, name_en: t.name_en, name_ru: t.name_ru, short_en: t.short_en, short_ru: t.short_ru,
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
  const cur = {
    countries: curation('countries.tsv'),
    waters: curation('waters.tsv'),
    zones: curation('zones.tsv'),
    assignments: curation('assignments.tsv'),
    metros: curation('metros.tsv'),
    placesOverrides: curation('places-overrides.tsv'),
    townCountries: curation('town-countries.tsv'),
    admin1Overrides: curation('admin1-overrides.tsv'),
    shortNames: curation('short-names.tsv'),
    wikidata: curation('wikidata-labels.tsv'),
  };
  // short-names.tsv holds countries' and provinces' short forms only (waters, zones and towns keep theirs in their own
  // tables): any other key would be silently ignored, so it fails the build.
  for (const r of cur.shortNames) {
    if (!/^adm[01]:[A-Z0-9.]+$/.test(r.key)) throw new Error(`short-names.tsv: ${r.key} is not a country or province key (adm0:/adm1:)`);
  }
  return cur;
}

/**
 * Release builds run on one Node, places/.nvmrc (CI uses the same file): name hygiene (NFC/NFD, \p{...} classes, case
 * mapping) follows that Node's Unicode tables, and the deflate stream its zlib. PLACES_ANY_NODE=1 allows another one for
 * local experiments; the build report records the one used.
 */
function checkNode() {
  const want = readFileSync(join(HERE, '.nvmrc'), 'utf8').trim().replace(/^v/, '');
  const have = process.versions.node;
  if (have !== want && process.env.PLACES_ANY_NODE !== '1') {
    throw new Error(`Node ${have}: release builds run on Node ${want} (places/.nvmrc); set PLACES_ANY_NODE=1 for a local experiment`);
  }
  return { node: have, unicode: process.versions.unicode, icu: process.versions.icu };
}

async function main() {
  const opt = parseArgs();
  const runtime = checkNode();
  const outDir = join(opt.out, opt.version);
  const work = join(opt.out, '.work');
  ensureDir(outDir);
  ensureDir(work);
  const src = loadSources(opt.sources, work);
  const bundle = loadBundle(opt.bundle, work);
  const cur = loadCuration();
  const report = { version: opt.version, minPopulation: opt.minPopulation, runtime };

  const countries = buildCountries(bundle, cur);
  const provinces = buildProvinces(bundle, src.root, cur);
  const waters = buildWaters(src.root, cur);
  const ctx = outlineContext(src.root, bundle);
  const zones = buildZones(ctx, countries, cur);
  const assignments = buildAssignments(ctx, countries, cur);
  // Short forms for keys the bundle does not have would be silently ignored: a renamed key fails the build.
  const keys = new Set([...countries, ...provinces].map((a) => a.key));
  for (const r of cur.shortNames) if (!keys.has(r.key)) throw new Error(`short-names.tsv: no such key ${r.key}`);
  log(`areas: ${countries.length} countries, ${provinces.length} provinces, ${waters.length} waters, ${zones.length} zones, ${assignments.length} assignments`);
  const towns = buildTowns(src.root, countries, provinces, zones, assignments, cur, opt.minPopulation, report);
  // The licence statement (LICENSES.md, "Place names pack") rests on this: the pack reads the bundle's countries and
  // provinces (Natural Earth) only, never its level-2 districts (geoBoundaries, CC BY-SA).
  report.bundleLevelsRead = [0, 1];
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
  const core = writePart(join(outDir, 'places-core.sqlite'), 'core', [...countries, ...waters, ...zones, ...assignments], null, meta);
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
