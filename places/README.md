# Place names pack

The map header of The Shelter names the place under the camera from this pack instead of Apple's geocoder: offline,
in microseconds, while the user pans. Two gzip'd SQLite files sit behind one pointer:

| Part | Contents | Needed for |
|---|---|---|
| `places-core.sqlite.gz` | the 255 country outlines of the regions bundle (vertex for vertex), 336 seas and oceans with curated English and Russian names, the neutral zones | the globe and regional tiers |
| `places-detail.sqlite.gz` | the 4,596 province outlines of the regions bundle, GeoNames towns of 5,000 people or more with English and Russian names | the city tier |

The design is the final architecture of 2026-10-17 (offline map-header titles). The app's side lives in the iOS
repository (`Projects/Dependencies/PlaceNames`); this directory builds and verifies the data. Nothing here touches the
regions bundle (`regions.sqlite.gz`, `regions-db.json`) or the CDN tiles.

## Files

| Path | What |
|---|---|
| `sources.mjs`, `sources.lock.json` | the pinned upstream inputs; the lock adds the sources archive and the regions bundle |
| `stage.mjs` | P0: the upstream files -> `places-sources-<date>.tar.gz` (no network) |
| `wikidata.mjs` | P0: freezes the Wikidata labels into `curation/wikidata-labels.tsv` (the only script that talks to a service) |
| `seed-waters.mjs` | P1: a draft of `curation/waters.tsv` from Natural Earth, for curation by hand |
| `curation/*.tsv` | P1: the curated tables (below) |
| `build.mjs` | P2: the two parts, their pointer and a build report |
| `resolve.mjs` | the reference resolver: the header's chain per tier over a built pack |
| `verify.mjs`, `reports.mjs` | P3: the checks and the review reports |
| `lattice.mjs` | the lattice answers and the diff between two packs |
| `fixtures/golden.tsv` | the golden points (checked here and by the iOS contract runner) |
| `fixtures/make-fixture.mjs` | a small fixture pack for the iOS contract runner |
| `accepted-diffs.md` | lattice changes accepted for a release |
| `test/*.test.mjs` | `node --test` unit tests |
| `dist/<version>/` | the committed release bytes (only from a release PR on) |

## Sources (P0)

Every input is pinned by size and sha256 in `sources.mjs`. Download each file into its own new, empty directory, then
stage them. The 2026-10-17 inputs:

```bash
NE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector
# Natural Earth 5.2.0's marine remaster exists only as a shapefile (the repo's geojson/ copy is 5.1.0).
for ext in shp shx dbf prj cpg; do curl -fsSO $NE/204b50046f908df927a31aa52b6d3e32f79b9709/10m_physical/ne_10m_geography_marine_polys.$ext; done
for ext in shp shx dbf prj cpg; do curl -fsSO $NE/204b50046f908df927a31aa52b6d3e32f79b9709/10m_cultural/ne_10m_admin_0_disputed_areas.$ext; done
for ext in dbf cpg; do curl -fsSO $NE/f1890d9f152c896d250a77557a5751a93d494776/10m_cultural/ne_10m_admin_1_states_provinces.$ext; done
curl -fsSO https://download.geonames.org/export/dump/cities1000.zip
curl -fsSO https://download.geonames.org/export/dump/cities5000.zip
curl -fsSO https://download.geonames.org/export/dump/alternateNamesV2.zip

node places/stage.mjs --date 2026-10-17 --ne-marine <dir> --ne-disputed <dir> --ne-admin1 <dir> \
  --cities1000 <zip> --cities5000 <zip> --alternate-names <zip> --out dist/places-sources
node places/wikidata.mjs dist/places-sources/places-sources-2026-10-17   # about 15 minutes, one request at a time
```

