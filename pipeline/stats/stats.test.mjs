// node --test pipeline/stats/stats.test.mjs — the CSV reader, the paging, the country assignment, the incremental merge
// and the checks that keep a wrong ComCat answer from being published.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  parseCSV, eventsFromCSV, halfYearPages, fetchPage, comcatCount, baseParams, pageMustHaveRows, setRequestIntervalForTests,
} from './comcat.mjs';
import { makeAssigner, polygonsOf, loadRegions, levelForMagnitude } from './assign.mjs';
import { aggregate, histogramYears, formatJSON, yearStart } from './aggregate.mjs';
import { plausibilityProblems, readPublished, windowCountProblem } from './plausibility.mjs';
import { judge } from './build-stats.mjs';
import { STATS_DIR, STATS_INDEX, SCHEMA_VERSION, TOP_LARGEST, TOP_RECENT } from './config.mjs';
import { INDEX_DIR } from '../../config.mjs';

test('CSV: quoted commas, doubled quotes, CRLF', () => {
  const rows = parseCSV('a,"b, c","d ""q"""\r\n1,,3\r\n');
  assert.deepEqual(rows, [['a', 'b, c', 'd "q"'], ['1', '', '3']]);
});

test('ComCat CSV rows become events; incomplete and non-earthquake rows are dropped', () => {
  const csv = [
    'time,latitude,longitude,depth,mag,magType,nst,gap,dmin,rms,net,id,updated,place,type',
    '2011-03-11T05:46:24.120Z,38.297,142.373,29,9.1,mww,541,9.5,,1.16,official,official20110311054624120_30,2022-01-01T00:00:00.000Z,"2011 Great Tohoku Earthquake, Japan",earthquake',
    '2011-03-11T06:00:00.000Z,,142.0,10,5.0,mb,,,,,us,usnoposition,2022-01-01T00:00:00.000Z,"nowhere",earthquake',
    '2011-03-12T00:00:00.000Z,10,10,0,4.6,mb,,,,,us,usblast,2022-01-01T00:00:00.000Z,"a blast",explosion',
  ].join('\n');
  const events = eventsFromCSV(csv);
  assert.equal(events.length, 1);
  assert.deepEqual(
    { ...events[0], t: undefined },
    {
      id: 'official20110311054624120_30', time: '2011-03-11T05:46:24Z', t: undefined, mag: 9.1,
      place: '2011 Great Tohoku Earthquake, Japan', lat: 38.297, lon: 142.373, depth: 29,
    },
  );
});

test('half-year pages are contiguous and cut at 1 January / 1 July', () => {
  const pages = halfYearPages('1936-01-01T00:00:00.000Z', '2026-10-06T00:00:00.000Z');
  assert.equal(pages.length, 182);
  assert.equal(pages[0].start, '1936-01-01T00:00:00.000Z');
  assert.equal(pages[0].end, '1936-07-01T00:00:00.000Z');
  assert.equal(pages.at(-1).end, '2026-10-06T00:00:00.000Z');
  for (let i = 1; i < pages.length; i++) assert.equal(pages[i].start, pages[i - 1].end);
});

// Two square "countries" 2 degrees wide, one with a "province", on the equator.
const square = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
const fixture = () => makeAssigner({
  adm0: [
    { id: 'AAA', name: 'A-land', bbox: [0, 0, 2, 2], polygons: polygonsOf(square(0, 0, 2, 2)) },
    { id: 'BBB', name: 'B-land', bbox: [10, 0, 12, 2], polygons: polygonsOf(square(10, 0, 12, 2)) },
  ],
  adm1: [
    // A province of B that pokes out of B's outline (the bundle's ADM1 and ADM0 come from different sources).
    { id: 'BBB.1', name: 'B-province', bbox: [9.5, 0, 11, 2], polygons: polygonsOf(square(9.5, 0, 11, 2)) },
  ],
});

