# region-tiles

Pre-baked admin-region polygons (country / province / district) + a country-keyed
point→region lookup index for **TheShelter**. When a user taps an earthquake, the
app highlights the admin region containing the epicenter, at a granularity chosen
by magnitude. Everything is static and served from a public GitHub repo via
jsDelivr — no runtime tiling, no server, no vector-tile decoding on the client.

> Boundaries © geoBoundaries (CC-BY), Natural Earth. — see [LICENSES.md](LICENSES.md)

## Levels

| Level | Meaning        | Magnitude (thresholds live on iOS) | Count |
|-------|----------------|------------------------------------|-------|
| ADM0  | country        | `M ≥ 6.0`                          | 255   |
| ADM1  | province/state | `4.0 ≤ M < 6.0`                     | 4,596 |
| ADM2  | district       | `M < 4.0`                          | 59,993 |

## Region ids

Stable dotted hierarchy, identical in the index and the geometry filenames:

- ADM0 — `CUB`
- ADM1 — `CUB.7`
- ADM2 — `CUB.7.3`

Parent of any id: `id.split('.').slice(0, -1).join('.')`.
ISO3 shard of any id: `id.split('.')[0]`.

## CDN layout

```
index/
  adm0.json                 # [{id, name, bbox}] — all countries (one small file)
  adm1/<ISO3>.json          # [{id, name, bbox}] — a country's provinces
  adm2/<ISO3>.json          # [{id, name, bbox}] — a country's districts
geo/
  adm0/<ISO3>.geojson       # a GeoJSON Feature (country outline)
  adm1/<ISO3>/<id>.geojson  # a GeoJSON Feature (province)
  adm2/<ISO3>/<id>.geojson  # a GeoJSON Feature (district)
version.json                # {version, generated, source, counts, lookup, attribution}
LICENSES.md
```

Served like the earthquake feed:

```
https://cdn.jsdelivr.net/gh/TheShelterApp/region-tiles@<tag>/index/adm0.json
https://cdn.jsdelivr.net/gh/TheShelterApp/region-tiles@<tag>/geo/adm2/CUB/CUB.7.3.geojson
```

Mirror: `https://raw.githubusercontent.com/TheShelterApp/region-tiles/<tag>/…`.
Pin a git tag (`v1.0.0`) as `<tag>` so the app is reproducible; jsDelivr's CORS +
long cache are used as-is.

- **index entry:** `{ "id": "CUB.7.3", "name": "El Salvador", "bbox": [minLng, minLat, maxLng, maxLat] }`
- **geometry file:** a GeoJSON `Feature`, `geometry` = `Polygon` | `MultiPolygon`,
  coordinates **[lng, lat]** WGS84, `properties = {id, name, level, country}`.
  Display-simplified: **every file ≤ 150 KB** (the hard cap). Target ≤ ~5,000
  vertices; a few genuine many-island archipelago districts keep more parts and
  exceed that soft target while still fitting the 150 KB byte cap.

## Lookup variant: country-keyed bbox + point-in-polygon

The app holds no global raster. To resolve `(lat, lng, level) → region id`:

1. **Country:** bbox-prefilter `index/adm0.json`; for each candidate fetch
   `geo/adm0/<ISO3>.geojson` and point-in-polygon. If none contain the point
   (offshore epicenter), pick the country with the nearest polygon **edge**.
2. **Region:** fetch `index/adm{level}/<ISO3>.json`; bbox-prefilter → fetch the
   few candidate `geo/…` files → point-in-polygon; nearest-edge fallback otherwise.
   The geometry you fetch to hit-test **is** the geometry you draw — no waste.
3. **Fall back up:** if the level has no data for that country (e.g. a micro-state
   with no ADM2), fall back `adm2 → adm1 → adm0`.

A complete reference implementation is [`pipeline/lib/resolve.mjs`](pipeline/lib/resolve.mjs)
(`resolveRegion(lat, lng, level)`), exercised by the acceptance tests.

> **Note on cross-provider parenting.** ADM2 comes from geoBoundaries and ADM1
> from Natural Earth, so an ADM2 id's embedded parent (`CUB.7` in `CUB.7.3`) is
> derived by a build-time point-in-polygon join and can occasionally disagree
> with the ADM1 you'd resolve independently at the same point (~2% of districts,
> at borders). This is harmless: magnitude selects a single level to display, and
> "fall back up" re-queries the index rather than trusting the id's parent.

## Building