GeoNames keeps no dated dumps, so the archive is what makes every later build byte-identical. It holds the Natural
Earth shapefiles and their GeoJSON, the admin-1 attribute columns the pack uses, `cities1000.txt` (both thresholds
derive from it: the cities5000 rule is population > 5,000 or PPLA/PPLC/PPLG, and staging checks it reproduces
`cities5000.zip` exactly) and the alternate names filtered to the `ru`, `en` and `wkdt` rows of those towns. It is
published as the release asset `places-sources-<date>` once the owner approves.

The regions bundle is the second input: `regions.sqlite.gz` of the `bundle-v1` release, whose sha256 must equal
`regions-db.json`. The pack never rebuilds the bundle.

## Curation (P1)

| Table | Rows | What |
|---|---|---|
| `waters.tsv` | 336 | one row per Natural Earth marine polygon, joined by `(ne_id, ne_name)`: English and Russian names, short forms, `parent` (the next larger water), `whole` (the row it is shown as), `globe` |
| `zones.tsv` | 12 | the neutral zones (policy `area`: 8 with outlines) and the bundle's own disputed countries (policy `country`, for review only) |
| `metros.tsv` | 32 | towns shown as their city (Q5, the metro): Tokyo's 23 special wards (bundle districts) and the districts of nine city-provinces within a radius (Istanbul, Mexico City, Jakarta, Taipei, Seoul, Moscow, Saint Petersburg, Beijing, Shanghai) |
| `places-overrides.tsv` | | town names, populations, keep/drop by geonameid |
| `admin1-overrides.tsv` | | province names by pack key |
| `short-names.tsv` | | short forms by pack key (countries, any other key) |
| `countries.tsv` | 255 | the bundle's countries with the app's ISO alpha-2 and part of the world (copied from `CountryName` and `WorldRegion`) |
| `wikidata-labels.tsv` | | frozen Wikidata labels (CC0); never edited by hand |

Every table is UTF-8, tab-separated, one header line, `#` comment lines. Russian names are data and stay in these
tables; code stays English and ASCII.

## Build (P2)

```bash
node places/build.mjs --sources dist/places-sources/places-sources-2026-10-17.tar.gz \
  --bundle <regions.sqlite.gz> --out dist/places --version 1.0.0 [--min-population 5000]
```

`--min-population 1000` builds the cities1000 variant (owner decision Q4 chose 5,000). The output directory
`dist/places/<version>/` holds both parts, `places-db.json` (the candidate pointer) and `build-report.json`. Rows are
sorted, `page_size` 4096, rollback journal, `VACUUM`, a fixed gzip header (`gzip -n -9` shape) and `meta.generated`
from `SOURCE_DATE_EPOCH` (default: the staging date), so a build depends only on its inputs.

### Towns

- The cities5000 set of `cities1000.txt` (population > 5,000 or PPLA/PPLC/PPLG), without PPLH, PPLQ, PPLW and PPLCH.
- **Country and province by polygon**: the bundle's country outline holding the town, else the province outline
  (mapped to its country: Sevastopol), else the nearest country outline within 22 km (a coast the simplified outlines
  cut off: Aden, Cadiz). A town farther than that from every outline is dropped and listed in the build report.
- **Metro rules**: `metros.tsv` (`adm2:` a bundle district, `admin1:` a GeoNames division within `km` of the metro,
  `place:` one town), then every section of a city (PPLX) takes the nearest larger non-section town within 15 km of the
  same country. Such a row keeps its own names but its `metro` is the town it is shown as.
- **English name**: GeoNames' `en` alternate where it differs from `name` (preferred first), else `name`; the soft-sign
  apostrophes of romanised Cyrillic dropped (`Mil'kovo` -> `Milkovo`, ex-USSR, Mongolia, Bulgaria); Japanese names
  without Hepburn macrons (`Hachioji`), as Apple writes them.
- **Russian name**: the override, else the Wikidata label (the item linked by GeoNames' `wkdt`, else the one item that
  claims the GeoNames ID), else GeoNames' `ru` (preferred, plain, short; never colloquial, historic or time-limited),
  else none: the app then shows the Latin name. Every Russian name must be Russian Cyrillic.

