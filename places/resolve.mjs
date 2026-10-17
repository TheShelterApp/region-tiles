// The reference resolver: the map header's title chain of the final architecture (section 5.6) over a built pack.
// verify.mjs runs the golden points and the lattice through it, and the iOS release gate compares the Swift chain
// (Projects/Dependencies/PlaceNames) with it answer for answer. Constants and steps are part of the pack's contract
// (README, "Lookups"); change them here and in the app together.
//
// usage (one point): node places/resolve.mjs <core.sqlite.gz> [<detail.sqlite.gz>] <lat> <lon> [globe|regional|city] [en|ru] [mpp]
import { fileURLToPath } from 'node:url';
import { openPart, PlaceIndex } from './lib/pack.mjs';
import { KM_PER_DEG } from './lib/geometry.mjs';

export const BAND_KM = 22; // 12 nautical miles: the owner's territorial-waters rule
export const GLOBE_BAND_PT = 24; // B_globe = max(BAND_KM, 24 pt x metres per point)
export const COUNTRY_REACH_KM = 500; // RegionGeometry.offshoreMaxDistanceSq
export const GAP_KM = 50; // a coastal gap of the marine partition: the nearest water polygon within 50 km
export const TOWN_REACH_KM = 50; // rule E candidates
export const ZONE_TIE_KM = 1; // in the band, a zone within 1 km of the nearest country's distance names the water
export const DEFAULT_GLOBE_MPP = 5000; // metres per point at the start of the globe tier (about 3,000 km camera distance)

/** Rule E's ranking radius R(pop) = clamp(10 km x (pop / 10,000)^0.25, 8 km, 30 km). */
export const townRadiusKm = (pop) => Math.min(30, Math.max(8, 10 * Math.pow(Math.max(pop, 1) / 1e4, 0.25)));
/** A city's urban reach over its own water U(pop) = min(20 km, 3 km x sqrt(pop / 100,000)). */
export const urbanReachKm = (pop) => Math.min(20, 3 * Math.sqrt(Math.max(pop, 0) / 1e5));

// Chain steps, as the DEBUG inspector numbers them: tier x 10 + step.
export const STEP = {
  globeLand: 11, globeBand: 12, globeWater: 13, globeGap: 14, globeNearest: 15,
  regionalLand: 21, regionalBand: 22, regionalWater: 23, regionalGap: 24, regionalNearestCountry: 25, regionalPartOfWorld: 26,
  cityTown: 31, cityProvince: 32, cityBay: 33, cityBand: 34,
};

/** WorldRegion.region(iso3:latitude:longitude:) of the app: the table plus the overseas coordinate rules. */
export function worldOf(country, lat, lon) {
  switch (country.iso3) {
    case 'RUS':
      if (lon >= 100 || lon < 0) return 'eastAsia';
      if (lon >= 60) return 'centralAsia';
      return 'easternEurope';
    case 'USA':
      if (lat < 30 && lon < -150) return 'oceania';
      break;
    case 'FRA':
      if (lon < -30) return lat < 10 ? 'southAmerica' : 'northAmerica';
      if (lat < 0 && lon > 30) return 'tropicalAfrica';
      break;
    case 'NLD':
      if (lon < -30) return 'northAmerica';
      break;
    case 'NOR':
      if (lat < -40) return 'antarctica';
      break;
    case 'ATF':
      if (lat > -30) return 'tropicalAfrica';
      break;
    case 'UMI':
      if (lon > -100 && lon < 0) return 'northAmerica';
      break;
    default:
      break;
  }
  return country.world;
}

const WORLD_EN = {
  northAmerica: 'North America', southAmerica: 'South America', northAfrica: 'North Africa', tropicalAfrica: 'Tropical Africa',
  antarctica: 'Antarctica', oceania: 'Oceania', westernEurope: 'Western Europe', easternEurope: 'Eastern Europe',
  centralAsia: 'Central Asia', eastAsia: 'East Asia', southAsia: 'South Asia', southEastAsia: 'South-East Asia', westernAsia: 'Western Asia',
};

export class Resolver {
  constructor(index) {
    this.ix = index;
  }

  static fromParts(corePath, detailPath = null) {
    return new Resolver(new PlaceIndex(openPart(corePath), detailPath ? openPart(detailPath) : null));
  }

  // ---- building blocks ------------------------------------------------------------------------------------------------

  /** Land: a country polygon or a province polygon (mapped to its country) or a zone polygon holds the point. */
  land(lat, lon) {
    const country = this.ix.countries.containing(lat, lon)[0] || null;
    const province = this.ix.provinces.containing(lat, lon)[0] || null;
    const zone = this.ix.zones.containing(lat, lon)[0] || null;
    const viaProvince = !country && province ? this.ix.countryByIso3.get(province.iso3) : null;
    return { country: country || viaProvince, province, zone, isLand: !!(country || province || zone) };
  }

