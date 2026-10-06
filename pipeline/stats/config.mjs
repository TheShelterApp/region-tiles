// Configuration of the area-history statistics (stats/): what is counted, where the raw ComCat pages are cached and
// how events are assigned to a country. Every tunable lives here so a run is reproducible.

import { join } from 'node:path';
import { ROOT } from '../../config.mjs';

/** The catalogue start: the "90-year area history" counts from here (fixed; the span grows by a year every January). */
export const SINCE = '1936-01-01T00:00:00Z';

/** Preferred magnitude floor (ComCat `minmagnitude`, inclusive). */
export const MIN_MAGNITUDE = 4.5;

/** ComCat `eventtype`: earthquakes only (no explosions, quarry blasts or other non-tectonic events). */
export const EVENT_TYPE = 'earthquake';

/** ComCat FDSN event service. */
export const COMCAT_BASE = 'https://earthquake.usgs.gov/fdsnws/event/1';

/** ComCat's hard cap per query is 20,000 rows; a page that returns the cap is split in two and fetched again. */
export const PAGE_LIMIT = 20000;

/** At most one ComCat request per this many milliseconds (the USGS asks clients to stay polite). */
export const MIN_REQUEST_INTERVAL_MS = 1100;

/** Raw ComCat pages (CSV) are cached here, never in git. Override with COMCAT_CACHE_DIR. */
export const CACHE_DIR = process.env.COMCAT_CACHE_DIR || join(ROOT, '.cache', 'comcat');

/** Published outputs. STATS_OUT_DIR moves them (a dry run on a copy, the end-to-end tests). */
export const STATS_DIR = process.env.STATS_OUT_DIR || join(ROOT, 'stats');
export const STATS_ADM0_DIR = join(STATS_DIR, 'adm0');
export const STATS_INDEX = join(STATS_DIR, 'index.json');

/** Schema of stats/index.json and stats/adm0/<ISO3>.json. Bump on an incompatible change (the app checks it). */
export const SCHEMA_VERSION = 1;

/** How many of the largest and of the most recent events each country file lists. */
export const TOP_LARGEST = 20;
export const TOP_RECENT = 20;

/**
 * An incremental run fetches again everything from 1 January of the year that holds (last cutoff - this many days):
 * ComCat revises magnitudes, locations and deletions mostly within months, and a whole year is replaced at once so a
 * year's histogram bin is never half old, half new.
 */
export const REVISION_WINDOW_DAYS = 365;

/**
 * The country assignment mirrors the app's region resolve (iOS `RegionTilesDatabase.resolve`), so the card counts
 * the events the app itself would place in the country:
 * - the level by magnitude (ADM1 for M < 6, ADM0 for M >= 6), walking up to ADM0, first polygon that contains the
 *   epicentre wins (the bundle's own simplified polygons, geo/);
 * - otherwise the nearest country among the OFFSHORE_CANDIDATES nearest by bounding box, measured to the nearest
 *   vertex of its outline in equirectangular degrees (longitude scaled by cos(latitude)), if that is within
 *   OFFSHORE_MAX_DEGREES (iOS `RegionGeometry.offshoreMaxDistanceSq` = 4.5 * 4.5, about 500 km);
 * - otherwise (open ocean, mid-ocean ridges) the event belongs to no country and is only counted as unassigned.
 */
export const OFFSHORE_MAX_DEGREES = 4.5;
export const OFFSHORE_CANDIDATES = 10;

export const SOURCE = {
  name: 'USGS ANSS Comprehensive Earthquake Catalog (ComCat)',
  url: 'https://earthquake.usgs.gov/fdsnws/event/1/',
  licence: 'Public domain (U.S. Geological Survey); see https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
  attribution: 'Earthquake data: U.S. Geological Survey, ANSS Comprehensive Earthquake Catalog (ComCat).',
};

// ---- Plausibility (XR-1, round 16) ---------------------------------------------------------------------------------
// A wrong ComCat answer must fail the build (exit 1: the refresh workflow pushes nothing) instead of publishing it. The
// checks run before any file is written; `--accept-drop` turns the comparisons with the previous files and the window
// count into warnings, for a genuine large revision an operator has reviewed. An empty page always fails.

/**
 * A page spanning at least this many days is never empty: every year since 1936 has at least 127 earthquakes of M4.5+
 * (1945, the fewest; published files of 2026-10-06), and a page is a half-year except the run's last one (from
 * 1 January or 1 July to the cutoff, today's catalogue: about 20 a day, 8,556 in 2025) and the halves of a page at the
 * row cap. A 204, an empty body or a header-only CSV for such a page is a wrong answer, never cached.
 */
export const EMPTY_PAGE_MIN_SPAN_DAYS = 7;

/** The events downloaded for the run's window may fall short of ComCat's /count of the same window by at most
 *  max(COUNT_SLACK, COUNT_TOLERANCE x count): more is a truncated page. (The whole catalogue matched exactly on
 *  2026-10-06; a few events revised between the pages and the count are the slack.) */
export const COUNT_TOLERANCE = 0.005;
export const COUNT_SLACK = 10;

/** Against the previous published files (same filter, a cutoff no earlier): the global total may drop by at most
 *  TOTAL_DROP_TOLERANCE, a year's global count by at most max(YEAR_DROP_SLACK, YEAR_DROP_TOLERANCE x its count), and,
 *  with the same assignment rule and regions, a country's total by at most max(COUNTRY_DROP_SLACK,
 *  COUNTRY_DROP_TOLERANCE x its total). ComCat's revisions move a few events across M4.5 or delete duplicates; the
 *  catalogue grows, so a larger drop is a lost page or a broken answer. */
export const TOTAL_DROP_TOLERANCE = 0.01;
export const YEAR_DROP_TOLERANCE = 0.05;
export const YEAR_DROP_SLACK = 10;
export const COUNTRY_DROP_TOLERANCE = 0.03;
export const COUNTRY_DROP_SLACK = 10;