test('assignment: inside an outline, by province below M6, offshore within 4.5 degrees, else open ocean', () => {
  const { assign } = fixture();
  assert.deepEqual(assign(1, 1, 7.0), { iso3: 'AAA', name: 'A-land', offshore: false });
  // M5 resolves at the province level first, like the app: the province's country wins outside B's outline.
  assert.deepEqual(assign(1, 9.7, 5.0), { iso3: 'BBB', name: 'B-land', offshore: false });
  // M6 resolves at the country level: no outline holds the point, the nearest country is B (0.5 deg away).
  assert.deepEqual(assign(1, 9.7, 6.0), { iso3: 'BBB', name: 'B-land', offshore: true });
  // 3 degrees east of A: offshore A.
  assert.deepEqual(assign(1, 5, 5.0), { iso3: 'AAA', name: 'A-land', offshore: true });
  // 6 degrees from A's nearest vertex and from B's: open ocean.
  assert.equal(assign(-5, 6, 5.0), null);
  assert.equal(levelForMagnitude(4.5), 1);
  assert.equal(levelForMagnitude(6), 0);
});

// A deterministic pseudo-random catalogue.
function catalogue(n, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const since = Date.UTC(1936, 0, 1);
  const until = Date.UTC(2026, 9, 6);
  return Array.from({ length: n }, (_, i) => {
    const t = since + Math.floor(rnd() * (until - since));
    return {
      id: `ev${i}`, t, time: new Date(Math.floor(t / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
      mag: Math.round((4.5 + rnd() * 4) * 10) / 10, place: `place ${i}`, lat: 0, lon: 0, depth: 10,
    };
  });
}

test('an incremental run over a full run of the older cutoff equals a full run', () => {
  const sinceMs = Date.UTC(1936, 0, 1);
  const all = catalogue(3000);
  const oldCutoff = Date.UTC(2025, 6, 15);
  const newCutoff = Date.UTC(2026, 9, 6);
  const oldEvents = all.filter((e) => e.t < oldCutoff);
  const full = aggregate({ events: all.filter((e) => e.t < newCutoff), windowStartMs: sinceMs, sinceMs, untilMs: newCutoff });
  const previous = aggregate({ events: oldEvents, windowStartMs: sinceMs, sinceMs, untilMs: oldCutoff });
  const windowStartMs = yearStart(2024);
  const incremental = aggregate({
    events: all.filter((e) => e.t >= windowStartMs && e.t < newCutoff),
    previous, windowStartMs, sinceMs, untilMs: newCutoff,
  });
  assert.deepEqual(incremental, full);
  // Running the same increment again changes nothing (idempotent).
  const again = aggregate({
    events: all.filter((e) => e.t >= windowStartMs && e.t < newCutoff),
    previous: incremental, windowStartMs, sinceMs, untilMs: newCutoff,
  });
  assert.deepEqual(again, full);
  assert.equal(full.total, all.length);
  assert.equal(full.largest.length, TOP_LARGEST);
  assert.equal(full.recent.length, TOP_RECENT);
});

test('a revised or deleted event inside the window replaces the old one', () => {
  const sinceMs = Date.UTC(1936, 0, 1);
  const untilMs = Date.UTC(2026, 0, 1);
  const e = { id: 'x', t: Date.UTC(2025, 5, 1), time: '2025-06-01T00:00:00Z', mag: 7.0, place: 'p', lat: 0, lon: 0, depth: 10 };
  const previous = aggregate({ events: [e], windowStartMs: sinceMs, sinceMs, untilMs });
  const revised = aggregate({ events: [{ ...e, mag: 6.8 }], previous, windowStartMs: yearStart(2025), sinceMs, untilMs });
  assert.equal(revised.total, 1);
  assert.equal(revised.largest[0].mag, 6.8);
  const deleted = aggregate({ events: [], previous, windowStartMs: yearStart(2025), sinceMs, untilMs });
  assert.equal(deleted.total, 0);
  assert.deepEqual(deleted.largest, []);
});

// The previous run listed events of the window that ComCat then deleted: older events the previous lists did not keep
// belong in the full run's lists, which the increment cannot know. It says so (`exact: false`), and the build runs in
// full instead.
test('an increment whose lists lost listed window events is flagged inexact', () => {
  const sinceMs = Date.UTC(1936, 0, 1);
  const oldCutoff = Date.UTC(2025, 9, 6);
  const newCutoff = Date.UTC(2026, 9, 6);
  const windowStartMs = yearStart(2024);
  const ev = (id, y, mag) => {
    const t = Date.UTC(y, 5, 1);
    return { id, t, time: new Date(t).toISOString().replace('.000Z', 'Z'), mag, place: id, lat: 0, lon: 0, depth: 10 };
  };
  // 25 older events (M5.0..M6.2) and 5 strong window events (M8) that make the previous strongest list.
  const older = Array.from({ length: 25 }, (_, i) => ev(`old${i}`, 1990 + i, 5 + i * 0.05));
  const strongWindow = Array.from({ length: 5 }, (_, i) => ev(`win${i}`, 2025, 8));
  const previous = aggregate({ events: [...older, ...strongWindow], windowStartMs: sinceMs, sinceMs, untilMs: oldCutoff });
  // ComCat deleted the five window events.
  const incremental = aggregate({ events: [], previous, windowStartMs, sinceMs, untilMs: newCutoff });
  const full = aggregate({ events: older, windowStartMs: sinceMs, sinceMs, untilMs: newCutoff });
  assert.equal(incremental.exact, false);
  assert.notDeepEqual(incremental.largest, full.largest, 'the merged list misses older events');
  assert.equal(full.exact, true);
});

// Random catalogues with random deletions and revisions inside the window: whenever the increment says it is exact it
// equals the full run, and the check is not vacuous (some increments are inexact, and some of those differ).
test('an increment that says it is exact equals the full run (randomized)', () => {
  const sinceMs = Date.UTC(1936, 0, 1);
  const oldCutoff = Date.UTC(2025, 6, 15);
  const newCutoff = Date.UTC(2026, 9, 6);
  const windowStartMs = yearStart(2024);
  let s = 11;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  let exactRuns = 0, inexactRuns = 0, inexactDiffering = 0;
  for (let run = 0; run < 400; run++) {
    const n = 5 + Math.floor(rnd() * 60);
    const all = catalogue(n, 1 + run);
    for (const e of all) if (rnd() < 0.4) { e.t = windowStartMs + Math.floor(rnd() * (oldCutoff - windowStartMs)); e.time = new Date(e.t).toISOString().replace('.000Z', 'Z'); }
    const before = all.filter((e) => e.t < oldCutoff);
    const previous = aggregate({ events: before, windowStartMs: sinceMs, sinceMs, untilMs: oldCutoff });
    // Now: window events deleted or revised (magnitude), new ones after the old cutoff.
    const now = [];
    for (const e of all) {
      if (e.t >= windowStartMs && rnd() < 0.3) continue;
      now.push(e.t >= windowStartMs && rnd() < 0.3 ? { ...e, mag: Math.round((e.mag - 0.4) * 10) / 10 } : e);
    }
    const full = aggregate({ events: now.filter((e) => e.t < newCutoff), windowStartMs: sinceMs, sinceMs, untilMs: newCutoff });
    const incremental = aggregate({
      events: now.filter((e) => e.t >= windowStartMs && e.t < newCutoff), previous, windowStartMs, sinceMs, untilMs: newCutoff,
    });
    if (incremental.exact) {
      exactRuns++;
      assert.deepEqual(incremental, full, `run ${run}`);
    } else {
      inexactRuns++;
      if (JSON.stringify(incremental.largest) !== JSON.stringify(full.largest)
        || JSON.stringify(incremental.recent) !== JSON.stringify(full.recent)) inexactDiffering++;
      assert.equal(incremental.total, full.total, 'the counts are exact either way');
    }
  }
  assert.ok(exactRuns > 100, `exact ${exactRuns}`);
  assert.ok(inexactRuns > 0 && inexactDiffering > 0, `inexact ${inexactRuns}, differing ${inexactDiffering}`);
});

test('histogram years run from the since year to the last full instant', () => {
  assert.deepEqual(histogramYears(Date.UTC(1936, 0, 1), Date.UTC(2026, 9, 6)), { first: 1936, length: 91 });
  assert.deepEqual(histogramYears(Date.UTC(1936, 0, 1), Date.UTC(2027, 0, 1)), { first: 1936, length: 91 });
});

test('formatting is stable and parses back', () => {
  const doc = { a: 1, histogram: { startYear: 1936, counts: [1, 2] }, list: [{ id: 'x', mag: 5 }] };
  assert.deepEqual(JSON.parse(formatJSON(doc)), doc);
  assert.equal(formatJSON(doc), formatJSON(JSON.parse(formatJSON(doc))));
});

// Against the repo's own polygons (skipped in a checkout without geo/).
test('real polygons: well-known epicentres', { skip: !existsSync(join(INDEX_DIR, 'adm0.json')) }, () => {
  const { assign } = loadRegions();
  // Tohoku 2011 (offshore, ~70 km from the coast), Kahramanmaras 2023, Amatrice 2016, Hindu Kush, Port Vila.
  assert.deepEqual(assign(38.297, 142.373, 9.1), { iso3: 'JPN', name: 'Japan', offshore: true });
  assert.equal(assign(37.226, 37.014, 7.8)?.iso3, 'TUR');
  assert.equal(assign(42.723, 13.188, 6.2)?.iso3, 'ITA');
  assert.equal(assign(36.5, 70.9, 5.0)?.iso3, 'AFG');
  assert.equal(assign(-17.74, 168.31, 5.5)?.iso3, 'VUT');
  // The Southwest Indian Ridge, 8 degrees from the nearest islands: open ocean. Near St Peter and St Paul Rocks the
  // Mid-Atlantic Ridge is offshore Brazil.
  assert.equal(assign(-40, 45, 5.0), null);
  assert.equal(assign(0.9, -29.5, 5.0)?.iso3, 'BRA');
});

// The published files (skipped until a build has run).
test('published files: schema, totals and ordering', { skip: !existsSync(STATS_INDEX) }, () => {
  const index = JSON.parse(readFileSync(STATS_INDEX, 'utf8'));
  assert.equal(index.schemaVersion, SCHEMA_VERSION);
  const files = readdirSync(join(STATS_DIR, 'adm0')).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, Object.keys(index.countries).length);
  let sum = 0;
  for (const f of files) {
    const doc = JSON.parse(readFileSync(join(STATS_DIR, 'adm0', f), 'utf8'));
    assert.equal(doc.schemaVersion, SCHEMA_VERSION);
    assert.equal(`${doc.id}.json`, f);
    assert.equal(doc.total, doc.histogram.counts.reduce((a, b) => a + b, 0), f);
    assert.equal(doc.total, index.countries[doc.id], f);
    assert.equal(doc.until, index.until);
    for (let i = 1; i < doc.largest.length; i++) assert.ok(doc.largest[i - 1].mag >= doc.largest[i].mag, f);
    for (let i = 1; i < doc.recent.length; i++) assert.ok(doc.recent[i - 1].time >= doc.recent[i].time, f);
    assert.ok(Buffer.byteLength(JSON.stringify(doc)) < 16 * 1024, `${f} is small`);
    sum += doc.total;
  }
  assert.equal(sum, index.assigned);
  assert.equal(index.total, index.assigned + index.unassigned.total);
});

// ---- XR-1 (round 16): a wrong ComCat answer fails the build before anything is written ------------------------------

const CSV_HEADER = 'time,latitude,longitude,depth,mag,magType,nst,gap,dmin,rms,net,id,updated,place,type';
const csvRow = (id, time, mag = 5.1) => `${time},35.0,140.0,10,${mag},mb,,,,,us,${id},2026-01-01T00:00:00.000Z,"somewhere",earthquake`;

/** Answers every request with `answer(url)` -> {status, body}; records the URLs. */
function stubFetch(answer) {
  const urls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const { status = 200, body = '' } = answer(String(url));
    return new Response(status === 204 ? null : body, { status });
  };
  return { urls, restore: () => { globalThis.fetch = original; } };
}

