// The review reports verify.mjs writes next to a built pack (final architecture section 3.2, P3), for the owner's
// review of names and policy before a release:
//   review-names.md       every Russian name the pack curates: waters, zones, metros, overrides, short forms
//   provinces.tsv         every province's English and Russian name (Natural Earth, with the overrides)
//   disputed.md           every Natural Earth disputed area with the pack's answer at a point inside it, per tier
//   ru-coverage.md        towns with a Russian name, per country, and where the names come from
//   short-candidates.tsv  names that may need a short form, by character count (the width gate runs on a Mac)
//   town-names-ru.md      the Russian name of every town of 100,000 people or more shown as itself, with its source and
//                         the alternatives the build saw (Wikidata's label, GeoNames' names), for the owner's review
//   sections.md           GeoNames city sections (PPLX) shown as themselves, and their population caps
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTsv } from './lib/io.mjs';
import { fromGeoJSON, polygonContains, quantise } from './lib/geometry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');

/** A point inside a polygon set: the box centre if inside, else the midpoint of the widest inside run of a scanline. */
function interiorPoint(polys) {
  const q = 1e5;
  const qp = quantise(polys, q);
  let best = null;
  qp.forEach((poly, pi) => {
    const r = poly[0];
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (let i = 0; i < r.length; i += 2) {
      minx = Math.min(minx, r[i]);
      maxx = Math.max(maxx, r[i]);
      miny = Math.min(miny, r[i + 1]);
      maxy = Math.max(maxy, r[i + 1]);
    }
    const area = (maxx - minx) * (maxy - miny);
    if (best && area <= best.area) return;
    for (let s = 1; s <= 15; s++) {
      const y = miny + ((maxy - miny) * s) / 16;
      let run = null;
      let start = null;
      const steps = 400;
      for (let k = 0; k <= steps; k++) {
        const x = minx + ((maxx - minx) * k) / steps;
        const inside = polygonContains(qp[pi], x, y);
        if (inside && start === null) start = x;
        if ((!inside || k === steps) && start !== null) {
          const end = inside ? x : x - (maxx - minx) / steps;
          if (!run || end - start > run[1] - run[0]) run = [start, end];
          start = null;
        }
      }
      if (run) {
        best = { area, lat: y / q, lon: (run[0] + run[1]) / 2 / q };
        if (s >= 7) break;
      }
    }
  });
  return best;
}

