// USGS ComCat download: CSV pages by era (PAGE_ERAS) of at most PAGE_LIMIT rows, ordered by time, at most one request
// per MIN_REQUEST_INTERVAL_MS, cached on disk (CACHE_DIR, never in git).
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMCAT_BASE, PAGE_LIMIT, PAGE_ERAS, MIN_REQUEST_INTERVAL_MS, CACHE_DIR, MIN_MAGNITUDE, EVENT_TYPE,
} from './config.mjs';

const USER_AGENT = 'TheShelterApp-region-tiles-stats (+https://github.com/TheShelterApp/region-tiles)';

// ---- CSV ----------------------------------------------------------------------------------------------------------

/** RFC 4180 CSV → array of string arrays (quoted fields, doubled quotes, CRLF or LF). */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** ComCat CSV text → events (`toEvent` per row; rows without an id, a time, a position or a magnitude are dropped). */
export function eventsFromCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const header = rows[0];
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`ComCat CSV: no "${name}" column in ${JSON.stringify(header)}`);
    return i;
  };
  const ix = {
    time: col('time'), lat: col('latitude'), lon: col('longitude'), depth: col('depth'), mag: col('mag'),
    id: col('id'), place: col('place'), type: col('type'),
  };
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const e = toEvent(rows[r], ix);
    if (e) out.push(e);
  }
  return out;
}

const num = (s) => (s === undefined || s === '' ? NaN : Number(s));

/**
 * One CSV row → `{id, time, t, mag, place, lat, lon, depth}` (`time` ISO 8601 to the second, `t` its epoch ms — the
 * published second, so an event sorts the same whether it was just read or read back from a published file).
 */
export function toEvent(row, ix) {
  const id = row[ix.id];
  const t = Date.parse(row[ix.time]);
  const lat = num(row[ix.lat]);
  const lon = num(row[ix.lon]);
  const mag = num(row[ix.mag]);
  if (!id || !Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(mag)) return null;
  if (row[ix.type] && row[ix.type] !== EVENT_TYPE) return null;
  const depth = num(row[ix.depth]);
  const second = Math.floor(t / 1000) * 1000;
  return {
    id,
    time: new Date(second).toISOString().replace('.000Z', 'Z'),
    t: second,
    mag: Math.round(mag * 100) / 100,
    place: (row[ix.place] || '').trim(),
    lat: Math.round(lat * 1000) / 1000,
    lon: Math.round(lon * 1000) / 1000,
    depth: Number.isFinite(depth) ? Math.round(depth * 10) / 10 : null,
  };
}

// ---- Paging -------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const ERAS = PAGE_ERAS.map((e) => ({ ...e, startMs: e.start === null ? -Infinity : Date.parse(e.start) }));
const iso = (ms) => new Date(ms).toISOString();

/** The era (PAGE_ERAS) an instant belongs to: the last one that starts at or before it. */
export function eraOf(ms) {
  let i = 0;
  while (i + 1 < ERAS.length && ERAS[i + 1].startMs <= ms) i++;
  return { ...ERAS[i], endMs: i + 1 < ERAS.length ? ERAS[i + 1].startMs : Infinity };
}

/** The first calendar boundary after `ms` of a step of `stepMonths` (months counted from year 0, UTC). */
function nextBoundary(ms, stepMonths) {
  const d = new Date(ms);
  const next = (Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / stepMonths) + 1) * stepMonths;
  return Date.UTC(Math.floor(next / 12), next % 12, 1);
}

/**
 * The pages [start, end) between two instants: each era's pages (PAGE_ERAS) cut at its calendar step and at the era's
 * end, so no page spans two eras. Since 1936 these are the half-years cut at 1 January and 1 July.
 */
export function pagesFor(startISO, endISO) {
  const end = Date.parse(endISO);
  const pages = [];
  let cur = Date.parse(startISO);
  while (cur < end) {
    const era = eraOf(cur);
    const next = Math.min(era.stepMonths ? nextBoundary(cur, era.stepMonths) : Infinity, era.endMs, end);
    pages.push({ start: iso(cur), end: iso(next) });
    cur = next;
  }
  return pages;
}

/** [start, end] cut at the era starts inside it: the window's per-era /count (each ISO, end inclusive like ComCat's). */
export function eraSegments(startISO, endISO) {
  const start = Date.parse(startISO);
  const end = Date.parse(endISO);
  const cuts = ERAS.map((e) => e.startMs).filter((ms) => ms > start && ms < end);
  const bounds = [start, ...cuts, end];
  return bounds.slice(1).map((b, i) => ({ start: iso(bounds[i]), end: iso(b) }));
}

const cacheName = (start, end) =>
  `${start}_${end}.csv`.replace(/:/g, '').replace(/\.000Z/g, 'Z');

// ---- HTTP ---------------------------------------------------------------------------------------------------------