const tempDir = (name) => mkdtempSync(join(tmpdir(), `region-tiles-${name}-`));

test('fetchPage: a half-year answered with 204, an empty body or a header-only CSV fails and caches nothing', async () => {
  setRequestIntervalForTests(0);
  for (const [status, body] of [[204, ''], [200, ''], [200, `${CSV_HEADER}\n`]]) {
    const cacheDir = tempDir('cache');
    const stub = stubFetch(() => ({ status, body }));
    try {
      await assert.rejects(
        fetchPage('2025-01-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z', { cacheDir, log: () => {} }),
        /always holds M4\.5\+ earthquakes/,
      );
    } finally { stub.restore(); }
    assert.deepEqual(readdirSync(cacheDir), [], `nothing cached after ${status} ${JSON.stringify(body)}`);
  }
});

test('fetchPage: a short page may be empty (not cached); a populated page is cached; a non-CSV body fails uncached', async () => {
  setRequestIntervalForTests(0);
  const cacheDir = tempDir('cache');
  let stub = stubFetch(() => ({ status: 204 }));
  try {
    assert.deepEqual(await fetchPage('2026-07-01T00:00:00.000Z', '2026-07-03T00:00:00.000Z', { cacheDir, log: () => {} }), []);
  } finally { stub.restore(); }
  assert.deepEqual(readdirSync(cacheDir), []);
  assert.equal(pageMustHaveRows('2026-07-01T00:00:00.000Z', '2026-07-03T00:00:00.000Z'), false);
  assert.equal(pageMustHaveRows('2026-07-01T00:00:00.000Z', '2026-07-08T00:00:00.000Z'), true);

  stub = stubFetch(() => ({ body: `${CSV_HEADER}\n${csvRow('us1', '2025-02-01T00:00:00.000Z')}\n` }));
  try {
    const events = await fetchPage('2025-01-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z', { cacheDir, log: () => {} });
    assert.deepEqual(events.map((e) => e.id), ['us1']);
  } finally { stub.restore(); }
  assert.equal(readdirSync(cacheDir).length, 1);

  const htmlDir = tempDir('cache');
  stub = stubFetch(() => ({ body: '<html><body>Service maintenance</body></html>\n' }));
  try {
    await assert.rejects(fetchPage('2025-01-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z', { cacheDir: htmlDir, log: () => {} }), /no "time" column/);
  } finally { stub.restore(); }
  assert.deepEqual(readdirSync(htmlDir), []);
});