  /** The nearest land within km: a zone when it is within ZONE_TIE_KM of the nearest country's distance. */
  nearestLand(lat, lon, km) {
    const c = this.ix.countries.nearest(lat, lon, km);
    const z = this.ix.zones.nearest(lat, lon, km);
    if (z && (!c || z.km <= c.km + ZONE_TIE_KM)) return { zone: z.area, country: c?.area || null, km: z.km };
    if (c) return { zone: null, country: c.area, km: c.km };
    return null;
  }

  /** Parent hops from a water to the top of its chain (an ocean: 0). */
  depth(w) {
    let d = 0;
    for (let cur = w; cur?.parent && d < 32; d++) cur = this.ix.byKey.get(cur.parent);
    return d;
  }

  shownWater(w) {
    return w.whole ? this.ix.byKey.get(w.whole) : w;
  }

  /**
   * The water polygon holding the point, else the nearest within GAP_KM (a coastal gap of the layer). Natural Earth 5.2
   * nests some features in their parent (the Sargasso Sea in the North Atlantic, the Strait of Dover in the English
   * Channel): the most specific one wins, the one with the most `parent` hops to the top of its chain (ties: the larger
   * `rank`, then the smaller key). verify.mjs check 3 proves that every nesting is along a parent chain.
   */
  water(lat, lon) {
    const w = this.ix.waters.containing(lat, lon).sort((a, b) => this.depth(b) - this.depth(a) || b.rank - a.rank || (a.key < b.key ? -1 : 1))[0];
    if (w) return { water: w, gap: false };
    const n = this.ix.waters.nearest(lat, lon, GAP_KM);
    return n ? { water: n.area, gap: true } : null;
  }

  /** Walk `parent` to the first water shown at the globe tier; else the top of the chain. */
  globeWater(w) {
    let cur = w;
    let top = w;
    for (let hops = 0; cur && hops < 16; hops++) {
      const s = this.shownWater(cur);
      if (s.globe) return s;
      top = cur;
      cur = cur.parent ? this.ix.byKey.get(cur.parent) : null;
    }
    return this.shownWater(top);
  }

  answerArea(a, level, step, language) {
    const s = level === 'water' ? this.shownWater(a) : a;
    const ru = language === 'ru';
    // Countries are named by the app (CountryName.geocoderStyle); the pack's English name is the bundle's.
    const name = level === 'country' ? (ru ? null : s.name_en) : ru ? s.name_ru || s.name_en : s.name_en;
    return { key: s.key, level, name, shortName: (ru ? s.short_ru : s.short_en) || null, step };
  }

  answerWorld(world, step) {
    return { key: `region:${world}`, level: 'partOfWorld', name: WORLD_EN[world] || world, shortName: null, step };
  }

  answerTown(t, step, language) {
    const shown = this.ix.towns.byId.get(t.metro) || t;
    const ru = language === 'ru';
    return {
      key: `place:${shown.id}`, level: 'place', name: ru ? shown.name_ru || shown.name_en : shown.name_en,
      shortName: (ru ? shown.short_ru : shown.short_en) || null, step, viaTown: t.id,
    };
  }

  /** Rule E: the town with the smallest d / R(pop), d <= 50 km, whose build-time country is `iso3`. Ties: smaller id. */
  ruleE(lat, lon, iso3) {
    let best = null;
    let bestScore = Infinity;
    for (const { town, km } of this.ix.towns.within(lat, lon, TOWN_REACH_KM)) {
      if (town.adm0 !== iso3) continue;
      const score = km / townRadiusKm(town.pop);
      if (score < bestScore || (score === bestScore && best && town.id < best.id)) {
        bestScore = score;
        best = town;
      }
    }
    return best;
  }

  /** A city's bay: a town within its urban reach U(pop) of the point, of the band's country. */
  bayTown(lat, lon, iso3) {
    let best = null;
    let bestScore = Infinity;
    for (const { town, km } of this.ix.towns.within(lat, lon, 20)) {
      if (town.adm0 !== iso3 || km > urbanReachKm(town.pop)) continue;
      const score = km / townRadiusKm(town.pop);
      if (score < bestScore || (score === bestScore && best && town.id < best.id)) {
        bestScore = score;
        best = town;
      }
    }
    return best;
  }

  // ---- the chain --------------------------------------------------------------------------------------------------------