let lastRequestAt = 0;
let requestCount = 0;
let requestIntervalMs = MIN_REQUEST_INTERVAL_MS;
export const stats = () => ({ requests: requestCount });
/** Tests only: the pause between requests (they answer from a stub, not from ComCat). */
export const setRequestIntervalForTests = (ms) => { requestIntervalMs = ms; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with the polite rate limit, a timeout and retries on network errors, 429 and 5xx. */
export async function politeGet(url, { attempts = 6, timeoutMs = 180_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const wait = lastRequestAt + requestIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    requestCount++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: ac.signal });
      const body = await res.text();
      if (res.ok) return { status: res.status, body };
      // 204: no events in the window (FDSN "nodata=204").
      if (res.status === 204) return { status: 204, body: '' };
      lastError = new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
      if (res.status !== 429 && res.status < 500) throw lastError;
    } catch (err) {
      lastError = err;
      if (err.message?.startsWith('HTTP 4') && !err.message.startsWith('HTTP 429')) throw err;
    } finally {
      clearTimeout(timer);
    }
    const backoff = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
    console.warn(`  retry ${attempt}/${attempts - 1} in ${backoff / 1000}s: ${lastError?.message}`);
    await sleep(backoff);
  }
  throw lastError;
}

function queryURL(endpoint, params) {
  const q = new URLSearchParams(params);
  return `${COMCAT_BASE}/${endpoint}?${q}`;
}

/** The common filter of every query: the magnitude floor and earthquakes only. */
export function baseParams(start, end) {
  return { starttime: start, endtime: end, minmagnitude: String(MIN_MAGNITUDE), eventtype: EVENT_TYPE };
}

/** ComCat /count for a filter (the build's window check, the verification). A body without a numeric count fails. */
export async function comcatCount(params) {
  const { body } = await politeGet(queryURL('count', { ...params, format: 'geojson' }));
  const count = JSON.parse(body || 'null')?.count;
  if (!Number.isInteger(count) || count < 0) throw new Error(`ComCat /count: no count in ${JSON.stringify(body.slice(0, 200))}`);
  return count;
}

/** Whether [start, end) is long enough that ComCat always lists M4.5+ earthquakes in it: at least its era's
 *  `minDaysWithRows` (PAGE_ERAS; the era of its start). */
export const pageMustHaveRows = (start, end) =>
  Date.parse(end) - Date.parse(start) >= eraOf(Date.parse(start)).minDaysWithRows * DAY_MS;

/**
 * The events of [start, end): read from the cache when `useCache` and the page is cached, else downloaded (and
 * cached). A page that hits PAGE_LIMIT is split at its midpoint and both halves fetched, so no row is lost to the cap.
 * A page at least its era's `minDaysWithRows` long without events (204, an empty body, a header-only CSV) throws, and
 * no empty page is ever cached; an empty cached page (an older run's) is downloaded again. A body that is not ComCat
 * CSV throws before it is cached.
 */
export async function fetchPage(start, end, { useCache = false, log = console.log, cacheDir = CACHE_DIR } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, cacheName(start, end));
  const mustHaveRows = pageMustHaveRows(start, end);
  if (useCache && existsSync(file)) {
    const cached = eventsFromCSV(readFileSync(file, 'utf8'));
    if (cached.length || !mustHaveRows) return cached;
    log(`  cached ${start.slice(0, 10)} → ${end.slice(0, 10)} holds no events: downloading it again`);
  }
  const url = queryURL('query', { ...baseParams(start, end), orderby: 'time-asc', limit: String(PAGE_LIMIT), format: 'csv' });
  const { status, body } = await politeGet(url);
  const rowCount = Math.max(0, parseCSV(body).length - 1);
  log(`  fetched ${start.slice(0, 10)} → ${end.slice(0, 10)}: ${rowCount} rows`);
  if (rowCount >= PAGE_LIMIT) {
    const mid = new Date(Math.floor((Date.parse(start) + Date.parse(end)) / 2 / 1000) * 1000).toISOString();
    log(`  page at the ${PAGE_LIMIT}-row cap, splitting at ${mid}`);
    const a = await fetchPage(start, mid, { useCache, log, cacheDir });
    const b = await fetchPage(mid, end, { useCache, log, cacheDir });
    return [...a, ...b];
  }
  const events = eventsFromCSV(body);
  if (!events.length) {
    if (mustHaveRows) {
      const what = status === 204 ? 'HTTP 204' : !body.trim() ? 'an empty body' : rowCount ? `${rowCount} rows without a usable event` : 'a header-only CSV';
      const { minDaysWithRows } = eraOf(Date.parse(start));
      throw new Error(`ComCat answered ${start} → ${end} with ${what}: a page of ${minDaysWithRows} days or more in this era always holds M${MIN_MAGNITUDE}+ earthquakes, so the answer is wrong (nothing cached, nothing written)`);
    }
    return events;
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
  return events;
}

/**
 * Every event of [start, end) by the era pages (`pagesFor`). Pages that END before `reuseCacheBefore` may come from
 * the cache (old pages hardly change); later pages are always downloaded again.
 */
export async function fetchRange(start, end, { reuseCacheBefore = null, log = console.log, cacheDir = CACHE_DIR } = {}) {
  const pages = pagesFor(start, end);
  const reuseUntil = reuseCacheBefore ? Date.parse(reuseCacheBefore) : -Infinity;
  const byId = new Map();
  for (const p of pages) {
    const useCache = Date.parse(p.end) <= reuseUntil;
    const events = await fetchPage(p.start, p.end, { useCache, log, cacheDir });
    for (const e of events) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
