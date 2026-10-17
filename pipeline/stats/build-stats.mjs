#!/usr/bin/env node
// Builds stats/adm0/<ISO3>.json + stats/index.json: per country, the USGS ComCat earthquakes M >= 4.5 since 1500, the
// century before ComCat's earliest (count, yearly histogram, the largest and the most recent events). See README "Area
// history statistics".
//
//   node pipeline/stats/build-stats.mjs            incremental: from 1 January of the year of (last cutoff - 365 days)
//   node pipeline/stats/build-stats.mjs --full     everything since 1500 (cached pages before the revision window reused)
//   --until=YYYY-MM-DD   the cutoff (exclusive, 00:00 UTC; default today) — the same cutoff gives the same files
//   --accept-drop        publish even when the window count or the comparison with the previous files fails (after
//                        reviewing a genuine large ComCat revision in the log); an empty page still fails
//
// A run falls back to --full by itself when there is no previous index, or it was built with another schema,
// assignment rule or region set. It fails (exit 1, nothing written) on an empty page, a window short of ComCat's own
// count (per era), an earthquake ComCat lists before the window start, or counts that drop implausibly against the
// previous files (plausibility.mjs, thresholds in config.mjs; a window opened earlier is compared over the previous
// window's years).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { INDEX_DIR, REGIONS_DB_JSON } from '../../config.mjs';
import {
  SCHEMA_VERSION, EARLIEST_QUERY_START, MIN_MAGNITUDE, EVENT_TYPE, SOURCE, STATS_DIR, STATS_ADM0_DIR, STATS_INDEX,
  REVISION_WINDOW_DAYS, OFFSHORE_MAX_DEGREES, OFFSHORE_CANDIDATES, TOP_LARGEST, TOP_RECENT,
} from './config.mjs';
import { fetchRange, comcatCount, baseParams, eraSegments, pageMustHaveRows, stats as httpStats } from './comcat.mjs';
import { loadRegions } from './assign.mjs';
import {
  comparison, countsFrom, earlierEventsProblem, plausibilityProblems, readPublished, windowCountProblem,
} from './plausibility.mjs';
import {
  aggregate, countryDocument, formatJSON, isoSeconds, SINCE_MS, yearOf, yearStart,
} from './aggregate.mjs';

const DAY = 86_400_000;