test('fetchPage: an empty page an older run cached is downloaded again, never trusted', async () => {
  setRequestIntervalForTests(0);
  const cacheDir = tempDir('cache');
  writeFileSync(join(cacheDir, '1990-01-01T000000Z_1990-07-01T000000Z.csv'), '');
  const stub = stubFetch(() => ({ body: `${CSV_HEADER}\n${csvRow('iscgem1', '1990-03-01T00:00:00.000Z')}\n` }));
  try {
    const events = await fetchPage('1990-01-01T00:00:00.000Z', '1990-07-01T00:00:00.000Z', { useCache: true, cacheDir, log: () => {} });
    assert.deepEqual(events.map((e) => e.id), ['iscgem1']);
    assert.equal(stub.urls.length, 1);
  } finally { stub.restore(); }
});

test('comcatCount: an answer without a count fails', async () => {
  setRequestIntervalForTests(0);
  for (const [status, body, ok] of [[200, '{"count":12,"maxAllowed":20000}', 12], [204, ''], [200, '{}'], [200, '{"count":-1}']]) {
    const stub = stubFetch(() => ({ status, body }));
    try {
      if (ok !== undefined) assert.equal(await comcatCount(baseParams('2025-01-01', '2025-02-01')), ok);
      else await assert.rejects(comcatCount(baseParams('2025-01-01', '2025-02-01')), /no count|JSON/);
    } finally { stub.restore(); }
  }
});

