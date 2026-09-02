// Phase 4 — write version.json (contract §5/§7).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILD, VERSION_JSON, DATA_VERSION, ATTRIBUTION, SOURCE_INFO, CDN } from '../config.mjs';
import { writeJSON, log } from './lib/util.mjs';

const counts = JSON.parse(readFileSync(join(BUILD, 'counts.json'), 'utf8'));

// Honor SOURCE_DATE_EPOCH (reproducible-builds convention) so identical inputs
// yield a byte-identical version.json; default to now() for normal builds.
const epoch = process.env.SOURCE_DATE_EPOCH;
const generated = epoch
  ? new Date(Number(epoch) * 1000).toISOString()
  : new Date().toISOString();

const version = {
  version: DATA_VERSION,
  generated,
  attribution: ATTRIBUTION,
  source: SOURCE_INFO,
  counts: { adm0: counts.adm0, adm1: counts.adm1, adm2: counts.adm2 },
  lookup: {
    variant: 'country-keyed-bbox',
    // iOS: bbox-prefilter the index, fetch candidate geo files, point-in-polygon,
    // nearest-edge fallback for offshore points; fall back up adm2->adm1->adm0.
    index: {
      adm0: 'index/adm0.json',
      adm1: 'index/adm1/{ISO3}.json',
      adm2: 'index/adm2/{ISO3}.json',
    },
    geometry: {
      adm0: 'geo/adm0/{ISO3}.geojson',
      adm1: 'geo/adm1/{ISO3}/{id}.geojson',
      adm2: 'geo/adm2/{ISO3}/{id}.geojson',
    },
    indexEntry: '{ id, name, bbox: [minLng, minLat, maxLng, maxLat] }',
    shardRule: "ISO3 = id.split('.')[0]",
    idScheme: { adm0: 'CUB', adm1: 'CUB.7', adm2: 'CUB.7.3' },
    parentRule: "parent id = id.split('.').slice(0, -1).join('.')",
    algorithm:
      'resolveCountry: bbox-prefilter index/adm0.json -> PIP candidate geo/adm0/{ISO3}.geojson -> nearest-edge fallback. ' +
      'resolveRegion(level): resolveCountry, then bbox-prefilter index/adm{level}/{ISO3}.json -> PIP candidate geo -> nearest-edge fallback; ' +
      'if the level has no data for the country, fall back up (adm2->adm1->adm0).',
  },
  // Magnitude->level thresholds live on the iOS side (tunable); listed for reference.
  magnitudeLevelsReference: { adm2: 'M < 4.0', adm1: '4.0 <= M < 6.0', adm0: 'M >= 6.0' },
  cdn: {
    jsdelivr: CDN.jsdelivr,
    raw: CDN.raw,
    note: "Replace {ref} with a git tag (e.g. v1.0.0) to pin. Replace {ISO3}/{id} per the paths above.",
  },
};

writeJSON(VERSION_JSON, version, { pretty: true });
log(`version.json written (v${DATA_VERSION}, ADM0=${counts.adm0} ADM1=${counts.adm1} ADM2=${counts.adm2})`);
