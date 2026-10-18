// Freeze the Wikidata labels (ru, en; CC0) the pack uses into places/curation/wikidata-labels.tsv, so a build never
// queries a live service. Run by hand after stage.mjs, reviewed as a diff.
//
// Towns: GeoNames links a place to its Wikidata item through `wkdt` alternate names, for about a quarter of the
// places only. The Wikidata Query Service also finds the items that carry the place's GeoNames ID (P1566). A place is
// linked by GeoNames' own `wkdt` row when it has one, else by P1566 when exactly one item claims the id.
// Waters: Natural Earth's `wikidataid` of every marine polygon.
//
// Politeness: one request at a time, at least 1.1 s apart, a descriptive User-Agent, and the Retry-After of a 429 or
// 503 is honoured. Every batch is cached under dist/places-wikidata-cache, so an interrupted run resumes.
//
// usage: node places/wikidata.mjs <staged sources dir> [--min-population 5000] [--cache <dir>]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTsv } from './lib/io.mjs';
import { clean, isRussian, hasCyrillic } from './lib/names.mjs';
import { keepTown } from './lib/places.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UA = 'TheShelter-region-tiles-places/1.0 (https://github.com/TheShelterApp/region-tiles; place-names pack build, run by hand)';
const GAP_MS = 1100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;

async function politeFetch(url, init = {}) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const wait = last + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(120000), headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip', ...(init.headers || {}) } });
      if (res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504) {
        const ra = Number(res.headers.get('retry-after')) || 10 * (attempt + 1);
        console.error(`  HTTP ${res.status}, waiting ${ra} s`);
        await res.arrayBuffer().catch(() => {});
        await sleep(ra * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json?.error?.code === 'maxlag') {
        const ra = Number(res.headers.get('retry-after')) || 5 * (attempt + 1);
        console.error(`  maxlag (${json.error.lag ?? '?'} s), waiting ${ra} s`);
        await sleep(ra * 1000);
        continue;
      }
      return json;
    } catch (e) {
      if (/^HTTP 4/.test(e.message)) throw new Error(`${url.slice(0, 120)}: ${e.message}`);
      console.error(`  ${e.message}, retrying`);
      await sleep(5000 * (attempt + 1));
    }
  }
  throw new Error('too many retries');
}

/** A JSON file cache for the batches of one run, so an interrupted freeze resumes without asking again. */
function cached(dir, name, compute) {
  const p = join(dir, `${name}.json`);
  if (existsSync(p)) return Promise.resolve(JSON.parse(readFileSync(p, 'utf8')));
  return compute().then((v) => {
    writeFileSync(p, JSON.stringify(v));
    return v;
  });
}

/** A label fit for the pack: cleaned, no parenthesised qualifier, Russian for ru and Latin-script for en. */
function usable(label, lang) {
  if (!label) return '';
  const s = clean(label.replace(/\s*\([^)]*\)\s*$/, ''));
  if (lang === 'ru') return isRussian(s) ? s : '';
  return hasCyrillic(s) ? '' : s;
}

async function labelsByQid(qids, cacheDir) {
  // The Query Service rather than wbgetentities: the API's maxlag guard can refuse a polite client for a long time
  // while the database replicas lag, and the labels are the same data.
  const out = new Map();
  const list = [...qids].filter((q) => /^Q\d+$/.test(q)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const BATCH = 400;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const query = `SELECT ?item ?ru ?en WHERE { VALUES ?item { ${batch.map((q) => `wd:${q}`).join(' ')} }
      OPTIONAL { ?item rdfs:label ?ru FILTER(LANG(?ru) = "ru") } OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") } }`;
    const json = await cached(cacheDir, `labels-${batch[0]}-${batch.length}`, () => politeFetch('https://query.wikidata.org/sparql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
      body: new URLSearchParams({ query }).toString(),
    }));
    for (const b of json.results.bindings) {
      const qid = b.item.value.replace(/^.*\//, '');
      if (!out.has(qid)) out.set(qid, { qid, ru: b.ru?.value || '', en: b.en?.value || '' });
    }
    console.log(`  labels ${i + batch.length}/${list.length}`);
  }
  return out;
}

async function itemsByGeonamesId(ids, cacheDir) {
  const out = new Map(); // geonameid -> [{qid, ru, en}]
  const list = [...ids].sort((a, b) => Number(a) - Number(b));
  const BATCH = 400;
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH);
    const query = `SELECT ?gn ?item ?ru ?en WHERE { VALUES ?gn { ${batch.map((g) => `"${g}"`).join(' ')} } ?item wdt:P1566 ?gn .
      OPTIONAL { ?item rdfs:label ?ru FILTER(LANG(?ru) = "ru") } OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") } }`;
    const json = await cached(cacheDir, `p1566-${batch[0]}-${batch.length}`, () => politeFetch('https://query.wikidata.org/sparql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
      body: new URLSearchParams({ query }).toString(),
    }));
    for (const b of json.results.bindings) {
      const gn = b.gn.value;
      const qid = b.item.value.replace(/^.*\//, '');
      if (!out.has(gn)) out.set(gn, []);
      const arr = out.get(gn);
      if (!arr.some((x) => x.qid === qid)) arr.push({ qid, ru: b.ru?.value || '', en: b.en?.value || '' });
    }
    if ((i / BATCH) % 10 === 0) console.log(`  P1566 ${i + batch.length}/${list.length}`);
  }
  return out;
}

