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
export const GLOBE_BAND_PT = 24; // B_globe = min(GLOBE_BAND_MAX_KM, max(BAND_KM, 24 pt x metres per point))
export const GLOBE_BAND_MAX_KM = 100; // the zoom-scaled band's cap (a zoomed-out globe is about 36 km per point)
export const COUNTRY_REACH_KM = 500; // RegionGeometry.offshoreMaxDistanceSq
export const GAP_KM = 50; // a coastal gap of the marine partition: the nearest water polygon within 50 km
export const TOWN_REACH_KM = 50; // rule E candidates
export const ZONE_TIE_KM = 1; // in the band, a zone within 1 km of its own administering country's distance names the water
export const NATIONAL_BAND_KM = 3; // over a national sea (Q7) the band shrinks to the simplified outlines' error at a coast
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

/**
 * The point as the app looks it up: the latitude clamped to [-90, 90], a longitude outside [-180, 180) wrapped into it
 * (180 is -180: the polygons that end at the antimeridian start again at -180). A longitude already in range is used as
 * it is, bit for bit.
 */
export function normalisePoint(lat, lon) {
  let x = lon;
  if (!(x >= -180 && x < 180)) {
    x = (x + 180) % 360;
    if (x < 0) x += 360;
    x -= 180;
  }
  return [Math.min(90, Math.max(-90, lat)), x];
}

/**
 * The short form of the name a row is shown with: English for an English title; for a Russian title its own Russian
 * short form, or the English one when the title fell back to the Latin name (no `name_ru`). Countries are named by the
 * app in both languages, so a Russian country title takes only `short_ru`.
 */