```bash
npm install
npm run build          # stage → normalize → simplify → index → version → validate
npm run build -- --restage   # also re-copy sources + re-download Natural Earth admin-0
```

Sources are **read-only**: ADM2 + admin-1 are snapshotted from the NeoFeoda
`grid-gen/cache` (never modified); Natural Earth admin-0 is downloaded fresh.
Individual steps: `npm run stage|normalize|simplify|index|version|validate`.

Pipeline is idempotent: `geo/` and `index/` are byte-identical across rebuilds
from the same sources. `version.json`'s `generated` timestamp is the only varying
field — set `SOURCE_DATE_EPOCH` (unix seconds) to pin it for bit-reproducible builds.

## Publishing

Commit `geo/`, `index/`, `version.json`, tag, push; jsDelivr picks up the tag.

```bash
git add geo index version.json README.md LICENSES.md
git commit -m "data v1.0.0"
git tag v1.0.0 && git push origin main --tags
```

Repo is ~285 MB (258 MB is ADM2 geometry across ~60k files, sharded by ISO3).
jsDelivr serves individual files fine (all are KB-sized, well under its 20 MB
per-file limit) and gzips them in transit. If the repo grows uncomfortable, the
`geo/` tree can be split to its own tag/release without changing the URL scheme.

## Offline SQLite bundle

An addition to the CDN for fully-offline point→region resolution on-device (the
per-region CDN files above stay the fallback). One SQLite file bundles all three
levels + a spatial index; iOS downloads it once and resolves locally.

- **`regions-db.json`** (committed to the repo root — the stable pointer iOS polls):
  `{ version, url, sizeBytes, sha256 }` where `url` is the direct download of the
  Release asset and `sizeBytes`/`sha256` are of the **`.gz`**.
- **`regions.sqlite.gz`** — the gzipped DB, published as a **GitHub Release asset**
  under tag **`bundle-v1`** (too big for comfortable jsDelivr; Releases handle 20–40 MB).

Schema (fixed — iOS depends on it exactly):

```sql
CREATE TABLE regions (
  id TEXT PRIMARY KEY,            -- 'USA' / 'USA.6' / 'USA.6.75'
  level INTEGER NOT NULL,         -- 0 / 1 / 2
  name TEXT NOT NULL,
  min_lng REAL NOT NULL, min_lat REAL NOT NULL, max_lng REAL NOT NULL, max_lat REAL NOT NULL,
  geometry BLOB NOT NULL          -- gzip of the BARE GeoJSON geometry object, [lng,lat] WGS84
);
CREATE INDEX idx_regions_level ON regions(level);
CREATE VIRTUAL TABLE regions_rtree USING rtree(rowid, min_lng, max_lng, min_lat, max_lat); -- rowid = regions.rowid
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- version, generated, count_adm0/1/2, attribution
```

`geometry` is `gunzip` → a bare `{"type":"Polygon"|"MultiPolygon","coordinates":…}`
(no Feature wrapper) — the same simplified polygons as `geo/`. Note the R*Tree
column order is `(min_lng, max_lng, min_lat, max_lat)` (paired per axis).

iOS flow: read `regions-db.json` → if `version` changed, download `url`, verify
`sha256`/`sizeBytes`, gunzip → open. Resolve `(lat,lng,level)`:

```sql
SELECT r.id, r.name, r.geometry
FROM regions_rtree rt JOIN regions r ON r.rowid = rt.rowid
WHERE rt.min_lng <= :lng AND rt.max_lng >= :lng
  AND rt.min_lat <= :lat AND rt.max_lat >= :lat
  AND r.level = :level;
```

then gunzip each candidate's `geometry` and point-in-polygon to pick the container;
offshore/border → nearest by polygon edge; missing level → fall back up
`adm2→adm1→adm0` (same semantics as `pipeline/lib/resolve.mjs`).

Build + publish the bundle:

```bash
npm run sqlite                                   # -> dist/regions.sqlite(.gz) + regions-db.json
node pipeline/verify-sqlite.mjs                  # acceptance checks
gh release create bundle-v1 dist/regions.sqlite.gz --title "Region SQLite bundle v1" --notes "…"
git add regions-db.json && git commit -m "…" && git push
```