async function main() {
  const [srcDir, ...rest] = process.argv.slice(2);
  if (!srcDir) throw new Error('usage: node places/wikidata.mjs <staged sources dir> [--min-population 5000]');
  const opt = Object.fromEntries(rest.map((v, i) => (i % 2 === 0 ? [v.replace(/^--/, ''), rest[i + 1]] : null)).filter(Boolean));
  const minPop = Number(opt['min-population'] || 5000);
  const cacheDir = opt.cache || join(HERE, '..', 'dist', 'places-wikidata-cache');
  mkdirSync(cacheDir, { recursive: true });

  // The kept towns (the build's population rule and feature-code filter).
  const ids = new Set();
  for (const line of readFileSync(join(srcDir, 'geonames', 'cities1000.txt'), 'utf8').split('\n')) {
    const c = line.split('\t');
    if (c.length < 19) continue;
    const pop = Number(c[14]) || 0;
    if (!keepTown(pop, c[7], minPop)) continue;
    ids.add(c[0]);
  }
  const gnLink = new Map();
  for (const line of readFileSync(join(srcDir, 'geonames', 'alternate-names-ru-en-wkdt.tsv'), 'utf8').split('\n')) {
    const c = line.split('\t');
    if (c[2] !== 'wkdt' || !ids.has(c[1])) continue;
    const q = c[3].trim();
    if (/^Q\d+$/.test(q) && !gnLink.has(c[1])) gnLink.set(c[1], q);
  }
  console.log(`towns: ${ids.size}; GeoNames wkdt links: ${gnLink.size}`);

  console.log('Wikidata Query Service: items by GeoNames ID (P1566)');
  const byGn = await itemsByGeonamesId(ids, cacheDir);

  const waters = JSON.parse(readFileSync(join(srcDir, 'ne', 'ne_10m_geography_marine_polys.geojson'), 'utf8'));
  const waterQids = new Set(waters.features.map((f) => f.properties.wikidataid).filter((q) => /^Q\d+$/.test(q || '')));

  // Labels for every QID we link but the P1566 query did not label (GeoNames-only links, waters).
  const need = new Set(waterQids);
  for (const [gn, q] of gnLink) if (!(byGn.get(gn) || []).some((x) => x.qid === q)) need.add(q);
  console.log(`labels of ${need.size} more items`);
  const labels = await labelsByQid(need, cacheDir);

  const rows = [];
  let linkedGn = 0;
  let linkedP = 0;
  let ambiguous = 0;
  for (const gn of [...ids].sort((a, b) => Number(a) - Number(b))) {
    const claims = byGn.get(gn) || [];
    let row = null;
    if (gnLink.has(gn)) {
      const q = gnLink.get(gn);
      const hit = claims.find((x) => x.qid === q) || labels.get(q);
      if (hit) row = { key: `place:${gn}`, qid: hit.qid || q, ru: hit.ru, en: hit.en, via: 'geonames-wkdt' };
      linkedGn++;
    } else if (claims.length === 1) {
      row = { key: `place:${gn}`, qid: claims[0].qid, ru: claims[0].ru, en: claims[0].en, via: 'wikidata-P1566' };
      linkedP++;
    } else if (claims.length > 1) {
      ambiguous++;
    }
    if (row) rows.push({ ...row, ru: usable(row.ru, 'ru'), en: usable(row.en, 'en') });
  }
  for (const q of [...waterQids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
    const l = labels.get(q);
    if (l) rows.push({ key: `qid:${q}`, qid: l.qid, ru: usable(l.ru, 'ru'), en: usable(l.en, 'en'), via: 'natural-earth' });
  }
  writeTsv(join(HERE, 'curation', 'wikidata-labels.tsv'), ['key', 'qid', 'ru', 'en', 'via'], rows, [
    'Wikidata labels (CC0), frozen by places/wikidata.mjs; do not edit by hand (correct a name in places-overrides.tsv or waters.tsv).',
    `key: place:<geonameid> (a town, linked via GeoNames wkdt or a unique Wikidata P1566 claim) or qid:<QID> (a Natural Earth water's wikidataid).`,
    `Retrieved ${new Date().toISOString().slice(0, 10)}; towns of the ${minPop >= 5000 ? 'cities5000' : 'cities1000'} set.`,
  ]);
  console.log(`wrote ${rows.length} rows: ${linkedGn} towns via GeoNames wkdt, ${linkedP} via P1566, ${ambiguous} ambiguous (skipped), ${waterQids.size} waters`);
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