export function shortForm(row, ru, namedByApp = false) {
  if (!ru) return row.short_en || null;
  return row.short_ru || (namedByApp || row.name_ru ? null : row.short_en || null);
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

  /**
   * Land: a country, province, zone or assignment polygon holds the point. Its country: an assignment area's (a curated
   * reassignment of a coarse outline: East Jerusalem and the West Bank to Palestine, the rest of the Jerusalem district
   * to Israel), else the one country the country and province layers agree on, else (they disagree, or two country
   * outlines overlap: both are simplified, so they part by a few km at borders) the country of the town rule E names
   * among the candidates' towns, else the province's, else the smallest key.
   */
  land(lat, lon) {
    const countries = this.ix.countries.containing(lat, lon);
    const province = this.ix.provinces.containing(lat, lon)[0] || null;
    const zone = this.ix.zones.containing(lat, lon)[0] || null;
    const assignment = this.assignmentAt(lat, lon);
    const country = (assignment && this.ix.countryByIso3.get(assignment.iso3)) || this.countryOf(lat, lon, countries, province);
    return { country, province, zone, assignment, isLand: !!(countries.length || province || zone || assignment) };
  }

  /** The assignment area holding the point: the smallest `rank` first, then the smaller key. */
  assignmentAt(lat, lon) {
    return this.ix.assignments.containing(lat, lon).sort((a, b) => a.rank - b.rank || (a.key < b.key ? -1 : 1))[0] || null;
  }

  countryOf(lat, lon, countries, province) {
    const candidates = [];
    for (const c of countries) if (!candidates.includes(c.iso3)) candidates.push(c.iso3);
    const provinceCountry = province && this.ix.countryByIso3.has(province.iso3) ? province.iso3 : null;
    if (provinceCountry && !candidates.includes(provinceCountry)) candidates.push(provinceCountry);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return this.ix.countryByIso3.get(candidates[0]);
    if (this.ix.towns) {
      const set = new Set(candidates);
      const t = this.ruleETown(lat, lon, (town) => set.has(town.adm0) || set.has(town.adm0_alt));
      if (t) return this.ix.countryByIso3.get(set.has(t.adm0) ? t.adm0 : t.adm0_alt);
    }
    if (provinceCountry) return this.ix.countryByIso3.get(provinceCountry);
    return countries[0];
  }

  /**
   * The nearest country land within km, without zones: a country outline, or (with `detail`) a province outline mapped
   * to its country, which is nearer where the simplified country outline cuts a coast off (Taman). Ties: the country
   * outline.
   */
  nearestCountry(lat, lon, km) {
    const c = this.ix.countries.nearest(lat, lon, km);
    const p = this.ix.provinces.nearest(lat, lon, km, (a) => this.ix.countryByIso3.has(a.iso3));
    if (p && (!c || p.km < c.km)) return { country: this.ix.countryByIso3.get(p.area.iso3), km: p.km };
    return c ? { country: c.area, km: c.km } : null;
  }

  /**
   * The nearest land within km. A zone wins over the nearest country when it is nearer, or, against one of its own
   * administering countries (`admin`: their outlines coincide along a coast), within ZONE_TIE_KM of it. The nearest
   * country comes along (the city tier's bay town is of that country).
   */
  nearestLand(lat, lon, km) {
    const land = this.nearestCountry(lat, lon, km);
    const z = this.ix.zones.nearest(lat, lon, km);
    if (z) {
      const own = land && z.area.admins.has(land.country.iso3);
      if (!land || (own ? z.km <= land.km + ZONE_TIE_KM : z.km < land.km)) return { zone: z.area, country: land?.country || null, km: z.km };
    }
    return land ? { zone: null, country: land.country, km: land.km } : null;
  }

  /**
   * A water where the 22 km band does not apply (owner decision Q7): a national sea such as Marmara shows its own name.
   * Only NATIONAL_BAND_KM keeps the coast's country, so a coastal point the simplified outlines leave in the water
   * (Kadikoy, 0.3 km off Turkey's outline) is still the country.
   */
  isNational(w) {
    return !!(w && !w.gap && w.water.national);
  }

  /** Parent hops from a water to the top of its chain (an ocean: 0). */
  depth(w) {
    let d = 0;
    for (let cur = w; cur?.parent && d < 32; d++) cur = this.ix.byKey.get(cur.parent);
    return d;
  }

  /** A water as it is shown: its `whole` row; a row without a name (check 5 allows none) takes its parent's. */
  shownWater(w) {
    let s = w.whole ? this.ix.byKey.get(w.whole) : w;
    for (let hops = 0; !s.name_en && s.parent && hops < 16; hops++) {
      const p = this.ix.byKey.get(s.parent);
      if (!p) break;
      s = p.whole ? this.ix.byKey.get(p.whole) : p;
    }
    return s;
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
    return { key: s.key, level, name, shortName: shortForm(s, ru, level === 'country'), step };
  }

  answerWorld(world, step) {
    return { key: `region:${world}`, level: 'partOfWorld', name: WORLD_EN[world] || world, shortName: null, step };
  }

  answerTown(t, step, language) {
    const shown = this.ix.towns.byId.get(t.metro) || t;
    const ru = language === 'ru';
    return {
      key: `place:${shown.id}`, level: 'place', name: ru ? shown.name_ru || shown.name_en : shown.name_en,
      shortName: shortForm(shown, ru), step, viaTown: t.id,
    };
  }

  /** Rule E over the towns `accept` takes: the smallest d / R(pop), d <= 50 km; ties: the smaller id. */
  ruleETown(lat, lon, accept) {
    let best = null;
    let bestScore = Infinity;
    for (const { town, km } of this.ix.towns.within(lat, lon, TOWN_REACH_KM)) {
      if (!accept(town)) continue;
      const score = km / townRadiusKm(town.pop);
      if (score < bestScore || (score === bestScore && best && town.id < best.id)) {
        bestScore = score;
        best = town;
      }
    }
    return best;
  }

  /** Rule E: the town of one of `iso3s` (its own country or its outline's, `adm0_alt`). */
  ruleE(lat, lon, iso3s) {
    return this.ruleETown(lat, lon, (t) => iso3s.has(t.adm0) || iso3s.has(t.adm0_alt));
  }

  /** A city's bay: a town within its urban reach U(pop) of the point, of the band's country. */
  bayTown(lat, lon, iso3) {
    let best = null;
    let bestScore = Infinity;
    for (const { town, km } of this.ix.towns.within(lat, lon, 20)) {
      if ((town.adm0 !== iso3 && town.adm0_alt !== iso3) || km > urbanReachKm(town.pop)) continue;
      const score = km / townRadiusKm(town.pop);
      if (score < bestScore || (score === bestScore && best && town.id < best.id)) {
        bestScore = score;
        best = town;
      }
    }
    return best;
  }

  // ---- the chain --------------------------------------------------------------------------------------------------------

  resolve({ lat: rawLat, lon: rawLon, tier, language = 'en', mpp = null }) {
    if (tier === 'city' && !this.ix.detail) return null; // the city tier needs both parts
    if (!Number.isFinite(rawLat) || !Number.isFinite(rawLon)) return null;
    const [lat, lon] = normalisePoint(rawLat, rawLon);
    const L = this.land(lat, lon);
    if (tier === 'globe') return this.globe(lat, lon, L, mpp ?? DEFAULT_GLOBE_MPP, language);
    if (tier === 'regional') return this.regional(lat, lon, L, language);
    return this.city(lat, lon, L, language);
  }

  globe(lat, lon, L, mpp, language) {
    if (L.isLand) {
      if (L.zone) return this.answerWorld(L.zone.world, STEP.globeLand);
      const c = L.country || this.nearestCountry(lat, lon, BAND_KM)?.country;
      if (c) return this.answerWorld(worldOf(c, lat, lon), STEP.globeLand);
    }
    // Inside a water named at the globe tier (an ocean, a major sea) only the 22 km band applies; elsewhere (Marmara,
    // a bay) the band grows with the zoom, capped, so a small enclosed sea reads as its land's part of the world. A scale
    // that is not a positive number (the app never sends one) leaves the plain band, as PlaceChain does.
    const w = this.water(lat, lon);
    const inGlobeRow = !!(w && !w.gap && this.shownWater(w.water).globe);
    const scaled = Number.isFinite(mpp) && mpp > 0 ? (GLOBE_BAND_PT * mpp) / 1000 : 0;
    const band = inGlobeRow ? BAND_KM : Math.min(GLOBE_BAND_MAX_KM, Math.max(BAND_KM, scaled));
    const near = this.nearestLand(lat, lon, band);
    if (near) return this.answerWorld(near.zone ? near.zone.world : worldOf(near.country, lat, lon), STEP.globeBand);
    if (w) return this.answerArea(this.globeWater(w.water), 'water', w.gap ? STEP.globeGap : STEP.globeWater, language);
    const c = this.nearestCountryAnywhere(lat, lon, false);
    return c ? this.answerWorld(worldOf(c, lat, lon), STEP.globeNearest) : null;
  }

  regional(lat, lon, L, language, fromCity = false) {
    let w;
    if (!fromCity) {
      if (L.zone) return this.answerArea(L.zone, 'zone', STEP.regionalLand, language);
      if (L.country) return this.answerArea(L.country, 'country', STEP.regionalLand, language);
      w = this.water(lat, lon);
      const near = this.nearestLand(lat, lon, this.isNational(w) ? NATIONAL_BAND_KM : BAND_KM);
      if (near) {
        return near.zone ? this.answerArea(near.zone, 'zone', STEP.regionalBand, language)
          : this.answerArea(near.country, 'country', STEP.regionalBand, language);
      }
    } else {
      w = this.water(lat, lon);
    }
    if (w) return this.answerArea(w.water, 'water', w.gap ? STEP.regionalGap : STEP.regionalWater, language);
    const iso = this.ix.countries.nearest(lat, lon, COUNTRY_REACH_KM, (a) => !!a.iso2);
    if (iso) return this.answerArea(iso.area, 'country', STEP.regionalNearestCountry, language);
    const c = this.nearestCountryAnywhere(lat, lon, false);
    return c ? this.answerWorld(worldOf(c, lat, lon), STEP.regionalPartOfWorld) : null;
  }

  city(lat, lon, L, language) {
    if (L.isLand) {
      // Rule E's towns: of the land's country; on land only a zone outline holds (Kunashir), of the zone's
      // administering countries; else of the country within the band.
      let iso3s = null;
      if (L.country) iso3s = new Set([L.country.iso3]);
      else if (L.zone && L.zone.admins.size) iso3s = L.zone.admins;
      else {
        const c = this.nearestCountry(lat, lon, BAND_KM)?.country;
        if (c) iso3s = new Set([c.iso3]);
      }
      if (iso3s) {
        const t = this.ruleE(lat, lon, iso3s);
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
      // A national sea (Q7) keeps its own name past a city's bay, beyond the outlines' error at its coast.
      if (near.km <= NATIONAL_BAND_KM || !this.isNational(this.water(lat, lon))) {
        return near.zone ? this.answerArea(near.zone, 'zone', STEP.cityBand, language)
          : this.answerArea(near.country, 'country', STEP.cityBand, language);
      }
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