  resolve({ lat, lon, tier, language = 'en', mpp = null }) {
    if (tier === 'city' && !this.ix.detail) return null; // the city tier needs both parts
    const L = this.land(lat, lon);
    if (tier === 'globe') return this.globe(lat, lon, L, mpp ?? DEFAULT_GLOBE_MPP, language);
    if (tier === 'regional') return this.regional(lat, lon, L, language);
    return this.city(lat, lon, L, language);
  }

  globe(lat, lon, L, mpp, language) {
    if (L.isLand) {
      if (L.zone) return this.answerWorld(L.zone.world, STEP.globeLand);
      const c = L.country || this.ix.countries.nearest(lat, lon, BAND_KM)?.area;
      if (c) return this.answerWorld(worldOf(c, lat, lon), STEP.globeLand);
    }
    const band = Math.max(BAND_KM, (GLOBE_BAND_PT * mpp) / 1000);
    const near = this.nearestLand(lat, lon, band);
    if (near) return this.answerWorld(near.zone ? near.zone.world : worldOf(near.country, lat, lon), STEP.globeBand);
    const w = this.water(lat, lon);
    if (w) return this.answerArea(this.globeWater(w.water), 'water', w.gap ? STEP.globeGap : STEP.globeWater, language);
    const c = this.nearestCountryAnywhere(lat, lon, false);
    return c ? this.answerWorld(worldOf(c, lat, lon), STEP.globeNearest) : null;
  }

  regional(lat, lon, L, language, fromCity = false) {
    if (!fromCity) {
      if (L.zone) return this.answerArea(L.zone, 'zone', STEP.regionalLand, language);
      if (L.country) return this.answerArea(L.country, 'country', STEP.regionalLand, language);
      const near = this.nearestLand(lat, lon, BAND_KM);
      if (near) {
        return near.zone ? this.answerArea(near.zone, 'zone', STEP.regionalBand, language)
          : this.answerArea(near.country, 'country', STEP.regionalBand, language);
      }
    }
    const w = this.water(lat, lon);
    if (w) return this.answerArea(w.water, 'water', w.gap ? STEP.regionalGap : STEP.regionalWater, language);
    const iso = this.ix.countries.nearest(lat, lon, COUNTRY_REACH_KM, (a) => !!a.iso2);
    if (iso) return this.answerArea(iso.area, 'country', STEP.regionalNearestCountry, language);
    const c = this.nearestCountryAnywhere(lat, lon, false);
    return c ? this.answerWorld(worldOf(c, lat, lon), STEP.regionalPartOfWorld) : null;
  }

  city(lat, lon, L, language) {
    if (L.isLand) {
      const country = L.country || this.ix.countries.nearest(lat, lon, BAND_KM)?.area || null;
      if (country) {
        const t = this.ruleE(lat, lon, country.iso3);
        if (t) return this.answerTown(t, STEP.cityTown, language);
      }
      // Inside a neutral zone the zone's name stands in for the administering country's province (final architecture
      // section 6: "the city tier shows towns as usual, with neutral province names").
      if (L.zone) return this.answerArea(L.zone, 'zone', STEP.cityProvince, language);
      if (L.province) return this.answerArea(L.province, 'province', STEP.cityProvince, language);
      return this.regional(lat, lon, L, language);
    }
    const near = this.nearestLand(lat, lon, BAND_KM);
    if (near) {
      const iso3 = near.country?.iso3;
      const t = iso3 ? this.bayTown(lat, lon, iso3) : null;
      if (t) return this.answerTown(t, STEP.cityBay, language);
      return near.zone ? this.answerArea(near.zone, 'zone', STEP.cityBand, language)
        : this.answerArea(near.country, 'country', STEP.cityBand, language);
    }
    return this.regional(lat, lon, L, language, true);
  }

  /** The nearest country at any distance (the last resort of the chains; it practically never fires). */
  nearestCountryAnywhere(lat, lon, isoOnly) {
    for (const km of [1000, 3000, 10000, 21000]) {
      const n = this.ix.countries.nearest(lat, lon, km, isoOnly ? (a) => !!a.iso2 : null);
      if (n) return n.area;
    }
    return null;
  }
}

export const KM_PER_DEGREE = KM_PER_DEG;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const a = process.argv.slice(2);
  const numeric = a.findIndex((v) => /^-?\d+(\.\d+)?$/.test(v));
  const parts = a.slice(0, numeric);
  const [lat, lon, tier = 'regional', language = 'en', mpp] = a.slice(numeric);
  const r = Resolver.fromParts(parts[0], parts[1] || null);
  for (const t of tier === 'all' ? ['globe', 'regional', 'city'] : [tier]) {
    console.log(t, JSON.stringify(r.resolve({ lat: Number(lat), lon: Number(lon), tier: t, language, mpp: mpp ? Number(mpp) : null })));
  }
}