### Provinces

The bundle numbers each country's Natural Earth admin-1 rows `<ISO3>.1..n` by `adm1_code`
(`pipeline/01-normalize.mjs`). The build numbers the same Natural Earth 5.1.2 table the same way and fails if a
bundle name does not match, then takes `name_en` and `name_ru` (stress marks stripped) and the overrides.

### Waters and zones

Waters: Douglas-Peucker 0.01 deg on each outer ring, island holes dropped (land is decided by the outlines first),
quantised to 1e-4 deg. Zones: the bundle's province rings (Crimea = `RUS.83` + `RUS.86`, Abkhazia = `GEO.1`) or
Natural Earth's disputed-area polygons at Douglas-Peucker 0.005 deg.

## File format (schema 1)

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE areas(
  id INTEGER PRIMARY KEY,           -- 1..n in (layer, key) order; stable within one file only
  layer INTEGER NOT NULL,           -- 0 country, 1 province, 2 water, 3 zone
  key TEXT NOT NULL UNIQUE,         -- adm0:<bundle id>, adm1:<bundle id>, sea:<ne_id>[-n], zone:<slug>: stable across versions
  iso3 TEXT,                        -- countries and provinces: the bundle's country id (JPN, CYN, KAS...)
  iso2 TEXT,                        -- countries: ISO 3166-1 alpha-2; NULL = not ISO-recognised (never the nearest country)
  world TEXT,                       -- countries: the WorldRegion case of the table; zones: the zone's explicit part of the world
  parent TEXT,                      -- provinces: adm0:<iso3>; waters: the next larger water's key (NULL: an ocean, the Caspian)
  whole TEXT,                       -- waters: the key this water is shown as (NULL = itself)
  globe INTEGER NOT NULL DEFAULT 0, -- waters: 1 = named at the globe tier
  kind TEXT,                        -- waters: Natural Earth featurecla; provinces: Natural Earth type_en; zones: 'area'
  rank INTEGER,                     -- waters: Natural Earth scalerank
  code TEXT,                        -- provinces: Natural Earth adm1_code; waters: ne_id; zones: the outline sources
  iso_3166_2 TEXT,                  -- provinces
  name_en TEXT NOT NULL,            -- countries: the bundle's English name (the app names countries with CountryName)
  name_ru TEXT,                     -- countries: NULL (the app's system name); waters and zones: always set
  short_en TEXT, short_ru TEXT,     -- short forms for the header when the full name does not fit
  min_lng REAL NOT NULL, min_lat REAL NOT NULL, max_lng REAL NOT NULL, max_lat REAL NOT NULL,
  q INTEGER NOT NULL,               -- quantisation: 100000 (1e-5 deg: countries) or 10000 (1e-4 deg: the rest)
  vertices INTEGER NOT NULL,        -- vertex count of the geometry (a check)
  geometry BLOB NOT NULL);          -- see "Geometry"
CREATE VIRTUAL TABLE areas_rtree USING rtree(id, min_lng, max_lng, min_lat, max_lat);  -- the SQL path (an extension, debugging)
CREATE TABLE places(                -- detail only
  cell INTEGER NOT NULL,            -- (floor(lat) + 90) * 360 + floor(lon) + 180 of the stored position
  id INTEGER NOT NULL,              -- GeoNames geonameid; key place:<id>
  lat INTEGER NOT NULL, lon INTEGER NOT NULL,  -- 1e-4 deg
  pop INTEGER NOT NULL,             -- the town's own population (rule E ranks with it)
  adm0 TEXT NOT NULL,               -- the bundle country id by polygon (see Towns)
  adm1 TEXT,                        -- the bundle province id by polygon, NULL outside every province
  metro INTEGER NOT NULL,           -- the geonameid this town is shown as (= id unless a metro rule or a section folds it)
  name_en TEXT NOT NULL, name_ru TEXT, short_en TEXT, short_ru TEXT,
  PRIMARY KEY(cell, id)) WITHOUT ROWID;
```

`meta` keys: `schema` (1), `part` (`core`/`detail`), `version` (semver, equal in both parts of a release), `generated`,
`sources_sha256`, `regions_bundle_sha256`, `regions_bundle_version`, `curation_sha256`, `attribution`, `geometry`
(`varint-zigzag-delta-v1`), `count_areas`, `count_countries`, `count_provinces`, `count_waters`, `count_zones`,
`count_places`, and in `detail` `min_population`. A reader names its columns, so additive tables and columns keep
schema 1; removing or redefining a field is schema 2 under a new pointer key.

### Geometry

`varint(polygons)`, then per polygon `varint(rings)` (the outer ring first, then holes), then per ring
`varint(vertices)` followed by that many pairs `zigzag(dx), zigzag(dy)` of the quantised coordinates
`round(lon * q)`, `round(lat * q)`. Each delta is taken from the ring's previous vertex, the first from (0, 0). The
closing vertex is not stored: every ring is implicitly closed. Varints are unsigned LEB128; `zigzag(v) = v >= 0 ? 2v :
-2v - 1`. A blob must decode to exactly its length.

## Lookups (the contract of `resolve.mjs` and the app)

- **Point in polygon**: even-odd ray cast over all rings of a polygon (holes flip), in quantised units: the point is
  `X = lon * q`, `Y = lat * q` as doubles, compared with the integer vertices exactly as
  `(yi > Y) != (yj > Y) && X < (xj - xi) * (Y - yi) / (yj - yi) + xi`. A geometry holds the point when any polygon does.
  Several areas of a layer holding a point (shared borders): the smallest key wins.
- **Distance to an area**: point-to-segment distance in a local equirectangular plane around the point,
  `x = (lonV - lon) * cos(lat)`, `y = latV - lat`, in degrees times 111.19508 km (mean radius 6,371.0088 km), over
  every edge including the closing one; near the antimeridian also with the point at lon +/- 360. The nearest area
  within a reach wins; ties go to the smaller key.
- **Distance to a town**: haversine, mean radius 6,371.0088 km.
- **Land**: a country, province or zone polygon holds the point; a province maps to its country.

Constants: band **B = 22 km**; globe band **max(22 km, 24 pt x metres per point)**; nearest ISO country **500 km**;
coastal gap **50 km**; rule E reach **50 km** with **R(pop) = clamp(10 km x (pop / 10,000)^0.25, 8, 30)**; a city's
bay **U(pop) = min(20 km, 3 km x sqrt(pop / 100,000))**; a zone wins the band over the nearest country when it is
within **1 km** of that country's distance.

| Tier | Chain (the first hit wins) |
|---|---|
| Globe | 1. Land: the zone's `world`, else the country's part of the world (`world` plus WorldRegion's coordinate rules for RUS, USA, FRA, NLD, NOR, ATF, UMI). 2. Water within the globe band of land: that land's part of the world. 3. A water polygon: walk `parent` to the first water whose shown row (`whole`) has `globe` = 1. 4. A coastal gap: the nearest water polygon within 50 km, as 3. 5. The nearest country's part of the world. |
| Regional | 1. Land: the zone, else the country. 2. Water within B: the nearest zone or country. 3. A water polygon (several, where Natural Earth nests a feature in its parent: the one with the most `parent` hops, then the larger `rank`, then the smaller key): its shown row. 4. A coastal gap: the nearest water polygon within 50 km. 5. The nearest country with an `iso2` within 500 km. 6. The nearest country's part of the world. |
| City (both parts) | 1. Land: rule E, the town with the smallest d / R(pop), d <= 50 km, whose `adm0` is the country under the point (ties: the smaller geonameid), shown as its `metro`. 2. Land inside a zone: the zone (its neutral name stands in for the administering country's province). 3. Land: the province. 4. Land without a province: regional 1. 5. Water within B: a town of the band's country within its U(pop) (a city's bay), else the zone or country. 6. Regional 3-6. |

Keys: `adm0:<id>`, `adm1:<id>`, `sea:<ne_id>`, `zone:<slug>`, `place:<geonameid>`, `region:<WorldRegion case>`. Names:
the shown row's `name_ru` (else `name_en`) in Russian, `name_en` in English; a water is named by its `whole` row, a
town by its `metro` row; countries and parts of the world by the app.

## Verify (P3)

```bash
node places/verify.mjs --pack dist/places/1.0.0 --sources <archive> --bundle <regions.sqlite.gz> --rebuild \
  [--previous places/dist/<previous version>]
```

| # | Check |
|---|---|
| 0 | `meta` matches the pointer and the tables; `PRAGMA quick_check` |
| 1 | every geometry decodes, re-encodes to the same bytes, and matches its stored vertex count and box |
| 2 | every country equals the bundle vertex for vertex; every province has the bundle's rings within half a quantum; `meta.regions_bundle_sha256` |
| 3 | the marine layer is a partition on the lattice, except Natural Earth 5.2's nested features (the Sargasso Sea in the North Atlantic, the Strait of Dover in the English Channel), which must lie along a parent chain; gaps <= 0.2 % of water points |
| 4 | every water chain ends in an ocean (the Caspian and Garabogaz are landlocked) and agrees with Natural Earth's `oceanbasin` (adjacency is reported) |
| 5 | names: `name_en` everywhere, `name_ru` on waters and zones, no capitals-only names, stress marks, double spaces, Cyrillic in English; Russian names are Russian |
| 6 | the golden points |
| 7 | the lattice regression against the previous release: at most 0.5 % of a tier's answers change without a line in `accepted-diffs.md` |
| 8 | part parity: `core` alone answers the globe and regional tiers as `core` + `detail` do, except where land is known only by a province outline |
| 9 | every country and zone has a part of the world |
| 10 | reproducibility: a second build has the same sha256 (`--rebuild`) |
| 11 | budgets: `core` <= 1 MB gz, `detail` <= 5 MB gz (8 MB at >= 1k), <= 200,000 towns |
| 12 | licences: the attribution, the `LICENSES.md` section, no OpenStreetMap, NeoFeoda or geoBoundaries input |

Reports in `dist/places/<version>/reports/`: `review-names.md` (every curated Russian name), `provinces.tsv`,
`disputed.md`, `ru-coverage.md`, `short-candidates.tsv`, `golden-results.tsv`, `water-parents.txt`, `water-nesting.txt`,
`part-parity.txt`, `name-problems.txt`, `lattice.tsv.gz` (and `lattice-diff.md` with `--previous`).

## Reproducibility

Two builds from the same commit, sources archive and bundle give the same sha256 on the same Node version. The deflate
stream comes from Node's zlib, which can differ between Node builds; CI therefore compares the inflated SQLite bytes
with the committed release files, which do not depend on the deflate implementation, and the committed `.gz` with the
pointer's sha256.

## Release (owner-approved; nothing here runs without the owner)

1. A release PR carries `places/dist/<version>/places-core.sqlite.gz`, `places-detail.sqlite.gz`, the new
   `places-db.json` at the repository root and the reports. The iOS release gate (`Scripts/check-place-pack.sh`) runs
   on the candidate files.
2. The owner reviews the names (`review-names.md`, `disputed.md`) and approves publishing.
3. Merge to `main`; then, on the merge commit, a session checks the committed bytes against `places-db.json`, creates
   the tag `bundle-places-<version>` and the GitHub release with the same two files (and the sources archive when it
   changed). The tag ruleset keeps the tag from moving, so the jsDelivr, release and raw URLs serve the same bytes.

The sources archive `places-sources-<date>` is published the same way, after the owner's approval.

## Licences

GeoNames is CC BY 4.0, Natural Earth public domain, Wikidata CC0; the pack is CC BY 4.0 (`LICENSES.md`, "Place names
pack"). `meta.attribution` carries the credit line.