Bump `BUNDLE_VERSION` in `config.mjs` on any geometry/composition change (and use
a new tag, e.g. `bundle-v2`, if you don't want to overwrite the existing asset).

## Area history statistics

Per country, the USGS ComCat earthquakes of magnitude 4.5 or more since 1936: the count, a yearly histogram, the
strongest and the latest events. TheShelter's event page shows the count of the event's country on its Statistics
card ("90-year area history") and the lists on the Previous earthquakes screen behind it.

> Earthquake data: U.S. Geological Survey, ANSS Comprehensive Earthquake Catalog (ComCat) — public domain
> (https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits, DOI 10.5066/F7MS3QZH).

```
stats/
  index.json            # schema, window, source, assignment rule, totals, {ISO3: count} for every country
  adm0/<ISO3>.json      # one country (every ADM0 id of index/adm0.json, zero counts included)
```

Served from `main` (refreshed monthly, so no tag):

```
https://cdn.jsdelivr.net/gh/TheShelterApp/region-tiles@main/stats/adm0/JPN.json
https://raw.githubusercontent.com/TheShelterApp/region-tiles/main/stats/adm0/JPN.json
```

A country file (`schemaVersion` 1; times are UTC, `[since, until)`):

```json
{
  "schemaVersion": 1, "id": "JPN", "name": "Japan",
  "since": "1936-01-01T00:00:00Z", "until": "2026-10-06T00:00:00Z",
  "minMagnitude": 4.5, "eventType": "earthquake",
  "source": "USGS ANSS Comprehensive Earthquake Catalog (ComCat)", "attribution": "…",
  "total": 25769,
  "histogram": { "startYear": 1936, "counts": [25, 26, 72, …] },
  "largest": [ {"id": "official20110311054624120_30", "time": "2011-03-11T05:46:24Z", "mag": 9.1,
                "place": "2011 Great Tohoku Earthquake, Japan", "lat": 38.297, "lon": 142.373, "depth": 29}, … ],
  "recent":  [ … ]
}
```

`largest` (20, strongest first, equal magnitudes oldest first) and `recent` (20, newest first) carry the ComCat event
id (its page is `https://earthquake.usgs.gov/earthquakes/eventpage/<id>`), the time to the second, the preferred
magnitude, ComCat's place text as published (older ISC-GEM places carry `?` for the letters ComCat's text lost), the
epicentre and the depth in km (`null` when unknown). Every file is under 8 KB.

**Country assignment** — the same rule as the app's region lookup (iOS `RegionTilesDatabase.resolve`), so the card
counts what the app itself places in the country: the level by magnitude (ADM1 below M6, ADM0 from M6) walking up to
ADM0, the first region whose box and polygon (`geo/`, the geometry of `regions.sqlite`) contain the epicentre; else,
offshore, the nearest of the 10 countries nearest by box, measured to the nearest vertex of its outline in
equirectangular degrees (longitude scaled by cos latitude), when within 4.5° (about 500 km: subduction trenches
100–300 km out count for their coast); else the event is in open ocean and counts for no country (`unassigned` in
`index.json`). Most M4.5+ earthquakes are at sea: 69.7 % count offshore for a country, 7.4 % are in open ocean.

**Building** (Node ≥ 20, no dependencies):

```bash
npm run stats                 # incremental: from 1 January of the year of (last cutoff − 365 days) to today 00:00 UTC
npm run stats -- --full       # everything since 1936 (cached pages before the revision window are reused)
npm run stats -- --until=2026-10-06   # a fixed cutoff: the same cutoff gives the same files
npm run stats -- --accept-drop        # publish although the plausibility checks fail (below; review the log first)
npm run test:stats            # unit tests, the real-polygon assignments, the published files' schema and totals
npm run stats:verify          # compare with ComCat /count (below)
```

