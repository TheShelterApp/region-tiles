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
