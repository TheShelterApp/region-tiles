// Unit tests of the place-names pack pipeline: node --test places/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeGeometry, decodeGeometry, polygonContains, distanceKm, haversineKm, simplifyRing, cellOf, fromGeoJSON, quantise,
  bboxOf, countVertices, KM_PER_DEG,
} from '../lib/geometry.mjs';
import { clean, isRussian, isAllCaps, titleCase, cleanRomanisation, appleStyle, nameProblems, stripAdminSuffix, nameSimilarity } from '../lib/names.mjs';
import { gzipDeterministic, gunzipChecked, tarDeterministic, untar } from '../lib/io.mjs';
import { keepTown, isCities5000 } from '../lib/places.mjs';
import { writePart, pointerUrls, wikidataRussian, pickRussian } from '../build.mjs';
import { releaseProblems } from '../check-release.mjs';
import { openPart, PlaceIndex } from '../lib/pack.mjs';
import { Resolver, townRadiusKm, urbanReachKm, worldOf, normalisePoint, shortForm } from '../resolve.mjs';
import { diffLattices, parseAccepted, parseAcceptedParity, targetedPoints, pointsTsv, pointAnswers, latticeTsv, SAMPLE_KINDS } from '../lattice.mjs';

// ---- geometry -----------------------------------------------------------------------------------------------------------

test('the geometry codec round-trips polygons, holes and large deltas', () => {
  const polys = [
    [Int32Array.from([0, 0, 18000000, 0, 18000000, 9000000]), Int32Array.from([1, 1, 2, 1, 2, 2])],
    [Int32Array.from([-17999999, -8999999, -17999990, -8999999, -17999990, -8999990])],
  ];
  const blob = encodeGeometry(polys);
  const back = decodeGeometry(blob);
  assert.equal(back.length, 2);
  assert.deepEqual([...back[0][0]], [...polys[0][0]]);
  assert.deepEqual([...back[0][1]], [...polys[0][1]]);
  assert.deepEqual([...back[1][0]], [...polys[1][0]]);
  assert.ok(encodeGeometry(back).equals(blob));
});

test('the geometry decoder refuses truncated and overlong blobs', () => {
  const blob = encodeGeometry([[Int32Array.from([0, 0, 10, 0, 10, 10])]]);
  assert.throws(() => decodeGeometry(blob.subarray(0, blob.length - 1)), /truncated/);
  assert.throws(() => decodeGeometry(Buffer.concat([blob, Buffer.from([0])])), /trailing/);
});

test('point in polygon is even-odd over all rings, in quantised units', () => {
  const q = 10000;
  const square = quantise(fromGeoJSON({ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] }), q)[0];
  assert.equal(polygonContains(square, 2 * q, 2 * q), true);
  assert.equal(polygonContains(square, 5 * q, 5 * q), false); // in the hole
  assert.equal(polygonContains(square, 11 * q, 5 * q), false);
});

test('distance to an outline is point to segment, not to the nearest vertex', () => {
  const q = 10000;
  // A long straight coast along the equator from 0 to 10 deg east: a point 0.1 deg north of its middle is 11.1 km away,
  // though the nearest vertex is 5 deg away.
  const polys = quantise(fromGeoJSON({ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, -1], [0, -1], [0, 0]]] }), q);
  const d = distanceKm(polys, polys.map((p) => bboxOf([p], q)), q, 5, 0.1, 50);
  assert.ok(Math.abs(d - 0.1 * KM_PER_DEG) < 0.01, `${d}`);
  assert.equal(distanceKm(polys, polys.map((p) => bboxOf([p], q)), q, 5, 2, 50), Infinity);
});

test('distance works across the antimeridian', () => {
  const q = 10000;
  const polys = quantise(fromGeoJSON({ type: 'Polygon', coordinates: [[[179.5, -1], [180, -1], [180, 1], [179.5, 1], [179.5, -1]]] }), q);
  const d = distanceKm(polys, polys.map((p) => bboxOf([p], q)), q, -179.9, 0, 50);
  assert.ok(Math.abs(d - 0.1 * KM_PER_DEG) < 0.05, `${d}`);
});

test('haversine, cells and Douglas-Peucker', () => {
  assert.ok(Math.abs(haversineKm(0, 0, 0, 1) - KM_PER_DEG) < 1e-6);
  assert.equal(cellOf(-90, -180), 0);
  assert.equal(cellOf(89.99, 179.99), 179 * 360 + 359);
  assert.equal(cellOf(90, 180), 179 * 360 + 359);
  const ring = Float64Array.from([0, 0, 1, 0.001, 2, 0, 2, 2, 0, 2]);
  assert.equal(simplifyRing(ring, 0.01).length / 2, 4);
  assert.equal(countVertices([[Int32Array.from([0, 0, 1, 1, 2, 2])]]), 3);
});

