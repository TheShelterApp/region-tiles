// Central configuration for the region-tiles pipeline.
// All tunables live here so the build is idempotent and easy to re-run.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = dirname(fileURLToPath(import.meta.url));

// ---- Read-only source locations (NeoFeoda cache) -------------------------
// NeoFeoda is a READ-ONLY reference. We snapshot what we need into src-data/.
export const NEOFEODA_CACHE = '/Users/nickaroot/Developer/NeoFeoda/tools/grid-gen/cache';
export const NEOFEODA_ADM2_DIR = join(NEOFEODA_CACHE, 'adm2');
export const NEOFEODA_NE_ADMIN1 = join(NEOFEODA_CACHE, 'ne_admin1.json');

// Natural Earth admin-0 (public domain) — downloaded fresh (not in NeoFeoda cache).
// martynafford mirror is the same one NeoFeoda's marine.mjs uses.
export const NE_ADMIN0_URL =
  'https://raw.githubusercontent.com/martynafford/natural-earth-geojson/master/10m/cultural/ne_10m_admin_0_countries.json';

// ---- Working / output directories ----------------------------------------
export const SRC_DATA = join(ROOT, 'src-data'); // gitignored snapshot of sources
export const SRC_ADM2 = join(SRC_DATA, 'adm2'); // copied per-country ADM2
export const SRC_NE_ADMIN1 = join(SRC_DATA, 'ne_admin1.json');
export const SRC_NE_ADMIN0 = join(SRC_DATA, 'ne_admin0.json');

export const BUILD = join(ROOT, '.build'); // gitignored intermediates
export const REGIONS_JSONL = join(BUILD, 'regions.jsonl'); // master id table
export const NORM_DIR = join(BUILD, 'norm'); // normalized (unsimplified) per-region geometry

// Published (committed) outputs — the CDN layout.
export const GEO_DIR = join(ROOT, 'geo');
export const INDEX_DIR = join(ROOT, 'index');
export const VERSION_JSON = join(ROOT, 'version.json');

// ---- Offline SQLite bundle (published as a GitHub Release asset) ----------
export const DIST = join(ROOT, 'dist'); // gitignored large artifacts
export const SQLITE_FILE = join(DIST, 'regions.sqlite');
export const SQLITE_GZ = join(DIST, 'regions.sqlite.gz');
export const REGIONS_DB_JSON = join(ROOT, 'regions-db.json'); // committed pointer for iOS
export const BUNDLE_VERSION = '1.0.0'; // bump on any geometry/composition change
export const BUNDLE_TAG = 'bundle-v1'; // GitHub Release tag holding regions.sqlite.gz

// ---- Levels ---------------------------------------------------------------
export const LEVELS = [0, 1, 2];

// ---- Simplification (mapshaper Visvalingam, weighted) --------------------
// Percentage of vertices to KEEP per level. Source ADM2 is already simplified,
// so most files are untouched in practice; the per-feature vertex cap catches
// the ~34 Arctic/archipelago mega-polygons (Nunavut, Sakha, etc.).
// Fraction of removable vertices to KEEP per level (mapshaper Visvalingam).
// Source ADM2 is already simplified and 99.9% of files meet the caps, so these
// are moderate (quality-preserving); the per-feature cap handles the few giants.
export const SIMPLIFY = {
  0: { percent: 0.12 }, // countries: shown zoomed out, coarse coastline OK
  1: { percent: 0.22 }, // provinces
  2: { percent: 0.45 }, // districts: keep detail (small units)
};

// Per-region caps (contract §4). Bytes is the HARD acceptance criterion (§8),
// guaranteed for every file (by extra simplification, then by dropping the
// smallest islet parts of many-island archipelago districts if needed).
// Vertices is a SOFT display target used to trigger extra simplification; a
// genuine many-island district may exceed it, which is allowed.
export const MAX_VERTICES_PER_REGION = 5000;
export const MAX_BYTES_PER_REGION = 150 * 1024;

// Coordinate precision (decimal places). 5dp ~= 1.1m — plenty for display.
export const COORD_PRECISION = 5;
// bbox precision in the index files.
export const BBOX_PRECISION = 5;

// ---- ISO3 code aliases (Natural Earth code -> canonical ADM2 filename ISO3)
// NE uses non-ISO codes for a few territories; join keys must be reconciled.
export const ISO_ALIAS = {
  PSX: 'PSE', // Palestine
  SDS: 'SSD', // South Sudan
  KOS: 'XKX', // Kosovo
  SAH: 'ESH', // Western Sahara
};

// ---- Version / attribution ------------------------------------------------
export const DATA_VERSION = '1.0.0';
export const ATTRIBUTION = 'Boundaries © geoBoundaries (CC-BY), Natural Earth.';
export const SOURCE_INFO = {
  adm2: 'geoBoundaries gbOpen ADM2 (commit 9469f09) via NeoFeoda cache, with OSM/ODbL overrides for ITA, DEU, FRA, ESP, PHL, BGD, ARE and RUS (St. Petersburg)',
  adm1: 'Natural Earth 10m admin-1 (public domain)',
  adm0: 'Natural Earth 10m admin-0 (public domain)',
};

// CDN base (GitHub org/repo) for URL hints in version.json / README.
export const CDN = {
  org: 'TheShelterApp',
  repo: 'region-tiles',
  jsdelivr: 'https://cdn.jsdelivr.net/gh/TheShelterApp/region-tiles@{ref}',
  raw: 'https://raw.githubusercontent.com/TheShelterApp/region-tiles/{ref}',
};