function parseArgs(argv) {
  const args = { full: false, until: null, acceptDrop: false };
  for (const a of argv) {
    if (a === '--full') args.full = true;
    else if (a === '--accept-drop') args.acceptDrop = true;
    else if (a.startsWith('--until=')) args.until = a.slice('--until='.length);
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

/** What the published numbers depend on besides the catalogue: a change forces a full rebuild. */
export function assignmentFingerprint() {
  const h = createHash('sha256');
  h.update(readFileSync(join(INDEX_DIR, 'adm0.json')));
  for (const f of readdirSync(join(INDEX_DIR, 'adm1')).sort()) h.update(readFileSync(join(INDEX_DIR, 'adm1', f)));
  const regionsVersion = existsSync(REGIONS_DB_JSON) ? JSON.parse(readFileSync(REGIONS_DB_JSON, 'utf8')).version : null;
  return {
    rule: 'iOS RegionTilesDatabase.resolve: level by magnitude (ADM1 below M6, ADM0 from M6) walking up to ADM0, '
      + 'first containing polygon wins; else the nearest of the bounding-box-nearest countries by outline vertex within '
      + 'the offshore cap; else unassigned (open ocean)',
    offshoreMaxDegrees: OFFSHORE_MAX_DEGREES,
    offshoreCandidates: OFFSHORE_CANDIDATES,
    polygons: 'region-tiles geo/adm0 + geo/adm1 (the geometry of regions.sqlite)',
    regionsVersion,
    regionIndexSha256: h.digest('hex'),
  };
}

const sameAssignment = (a, b) =>
  a && b && a.offshoreMaxDegrees === b.offshoreMaxDegrees && a.offshoreCandidates === b.offshoreCandidates
  && a.regionIndexSha256 === b.regionIndexSha256 && a.regionsVersion === b.regionsVersion;

function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Problems found before any write: an error unless `acceptDrop`, which logs them as warnings. `outcome` says what the
 *  refusal left undone: the build refuses before it writes a file; the verify step (verify-stats.mjs --window) runs after
 *  the build wrote the files on the runner, before the workflow commits or pushes them. */
export function judge(problems, { acceptDrop, log, outcome = 'nothing written' }) {
  if (!problems.length) return;
  if (!acceptDrop) {
    throw new Error(`the statistics are not plausible, ${outcome}:\n  - ${problems.join('\n  - ')}\n`
      + 'Run again later; publish anyway only after reviewing a genuine ComCat revision (--accept-drop).');
  }
  for (const p of problems) log(`⚠ accepted (--accept-drop): ${p}`);
}

export async function build({ full = false, until = null, acceptDrop = false, log = console.log } = {}) {
  const today = new Date();
  const untilMs = until ? Date.parse(`${until}T00:00:00Z`) : Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (!Number.isFinite(untilMs)) throw new Error(`bad --until ${until}`);
  const fingerprint = assignmentFingerprint();

  const previousIndex = existsSync(STATS_INDEX) ? JSON.parse(readFileSync(STATS_INDEX, 'utf8')) : null;
  let mode = full ? 'full' : 'incremental';
  let reason = full ? '--full' : '';
  if (!full) {
    if (!previousIndex) { mode = 'full'; reason = 'no previous stats/index.json'; }
    else if (previousIndex.schemaVersion !== SCHEMA_VERSION) { mode = 'full'; reason = `schema ${previousIndex.schemaVersion} → ${SCHEMA_VERSION}`; }
    else if (previousIndex.since !== isoSeconds(SINCE_MS) || previousIndex.minMagnitude !== MIN_MAGNITUDE
      || previousIndex.eventType !== EVENT_TYPE || previousIndex.topLargest !== TOP_LARGEST || previousIndex.topRecent !== TOP_RECENT) {
      mode = 'full'; reason = 'window start, filter or list sizes changed';
    } else if (!sameAssignment(previousIndex.assignment, fingerprint)) { mode = 'full'; reason = 'assignment rule or regions changed'; }
    else if (Date.parse(previousIndex.until) > untilMs) { mode = 'full'; reason = 'cutoff earlier than the previous one'; }
  }

  const revisionStartMs = (cutoffMs) => Math.max(SINCE_MS, yearStart(yearOf(cutoffMs - REVISION_WINDOW_DAYS * DAY)));
  const windowStartMs = mode === 'full' ? SINCE_MS : revisionStartMs(Date.parse(previousIndex.until));
  log(`▶ ${mode}${reason ? ` (${reason})` : ''}: ${isoSeconds(windowStartMs)} → ${isoSeconds(untilMs)}`);

  const fetched = await fetchRange(new Date(windowStartMs).toISOString(), new Date(untilMs).toISOString(), {
    // A full run reuses cached pages that end before this run's own revision window; the recent ones are fetched again.
    reuseCacheBefore: mode === 'full' ? new Date(revisionStartMs(untilMs)).toISOString() : null,
    log,
  });
  // The download against ComCat's own count of the same window, era by era (PAGE_ERAS: the sparse early eras keep a
  // tolerance of their own size), each [start, end] inclusive on both sides like ComCat's: a truncated page. An
  // incremental window lies in one era (one request), a full one in three.
  const windowISO = [new Date(windowStartMs).toISOString(), new Date(untilMs).toISOString()];
  const countProblems = [];
  for (const segment of eraSegments(...windowISO)) {
    const [from, to] = [Date.parse(segment.start), Date.parse(segment.end)];
    const comcat = await comcatCount(baseParams(segment.start, segment.end));
    const downloaded = fetched.filter((e) => e.t >= from && e.t <= to).length;
    log(`▶ ComCat /count of ${isoSeconds(from)} → ${isoSeconds(to)}: ${comcat}, downloaded ${downloaded}`);
    const problem = windowCountProblem({ downloaded, comcat, window: `${segment.start} → ${segment.end}` });
    if (problem) countProblems.push(problem);
  }
  // SHLTR-120: the window starts at the catalogue's earliest year. An earthquake ComCat lists before SINCE (a newly
  // added historical event) needs SINCE moved back; one request, ComCat's endtime being inclusive, up to SINCE's last ms.
  const earlier = await comcatCount(baseParams(EARLIEST_QUERY_START, new Date(SINCE_MS - 1).toISOString()));
  log(`▶ ComCat /count before ${isoSeconds(SINCE_MS)}: ${earlier}`);
  const earlierProblem = earlierEventsProblem({ count: earlier, since: isoSeconds(SINCE_MS) });
  if (earlierProblem) countProblems.push(earlierProblem);
  judge(countProblems, { acceptDrop, log });
  // ComCat's endtime is inclusive: an event at the cutoff's very second belongs to the next run ([since, until)).
  const events = fetched.filter((e) => e.t >= windowStartMs && e.t < untilMs);
  log(`▶ ${events.length} events in the window (${httpStats().requests} ComCat requests)`);
  if (!events.length && pageMustHaveRows(...windowISO)) {
    throw new Error(`no events in the window ${windowISO.join(' → ')}: ComCat's answer is wrong, nothing written`);
  }

  const regions = loadRegions();
  const perCountry = new Map(regions.countries.map((c) => [c.id, []]));
  const unassigned = [];
  let offshore = 0;
  for (const e of events) {
    const hit = regions.assign(e.lat, e.lon, e.mag);
    if (!hit) { unassigned.push(e); continue; }
    if (hit.offshore) offshore++;
    perCountry.get(hit.iso3).push(e);
  }
  log(`▶ assigned ${events.length - unassigned.length} (${offshore} offshore), unassigned ${unassigned.length}`);

  mkdirSync(STATS_ADM0_DIR, { recursive: true });
  const aggregates = [];
  for (const c of regions.countries) {
    const file = join(STATS_ADM0_DIR, `${c.id}.json`);
    const previous = mode === 'incremental' && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (mode === 'incremental' && !previous) throw new Error(`incremental run without ${file}: run with --full`);
    aggregates.push({ c, file, agg: aggregate({ events: perCountry.get(c.id), previous, windowStartMs, sinceMs: SINCE_MS, untilMs }) });
  }
  // A strongest or latest list the increment cannot prove equal to a full run's (`mergedListIsExact`: events of the
  // window that were listed were deleted or revised away) — rebuild everything, before any file is written.
  const inexact = aggregates.filter(({ agg }) => !agg.exact).map(({ c }) => c.id);
  if (inexact.length) {
    log(`▶ the increment cannot prove the lists of ${inexact.join(', ')}: full run`);
    return build({ full: true, until, acceptDrop, log });
  }
  const totals = Object.fromEntries(aggregates.map(({ c, agg }) => [c.id, agg.total]));
  const unassignedAgg = aggregate({
    events: unassigned,
    previous: mode === 'incremental' ? { histogram: previousIndex.unassigned.histogram, largest: [], recent: [] } : null,
    windowStartMs, sinceMs: SINCE_MS, untilMs,
  });
  const assigned = Object.values(totals).reduce((a, b) => a + b, 0);

  // Before any write: the new counts against the previous published files, over the previous window's years (a window
  // opened earlier adds years the previous files never counted; the drop checks still hold for every year they did).
  const published = readPublished(STATS_DIR);
  const { comparable, fromYear } = comparison(previousIndex, {
    sinceMs: SINCE_MS, untilMs, minMagnitude: MIN_MAGNITUDE, eventType: EVENT_TYPE,
  });
  if (previousIndex && !comparable) log('▶ the previous files have another filter, an earlier start or a later cutoff: not compared');
  const next = countsFrom({
    countries: Object.fromEntries(aggregates.map(({ c, agg }) => [c.id, agg.histogram])), unassigned: unassignedAgg.histogram,
  }, fromYear);
  const problems = plausibilityProblems({
    previous: published,
    next,
    comparable,
    sameAssignment: comparable && !!sameAssignment(previousIndex.assignment, fingerprint),
  });
  judge(problems, { acceptDrop, log });
  if (published && comparable) {
    const over = fromYear > yearOf(SINCE_MS) ? ` over the years from ${fromYear} (the previous window; the earlier years are new)` : '';
    log(`▶ plausible against the previous files${over}: total ${published.total} → ${next.total}`);
  }

  for (const { c, file, agg } of aggregates) {
    writeAtomic(file, `${formatJSON(countryDocument({ id: c.id, name: c.name, agg, sinceMs: SINCE_MS, untilMs }))}\n`);
  }
  const index = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: isoSeconds(Math.floor(Date.now() / 1000) * 1000),
    since: isoSeconds(SINCE_MS),
    until: isoSeconds(untilMs),
    minMagnitude: MIN_MAGNITUDE,
    eventType: EVENT_TYPE,
    topLargest: TOP_LARGEST,
    topRecent: TOP_RECENT,
    source: SOURCE,
    lastRun: { mode, windowStart: isoSeconds(windowStartMs), windowEvents: events.length },
    assignment: fingerprint,
    files: 'adm0/{ISO3}.json',
    total: assigned + unassignedAgg.total,
    assigned,
    unassigned: { total: unassignedAgg.total, histogram: unassignedAgg.histogram },
    countries: totals,
  };
  mkdirSync(STATS_DIR, { recursive: true });
  writeAtomic(STATS_INDEX, `${formatJSON(index)}\n`);
  log(`▶ wrote ${regions.countries.length} country files + stats/index.json: total ${index.total}, assigned ${assigned}`);
  return index;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