// ---- names ------------------------------------------------------------------------------------------------------------

test('name hygiene', () => {
  assert.equal(clean('  \u0429\u0435\u0446\u0438\u0301\u043D\u0441\u043A\u0438\u0439   \u0437\u0430\u043B\u0438\u0301\u0432 '), '\u0429\u0435\u0446\u0438\u043D\u0441\u043A\u0438\u0439 \u0437\u0430\u043B\u0438\u0432');
  assert.equal(clean('Bah\u00EDa Blanca'), 'Bah\u00EDa Blanca'); // a Latin accent is not a stress mark
  assert.equal(isRussian('\u0411\u0430\u043B\u0442\u0438\u0439\u0441\u043A\u043E\u0435 \u043C\u043E\u0440\u0435'), true);
  assert.equal(isRussian('\u0411\u043E\u0442\u043D\u0456\u0447\u043D\u0435 \u043C\u043E\u0440\u0435'), false); // Ukrainian i
  assert.equal(isRussian('Balt\u0438'), false);
  assert.equal(isAllCaps('INDIAN OCEAN'), true);
  assert.equal(isAllCaps('USA'), false);
  assert.equal(titleCase('NORTH PACIFIC OCEAN'), 'North Pacific Ocean');
  assert.equal(cleanRomanisation("Mil'kovo", 'RU'), 'Milkovo');
  assert.equal(cleanRomanisation('Ust\u2019-Kut', 'RU'), 'Ust-Kut');
  assert.equal(cleanRomanisation("O'Higgins", 'CL'), "O'Higgins");
  assert.equal(cleanRomanisation("Ma'ale Adumim", 'PS'), "Ma'ale Adumim");
  assert.equal(appleStyle('Hachi\u014Dji', 'JP'), 'Hachioji');
  assert.equal(appleStyle('Pazarc\u0131k', 'TR'), 'Pazarc\u0131k');
  assert.deepEqual(nameProblems('North  Sea', { language: 'en' }), ['double-space']);
  assert.deepEqual(nameProblems('\u041C\u043E\u0440\u0435', { language: 'en' }), ['cyrillic-in-en']);
  assert.deepEqual(nameProblems('Sea', { language: 'ru' }), ['not-russian']);
});

test('town rules: the cities5000 set and the dropped feature codes', () => {
  assert.equal(isCities5000(5001, 'PPL'), true);
  assert.equal(isCities5000(5000, 'PPL'), false);
  assert.equal(isCities5000(100, 'PPLA'), true);
  assert.equal(isCities5000(100, 'PPLG'), true);
  assert.equal(keepTown(1e6, 'PPLH', 5000), false);
  assert.equal(keepTown(1500, 'PPL', 1000), true);
  assert.equal(keepTown(1500, 'PPL', 5000), false);
});

// ---- files ------------------------------------------------------------------------------------------------------------

test('the gzip writer is deterministic and passes the app checks', () => {
  const data = Buffer.from('SQLite format 3\u0000'.repeat(100));
  const a = gzipDeterministic(data);
  assert.ok(a.equals(gzipDeterministic(data)));
  assert.deepEqual([...a.subarray(0, 10)], [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 3]);
  assert.ok(gunzipChecked(a).equals(data));
  const bad = Buffer.from(a);
  bad.writeUInt32LE(1, bad.length - 4);
  assert.throws(() => gunzipChecked(bad), /ISIZE|CRC/);
});

