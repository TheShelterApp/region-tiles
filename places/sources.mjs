// The upstream inputs of the place-names pack, pinned by size and sha256. stage.mjs refuses any file that differs,
// and copies this list into places/sources.lock.json and the sources archive's SOURCES.json.
//
// To refresh a source: download the new file into a new empty directory (README, "Sources"), put its URL, version,
// date, size and sha256 here, run stage.mjs with a new --date, and review the diff of the curation reports.

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector';
// Natural Earth 5.2.0's marine remaster (#735) exists only as a shapefile: the repository's geojson/ copy of the layer
// was last regenerated for 5.1.0. Both NE layers below are read at that commit.
const NE_52 = '204b50046f908df927a31aa52b6d3e32f79b9709';
// Natural Earth 5.1.2 (tag v5.1.2): the admin-1 edition the regions bundle bundle-v1 was built from (the attribute
// table equals region-tiles' src-data/ne_admin1.json field for field, in the same row order).
const NE_512 = 'f1890d9f152c896d250a77557a5751a93d494776';
const GN = 'https://download.geonames.org/export/dump';

const shapefile = (dir, stem, commit, sizes) => Object.entries(sizes).map(([ext, [size, sha256]]) => ({
  path: `${dir}/${stem}.${ext}`,
  url: `${NE}/${commit}/${dir}/${stem}.${ext}`,
  size,
  sha256,
}));

export const SOURCES = {
  upstream: [
    {
      id: 'ne_marine',
      name: 'Natural Earth 10m geography_marine_polys',
      version: '5.2.0 (nvkelso/natural-earth-vector commit 204b500, "#735 marine area remastering", 2022-06-02)',
      licence: 'public domain',
      retrieved: '2026-10-17',
      files: shapefile('10m_physical', 'ne_10m_geography_marine_polys', NE_52, {
        shp: [973288, '1e13163173508efce208992df42c69b62ad0e16594257f14509d29188ea6439a'],
        shx: [2788, 'b5ea76c66b7b3876791284a8a84749e954d188374ba20ef9e5998ad8a286c0dd'],
        dbf: [2324386, '018b5009a9680eaa981829c63c305c965d707bb1fa3ccb2523e31c0f4713b4a4'],
        prj: [145, 'a02a27b1d1982c8516d83398e85a3c8b1aef1713c13ef4d84d7bde17430c07c4'],
        cpg: [5, '3ad3031f5503a4404af825262ee8232cc04d4ea6683d42c5dd0a2f2a27ac9824'],
      }),
    },
    {
      id: 'ne_disputed',
      name: 'Natural Earth 10m admin_0_disputed_areas',
      version: 'nvkelso/natural-earth-vector commit 204b500 (5.2.0)',
      licence: 'public domain',
      retrieved: '2026-10-17',
      files: shapefile('10m_cultural', 'ne_10m_admin_0_disputed_areas', NE_52, {
        shp: [243156, '5c44088c26c93e5317a7ca3be83c6cffc4d53370a7199f070df3c42cf6f7add5'],
        shx: [892, '3d928545d18ff6b44f51b2262f0ebdb260c372f5123fad1184ae40ebcbc7474a'],
        dbf: [326368, '6847e4f8da4f595409e0fa09f44c08b3c5141b9fba7af8c3ff0f91e57adcdf46'],
        prj: [145, 'a02a27b1d1982c8516d83398e85a3c8b1aef1713c13ef4d84d7bde17430c07c4'],
        cpg: [5, '3ad3031f5503a4404af825262ee8232cc04d4ea6683d42c5dd0a2f2a27ac9824'],
      }),
    },
    {
      id: 'ne_admin1',
      name: 'Natural Earth 10m admin_1_states_provinces (attribute table)',
      version: '5.1.2 (tag v5.1.2, commit f1890d9)',
      licence: 'public domain',
      retrieved: '2026-10-17',
      files: shapefile('10m_cultural', 'ne_10m_admin_1_states_provinces', NE_512, {
        dbf: [15161514, '445a8a9bea889634faf0af18081830df0b05b8471fc6af8dc42aecdd7a71bba1'],
        cpg: [5, '3ad3031f5503a4404af825262ee8232cc04d4ea6683d42c5dd0a2f2a27ac9824'],
      }),
    },
    {
      id: 'geonames_cities',
      name: 'GeoNames cities1000 and cities5000',
      version: 'daily dump of 2026-10-17 (Last-Modified Sat, 17 Oct 2026 02:03:41 GMT)',
      licence: 'CC BY 4.0',
      retrieved: '2026-10-17',
      files: [
        { path: 'geonames/cities1000.zip', url: `${GN}/cities1000.zip`, size: 11066504, sha256: 'e422b498433420ef750b14b947acfb6b88850cb15f88646a07ee91822f1035ac' },
        { path: 'geonames/cities5000.zip', url: `${GN}/cities5000.zip`, size: 5713325, sha256: 'bcda513b9133d8e4d608a0dc4f46b1138236a5e50a961532cd387a5e82f55ee4' },
      ],
    },
    {
      id: 'geonames_alternate_names',
      name: 'GeoNames alternateNamesV2',
      version: 'daily dump of 2026-10-17 (Last-Modified Sat, 17 Oct 2026 02:09:09 GMT)',
      licence: 'CC BY 4.0',
      retrieved: '2026-10-17',
      files: [
        { path: 'geonames/alternateNamesV2.zip', url: `${GN}/alternateNamesV2.zip`, size: 204947092, sha256: '5dc235aba7adca5290dd4f98b28b1a3534e1dbe97f4c5732323bcac865d535d1' },
      ],
    },
  ],
  // The outlines of countries and provinces: the regions bundle's release asset, pinned by regions-db.json.
  regionsBundle: {
    version: '1.0.0',
    url: 'https://github.com/TheShelterApp/region-tiles/releases/download/bundle-v1/regions.sqlite.gz',
    size: 40337310,
    sha256: 'f14b777271b11d4b720547430d89e0e952576b5017502e99a817d8f757a6b18f',
  },
  // Wikidata labels are fetched once by places/wikidata.mjs and frozen in places/curation/wikidata-labels.tsv.
  wikidata: {
    name: 'Wikidata labels (ru, en)',
    licence: 'CC0',
    api: 'https://query.wikidata.org/sparql (P1566 GeoNames ID claims, rdfs:label ru and en)',
    frozen_in: 'places/curation/wikidata-labels.tsv',
  },
  attribution: 'Place names: GeoNames (https://www.geonames.org), CC BY 4.0, filtered, renamed and converted by The Shelter. Seas, oceans, countries and provinces: Natural Earth (public domain). Some names: Wikidata (CC0).',
};
