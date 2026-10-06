// USGS ComCat download: CSV pages of at most PAGE_LIMIT rows, ordered by time, at most one request per
// MIN_REQUEST_INTERVAL_MS, cached on disk (CACHE_DIR, never in git).
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import {
  COMCAT_BASE, PAGE_LIMIT, MIN_REQUEST_INTERVAL_MS, CACHE_DIR, MIN_MAGNITUDE, EVENT_TYPE,
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

/** Half-year pages [start, end) between two instants, cut at 1 January and 1 July (UTC). */
export function halfYearPages(startISO, endISO) {
  const end = Date.parse(endISO);
  const pages = [];
  let cur = Date.parse(startISO);
  while (cur < end) {
    const d = new Date(cur);
    const y = d.getUTCFullYear();
    const nextBoundary = d.getUTCMonth() < 6 ? Date.UTC(y, 6, 1) : Date.UTC(y + 1, 0, 1);
    const next = Math.min(nextBoundary, end);
    pages.push({ start: new Date(cur).toISOString(), end: new Date(next).toISOString() });
    cur = next;
  }
  return pages;
}

const cacheName = (start, end) =>
  `${start}_${end}.csv`.replace(/:/g, '').replace(/\.000Z/g, 'Z');

// ---- HTTP ---------------------------------------------------------------------------------------------------------

let lastRequestAt = 0;
let requestCount = 0;
export const stats = () => ({ requests: requestCount });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET with the polite rate limit, a timeout and retries on network errors, 429 and 5xx. */
export async function politeGet(url, { attempts = 6, timeoutMs = 180_000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
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

/** ComCat /count for a filter (used by the verification). */
export async function comcatCount(params) {
  const { body } = await politeGet(queryURL('count', { ...params, format: 'geojson' }));
  return JSON.parse(body).count;
}

/**
 * The events of [start, end): read from the cache when `useCache` and the page is cached, else downloaded (and
 * cached). A page that hits PAGE_LIMIT is split at its midpoint and both halves fetched, so no row is lost to the cap.
 */
export async function fetchPage(start, end, { useCache = false, log = console.log } = {}) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const file = join(CACHE_DIR, cacheName(start, end));
  let text;
  if (useCache && existsSync(file)) {
    text = readFileSync(file, 'utf8');
  } else {
    const url = queryURL('query', { ...baseParams(start, end), orderby: 'time-asc', limit: String(PAGE_LIMIT), format: 'csv' });
    const { body } = await politeGet(url);
    text = body;
    const rowCount = Math.max(0, parseCSV(text).length - 1);
    log(`  fetched ${start.slice(0, 10)} → ${end.slice(0, 10)}: ${rowCount} rows`);
    if (rowCount >= PAGE_LIMIT) {
      const mid = new Date(Math.floor((Date.parse(start) + Date.parse(end)) / 2 / 1000) * 1000).toISOString();
      log(`  page at the ${PAGE_LIMIT}-row cap, splitting at ${mid}`);
      const a = await fetchPage(start, mid, { useCache, log });
      const b = await fetchPage(mid, end, { useCache, log });
      return [...a, ...b];
    }
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }
  return eventsFromCSV(text);
}

/**
 * Every event of [start, end) by half-year pages. Pages that END before `reuseCacheBefore` may come from the cache
 * (old pages hardly change); later pages are always downloaded again.
 */
export async function fetchRange(start, end, { reuseCacheBefore = null, log = console.log } = {}) {
  const pages = halfYearPages(start, end);
  const reuseUntil = reuseCacheBefore ? Date.parse(reuseCacheBefore) : -Infinity;
  const byId = new Map();
  for (const p of pages) {
    const useCache = Date.parse(p.end) <= reuseUntil;
    const events = await fetchPage(p.start, p.end, { useCache, log });
    for (const e of events) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
