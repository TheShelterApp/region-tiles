// Per-country aggregation and the incremental merge. Pure functions (no I/O), so the tests can prove that an
// incremental run gives the same files as a full one.
import { SCHEMA_VERSION, SINCE, MIN_MAGNITUDE, EVENT_TYPE, SOURCE, TOP_LARGEST, TOP_RECENT } from './config.mjs';

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** Largest first; equal magnitudes oldest first; then by id (a total order, so reruns are byte-identical). */
export const largestOrder = (a, b) => b.mag - a.mag || a.t - b.t || byId(a, b);
/** Newest first; then by id. */
export const recentOrder = (a, b) => b.t - a.t || byId(a, b);

export const yearOf = (ms) => new Date(ms).getUTCFullYear();
export const yearStart = (year) => Date.UTC(year, 0, 1);

/** The published shape of an event (the order of the keys is the file's). */
export const publicEvent = (e) => ({
  id: e.id, time: e.time, mag: e.mag, place: e.place, lat: e.lat, lon: e.lon, depth: e.depth,
});

/** A published event read back from a file, with its epoch ms for sorting. */
const readBack = (e) => ({ ...e, t: Date.parse(e.time) });

/** Years covered by [since, until): from the since year to the year of the last instant before `until`. */
export function histogramYears(sinceMs, untilMs) {
  const first = yearOf(sinceMs);
  const last = yearOf(untilMs - 1);
  return { first, length: Math.max(0, last - first + 1) };
}

/**
 * Whether a merged list is provably the one a full run gives. The previous list was the top of every event then, so
 * an older event it does not hold ranks after its last entry: the merge is exact when the previous list held every
 * older event, or when the merged list is full and still ends at or ahead of that last entry. Otherwise (events of the
 * window that were in the previous list were deleted or revised down, and nothing new took their place) an older event
 * the previous list did not keep may belong in the list, and only a full run can tell.
 */
export function mergedListIsExact({ previousList, merged, olderCount, keptOlderCount, order, size }) {
  if (olderCount <= keptOlderCount) return true;
  if (merged.length < size || !previousList.length) return false;
  return order(merged.at(-1), readBack(previousList.at(-1))) <= 0;
}

/**
 * One country's (or the unassigned bucket's) aggregate over [since, until).
 * - `events`: the events of the window [windowStart, until) assigned here (any order).
 * - `previous`: the same country's previous document (or null): its histogram bins before the window's year and its
 *   largest / recent events before `windowStart` are kept, the rest comes from `events`. `windowStart` must be
 *   1 January of a year, so a bin is never half old, half new.
 * - `exact` (not published): false when the merged lists may differ from a full run's (`mergedListIsExact`); the
 *   build then runs in full.
 */
export function aggregate({ events, previous = null, windowStartMs, sinceMs, untilMs }) {
  const { first, length } = histogramYears(sinceMs, untilMs);
  const counts = new Array(length).fill(0);
  const windowYear = yearOf(windowStartMs);

  if (previous) {
    const prevFirst = previous.histogram.startYear;
    previous.histogram.counts.forEach((n, i) => {
      const year = prevFirst + i;
      if (year < windowYear && year >= first && year - first < length) counts[year - first] = n;
    });
  }
  for (const e of events) {
    const i = yearOf(e.t) - first;
    if (i >= 0 && i < length) counts[i]++;
  }

  const kept = (list) => (previous ? list.map(readBack).filter((e) => e.t < windowStartMs && e.t >= sinceMs) : []);
  const keptLargest = kept(previous?.largest ?? []);
  const keptRecent = kept(previous?.recent ?? []);
  const largest = [...keptLargest, ...events].sort(largestOrder).slice(0, TOP_LARGEST);
  const recent = [...keptRecent, ...events].sort(recentOrder).slice(0, TOP_RECENT);

  let exact = true;
  if (previous) {
    // The older events (before the window's year, from the since year on) the previous document counted.
    const olderCount = counts.slice(0, Math.max(0, Math.min(length, windowYear - first))).reduce((a, b) => a + b, 0);
    exact = mergedListIsExact({
      previousList: previous.largest ?? [], merged: largest, olderCount, keptOlderCount: keptLargest.length,
      order: largestOrder, size: TOP_LARGEST,
    }) && mergedListIsExact({
      previousList: previous.recent ?? [], merged: recent, olderCount, keptOlderCount: keptRecent.length,
      order: recentOrder, size: TOP_RECENT,
    });
  }

  return {
    total: counts.reduce((a, b) => a + b, 0),
    histogram: { startYear: first, counts },
    largest: largest.map(publicEvent),
    recent: recent.map(publicEvent),
    exact,
  };
}

/** The published document of one country. */
export function countryDocument({ id, name, agg, sinceMs, untilMs }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    name,
    since: isoSeconds(sinceMs),
    until: isoSeconds(untilMs),
    minMagnitude: MIN_MAGNITUDE,
    eventType: EVENT_TYPE,
    source: SOURCE.name,
    attribution: SOURCE.attribution,
    total: agg.total,
    histogram: agg.histogram,
    largest: agg.largest,
    recent: agg.recent,
  };
}

export const isoSeconds = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

export const SINCE_MS = Date.parse(SINCE);

/**
 * JSON with stable, diff-friendly formatting: objects one key per line, arrays of numbers inline, arrays of objects
 * one object per line.
 */
export function formatJSON(value, indent = 0) {
  const pad = (n) => '  '.repeat(n);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every((v) => v === null || typeof v !== 'object')) return JSON.stringify(value);
    return `[\n${value.map((v) => pad(indent + 1) + JSON.stringify(v)).join(',\n')}\n${pad(indent)}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    if (entries.every(([, v]) => v === null || typeof v !== 'object') && entries.length <= 3) return JSON.stringify(value);
    return `{\n${entries
      .map(([k, v]) => `${pad(indent + 1)}${JSON.stringify(k)}: ${formatJSON(v, indent + 1)}`)
      .join(',\n')}\n${pad(indent)}}`;
  }
  return JSON.stringify(value);
}
