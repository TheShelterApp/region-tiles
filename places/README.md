# Place names pack

The map header of The Shelter names the place under the camera from this pack instead of Apple's geocoder: offline,
in microseconds, while the user pans. Two gzip'd SQLite files sit behind one pointer:

| Part | Contents | Needed for |
|---|---|---|
| `places-core.sqlite.gz` | the 255 country outlines of the regions bundle (vertex for vertex), 336 seas and oceans with curated English and Russian names, the neutral zones, the assignment areas | the globe and regional tiers |
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
| `build.mjs` | P2: the two parts, their pointer and a build report (on the Node of `.nvmrc`) |
| `.nvmrc` | the Node release builds and CI use (name hygiene follows its Unicode tables) |
| `resolve.mjs` | the reference resolver: the header's chain per tier over a built pack |
| `verify.mjs`, `reports.mjs` | P3: the checks and the review reports |
| `lattice.mjs` | the lattice answers, the diff between two packs, and the targeted sample of the iOS release gate |
| `fixtures/golden.tsv` | the golden points (checked here and by the iOS contract runner) |
| `fixtures/make-fixture.mjs` | a small fixture pack for the iOS contract runner |
| `accepted-diffs.md` | lattice changes and part-parity differences accepted for a release |
| `check-release.mjs` | a release's committed bytes against `places-db.json` (version, schema, parts, sha256, sizes, exact URLs) and a fresh build |
| `release.mjs` | cuts a release on the merge commit after the owner's approval (a dry run unless `--execute`) |
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
| `zones.tsv` | 12 | the neutral zones (policy `area`: 8 with outlines, each with its administering countries `admin`) and the bundle's own disputed countries (policy `country`, for review only) |
| `assignments.tsv` | 2 | assignment areas: land whose country a policy draws against the simplified outlines (Q2: East Jerusalem and the West Bank are Palestine, the rest of the Jerusalem district Israel) |
| `metros.tsv` | 34 | towns shown as their city (Q5, the metro): Tokyo's 23 special wards and the municipality of Sao Paulo (GeoNames second-order divisions), the districts of nine city-provinces within a radius (Istanbul, Mexico City, Jakarta, Taipei, Seoul, Moscow, Saint Petersburg, Beijing, Shanghai), single towns |
| `town-countries.tsv` | | the policy pairs that keep a town in its outline's country instead of GeoNames' (Crimea, Northern Cyprus, Somaliland, the overseas departments...) |
| `places-overrides.tsv` | | town names, populations, positions, countries, keep/drop by geonameid |
| `admin1-overrides.tsv` | | province names by pack key |
| `short-names.tsv` | | short forms of countries and provinces by pack key (waters, zones and towns keep theirs in their own tables; any other key fails the build) |
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

