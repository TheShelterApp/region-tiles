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

/** Published outputs. */
export const STATS_DIR = join(ROOT, 'stats');
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
