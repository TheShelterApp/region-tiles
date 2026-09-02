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