- The cities5000 set of `cities1000.txt` (population > 5,000, or a seat PPLA/PPLC/PPLG at any size: owner decision Q4,
  towns of 5,000 people or more, keeps GeoNames' seats of first-order divisions), without PPLH, PPLQ, PPLW and PPLCH.
  `--min-population N` builds population > N plus the seats (N <= 1000: all of cities1000).
- **Country**: GeoNames' (its country code as the bundle's country, `countries.tsv` iso2), unless a policy pair of
  `town-countries.tsv` keeps the country of the outline the town lies in (Crimea's towns stay in the bundle's Russia,
  the overseas departments in its France), or an override sets it. The outline's country is the land function at the
  town (an assignment area, the country and province outlines; else the nearest country or province outline within
  22 km, a coast the simplified outlines cut off: Aden, Taman, Yuzhno-Kurilsk); when it differs from the town's own it is
  kept as `adm0_alt`, so rule E still names the town on that land (El Paso lies inside Mexico's simplified outline). A
  town farther than 22 km from every outline is dropped and listed in the build report; a GeoNames country code with no
  bundle country and no policy row fails the build. Province by polygon.
- **Metro rules**: `metros.tsv` (`admin2:` a GeoNames second-order division within `km` of the metro: a Tokyo ward, the
  Sao Paulo municipality; `admin1:` a first-order division within `km`; `place:` one town). A town of an `admin2:`
  division farther out fails the build (a misplaced record: drop it), as does a town of the metro's prefecture named
  after a ward and not folded. Then every section of a city (PPLX) takes the nearest non-section town within 15 km of a
  shared country with at least its population, never one of another municipality (both with a GeoNames admin2); a
  section with none is shown as itself, its population capped at the largest non-section town within 15 km (unless an
  override keeps it). Such a row keeps its own names but its `metro` is the town it is shown as; `sections.md` lists
  the sections shown as themselves.
- **English name**: GeoNames' `en` alternate where it differs from `name` (preferred first), else `name`; the soft-sign
  apostrophes of romanised Cyrillic dropped (`Mil'kovo` -> `Milkovo`, ex-USSR, Mongolia, Bulgaria); Japanese names
  without Hepburn macrons (`Hachioji`), as Apple writes them.
- **Russian name**: the override, else the Wikidata label (the item linked by GeoNames' `wkdt`, else the one item that
  claims the GeoNames ID) when that item is the town's: its English label is alike one of the town's GeoNames names and
  has no qualifier the town's name lacks ("Old Delhi", "Baixada Santista", "Tagansky District"), and its Russian label is
  no district, agglomeration or administrative unit; else GeoNames' preferred `ru`, else its only plain `ru` (two
  different ones are a guess: none), never colloquial, historic or time-limited; else none: the app then shows the Latin
  name. Every Russian name must be Russian Cyrillic. `reports/town-names-ru.md` lists every town of 100,000 people or
  more with its source for the owner's review.
- **English name** cleanup also drops the administrative suffixes of Korean, North Korean, Chinese and Japanese names
  ("Goyang-si", "Zhu Cheng City", "Nara-shi") and soft-sign apostrophes at a word's end ("Ryazan'").

### Provinces

The bundle numbers each country's Natural Earth admin-1 rows `<ISO3>.1..n` by `adm1_code`
(`pipeline/01-normalize.mjs`). The build numbers the same Natural Earth 5.1.2 table the same way and fails if a
bundle name does not match, then takes `name_en` and `name_ru` (stress marks stripped) and the overrides.

### Waters and zones

Waters: Douglas-Peucker 0.01 deg on each outer ring, island holes dropped (land is decided by the outlines first),
quantised to 1e-4 deg; `national` marks a national sea (Q7: the Sea of Marmara, the Bosporus, the Dardanelles). Zones:
the bundle's province rings (Crimea = `RUS.83` + `RUS.86`, Abkhazia = `GEO.1`, each checked against its bundle name) or
Natural Earth's disputed-area polygons at Douglas-Peucker 0.005 deg, with their administering countries. Assignment
areas: the same sources at Douglas-Peucker 0.001 deg.

