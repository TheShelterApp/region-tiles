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
//
// --window (the refresh workflow, before its push; R16-FOLLOWUPS (4)): the same check, bounded to the last build's own
// window (index.json lastRun.windowStart → until) and to WINDOW_SAMPLE. It reads only the pages that build cached and
// asks ComCat one /count per sample country (3 requests), never the whole catalogue (182 page requests on a fresh
// runner). Per sample country it fails (exit 1) when the download falls short of ComCat's /count in the box by more
// than the build's window tolerance, or when a window year's published bin differs from a recount of the window's
// events assigned to the country. --accept-drop turns those into warnings, as for the build.
//   node pipeline/stats/verify-stats.mjs --window [--accept-drop] [ISO3 ...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INDEX_DIR } from '../../config.mjs';
import { STATS_INDEX, STATS_ADM0_DIR } from './config.mjs';
import { fetchRange, comcatCount, baseParams, stats as httpStats } from './comcat.mjs';
import { loadRegions } from './assign.mjs';
import { windowCountProblem } from './plausibility.mjs';
import { yearOf } from './aggregate.mjs';
import { judge } from './build-stats.mjs';

// Japan, Indonesia, Chile, Turkey, Italy, Iceland; Afghanistan (landlocked); Vanuatu (island state).
const DEFAULT_SAMPLE = ['JPN', 'IDN', 'CHL', 'TUR', 'ITA', 'ISL', 'AFG', 'VUT'];
/** The refresh workflow's sample: mostly offshore (Japan), coast and trench (Chile), landlocked (Afghanistan). */
export const WINDOW_SAMPLE = ['JPN', 'CHL', 'AFG'];
/** What a refused window check leaves undone (judge's wording): the files are on the runner, not in the repository. */
export const VERIFY_OUTCOME = 'nothing committed or pushed';

const boxOf = (id, c) => {
  const [minLng, minLat, maxLng, maxLat] = c.bbox;
  if (maxLng - minLng > 180) throw new Error(`${id}: the box crosses the antimeridian, pick another sample`);
  return {
    params: { minlatitude: String(minLat), maxlatitude: String(maxLat), minlongitude: String(minLng), maxlongitude: String(maxLng) },
    contains: (e) => e.lon >= minLng && e.lon <= maxLng && e.lat >= minLat && e.lat <= maxLat,
  };
};

/**
 * The window check of one sample country (pure, for the tests). `events`: the download of the window as fetchRange
 * returns it (ComCat's endtime is inclusive, as for /count); `doc`: the country's published file; `assign`: the build's
 * assigner. Returns the table row and the problems (strings).
 */
export function windowCheck({ id, events, contains, comcatBox, doc, assign, windowStartMs, untilMs }) {
  const problems = [];
  const downloadedBox = events.filter(contains).length;
  const short = windowCountProblem({ downloaded: downloadedBox, comcat: comcatBox, window: `${id}'s box` });
  if (short) problems.push(short);
  const first = yearOf(windowStartMs);
  const last = yearOf(untilMs - 1);
  const recount = new Array(last - first + 1).fill(0);
  for (const e of events) {
    if (e.t < windowStartMs || e.t >= untilMs) continue;
    if (assign(e.lat, e.lon, e.mag)?.iso3 === id) recount[yearOf(e.t) - first]++;
  }
  const { startYear, counts } = doc.histogram;
  const published = recount.map((_, i) => counts[first + i - startYear] ?? 0);
  const differ = recount.map((n, i) => (n === published[i] ? null : `${first + i}: published ${published[i]}, recount ${n}`)).filter(Boolean);
  if (differ.length) problems.push(`${id}: the published bins of the window differ from a recount of its events (${differ.join('; ')})`);
  return {
    row: { id, comcatBox, downloadedBox, published: published.reduce((a, b) => a + b, 0), recount: recount.reduce((a, b) => a + b, 0) },
    problems,
  };
}

async function verifyWindow({ sample, acceptDrop }) {
  const index = JSON.parse(readFileSync(STATS_INDEX, 'utf8'));
  const adm0 = new Map(JSON.parse(readFileSync(join(INDEX_DIR, 'adm0.json'), 'utf8')).map((e) => [e.id, e]));
  const windowStart = index.lastRun?.windowStart;
  if (!windowStart) throw new Error('stats/index.json has no lastRun.windowStart: run build-stats first');
  const until = index.until;
  // The pages of the build's own window end at or before `until`: all of them come from its cache.
  const events = await fetchRange(windowStart, until, { reuseCacheBefore: until, log: () => {} });
  const pageRequests = httpStats().requests;
  const { assign } = loadRegions();
  const rows = [];
  const problems = [];
  for (const id of sample) {
    const c = adm0.get(id);
    if (!c) throw new Error(`no ADM0 ${id}`);
    const box = boxOf(id, c);
    const comcatBox = await comcatCount({ ...baseParams(windowStart, until), ...box.params });
    const doc = JSON.parse(readFileSync(join(STATS_ADM0_DIR, `${id}.json`), 'utf8'));
    const r = windowCheck({
      id, events, contains: box.contains, comcatBox, doc, assign, windowStartMs: Date.parse(windowStart), untilMs: Date.parse(until),
    });
    rows.push({ ...r.row, name: c.name });
    problems.push(...r.problems);
  }
  console.log(`Window ${windowStart} → ${until} (${index.lastRun.mode} run), M >= ${index.minMagnitude}, ${index.eventType}: `
    + `${events.length} events downloaded, ${httpStats().requests} ComCat request(s) (${pageRequests} for pages).\n`);
  console.log('| Country | ComCat /count in its box | Downloaded in the box | Published, window years | Recount, window years |');
  console.log('|---|---:|---:|---:|---:|');
  for (const r of rows) console.log(`| ${r.name} (${r.id}) | ${r.comcatBox} | ${r.downloadedBox} | ${r.published} | ${r.recount} |`);
  // The build has written the files on the runner by now; the refusal stops the workflow before its commit and push.
  judge(problems, { acceptDrop, log: console.log, outcome: VERIFY_OUTCOME });
}

async function verifyAll(sample) {
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
    const box = boxOf(id, c);
    const comcatBox = await comcatCount({ ...baseParams(since, until), ...box.params });
    let downloadedBox = 0, onshore = 0, offshore = 0, assignedInBox = 0, offshoreTight = 0;
    for (const e of events) {
      const inBox = box.contains(e);
      if (inBox) downloadedBox++;
      const hit = regions.assign(e.lat, e.lon, e.mag);
      if (hit?.iso3 === id && hit.offshore) {
        const t = tight.assign(e.lat, e.lon, e.mag);
        if (t?.iso3 === id && t.offshore) offshoreTight++;
      }
      if (hit?.iso3 !== id) continue;
      if (hit.offshore) offshore++; else onshore++;
      if (inBox) assignedInBox++;
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
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const window = argv.includes('--window');
  const acceptDrop = argv.includes('--accept-drop');
  const unknown = argv.filter((a) => a.startsWith('--') && a !== '--window' && a !== '--accept-drop');
  const ids = argv.filter((a) => !a.startsWith('--'));
  const run = unknown.length
    ? Promise.reject(new Error(`unknown argument ${unknown[0]}`))
    : window ? verifyWindow({ sample: ids.length ? ids : WINDOW_SAMPLE, acceptDrop }) : verifyAll(ids.length ? ids : DEFAULT_SAMPLE);
  run.catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