ComCat is read in half-year pages (`orderby=time-asc`, `limit=20000`; a page at the cap is split in two), at most one
request per 1.1 s, cached as CSV under `.cache/comcat/` (never committed; `COMCAT_CACHE_DIR` moves it). A full read is
182 requests (about 3½ minutes, 50 MB). An incremental run replaces whole years from its window start: the old files
keep the earlier years' bins and events, the window's events (new ones and ComCat's revisions and deletions) are read
again, so running it twice gives the same files. It falls back to a full run by itself when there is no previous
`index.json` or it was built with another schema, filter, list size, assignment rule or region set, and when a
country's strongest or latest list cannot be proven equal to a full run's (listed events of the window were deleted or
revised away, so an older event the old file did not list may belong in it; checked before any file is written).
Checked on real data: a full run to 2026-09-01 followed by an incremental run to 2026-10-06 gives the same files as a
full run to 2026-10-06.

**Plausibility** (round 16) — a wrong ComCat answer fails the build (exit 1) before any file is written, so the
workflow pushes nothing and the app keeps the last good files (a device keeps a fetched file up to jsDelivr's 7-day
max-age, so a bad publish could not be taken back in time):

- a page of 7 days or more with no events (a 204, an empty body, a header-only CSV) fails: every year since 1936 has at
  least 127 M4.5+ earthquakes (1945), and a page is a half-year except the run's last one. No empty page is ever
  cached, and an empty page an older run cached is downloaded again;
- the run's window must hold events, and its download may fall short of ComCat's `/count` of the same window by at most
  max(10, 0.5 %) (one extra request; the whole catalogue matched exactly on 2026-10-06): more is a truncated page;
- against the published files (same filter, a cutoff no earlier): the global total may drop by at most 1 %, a year's
  global count by at most max(10, 5 %), and, with the same assignment rule and regions, a country's total by at most
  max(10, 3 %). ComCat's revisions delete duplicates and move a few events across M4.5; the catalogue grows.

The thresholds live in `pipeline/stats/config.mjs`. `--accept-drop` (the workflow's `accept_drop`) turns the window
count and the comparison into warnings, for a genuine large revision someone has reviewed; an empty page always fails.
A dry run of the checks on real data (2026-10-06, a copy of the files): the window count matched (306,469 of 306,469)
and the total moved 306,470 → 306,469 (a Dominican Republic event deleted or revised below M4.5 since the morning's build).

**Refresh** — `.github/workflows/stats-refresh.yml`: on the 2nd of every month (04:17 UTC) incremental, every January
(and on a manual run with `full`) the whole catalogue again, so revisions of older events reach the files once a year.
A run that fails the plausibility checks pushes nothing (run it again later, or with `accept_drop` after a review); a
manual run with `dry_run` builds and tests without committing or pushing.
The workflow pushes `stats/` to `main` itself with the default `GITHUB_TOKEN` (`contents: write`): `main`'s ruleset
forbids only deletion and non-fast-forward updates, and the repository does not let Actions open pull requests. No
other secret. GitHub pauses scheduled workflows of a public repository after 60 days without activity; the monthly
commit is that activity. `.github/workflows/stats-ci.yml` runs `npm run test:stats` on every change to the pipeline or
the files.

**Verification** (2026-10-06, cutoff 2026-10-06 00:00 UTC, `npm run stats:verify`): the whole download equals ComCat's
own count (306,470 events), and inside each sample country's box the download equals ComCat's `/count` (Indonesia: one
event revised into the box between the download and the count). The published total is the events inside the outline
plus the offshore events within 4.5°; the last column shows what a tighter 1.8° (about 200 km) cap would keep offshore.

| Country | ComCat /count in its box | Downloaded in the box | Published total | inside the outline | offshore ≤ 4.5° | of the total, in the box | offshore ≤ 1.8° (comparison) |
|---|---:|---:|---:|---:|---:|---:|---:|
| Japan (JPN) | 29168 | 29168 | 25769 | 2640 | 23129 | 24302 | 21032 |
| Indonesia (IDN) | 41059 | 41058 | 41650 | 7213 | 34437 | 39544 | 33030 |
| Chile (CHL) | 15004 | 15004 | 10396 | 4875 | 5521 | 9859 | 4987 |
| Turkey (TUR) | 2073 | 2073 | 1685 | 1430 | 255 | 1653 | 255 |
| Italy (ITA) | 825 | 825 | 607 | 395 | 212 | 597 | 211 |
| Iceland (ISL) | 582 | 582 | 797 | 486 | 311 | 582 | 189 |
| Afghanistan (AFG), landlocked | 4357 | 4357 | 2508 | 2508 | 0 | 2508 | 0 |
| Vanuatu (VUT), island state | 7146 | 7146 | 9161 | 406 | 8755 | 7058 | 8625 |

A box is a rectangle: Japan's takes in the Kurils (4,736 events assigned to Russia) and a few of Korea's and China's,
Chile's the Argentine and Bolivian Andes and open ocean, Afghanistan's the Hindu Kush of Pakistan and Tajikistan, so
the published total is lower; Iceland's and Vanuatu's totals are higher because the ridge and trench events beyond
their boxes count for them offshore. Earthquakes before the 1960s are the
large ones only (ComCat's early years come from the ISC-GEM catalogue), so the histogram's first decades are sparse.