test('window count: a download short of ComCat\'s own count by more than the tolerance is a truncated page', () => {
  const window = 'w';
  assert.equal(windowCountProblem({ downloaded: 14407, comcat: 14407, window }), null);
  assert.equal(windowCountProblem({ downloaded: 14407 - 72, comcat: 14407, window }), null, '0.5 % of 14,407 is 72');
  assert.match(windowCountProblem({ downloaded: 14407 - 73, comcat: 14407, window }), /short by 73, at most 72/);
  assert.equal(windowCountProblem({ downloaded: 90, comcat: 100, window }), null, 'the slack of 10');
  assert.match(windowCountProblem({ downloaded: 89, comcat: 100, window }), /truncated/);
  assert.equal(windowCountProblem({ downloaded: 120, comcat: 100, window }), null, 'more than the count is not a loss');
});

test('plausibility: zero events, a dropping total, year or country fail; small revisions pass', () => {
  const previous = {
    total: 306470,
    countries: { JPN: 25769, ISL: 797, AIA: 3 },
    years: new Map([[1945, 127], [2024, 6397], [2025, 8556], [2026, 5851]]),
  };
  const ok = {
    total: 306470 - 3000,
    countries: { JPN: 25769 - 700, ISL: 797 - 23, AIA: 0 },
    years: new Map([[1945, 117], [2024, 6397 - 319], [2025, 8556 - 427], [2026, 6200]]),
  };
  assert.deepEqual(plausibilityProblems({ previous, next: ok, comparable: true, sameAssignment: true }), []);

  const zero = { total: 0, countries: {}, years: new Map() };
  const all = plausibilityProblems({ previous, next: zero, comparable: true, sameAssignment: true });
  assert.equal(all.length, 4, all.join('\n'));
  assert.match(all[0], /counts 0 earthquakes/);
  assert.match(all[1], /global total drops from 306470 to 0/);
  assert.match(all[2], /4 year\(s\) drops: 1945: 127 → 0/);
  assert.match(all[3], /2 countries drops: ISL 797 → 0 .*JPN 25769 → 0/);
  assert.doesNotMatch(all[3], /AIA/, 'a drop within the slack of 10');
  // Without a previous build, or with another filter or an earlier cutoff, only the zero total is judged.
  assert.deepEqual(plausibilityProblems({ previous: null, next: zero, comparable: false, sameAssignment: false }), [all[0]]);
  assert.deepEqual(plausibilityProblems({ previous, next: zero, comparable: false, sameAssignment: false }), [all[0]]);
  // Another assignment rule moves events between countries: their totals are not compared, the years still are.
  const moved = { ...ok, countries: { JPN: 100, ISL: 0, AIA: 0 } };
  assert.deepEqual(plausibilityProblems({ previous, next: moved, comparable: true, sameAssignment: false }), []);
  // One half-year page lost: about half of a year's events.
  const lostPage = { ...ok, total: ok.total, years: new Map([...ok.years, [2025, 4300]]) };
  assert.match(plausibilityProblems({ previous, next: lostPage, comparable: true, sameAssignment: true })[0], /2025: 8556 → 4300/);
  // The global total just past the 1 % tolerance.
  assert.match(plausibilityProblems({ previous, next: { ...ok, total: 306470 - 3065 }, comparable: true, sameAssignment: true })[0], /at most 3064 allowed/);
});

