#!/usr/bin/env node
// Checks the published statistics against ComCat's own /count:
//   1. the whole download: ComCat's count for [since, until) = the events the build read;
//   2. per sample country, ComCat's count inside the country's bounding box = the downloaded events in that box (the
//      download lost nothing there), next to the country's published total, split into events inside its outline and
//      offshore events within the cap (which is why a published total may exceed the box, or fall short of it where
//      the box takes in a neighbour's or the open sea's events), and for comparison the offshore events a tighter cap
//      of 1.8 degrees (about 200 km) would keep.
// Reads the raw pages from the cache (run build-stats first); prints a Markdown table.
//   node pipeline/stats/verify-stats.mjs [ISO3 ...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INDEX_DIR } from '../../config.mjs';
import { STATS_INDEX, STATS_ADM0_DIR } from './config.mjs';
import { fetchRange, comcatCount, baseParams } from './comcat.mjs';
import { loadRegions } from './assign.mjs';

// Japan, Indonesia, Chile, Turkey, Italy, Iceland; Afghanistan (landlocked); Vanuatu (island state).
const DEFAULT_SAMPLE = ['JPN', 'IDN', 'CHL', 'TUR', 'ITA', 'ISL', 'AFG', 'VUT'];

const sample = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SAMPLE;
const index = JSON.parse(readFileSync(STATS_INDEX, 'utf8'));
const adm0 = new Map(JSON.parse(readFileSync(join(INDEX_DIR, 'adm0.json'), 'utf8')).map((e) => [e.id, e]));
const since = index.since;
const until = index.until;

const events = await fetchRange(since, until, { reuseCacheBefore: until, log: () => {} });
const regions = loadRegions();
const TIGHT_DEGREES = 1.8;
const tight = loadRegions({ offshoreMaxDegrees: TIGHT_DEGREES });
const comcatAll = await comcatCount(baseParams(since, until));

const rows = [];
for (const id of sample) {
  const c = adm0.get(id);
  if (!c) throw new Error(`no ADM0 ${id}`);
  const [minLng, minLat, maxLng, maxLat] = c.bbox;
  if (maxLng - minLng > 180) throw new Error(`${id}: the box crosses the antimeridian, pick another sample`);
  const inBox = (e) => e.lon >= minLng && e.lon <= maxLng && e.lat >= minLat && e.lat <= maxLat;
  const comcatBox = await comcatCount({
    ...baseParams(since, until),
    minlatitude: String(minLat), maxlatitude: String(maxLat), minlongitude: String(minLng), maxlongitude: String(maxLng),
  });
  let downloadedBox = 0, onshore = 0, offshore = 0, assignedInBox = 0, offshoreTight = 0;
  for (const e of events) {
    const box = inBox(e);
    if (box) downloadedBox++;
    const hit = regions.assign(e.lat, e.lon, e.mag);
    if (hit?.iso3 === id && hit.offshore) {
      const t = tight.assign(e.lat, e.lon, e.mag);
      if (t?.iso3 === id && t.offshore) offshoreTight++;
    }
    if (hit?.iso3 !== id) continue;
    if (hit.offshore) offshore++; else onshore++;
    if (box) assignedInBox++;
  }
  const published = JSON.parse(readFileSync(join(STATS_ADM0_DIR, `${id}.json`), 'utf8')).total;
  rows.push({ id, name: c.name, comcatBox, downloadedBox, published, onshore, offshore, assignedInBox, offshoreTight });
}

console.log(`Cutoff ${since} → ${until}, M >= ${index.minMagnitude}, ${index.eventType}.`);
console.log(`Whole catalogue: ComCat /count ${comcatAll}, downloaded ${events.length} (Δ ${events.length - comcatAll}).\n`);
console.log(`| Country | ComCat /count in its box | Downloaded in the box | Published total | inside the outline | offshore ≤ 4.5° | of the total, in the box | offshore ≤ ${TIGHT_DEGREES}° (comparison) |`);
console.log('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  console.log(`| ${r.name} (${r.id}) | ${r.comcatBox} | ${r.downloadedBox} | ${r.published} | ${r.onshore} | ${r.offshore} | ${r.assignedInBox} | ${r.offshoreTight} |`);
}
const bad = rows.filter((r) => r.published !== r.onshore + r.offshore);
if (bad.length) {
  console.error(`\n✗ published totals differ from a recount: ${bad.map((r) => r.id).join(', ')}`);
  process.exit(1);
}