export function writeReviewReports({ core, detail, full, reports, srcRoot, buildReport = null }) {
  const waters = core.areas.filter((a) => a.layer === 2);
  const byKey = new Map([...core.areas, ...detail.areas].map((a) => [a.key, a]));
  const towns = new Map(detail.places.map((t) => [t.id, t]));
  const cur = (f) => readTsv(join(HERE, 'curation', f)).rows;

  // ---- review-names.md --------------------------------------------------------------------------------------------
  const L = ['# Place names pack: names for review', '',
    `Pack ${core.meta.version}, built ${core.meta.generated}. Every Russian name the pack curates, in one place. ` +
    'Countries are not listed: the app names them with the system (CountryName). Edit the curation tables in ' +
    '`places/curation/` to change a name.', ''];
  L.push(`## Seas and oceans (${waters.length} rows, places/curation/waters.tsv)`, '',
    'Shown as: the name the header shows for this polygon (its `whole`). Globe: named at the globe tier.', '',
    '| Key | Class | English | Russian | Short en / ru | Shown as | Globe | Parent |', '|---|---|---|---|---|---|---|---|');
  const sortedWaters = [...waters].sort((a, b) => (a.rank - b.rank) || a.name_en.localeCompare(b.name_en));
  for (const w of sortedWaters) {
    const shown = w.whole ? byKey.get(w.whole) : null;
    const parent = w.parent ? byKey.get(w.parent) : null;
    L.push(`| ${w.key} | ${w.kind} ${w.rank} | ${esc(w.name_en)} | ${esc(w.name_ru)} | ${esc([w.short_en, w.short_ru].filter(Boolean).join(' / '))} | ${shown ? esc(shown.name_en) : ''} | ${w.globe ? 'yes' : ''} | ${parent ? esc(parent.name_en) : ''} |`);
  }
  L.push('', '## Neutral zones (places/curation/zones.tsv; owner decision Q1 = B, the list awaits sign-off)', '',
    '| Key | English | Russian | Part of the world | Policy | Outline | Note |', '|---|---|---|---|---|---|---|');
  for (const z of cur('zones.tsv')) L.push(`| ${z.key} | ${esc(z.name_en)} | ${esc(z.name_ru)} | ${z.world} | ${z.policy} | ${esc(z.source)} | ${esc(z.note)} |`);
  L.push('', '## Metro rules (places/curation/metros.tsv) and what they fold', '');
  const foldCount = new Map();
  for (const t of detail.places) if (t.metro !== t.id) foldCount.set(t.metro, (foldCount.get(t.metro) || 0) + 1);
  L.push('| Rule | Shown as | Name (ward / metro) | km |', '|---|---|---|---|');
  for (const m of cur('metros.tsv')) {
    const t = towns.get(Number(m.metro));
    L.push(`| ${m.rule} | ${esc(t?.name_en)} / ${esc(t?.name_ru)} | ${esc(m.check_name)} | ${esc(m.km)} |`);
  }
  L.push('', 'Towns shown as another town (metro rules plus sections of a city, GeoNames PPLX, within 15 km), the 60 largest groups:', '',
    '| Shown as | Russian | Towns folded in |', '|---|---|---|');
  for (const [id, n] of [...foldCount].sort((a, b) => b[1] - a[1]).slice(0, 60)) {
    const t = towns.get(id);
    L.push(`| ${esc(t.name_en)} (place:${id}) | ${esc(t.name_ru)} | ${n} |`);
  }
  L.push('', '## Town overrides (places/curation/places-overrides.tsv)', '', '| geonameid | English | Russian | Note |', '|---|---|---|---|');
  for (const o of cur('places-overrides.tsv')) {
    const t = towns.get(Number(o.geonameid));
    L.push(`| ${o.geonameid} | ${esc(t?.name_en ?? o.name_en)} | ${esc(t?.name_ru ?? o.name_ru)} | ${esc(o.note)} |`);
  }
  L.push('', '## Province overrides (places/curation/admin1-overrides.tsv)', '', '| Key | English | Russian | Note |', '|---|---|---|---|');
  for (const o of cur('admin1-overrides.tsv')) {
    const a = byKey.get(o.key);
    L.push(`| ${o.key} | ${esc(a?.name_en)} | ${esc(a?.name_ru)} | ${esc(o.note)} |`);
  }
  L.push('', '## Short forms (places/curation/short-names.tsv; waters and zones keep theirs in their own tables)', '',
    '| Key | Short en | Short ru | Note |', '|---|---|---|---|');
  for (const s of cur('short-names.tsv')) L.push(`| ${s.key} | ${esc(s.short_en)} | ${esc(s.short_ru)} | ${esc(s.note)} |`);

  // ---- metro candidates: big cities with large non-section towns of the same GeoNames division close by, not folded ----
  const gn = new Map();
  for (const line of readFileSync(join(srcRoot, 'geonames', 'cities1000.txt'), 'utf8').split('\n')) {
    const c = line.split('\t');
    if (c.length >= 19) gn.set(Number(c[0]), { fcode: c[7], cc: c[8], a1: c[10] });
  }
  const hav = (a, b) => {
    const r = Math.PI / 180;
    const dLat = (b.lat - a.lat) / 1e4 * r;
    const dLon = (b.lon - a.lon) / 1e4 * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat / 1e4 * r) * Math.cos(b.lat / 1e4 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(x));
  };
  const big = detail.places.filter((t) => t.pop >= 1e6 && t.metro === t.id);
  L.push('', '## Metro candidates (for review): cities of 1M+ with towns of 100k+ of the same GeoNames division within 15 km', '',
    'Not folded today: Q5 (the metro) may want a metros.tsv rule for some of them; separate municipalities keep their names.', '',
    '| City | Russian | Nearby towns shown as themselves |', '|---|---|---|');
  for (const m of big.sort((a, b) => b.pop - a.pop)) {
    const g = gn.get(m.id);
    const near = detail.places.filter((t) => t !== m && t.metro === t.id && t.pop >= 1e5 && gn.get(t.id)?.cc === g?.cc && gn.get(t.id)?.a1 === g?.a1 && hav(m, t) <= 15);
    if (near.length) L.push(`| ${esc(m.name_en)} (place:${m.id}) | ${esc(m.name_ru)} | ${near.map((t) => `${esc(t.name_en)} ${hav(m, t).toFixed(0)} km`).join(', ')} |`);
  }
  writeFileSync(join(reports, 'review-names.md'), L.join('\n') + '\n');

  // ---- town-names-ru.md -----------------------------------------------------------------------------------------------
  if (buildReport?.russianReview) {
    const via = { override: 'override', wikidata: 'Wikidata', 'geonames-preferred': 'GeoNames (preferred)', geonames: 'GeoNames (the only name)',
      'geonames-short': 'GeoNames (the only short name)', ambiguous: 'none: GeoNames names differ', none: 'none' };
    const T = ['# Russian names of towns of 100,000 people or more', '',
      `Pack ${core.meta.version}. Every town of 100,000 people or more that the header shows as itself, with its Russian name and where it comes from: ` +
      'an override (places/curation/places-overrides.tsv), the Wikidata label of the town\'s item (used only when the item\'s English label is ' +
      'the town\'s name and the Russian label is no district, agglomeration or "old" quarter), GeoNames\' preferred Russian name, or GeoNames\' ' +
      'only Russian name (two different ones are a guess: none, the Latin name shows). To change a name, add an override.', '',
      `${buildReport.russianReview.length} towns; without a Russian name: ${buildReport.russianReview.filter((r) => !r.name_ru).length}.`, '',
      '| Town | Country | English | Russian | Source | Wikidata label (en / ru) | GeoNames |', '|---|---|---|---|---|---|---|'];
    for (const r of buildReport.russianReview) {
      T.push(`| place:${r.id} | ${r.cc} | ${esc(r.name_en)} | ${esc(r.name_ru)} | ${via[r.via] || r.via} | ${r.wikidata ? `${esc(r.wikidata_en)} / ${esc(r.wikidata)}${r.wikidata_used ? '' : ' (rejected)'}` : ''} | ${esc(r.geonames)} |`);
    }
    writeFileSync(join(reports, 'town-names-ru.md'), T.join('\n') + '\n');
  }

  // ---- sections.md --------------------------------------------------------------------------------------------------
  if (buildReport?.sectionsShownAsThemselves) {
    const S = ['# City sections shown as themselves', '',
      'GeoNames city sections (PPLX) with no town of their municipality within 15 km to fold into (often the city\'s own ' +
      'record: Ichikawa, Navi Mumbai; or a district of a city whose record lies farther away). A section larger than every town ' +
      'within 15 km ranks with that town\'s population instead (capped), so a record carrying a whole district\'s or city\'s ' +
      'figure does not win rule E far beyond its place; keep 1 in places-overrides.tsv exempts one.', '',
      '| Town | Country | Name | Population | Capped to |', '|---|---|---|---|---|'];
    for (const t of buildReport.sectionsShownAsThemselves) S.push(`| place:${t.id} | ${t.cc} | ${esc(t.name)} | ${t.pop} | ${t.cappedTo ?? ''} |`);
    if (buildReport.wardNamesElsewhere?.length) {
      S.push('', 'Towns named after a Tokyo ward outside Tokyo with 100,000 people or more (a ward\'s record at a wrong place would ' +
        'win rule E there; real cities of that name are fine):', '', '| Town | Ward | Name | Prefecture | Population |', '|---|---|---|---|---|');
      for (const w of buildReport.wardNamesElsewhere) S.push(`| place:${w.id} | ${w.ward} | ${esc(w.name)} | JP.${w.a1} | ${w.pop} |`);
    }
    writeFileSync(join(reports, 'sections.md'), S.join('\n') + '\n');
  }

  // ---- provinces.tsv ------------------------------------------------------------------------------------------------
  const prov = detail.areas.filter((a) => a.layer === 1).sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true }));
  writeFileSync(join(reports, 'provinces.tsv'), ['key\tiso_3166_2\tname_en\tname_ru\tshort_en\tshort_ru\tkind',
    ...prov.map((a) => [a.key, a.iso_3166_2 ?? '', a.name_en, a.name_ru ?? '', a.short_en ?? '', a.short_ru ?? '', a.kind ?? ''].join('\t'))].join('\n') + '\n');

  // ---- disputed.md --------------------------------------------------------------------------------------------------
  const ne = JSON.parse(readFileSync(join(srcRoot, 'ne', 'ne_10m_admin_0_disputed_areas.geojson'), 'utf8'));
  const D = ['# Disputed areas: what the pack answers', '',
    'Every Natural Earth 10m admin_0_disputed_areas feature, with the pack\'s answer at a point inside it, per tier, ' +
    'in English and Russian. Countries show the app\'s system name in Russian, marked "(system)". ' +
    'Policy: final architecture section 6, option B (owner decision Q1); the zones are in places/curation/zones.tsv.', '',
    '| NE | Feature | Note (NE) | Point | Globe | Regional (en / ru) | City (en / ru) |', '|---|---|---|---|---|---|---|'];
  const fmt = (r, ru) => {
    if (!r) return '-';
    const ruName = r.level === 'country' ? '(system)' : ru?.name ?? '';
    return `${esc(r.name)} / ${esc(ruName)} \`${r.key}\``;
  };
  for (const f of [...ne.features].sort((a, b) => a.properties.BRK_A3.localeCompare(b.properties.BRK_A3))) {
    const p = f.properties;
    const pt = interiorPoint(fromGeoJSON(f.geometry));
    if (!pt) continue;
    const q = { lat: pt.lat, lon: pt.lon };
    const g = full.resolve({ ...q, tier: 'globe', language: 'en' });
    const r = full.resolve({ ...q, tier: 'regional', language: 'en' });
    const rr = full.resolve({ ...q, tier: 'regional', language: 'ru' });
    const c = full.resolve({ ...q, tier: 'city', language: 'en' });
    const cr = full.resolve({ ...q, tier: 'city', language: 'ru' });
    D.push(`| ${p.BRK_A3} | ${esc(p.BRK_NAME)} | ${esc(p.NOTE_BRK)} | ${pt.lat.toFixed(3)}, ${pt.lon.toFixed(3)} | ${esc(g?.name)} | ${fmt(r, rr)} | ${fmt(c, cr)} |`);
  }
  writeFileSync(join(reports, 'disputed.md'), D.join('\n') + '\n');

  // ---- ru-coverage.md -----------------------------------------------------------------------------------------------
  const wd = new Map(cur('wikidata-labels.tsv').filter((r) => r.key.startsWith('place:')).map((r) => [Number(r.key.slice(6)), r]));
  const over = new Set(cur('places-overrides.tsv').filter((o) => o.name_ru).map((o) => Number(o.geonameid)));
  const per = new Map();
  for (const t of detail.places) {
    if (t.metro !== t.id) continue; // aliases are shown as their metro
    const c = per.get(t.adm0) || { towns: 0, ru: 0, wikidata: 0, override: 0, geonames: 0 };
    c.towns++;
    if (t.name_ru) {
      c.ru++;
      if (over.has(t.id)) c.override++;
      else if (wd.get(t.id)?.ru === t.name_ru) c.wikidata++;
      else c.geonames++;
    }
    per.set(t.adm0, c);
  }
  const tot = [...per.values()].reduce((s, c) => ({ towns: s.towns + c.towns, ru: s.ru + c.ru, wikidata: s.wikidata + c.wikidata, geonames: s.geonames + c.geonames, override: s.override + c.override }), { towns: 0, ru: 0, wikidata: 0, geonames: 0, override: 0 });
  const R = ['# Russian town names per country', '',
    `Towns shown as themselves (aliases excluded): ${tot.towns}; with a Russian name: ${tot.ru} (${(100 * tot.ru / tot.towns).toFixed(1)} %): ` +
    `Wikidata ${tot.wikidata}, GeoNames ${tot.geonames}, overrides ${tot.override}. A town without one shows its Latin name in Russian.`, '',
    '| Country | Towns | Russian | Share | Wikidata | GeoNames |', '|---|---|---|---|---|---|'];
  for (const [iso, c] of [...per].sort((a, b) => b[1].towns - a[1].towns)) {
    R.push(`| ${iso} | ${c.towns} | ${c.ru} | ${(100 * c.ru / c.towns).toFixed(0)} % | ${c.wikidata} | ${c.geonames} |`);
  }
  writeFileSync(join(reports, 'ru-coverage.md'), R.join('\n') + '\n');

  // ---- short-candidates.tsv -----------------------------------------------------------------------------------------
  const cand = [];
  const push = (key, layer, lang, name, short) => {
    if (name && name.length >= 18) cand.push({ key, layer, lang, chars: name.length, name, short: short || '' });
  };
  for (const a of [...core.areas, ...detail.areas]) {
    if (a.layer === 0) continue; // country names come from the system: the gate measures them on the device's names
    push(a.key, ['country', 'province', 'water', 'zone'][a.layer], 'en', a.name_en, a.short_en);
    push(a.key, ['country', 'province', 'water', 'zone'][a.layer], 'ru', a.name_ru, a.short_ru);
  }
  for (const t of detail.places) {
    if (t.metro !== t.id) continue;
    push(`place:${t.id}`, 'town', 'en', t.name_en, t.short_en);
    push(`place:${t.id}`, 'town', 'ru', t.name_ru, t.short_ru);
  }
  cand.sort((a, b) => b.chars - a.chars || a.key.localeCompare(b.key));
  writeFileSync(join(reports, 'short-candidates.tsv'), ['# Names of 18 characters or more, longest first. The header fits about 20-24 characters at 28 pt bold scaled to 0.64;',
    '# the release gate (iOS Scripts/check-place-pack.sh) measures the real widths with the system font.',
    'key\tlayer\tlang\tchars\tname\tshort', ...cand.map((c) => [c.key, c.layer, c.lang, c.chars, c.name, c.short].join('\t'))].join('\n') + '\n');
}