## File format (schema 1)

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE areas(
  id INTEGER PRIMARY KEY,           -- 1..n in (layer, key) order; stable within one file only
  layer INTEGER NOT NULL,           -- 0 country, 1 province, 2 water, 3 zone, 4 assignment area
  key TEXT NOT NULL UNIQUE,         -- adm0:<bundle id>, adm1:<bundle id>, sea:<ne_id>[-n], zone:<slug>, assign:<slug>: stable across versions
  iso3 TEXT,                        -- countries and provinces: the bundle's country id (JPN, CYN, KAS...); assignment areas: the country they give
  iso2 TEXT,                        -- countries: ISO 3166-1 alpha-2; NULL = not ISO-recognised (never the nearest country)
  world TEXT,                       -- countries: the WorldRegion case of the table; zones: the zone's explicit part of the world
  parent TEXT,                      -- provinces: adm0:<iso3>; waters: the next larger water's key (NULL: an ocean, the Caspian)
  whole TEXT,                       -- waters: the key this water is shown as (NULL = itself)
  globe INTEGER NOT NULL DEFAULT 0, -- waters: 1 = named at the globe tier
  kind TEXT,                        -- waters: Natural Earth featurecla; provinces: Natural Earth type_en; zones: 'area'
  rank INTEGER,                     -- waters: Natural Earth scalerank; assignment areas: the order (the smallest first)
  code TEXT,                        -- provinces: Natural Earth adm1_code; waters: ne_id; zones: the outline sources
  iso_3166_2 TEXT,                  -- provinces
  name_en TEXT NOT NULL,            -- countries: the bundle's English name (the app names countries with CountryName)
  name_ru TEXT,                     -- countries: NULL (the app's system name); waters and zones: always set
  short_en TEXT, short_ru TEXT,     -- short forms for the header when the full name does not fit
  admin TEXT,                       -- zones: the administering countries, space-separated bundle ids (the band's zone tie)
  national INTEGER NOT NULL DEFAULT 0,  -- waters: 1 = a national sea (Q7): the 22 km band does not apply over it
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
  adm0 TEXT NOT NULL,               -- the town's country, a bundle id (GeoNames' unless a policy pair; see Towns)
  adm1 TEXT,                        -- the bundle province id by polygon, NULL outside every province
  adm0_alt TEXT,                    -- the country of the outline the town lies in when it differs from adm0 (rule E names it there too)
  metro INTEGER NOT NULL,           -- the geonameid this town is shown as (= id unless a metro rule or a section folds it)
  name_en TEXT NOT NULL, name_ru TEXT, short_en TEXT, short_ru TEXT,
  PRIMARY KEY(cell, id)) WITHOUT ROWID;
```

`meta` keys: `schema` (1), `part` (`core`/`detail`), `version` (semver, equal in both parts of a release), `generated`,
`sources_sha256`, `regions_bundle_sha256`, `regions_bundle_version`, `curation_sha256`, `attribution`, `geometry`
(`varint-zigzag-delta-v1`), `count_areas`, `count_countries`, `count_provinces`, `count_waters`, `count_zones`,
`count_assignments`, `count_places`, and in `detail` `min_population`. A reader names its columns, so additive tables
and columns keep schema 1; removing or redefining a field is schema 2 under a new pointer key.

### Geometry

`varint(polygons)`, then per polygon `varint(rings)` (the outer ring first, then holes), then per ring
`varint(vertices)` followed by that many pairs `zigzag(dx), zigzag(dy)` of the quantised coordinates
`round(lon * q)`, `round(lat * q)`. Each delta is taken from the ring's previous vertex, the first from (0, 0). The
closing vertex is not stored: every ring is implicitly closed. Varints are unsigned LEB128; `zigzag(v) = v >= 0 ? 2v :
-2v - 1`. A blob must decode to exactly its length.

## Lookups (the contract of `resolve.mjs` and the app)

- **The point**: the latitude clamped to [-90, 90]; a longitude outside [-180, 180) is wrapped into it (180 is -180,
  where the polygons that end at the antimeridian start again). A longitude in range is used as it is, bit for bit.
- **Point in polygon**: even-odd ray cast over all rings of a polygon (holes flip), in quantised units: the point is
  `X = lon * q`, `Y = lat * q` as doubles, compared with the integer vertices exactly as
  `(yi > Y) != (yj > Y) && X < (xj - xi) * (Y - yi) / (yj - yi) + xi`. A geometry holds the point when any polygon does.
  Several areas of a layer holding a point (shared borders): the smallest key wins.
- **Distance to an area**: point-to-segment distance in a local equirectangular plane around the point,
  `x = (lonV - lon) * cos(lat)`, `y = latV - lat`, in degrees times 111.19508 km (mean radius 6,371.0088 km), over
  every edge including the closing one; near the antimeridian also with the point at lon +/- 360. The nearest area
  within a reach wins; ties go to the smaller key.
- **Distance to a town**: haversine, mean radius 6,371.0088 km.
- **Land**: a country, province, zone or assignment polygon holds the point. **Its country**: the assignment area's
  (the smallest `rank` holding the point, then the smaller key); else the one country the country polygons and the
  province polygon (mapped to its country) agree on; else, where they disagree or two country polygons overlap (both
  layers are simplified: they part by 1-5 km at borders), the country of the town rule E names among the candidate
  countries' towns (`adm0` or `adm0_alt` among them; that town's `adm0` when it is a candidate, else its `adm0_alt`),
  else the province's country, else the smallest key. `core` alone: the country polygons only.
- **The nearest country land** within a reach: the nearest country outline, or with `detail` the nearest province
  outline (mapped to its country) when strictly nearer; ties go to the country outline.
- **The nearest land** within a reach: that country land, or the nearest zone when it is strictly nearer, or when the
  country is one of the zone's `admin` countries and the zone is within **1 km** more (their outlines coincide along a
  coast). The country comes along (the city tier's bay town is of that country).

Constants: band **B = 22 km**; over a `national` water **3 km** (the simplified outlines' error at its coast); globe
band **22 km inside a water whose shown row is a globe row, else min(100 km, max(22 km, 24 pt x metres per point))**;
nearest ISO country **500 km**; coastal gap **50 km**; rule E reach **50 km** with **R(pop) = clamp(10 km x
(pop / 10,000)^0.25, 8, 30)**; a city's bay **U(pop) = min(20 km, 3 km x sqrt(pop / 100,000))**.

| Tier | Chain (the first hit wins) |
|---|---|
| Globe | 1. Land: the zone's `world`, else the part of the world of the country (or of the nearest country land within B) (`world` plus WorldRegion's coordinate rules for RUS, USA, FRA, NLD, NOR, ATF, UMI). 2. Water within the globe band of land: that land's part of the world. 3. A water polygon: walk `parent` to the first water whose shown row (`whole`) has `globe` = 1. 4. A coastal gap: the nearest water polygon within 50 km, as 3. 5. The nearest country's part of the world. |
| Regional | 1. Land: the zone, else the country. 2. Water within B (3 km over a `national` water): the nearest land. 3. A water polygon (several, where Natural Earth nests a feature in its parent: the one with the most `parent` hops, then the larger `rank`, then the smaller key): its shown row. 4. A coastal gap: the nearest water polygon within 50 km. 5. The nearest country with an `iso2` within 500 km. 6. The nearest country's part of the world. |
| City (both parts) | 1. Land: rule E, the town with the smallest d / R(pop), d <= 50 km, whose `adm0` or `adm0_alt` is the country under the point (where only a zone polygon holds the land: one of the zone's `admin` countries; land of no country: the nearest country land within B) (ties: the smaller geonameid), shown as its `metro`. 2. Land inside a zone: the zone (its neutral name stands in for the administering country's province). 3. Land: the province. 4. Land without a province: regional 1. 5. Water within B: a town of the band's country (`adm0` or `adm0_alt`) within its U(pop) (a city's bay), else the zone or country (over a `national` water only within 3 km). 6. Regional 3-6. |

Keys: `adm0:<id>`, `adm1:<id>`, `sea:<ne_id>`, `zone:<slug>`, `place:<geonameid>`, `region:<WorldRegion case>`. Names:
the shown row's `name_ru` (else `name_en`) in Russian, `name_en` in English; a water is named by its `whole` row (a row
without a name by its parent's), a town by its `metro` row; countries and parts of the world by the app. Short forms
go with the name shown: `short_en` for an English title; for a Russian one `short_ru`, or `short_en` when the title
fell back to the Latin name (no `name_ru`); a Russian country title (the app's name) takes only `short_ru`.

### The release gate's parity run

The iOS release gate (`Scripts/check-place-pack.sh` in the iOS repository) compares the Swift chain with this resolver
field by field (key, chain step, names, short forms; countries' and parts of the world's names excepted, the app names
those) on two samples:

```bash
node places/lattice.mjs answers <core.gz> <detail.gz> --out lattice.tsv.gz --n 100000      # the Fibonacci lattice
node places/lattice.mjs points <core.gz> <detail.gz> --out points.tsv --n 20000 --golden places/fixtures/golden.tsv
node places/lattice.mjs answers <core.gz> <detail.gz> --out points-answers.tsv.gz --points points.tsv
```

`points` writes a deterministic targeted sample (seed 1): the golden points, then points where an answer changes and
the two implementations could part: off country, zone, water and province outlines at the band, tie, gap and reach
distances, around towns at R(pop), U(pop) and 50 km, between two towns where their rule E scores are equal, exactly on
vertices and on the rays through them, golden-style 4-decimal points, the antimeridian (180 itself included) and the
poles; each with a globe scale from 500 to 30,000 m per point. A uniform lattice almost never lands on those places.

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
| 8 | part parity: every lattice point where `core` alone answers the globe or regional tier unlike `core` + `detail` is listed with its kind (land only by a province outline, outlines that disagree, a band measured to a province outline); one where `core` alone shows a zone, a water over land, another country or another part of the world must be accepted in `accepted-diffs.md`, and an unexplained one fails |
| 9 | every country and zone has a part of the world |
| 10 | reproducibility: a second build has the same sha256 (`--rebuild`) |
| 11 | budgets: `core` <= 1 MB gz, `detail` <= 5 MB gz (8 MB at >= 1k), <= 200,000 towns |
| 12 | licences: the attribution, the `LICENSES.md` section, no OpenStreetMap, NeoFeoda or geoBoundaries input (the build reads the bundle's levels 0 and 1, Natural Earth, only) |
| 13 | town countries: every town whose country differs from GeoNames' is listed (`town-countries.md`); one no policy pair or override explains fails |

Reports in `dist/places/<version>/reports/`: `review-names.md` (every curated Russian name), `town-names-ru.md` (the
Russian names of towns of 100,000 people or more), `provinces.tsv`, `disputed.md`, `ru-coverage.md`, `sections.md`,
`town-countries.md`, `short-candidates.tsv`, `golden-results.tsv`, `water-parents.txt`, `water-nesting.txt`,
`part-parity.txt`, `name-problems.txt`, `lattice.tsv.gz` (and `lattice-diff.md` with `--previous`).

## Reproducibility

Two builds from the same commit, sources archive and bundle give the same sha256 on the same Node version. Release
builds and CI run on the Node of `places/.nvmrc` (`build.mjs` refuses another one unless `PLACES_ANY_NODE=1`): name
hygiene follows that Node's Unicode tables, and the deflate stream its zlib. CI also compares the inflated SQLite bytes
with the committed release files, and the committed `.gz` with the pointer's sha256. The workflow's actions are pinned
by commit; it runs on pull requests and on the merge to `main`.

## Release (owner-approved; nothing here runs without the owner)

1. A release PR carries `places/dist/<version>/places-core.sqlite.gz`, `places-detail.sqlite.gz` (`.gitignore`
   re-includes `places/dist/`), the new `places-db.json` at the repository root (the build's
   `dist/places/<version>/places-db.json`) and the reports. CI's last step (`check-release.mjs`) fails when the pointer
   names `places/VERSION` but the bytes are missing, or when the pointer is not exactly this version's (version, schema,
   parts, sha256, sizes, URLs). The iOS release gate (`Scripts/check-place-pack.sh`) runs on the candidate files.
2. The owner reviews the names (`review-names.md`, `town-names-ru.md`, `disputed.md`, `town-countries.md`) and
   approves publishing.
3. Merge to `main`; then, on the merge commit, a session runs `node places/release.mjs` (a dry run: it checks a clean
   `main` equal to `origin/main`, the committed bytes against `places-db.json` and that the tag is new, and prints the
   commands), then `node places/release.mjs --execute`: the tag `bundle-places-<version>` and the GitHub release with
   the same two files (and `--sources <archive>` when it changed). The tag ruleset keeps the tag from moving, so the
   jsDelivr, release and raw URLs serve the same bytes.

The sources archive `places-sources-<date>` is published the same way, after the owner's approval.

## Licences

GeoNames is CC BY 4.0, Natural Earth public domain, Wikidata CC0; the pack is CC BY 4.0 (`LICENSES.md`, "Place names
pack"). `meta.attribution` carries the credit line.
