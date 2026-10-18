// P0: stage the place-names pack's sources into one reproducible archive, `places-sources-<date>.tar.gz`.
//
// The upstream files are downloaded by hand first (README, "Sources"; each into its own empty directory). This script
// makes no network requests: it reads those files, checks them against what it expects, filters the GeoNames
// alternate names to the kept places' ru / en / wkdt rows, converts the Natural Earth shapefiles to GeoJSON, and
// writes the archive plus `places/sources.lock.json`. The archive is published as a release asset of this repository
// once the owner approves it; every later build reads only the archive, the regions bundle and the curation tables.
//
// usage: node places/stage.mjs --date 2026-10-17 \
//   --ne-marine <dir with ne_10m_geography_marine_polys.{shp,shx,dbf,prj,cpg}> \
//   --ne-disputed <dir with ne_10m_admin_0_disputed_areas.{shp,shx,dbf,prj,cpg}> \
//   --ne-admin1 <dir with ne_10m_admin_1_states_provinces.{dbf,cpg}> \
//   --cities1000 <cities1000.zip> --cities5000 <cities5000.zip> --alternate-names <alternateNamesV2.zip> \
//   --out <empty output dir>
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { readDbf } from './lib/dbf.mjs';
import { ensureDir, sha256, sha256File, stableStringify, gzipDeterministic, tarDeterministic, listFiles, writeTsv } from './lib/io.mjs';
import { SOURCES } from './sources.mjs';
import { isCities5000 } from './lib/places.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MAPSHAPER = join(ROOT, 'node_modules', '.bin', 'mapshaper');

function args() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i += 2) {
    if (!a[i].startsWith('--')) throw new Error(`unexpected argument ${a[i]}`);
    out[a[i].slice(2)] = a[i + 1];
  }
  for (const k of ['date', 'ne-marine', 'ne-disputed', 'ne-admin1', 'cities1000', 'cities5000', 'alternate-names', 'out']) {
    if (!out[k]) throw new Error(`missing --${k}`);
  }
  return out;
}

const log = (...m) => console.log('[stage]', ...m);

/** Every upstream file of SOURCES must be present with the pinned size and sha256. */
function checkUpstream(opt) {
  const dirs = { ne_marine: opt['ne-marine'], ne_disputed: opt['ne-disputed'], ne_admin1: opt['ne-admin1'] };
  const files = {
    'geonames/cities1000.zip': opt.cities1000,
    'geonames/cities5000.zip': opt.cities5000,
    'geonames/alternateNamesV2.zip': opt['alternate-names'],
  };
  const found = {};
  for (const src of SOURCES.upstream) {
    for (const f of src.files) {
      const path = src.id in dirs ? join(dirs[src.id], basename(f.path)) : files[f.path];
      if (!path || !existsSync(path)) throw new Error(`missing upstream file ${f.path} (${src.id})`);
      const size = statSync(path).size;
      const hash = sha256File(path);
      if (f.size !== size || f.sha256 !== hash) {
        throw new Error(`${f.path}: ${size} B ${hash}, sources.mjs pins ${f.size} B ${f.sha256}`);
      }
      found[f.path] = path;
    }
  }
  return found;
}

function unzipText(zip, member) {
  return execFileSync('unzip', ['-p', zip, member], { maxBuffer: 1 << 30 }).toString('utf8');
}

async function filterAlternateNames(zip, keep, outPath) {
  // Streamed: the file is 786 MB unzipped. Rows: alternateNameId, geonameid, isolanguage, alternate name,
  // isPreferredName, isShortName, isColloquial, isHistoric, from, to.
  const child = spawn('unzip', ['-p', zip, 'alternateNamesV2.txt']);
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const kept = [];
  let total = 0;
  for await (const line of rl) {
    total++;
    const c = line.split('\t');
    if (c.length < 4) continue;
    const lang = c[2];
    if (lang !== 'ru' && lang !== 'en' && lang !== 'wkdt') continue;
    if (!keep.has(c[1])) continue;
    kept.push(c.slice(0, 10).join('\t'));
  }
  await new Promise((resolve, reject) => child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`unzip ${code}`)))));
  // Sorted by geonameid, then alternateNameId, so the file does not depend on the dump's row order.
  kept.sort((a, b) => {
    const [ia, ga] = a.split('\t');
    const [ib, gb] = b.split('\t');
    return Number(ga) - Number(gb) || Number(ia) - Number(ib);
  });
  writeFileSync(outPath, kept.join('\n') + '\n');
  return { total, kept: kept.length };
}