test('the tar writer round-trips and is deterministic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'places-tar-'));
  try {
    mkdirSync(join(dir, 'in', 'a'), { recursive: true });
    writeFileSync(join(dir, 'in', 'a', 'x.txt'), 'hello');
    writeFileSync(join(dir, 'in', 'b.bin'), Buffer.alloc(700, 7));
    const t1 = tarDeterministic(join(dir, 'in'), ['a/x.txt', 'b.bin'], 'p', 1760659200);
    const t2 = tarDeterministic(join(dir, 'in'), ['a/x.txt', 'b.bin'], 'p', 1760659200);
    assert.ok(t1.equals(t2));
    assert.deepEqual(untar(t1, join(dir, 'out')), ['p/a/x.txt', 'p/b.bin']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the resolver over a synthetic pack ---------------------------------------------------------------------------------
// Two countries on the equator (A west of 0, B east of 0, ISO-recognised), a province of A, a zone inside B, a sea
// between them in the north, the two halves of an ocean, and towns.

const Q5 = 100000;
const Q4 = 10000;
function rect(x0, y0, x1, y1, q) {
  return quantise([[Float64Array.from([x0, y0, x1, y0, x1, y1, x0, y1])]], q);
}
function area(fields) {
  const polys = fields.polys;
  const b = bboxOf(polys, fields.q);
  return {
    iso3: null, iso2: null, world: null, parent: null, whole: null, globe: 0, kind: null, rank: null, code: null, iso_3166_2: null,
    name_ru: null, short_en: null, short_ru: null, ...fields, polys: undefined,
    min_lng: b[0], min_lat: b[1], max_lng: b[2], max_lat: b[3], vertices: countVertices(polys), geometry: encodeGeometry(polys),
  };
}

function syntheticPack() {
  const dir = mkdtempSync(join(tmpdir(), 'places-pack-'));
  const core = [
    area({ layer: 0, key: 'adm0:AAA', iso3: 'AAA', iso2: 'AA', world: 'westernEurope', name_en: 'Aland', q: Q5, polys: rect(-10, -5, -1, 5, Q5) }),
    area({ layer: 0, key: 'adm0:BBB', iso3: 'BBB', iso2: 'BB', world: 'easternEurope', name_en: 'Bland', q: Q5, polys: rect(1, -5, 10, 5, Q5) }),
    area({ layer: 0, key: 'adm0:RUS', iso3: 'RUS', iso2: 'RU', world: 'easternEurope', name_en: 'Russia', q: Q5, polys: rect(120, 50, 130, 60, Q5) }),
    area({ layer: 2, key: 'sea:1', kind: 'sea', rank: 3, name_en: 'Strait Sea', name_ru: '\u041F\u0440\u043E\u043B\u0438\u0432\u043D\u043E\u0435 \u043C\u043E\u0440\u0435', parent: 'sea:10', q: Q4, polys: rect(-1, -5, 1, 5, Q4) }),
    area({ layer: 2, key: 'sea:10', kind: 'ocean', rank: 0, globe: 1, name_en: 'Big Ocean', name_ru: '\u0411\u043E\u043B\u044C\u0448\u043E\u0439 \u043E\u043A\u0435\u0430\u043D', q: Q4, polys: rect(-30, 5, 30, 40, Q4) }),
    area({ layer: 2, key: 'sea:11', kind: 'ocean', rank: 0, whole: 'sea:10', name_en: 'South Big Ocean', name_ru: '\u042E\u0436\u043D\u044B\u0439 \u043E\u043A\u0435\u0430\u043D', q: Q4, polys: rect(-30, -40, 30, -5, Q4) }),
    area({ layer: 3, key: 'zone:z', world: 'westernAsia', kind: 'area', name_en: 'Zone', name_ru: '\u0417\u043E\u043D\u0430', q: Q4, polys: rect(8, 3, 10, 5, Q4) }),
  ];
  const detail = [
    area({ layer: 1, key: 'adm1:AAA.1', iso3: 'AAA', parent: 'adm0:AAA', name_en: 'West Province', name_ru: '\u0417\u0430\u043F\u0430\u0434', q: Q4, polys: rect(-10, -5, -1, 5, Q4) }),
    // A province reaching past its country's outline (the bundle's Sevastopol case).
    area({ layer: 1, key: 'adm1:BBB.1', iso3: 'BBB', parent: 'adm0:BBB', name_en: 'East Province', q: Q4, polys: rect(1, -5, 10.5, 5, Q4) }),
  ];
  const town = (id, lat, lon, pop, adm0, metro = id, nameRu = null) => ({ id, lat: Math.round(lat * Q4), lon: Math.round(lon * Q4), pop, adm0, adm1: null, adm0_alt: null, metro, name_en: `T${id}`, name_ru: nameRu, short_en: null, short_ru: null });
  const towns = [
    town(1, 0, -5, 1000000, 'AAA', 1, '\u0413\u043E\u0440\u043E\u0434'),
    town(2, 0, -4.8, 20000, 'AAA', 1), // a section of town 1: shown as town 1
    town(3, 0, -2, 5000, 'AAA'),
    town(4, 0, 2, 50000, 'BBB'), // across the border from town 3
    town(5, 0, -1.02, 400000, 'AAA'), // a port at the strait: its bay reaches U(400k) = 6 km
  ];
  const meta = { version: '0.0.1', generated: '2026-10-17T00:00:00Z', attribution: 'test' };
  writePart(join(dir, 'core.sqlite'), 'core', core, null, meta);
  writePart(join(dir, 'detail.sqlite'), 'detail', detail, towns, { ...meta, min_population: '5000' });
  const c = openPart(join(dir, 'core.sqlite.gz'));
  const d = openPart(join(dir, 'detail.sqlite.gz'));
  rmSync(dir, { recursive: true, force: true });
  return { full: new Resolver(new PlaceIndex(c, d)), coreOnly: new Resolver(new PlaceIndex(c, null)), c, d };
}

test('a written part has the schema-1 meta and counts', () => {
  const { c, d } = syntheticPack();
  assert.equal(c.meta.schema, '1');
  assert.equal(c.meta.part, 'core');
  assert.equal(d.meta.part, 'detail');
  assert.equal(c.meta.count_waters, '3');
  assert.equal(d.meta.count_places, '5');
  assert.equal(c.places, null);
});

test('regional chain: land, zone, band, water, whole', () => {
  const { full } = syntheticPack();
  const r = (lat, lon) => full.resolve({ lat, lon, tier: 'regional' });
  assert.equal(r(0, -5).key, 'adm0:AAA');
  assert.equal(r(4, 9).key, 'zone:z');
  assert.equal(r(0, -0.9).key, 'adm0:AAA'); // 11 km off A's coast: the band
  assert.equal(r(0, 0).key, 'sea:1'); // 111 km from both coasts
  assert.equal(r(20, 0).key, 'sea:10');
  assert.equal(r(-20, 0).key, 'sea:10'); // the south half is shown as the whole ocean
  assert.equal(full.resolve({ lat: -20, lon: 0, tier: 'regional', language: 'ru' }).name, '\u0411\u043E\u043B\u044C\u0448\u043E\u0439 \u043E\u043A\u0435\u0430\u043D');
});

test('globe chain: part of the world, the zoom-scaled band, the globe ancestor', () => {
  const { full } = syntheticPack();
  const g = (lat, lon, mpp) => full.resolve({ lat, lon, tier: 'globe', mpp });
  assert.equal(g(0, -5).key, 'region:westernEurope');
  assert.equal(g(4, 9).key, 'region:westernAsia'); // the zone's explicit part of the world
  assert.equal(g(0, -0.5, 100).key, 'sea:10'); // 55 km from land, band 22 km: the strait's globe ancestor
  assert.equal(g(0, -0.5, 5000).key, 'region:westernEurope'); // the strait is no globe water: band 100 km (120 capped)
  assert.equal(g(0, 0, 5000).key, 'sea:10'); // 111 km from both coasts: beyond the capped band
  assert.equal(g(5.5, -5, 5000).key, 'sea:10'); // inside the globe ocean, 55 km off: only the 22 km band applies
  assert.equal(g(5.1, -5, 5000).key, 'region:westernEurope'); // 11 km off: the band
  assert.equal(g(55, 125).key, 'region:eastAsia'); // WorldRegion's coordinate rule for Russia
});

test('city chain: rule E, metro, province, bay, core-only', () => {
  const { full, coreOnly } = syntheticPack();
  const c = (lat, lon) => full.resolve({ lat, lon, tier: 'city' });
  assert.equal(c(0, -4.8).key, 'place:1'); // the section is shown as its city
  assert.equal(c(0, -4.8).viaTown, 2); // the section itself wins by d / R (its own population), shown as town 1
  assert.equal(c(0.02, -2).key, 'place:3');
  assert.equal(c(0, -1.3).key, 'place:5');
  assert.equal(c(0, 1.8).key, 'place:4'); // country B: town 3 (in A) does not count
  assert.equal(c(-4.9, 10.2).key, 'adm1:BBB.1'); // land only by the province outline, no town within 50 km
  assert.equal(c(0, -0.98).key, 'place:5'); // water 2 km off the port: its bay
  assert.equal(c(0, -0.9).key, 'adm0:AAA'); // water 11 km off: the band, the port's bay ends at 6 km
  assert.equal(coreOnly.resolve({ lat: 0, lon: -5, tier: 'city' }), null);
  assert.equal(full.resolve({ lat: 0, lon: -5, tier: 'city', language: 'ru' }).name, '\u0413\u043E\u0440\u043E\u0434');
  assert.equal(full.resolve({ lat: 0, lon: -2, tier: 'city', language: 'ru' }).name, 'T3'); // no Russian name: the Latin one
});

test('rule E and bay radii', () => {
  assert.equal(townRadiusKm(10000), 10);
  assert.equal(townRadiusKm(100), 8);
  assert.equal(townRadiusKm(1e8), 30);
  assert.equal(urbanReachKm(100000), 3);
  assert.equal(urbanReachKm(1e8), 20);
  assert.equal(worldOf({ iso3: 'USA', world: 'northAmerica' }, 21, -157), 'oceania');
  assert.equal(worldOf({ iso3: 'FRA', world: 'westernEurope' }, 4, -53), 'southAmerica');
});

test('the lattice diff counts changes and honours accepted lines', () => {
  const row = (g, r, c) => ({ lat: 0, lon: 0, globe: { key: g, en: g, ru: g }, regional: { key: r, en: r, ru: r }, city: { key: c, en: c, ru: c } });
  const old = [row('a', 'b', 'c'), row('a', 'b', 'c'), row('a', 'b', 'c'), row('a', 'b', 'c')];
  const neu = [row('a', 'b', 'c'), row('a', 'x', 'c'), row('a', 'x', 'c'), row('z', 'b', 'c')];
  const d = diffLattices(old, neu, [{ tier: 'regional', from: 'b', to: 'x' }]);
  assert.equal(d.regional.changed, 2);
  assert.equal(d.regional.unaccepted, 0);
  assert.equal(d.globe.unaccepted, 1);
  assert.equal(d.globe.unacceptedShare, 0.25);
  assert.deepEqual(parseAccepted('/nonexistent'), []);
});

test('the point is normalised as the app does: 180 is -180, a longitude in range is kept bit for bit', () => {
  assert.deepEqual(normalisePoint(10, 180), [10, -180]);
  assert.deepEqual(normalisePoint(10, -180), [10, -180]);
  assert.deepEqual(normalisePoint(95, 190), [90, -170]);
  assert.deepEqual(normalisePoint(-91, -190), [-90, 170]);
  const lon = 139.12345;
  assert.equal(normalisePoint(0, lon)[1], lon);
  const { full } = syntheticPack();
  assert.equal(full.resolve({ lat: 0, lon: 355, tier: 'regional' }).key, 'adm0:AAA'); // -5
  assert.equal(full.resolve({ lat: Number.NaN, lon: 0, tier: 'regional' }), null);
});

test('short forms: the shown name\'s, the Latin one only when a Russian title fell back to the Latin name', () => {
  const row = { name_en: 'Long Name', name_ru: null, short_en: 'Long', short_ru: null };
  assert.equal(shortForm(row, false), 'Long');
  assert.equal(shortForm(row, true), 'Long'); // the Russian title is the Latin name
  assert.equal(shortForm({ ...row, name_ru: '\u0418\u043C\u044F' }, true), null); // a Russian title, no Russian short form
  assert.equal(shortForm({ ...row, short_ru: '\u041A' }, true), '\u041A');
  assert.equal(shortForm(row, true, true), null); // a country: the app names it in Russian
});

test('the targeted sample is deterministic and its answers carry the parity columns', () => {
  const { full } = syntheticPack();
  const a = targetedPoints(full, 400, 7);
  const b = targetedPoints(full, 400, 7);
  assert.equal(pointsTsv(a), pointsTsv(b));
  assert.ok(a.length > 300);
  const kinds = new Set(a.map((p) => p.kind));
  for (const [kind] of SAMPLE_KINDS) if (kind !== 'assignment-edge') assert.ok(kinds.has(kind), kind); // the synthetic pack has no assignment area
  const rows = pointAnswers(full, a.slice(0, 5).map((p) => ({ ...p, text: [String(p.lat), String(p.lon), String(p.mpp)] })));
  const tsv = latticeTsv(rows).split('\n');
  assert.equal(tsv[0].split('\t').length, 4 + 3 * 6);
  assert.equal(tsv[1].split('\t')[3], a[0].kind);
  assert.equal(tsv[1].split('\t')[0], String(a[0].lat));
});

// ---- borders, bands, national seas, assignments (the 2026-10-17 review) -------------------------------------------------
// AAA and BBB: the country outlines put the border at lon 0.2, the provinces at 0 (simplified outlines part by a few km).
// CCC (not the zone's administering country) and DDD (its administering country) face zone islands across water; DDD's
// province reaches 0.3 deg past its country outline (Taman). EEE borders a national sea. III and PPP: an assignment area.
function borderPack() {
  const dir = mkdtempSync(join(tmpdir(), 'places-border-'));
  const core = [
    area({ layer: 0, key: 'adm0:AAA', iso3: 'AAA', iso2: 'AA', world: 'westernEurope', name_en: 'Aland', q: Q5, polys: rect(-10, -5, 0.2, 5, Q5) }),
    area({ layer: 0, key: 'adm0:BBB', iso3: 'BBB', iso2: 'BB', world: 'easternEurope', name_en: 'Bland', q: Q5, polys: rect(0.2, -5, 10, 5, Q5) }),
    area({ layer: 0, key: 'adm0:CCC', iso3: 'CCC', iso2: 'CC', world: 'eastAsia', name_en: 'Cland', q: Q5, polys: rect(18, 0, 19.905, 1, Q5) }),
    area({ layer: 0, key: 'adm0:DDD', iso3: 'DDD', iso2: 'DD', world: 'easternEurope', name_en: 'Dland', q: Q5, polys: rect(30, 0, 31, 1, Q5) }),
    area({ layer: 0, key: 'adm0:EEE', iso3: 'EEE', iso2: 'EE', world: 'westernAsia', name_en: 'Eland', q: Q5, polys: rect(38, 0, 40, 2, Q5) }),
    area({ layer: 0, key: 'adm0:III', iso3: 'III', iso2: 'II', world: 'westernAsia', name_en: 'Iland', q: Q5, polys: rect(48, 0, 50, 2, Q5) }),
    area({ layer: 0, key: 'adm0:PPP', iso3: 'PPP', iso2: 'PP', world: 'westernAsia', name_en: 'Pland', q: Q5, polys: rect(50, 0, 52, 2, Q5) }),
    area({ layer: 2, key: 'sea:20', kind: 'ocean', rank: 0, globe: 1, name_en: 'Wide Ocean', name_ru: '\u041E\u043A\u0435\u0430\u043D', q: Q4, polys: rect(-60, -60, 60, -6, Q4) }),
    area({ layer: 2, key: 'sea:21', kind: 'sea', rank: 5, national: 1, name_en: 'Inner Sea', name_ru: '\u041C\u043E\u0440\u0435', parent: 'sea:20', q: Q4, polys: rect(40, 0, 42, 2, Q4) }),
    area({ layer: 3, key: 'zone:c', world: 'eastAsia', kind: 'area', admin: 'BBB', name_en: 'Isle C', name_ru: '\u041E\u0441\u0442\u0440\u043E\u0432', q: Q4, polys: rect(20, 0, 21, 1, Q4) }),
    area({ layer: 3, key: 'zone:d', world: 'easternEurope', kind: 'area', admin: 'DDD', name_en: 'Isle D', name_ru: '\u041E\u0441\u0442\u0440\u043E\u0432', q: Q4, polys: rect(31.5, 0, 32, 1, Q4) }),
    area({ layer: 4, key: 'assign:x', iso3: 'III', rank: 1, kind: 'assignment', name_en: 'III here', q: Q4, polys: rect(50, 0, 50.5, 2, Q4) }),
  ];
  const detail = [
    area({ layer: 1, key: 'adm1:AAA.1', iso3: 'AAA', parent: 'adm0:AAA', name_en: 'A Province', q: Q4, polys: rect(-10, -5, 0, 5, Q4) }),
    area({ layer: 1, key: 'adm1:BBB.1', iso3: 'BBB', parent: 'adm0:BBB', name_en: 'B Province', q: Q4, polys: rect(0, -5, 10, 5, Q4) }),
    area({ layer: 1, key: 'adm1:DDD.1', iso3: 'DDD', parent: 'adm0:DDD', name_en: 'D Province', q: Q4, polys: rect(30, 0, 31.3, 1, Q4) }),
  ];
  const town = (id, lat, lon, pop, adm0, alt = null) => ({ id, lat: Math.round(lat * Q4), lon: Math.round(lon * Q4), pop, adm0, adm1: null, adm0_alt: alt, metro: id, name_en: `T${id}`, name_ru: null, short_en: null, short_ru: null });
  const towns = [
    town(11, 1, -0.1, 50000, 'AAA'),
    town(12, 1, 0.1, 50000, 'BBB'),
    town(13, 3, 0.3, 20000, 'AAA', 'BBB'), // an A town inside B's outline (adm0_alt BBB)
  ];
  const meta = { version: '0.0.1', generated: '2026-10-17T00:00:00Z', attribution: 'test' };
  writePart(join(dir, 'core.sqlite'), 'core', core, null, meta);
  writePart(join(dir, 'detail.sqlite'), 'detail', detail, towns, { ...meta, min_population: '5000' });
  const c = openPart(join(dir, 'core.sqlite.gz'));
  const d = openPart(join(dir, 'detail.sqlite.gz'));
  rmSync(dir, { recursive: true, force: true });
  return { full: new Resolver(new PlaceIndex(c, d)), coreOnly: new Resolver(new PlaceIndex(c, null)) };
}

test('outlines that disagree near a border: rule E\'s town decides, else the province; core alone: the country outline', () => {
  const { full, coreOnly } = borderPack();
  const reg = (r, lat, lon) => r.resolve({ lat, lon, tier: 'regional' }).key;
  assert.equal(reg(full, 1, 0.15), 'adm0:BBB'); // country outline A, province B: the nearest town (12, in B) decides
  assert.equal(reg(full, 1, -0.05), 'adm0:AAA'); // both say A
  assert.equal(reg(full, -4, 0.1), 'adm0:BBB'); // no town within 50 km: the province
  assert.equal(reg(coreOnly, 1, 0.15), 'adm0:AAA');
  assert.equal(full.resolve({ lat: 1, lon: 0.15, tier: 'city' }).key, 'place:12');
});

test('a town is named on the land its outline gives it (adm0_alt)', () => {
  const { full } = borderPack();
  assert.equal(full.resolve({ lat: 3, lon: 0.31, tier: 'city' }).key, 'place:13'); // land B, a town of A with alt B
});

test('the band: a zone ties only with its own administering country, province outlines count with detail', () => {
  const { full, coreOnly } = borderPack();
  // 5.0 km from Cland (not the zone's administering country), 5.56 km from zone c: the nearer country wins.
  assert.equal(full.resolve({ lat: 0.5, lon: 19.95, tier: 'regional' }).key, 'adm0:CCC');
  // 5.6 km from D's province outline (39 km from its country outline), 16.7 km from zone d: the province's country.
  assert.equal(full.resolve({ lat: 0.5, lon: 31.35, tier: 'regional' }).key, 'adm0:DDD');
  assert.equal(coreOnly.resolve({ lat: 0.5, lon: 31.35, tier: 'regional' }).key, 'zone:d'); // core alone: the zone
  assert.equal(full.resolve({ lat: 0.5, lon: 31.48, tier: 'regional' }).key, 'zone:d'); // 2.2 km from the zone: it ties
});

test('a national sea shows its name past the 3 km the outlines may miss at its coast (Q7)', () => {
  const { full } = borderPack();
  assert.equal(full.resolve({ lat: 1, lon: 40.1, tier: 'regional' }).key, 'sea:21'); // 11 km off: the sea, not the country
  assert.equal(full.resolve({ lat: 1, lon: 40.02, tier: 'regional' }).key, 'adm0:EEE'); // 2.2 km off: the coast's country
  assert.equal(full.resolve({ lat: 1, lon: 40.1, tier: 'city' }).key, 'sea:21');
  assert.equal(full.resolve({ lat: 1, lon: 40.1, tier: 'globe', mpp: 5000 }).key, 'region:westernAsia'); // the globe keeps its band
});

test('an assignment area gives its country before the outlines', () => {
  const { full, coreOnly } = borderPack();
  assert.equal(full.resolve({ lat: 1, lon: 50.2, tier: 'regional' }).key, 'adm0:III');
  assert.equal(coreOnly.resolve({ lat: 1, lon: 50.2, tier: 'regional' }).key, 'adm0:III');
  assert.equal(full.resolve({ lat: 1, lon: 51, tier: 'regional' }).key, 'adm0:PPP');
});

test('the accepted diffs of one release only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'places-acc-'));
  try {
    const f = join(dir, 'a.md');
    writeFileSync(f, ['## 1.0.0', '- `regional * *`: everything', '- `parity regional 1.0000,2.0000 sea:1 adm0:X`: x', '## 1.1.0', '- `city a b`: one'].join('\n'));
    assert.deepEqual(parseAccepted(f, '1.1.0'), [{ tier: 'city', from: 'a', to: 'b' }]);
    assert.equal(parseAccepted(f, '1.0.0').length, 1);
    assert.equal(parseAccepted(f).length, 2);
    assert.deepEqual([...parseAcceptedParity(f, '1.0.0')], ['regional 1.0000,2.0000 sea:1 adm0:X']);
    assert.equal(parseAcceptedParity(f, '1.1.0').size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a release pointer must be this version\'s, with the URLs it publishes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'places-rel-'));
  try {
    const committed = join(dir, '9.9.9');
    mkdirSync(committed);
    const meta = { version: '9.9.9', generated: '2026-10-17T00:00:00Z', attribution: 'test' };
    const parts = ['core', 'detail'].map((name) => writePart(join(committed, `places-${name}.sqlite`), name, [], name === 'detail' ? [] : null, meta));
    const pointer = { version: '9.9.9', schema: 1, parts: parts.map((p) => ({ name: p.name, size_bytes: p.size_bytes, inflated_bytes: p.inflated_bytes, sha256: p.sha256, urls: pointerUrls('9.9.9', p.name) })) };
    const pointerPath = join(dir, 'places-db.json');
    writeFileSync(pointerPath, JSON.stringify(pointer));
    assert.deepEqual(releaseProblems({ committed, pointerPath, version: '9.9.9' }), []);
    pointer.parts[1].urls = pointerUrls('9.9.8', 'detail');
    writeFileSync(pointerPath, JSON.stringify(pointer));
    assert.ok(releaseProblems({ committed, pointerPath, version: '9.9.9' }).some((p) => p.startsWith('detail: urls')));
    assert.ok(releaseProblems({ committed, pointerPath, version: '9.9.10' }).some((p) => p.includes('places/VERSION')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('town names: soft signs at a word end, admin suffixes, Wikidata items that are not the town, GeoNames guesses', () => {
  assert.equal(cleanRomanisation("Ryazan'", 'RU'), 'Ryazan');
  assert.equal(cleanRomanisation("Homyel'", 'BY'), 'Homyel');
  assert.equal(cleanRomanisation("O'Higgins", 'CL'), "O'Higgins");
  assert.equal(stripAdminSuffix('Goyang-si', 'KR'), 'Goyang');
  assert.equal(stripAdminSuffix('Nishi-Tokyo-shi', 'JP'), 'Nishi-Tokyo');
  assert.equal(stripAdminSuffix('Quezon City', 'PH'), 'Quezon City');
  assert.ok(nameSimilarity('Faiyum', 'Al Fayyum') >= 0.5);
  const delhi = ['Delhi', 'Dilli'];
  assert.equal(wikidataRussian({ ru: '\u0421\u0442\u0430\u0440\u044B\u0439 \u0414\u0435\u043B\u0438', en: 'Old Delhi' }, delhi), '');
  assert.equal(wikidataRussian({ ru: '\u0414\u0435\u043B\u0438', en: 'Delhi' }, delhi), '\u0414\u0435\u043B\u0438');
  assert.equal(wikidataRussian({ ru: '\u0421\u0430\u043D\u0442\u0443\u0441', en: 'Baixada Santista' }, ['Santos']), '');
  assert.equal(wikidataRussian({ ru: '\u0422\u0430\u0433\u0430\u043D\u0441\u043A\u0438\u0439 \u0440\u0430\u0439\u043E\u043D', en: 'Taganskiy' }, ['Taganskiy']), '');
  assert.equal(wikidataRussian({ ru: '\u0421\u0442\u0430\u0440\u044B\u0439 \u041E\u0441\u043A\u043E\u043B', en: 'Stary Oskol' }, ['Staryy Oskol']), '\u0421\u0442\u0430\u0440\u044B\u0439 \u041E\u0441\u043A\u043E\u043B');
  const alt = (name, preferred = false) => ({ lang: 'ru', name, preferred, short: false, colloquial: false, historic: false, from: '', to: '' });
  assert.equal(pickRussian([alt('\u0417\u0430\u0440\u044F'), alt('\u0417\u0430\u0440\u0438\u0430')]).name, ''); // two different names: a guess
  assert.equal(pickRussian([alt('\u041A\u0430\u043B\u044C\u043A\u0443\u0442\u0442\u0430'), alt('\u041A\u043E\u0436\u0438\u043A\u043E\u0434\u0435')]).name, '');
  assert.equal(pickRussian([alt('\u041A\u0430\u044F\u043D\u0438'), alt('\u041A\u0430\u044F\u0430\u043D\u0438')]).name, '\u041A\u0430\u044F\u043D\u0438'); // two spellings of one name
  assert.equal(pickRussian([alt('\u0417\u0430\u0440\u044F'), alt('\u0417\u0430\u0440\u0438\u044F', true)]).name, '\u0417\u0430\u0440\u0438\u044F');
  assert.equal(pickRussian([alt('\u0416\u0438\u0433\u0443\u043B\u0451\u0432\u0441\u043A'), alt('\u0416\u0438\u0433\u0443\u043B\u0435\u0432\u0441\u043A')]).name, '\u0416\u0438\u0433\u0443\u043B\u0451\u0432\u0441\u043A');
});

test('the town threshold honours any minimum population', () => {
  assert.equal(keepTown(9000, 'PPL', 10000), false);
  assert.equal(keepTown(10001, 'PPL', 10000), true);
  assert.equal(keepTown(100, 'PPLA', 10000), true);
});