test('plausibility: --accept-drop turns the problems into warnings', () => {
  assert.throws(() => judge(['x drops'], { acceptDrop: false, log: () => {} }), /not plausible, nothing written:\n {2}- x drops/);
  const lines = [];
  judge(['x drops'], { acceptDrop: true, log: (l) => lines.push(l) });
  assert.deepEqual(lines, ['⚠ accepted (--accept-drop): x drops']);
  judge([], { acceptDrop: false, log: () => assert.fail('no log') });
});

test('readPublished sums the global histogram of the published files', () => {
  const dir = tempDir('stats');
  mkdirSync(join(dir, 'adm0'));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({
    total: 9, countries: { AAA: 4, BBB: 2 }, unassigned: { total: 3, histogram: { startYear: 2000, counts: [1, 2] } },
  }));
  writeFileSync(join(dir, 'adm0', 'AAA.json'), JSON.stringify({ histogram: { startYear: 1999, counts: [1, 1, 2] } }));
  const p = readPublished(dir);
  assert.equal(p.total, 9);
  assert.deepEqual([...p.years], [[1999, 1], [2000, 2], [2001, 4]]);
  assert.deepEqual(p.missing, ['BBB']);
  assert.equal(readPublished(tempDir('empty')), null);
});

// End to end on a copy of the published files (skipped until a build has run): the scenario of the audit. Every page
// answers 204, or every page holds a single row while ComCat's /count says thousands: the build exits 1 and no
// published byte changes.
const buildScript = fileURLToPath(new URL('./build-stats.mjs', import.meta.url));
function runBuildWithStub(stubSource) {
  const out = tempDir('stats-copy');
  cpSync(STATS_DIR, out, { recursive: true });
  const stub = join(tempDir('stub'), 'stub.mjs');
  writeFileSync(stub, stubSource);
  const before = snapshotDir(out);
  // An incremental run four weeks after the published cutoff (3 or 4 half-year pages, whatever the date).
  const until = new Date(Date.parse(JSON.parse(readFileSync(STATS_INDEX, 'utf8')).until) + 28 * 86_400_000).toISOString().slice(0, 10);
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, buildScript, `--until=${until}`], {
    env: { ...process.env, STATS_OUT_DIR: out, COMCAT_CACHE_DIR: tempDir('cache') }, encoding: 'utf8', timeout: 60_000,
  });
  return { r, unchanged: JSON.stringify(snapshotDir(out)) === JSON.stringify(before) };
}
function snapshotDir(dir) {
  return readdirSync(dir, { recursive: true }).sort().map((f) => {
    const file = join(dir, f);
    return statSync(file).isDirectory() ? [f] : [f, readFileSync(file, 'utf8')];
  });
}

test('build: ComCat answering 204 everywhere fails before any write', { skip: !existsSync(STATS_INDEX) }, () => {
  const { r, unchanged } = runBuildWithStub('globalThis.fetch = async () => new Response(null, { status: 204 });\n');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /HTTP 204/);
  assert.ok(unchanged, 'the published files are unchanged');
});

test('build: a window short of ComCat\'s own count fails before any write', { skip: !existsSync(STATS_INDEX) }, () => {
  const { r, unchanged } = runBuildWithStub(`
    let n = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/count?')) return new Response('{"count":15000}', { status: 200 });
      const start = new URL(String(url)).searchParams.get('starttime');
      n++;
      return new Response(${JSON.stringify(CSV_HEADER)} + '\\n' + start.slice(0, 19) + '.000Z,35.0,140.0,10,5.1,mb,,,,,us,stub' + n + ',2026-01-01T00:00:00.000Z,"x",earthquake\\n', { status: 200 });
    };
  `);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /▶ incremental: /);
  assert.match(r.stderr, /not plausible, nothing written:\n {2}- the download of .* holds [34] events, ComCat's \/count of the same window 15000/);
  assert.ok(unchanged, 'the published files are unchanged');
});