async function main() {
  const opt = args();
  const found = checkUpstream(opt);
  const stageRoot = join(opt.out, `places-sources-${opt.date}`);
  if (existsSync(stageRoot) && readdirSync(stageRoot).length) throw new Error(`${stageRoot} is not empty`);
  ensureDir(join(stageRoot, 'ne'));
  ensureDir(join(stageRoot, 'geonames'));

  // Natural Earth: the shapefiles as published, plus their GeoJSON (mapshaper, full precision).
  for (const [id, stem] of [['ne_marine', 'ne_10m_geography_marine_polys'], ['ne_disputed', 'ne_10m_admin_0_disputed_areas']]) {
    const dir = id === 'ne_marine' ? opt['ne-marine'] : opt['ne-disputed'];
    for (const ext of ['shp', 'shx', 'dbf', 'prj', 'cpg']) copyFileSync(join(dir, `${stem}.${ext}`), join(stageRoot, 'ne', `${stem}.${ext}`));
    execFileSync(MAPSHAPER, ['-i', join(stageRoot, 'ne', `${stem}.shp`), 'encoding=utf8', '-o',
      join(stageRoot, 'ne', `${stem}.geojson`), 'format=geojson'], { stdio: 'pipe' });
    log(`${stem}: shapefile + GeoJSON`);
  }

  // Natural Earth admin-1: the columns the pack uses, in the .dbf's row order (the regions bundle numbers provinces
  // by that table: README, "Provinces").
  const a1 = readDbf(join(opt['ne-admin1'], 'ne_10m_admin_1_states_provinces.dbf'));
  const a1cols = ['adm1_code', 'adm0_a3', 'sov_a3', 'iso_a2', 'iso_3166_2', 'name', 'name_en', 'name_ru', 'name_alt',
    'gn_name', 'type_en', 'wikidataid', 'gn_id', 'ne_id'];
  writeTsv(join(stageRoot, 'ne', 'ne_10m_admin_1_states_provinces.tsv'), a1cols,
    a1.rows.map((r) => Object.fromEntries(a1cols.map((k) => [k, String(r[k] ?? '').replace(/[\t\r\n]+/g, ' ').trim()]))));
  log(`admin-1: ${a1.rows.length} rows`);

  // GeoNames: cities1000 as published (both thresholds derive from it), checked against cities5000.
  const c1 = unzipText(found['geonames/cities1000.zip'], 'cities1000.txt');
  writeFileSync(join(stageRoot, 'geonames', 'cities1000.txt'), c1);
  const ids = new Set();
  const derived5000 = new Set();
  for (const line of c1.split('\n')) {
    const c = line.split('\t');
    if (c.length < 19) continue;
    ids.add(c[0]);
    if (isCities5000(Number(c[14]) || 0, c[7])) derived5000.add(c[0]);
  }
  const c5ids = new Set(unzipText(found['geonames/cities5000.zip'], 'cities5000.txt').split('\n').filter(Boolean).map((l) => l.split('\t')[0]));
  const missing = [...c5ids].filter((id) => !derived5000.has(id));
  const extra = [...derived5000].filter((id) => !c5ids.has(id));
  if (missing.length || extra.length) throw new Error(`cities5000 rule: ${missing.length} missing, ${extra.length} extra`);
  log(`cities1000: ${ids.size} places; the cities5000 rule reproduces cities5000.zip (${c5ids.size})`);

  const alt = await filterAlternateNames(found['geonames/alternateNamesV2.zip'], ids, join(stageRoot, 'geonames', 'alternate-names-ru-en-wkdt.tsv'));
  log(`alternate names: ${alt.kept} of ${alt.total} rows kept (ru, en, wkdt of the cities1000 places)`);

  writeFileSync(join(stageRoot, 'SOURCES.json'), stableStringify({
    staged: opt.date,
    upstream: SOURCES.upstream,
    derived: {
      'ne/ne_10m_geography_marine_polys.geojson': 'mapshaper -i <shp> encoding=utf8 -o <geojson> format=geojson',
      'ne/ne_10m_admin_0_disputed_areas.geojson': 'mapshaper -i <shp> encoding=utf8 -o <geojson> format=geojson',
      'ne/ne_10m_admin_1_states_provinces.tsv': `columns ${a1cols.join(', ')} of the .dbf, in its row order`,
      'geonames/cities1000.txt': 'cities1000.zip, unzipped',
      'geonames/alternate-names-ru-en-wkdt.tsv': 'alternateNamesV2.txt rows with isolanguage ru, en or wkdt whose geonameid is in cities1000.txt, sorted by geonameid and alternateNameId',
    },
    attribution: SOURCES.attribution,
  }));

  const files = listFiles(stageRoot);
  const mtime = Math.floor(Date.parse(`${opt.date}T00:00:00Z`) / 1000);
  const tar = tarDeterministic(stageRoot, files, `places-sources-${opt.date}`, mtime);
  const gz = gzipDeterministic(tar);
  const archive = join(opt.out, `places-sources-${opt.date}.tar.gz`);
  writeFileSync(archive, gz);
  const fileHashes = Object.fromEntries(files.map((f) => [f, { size: statSync(join(stageRoot, f)).size, sha256: sha256File(join(stageRoot, f)) }]));
  log(`archive ${archive}: ${gz.length} B, sha256 ${sha256(gz)}`);

  const lock = {
    note: 'Generated by places/stage.mjs. The upstream entries are the files the archive was staged from; the build reads only the archive (by sha256), the regions bundle (by the sha256 of regions-db.json) and places/curation.',
    upstream: SOURCES.upstream,
    archive: {
      file: `places-sources-${opt.date}.tar.gz`,
      size: gz.length,
      sha256: sha256(gz),
      tar_size: tar.length,
      release_tag: `places-sources-${opt.date}`,
      url: `https://github.com/TheShelterApp/region-tiles/releases/download/places-sources-${opt.date}/places-sources-${opt.date}.tar.gz`,
      published: false,
      files: fileHashes,
    },
    regions_bundle: SOURCES.regionsBundle,
    wikidata: SOURCES.wikidata,
  };
  writeFileSync(join(HERE, 'sources.lock.json'), stableStringify(lock));
  log('wrote places/sources.lock.json');
}

main().catch((e) => {
  console.error(e.stack || String(e));
  process.exit(1);
});
