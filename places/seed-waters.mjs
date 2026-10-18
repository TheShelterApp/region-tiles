// P1 helper: seed (or re-seed) places/curation/waters.tsv from Natural Earth's marine polygons and the frozen Wikidata
// labels, and report what a curator has to look at. An existing waters.tsv is never overwritten: the draft goes to
// --out, and the curated file is edited by hand from it (README, "Curation").
//
// What the draft fills in:
// - key: sea:<ne_id>; a second feature with the same ne_id (Natural Earth 5.2 repeats two) gets sea:<ne_id>-2.
// - name_en: Natural Earth's name_en, title-cased, abbreviations expanded; ru: the Wikidata label, else NE name_ru.
// - parent: the next larger water body. Natural Earth 5.2's subbasin when it names another row, else its oceanbasin
//   (an ocean row, or the Mediterranean / Baltic / Caspian rows for NE's regional basins), else the adjacent row of the
//   smallest scalerank by shared boundary vertices (the layer is a partition, so neighbours share vertices).
// - whole: the row a part is shown as (the North/South halves of the Pacific and Atlantic, the Mediterranean basins,
//   unnamed slivers), globe: 1 for the five whole oceans and the curated major seas.
//
// usage: node places/seed-waters.mjs <staged sources dir> --out <draft.tsv>
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTsv, writeTsv } from './lib/io.mjs';
import { clean, titleCase, isRussian } from './lib/names.mjs';
import { fromGeoJSON } from './lib/geometry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// R3's 22 globe seas plus the large seas the final architecture names (the Baltic, North, Bering, Barents seas).
export const GLOBE_SEAS = new Set([
  'Mediterranean Sea', 'Caribbean Sea', 'Gulf of Mexico', 'Bay of Bengal', 'Arabian Sea', 'South China Sea',
  'Philippine Sea', 'Coral Sea', 'Tasman Sea', 'Sea of Okhotsk', 'Sea of Japan', 'Black Sea', 'Red Sea', 'Caspian Sea',
  'Persian Gulf', 'Hudson Bay', 'Baffin Bay', 'Labrador Sea', 'Beaufort Sea', 'Gulf of Alaska', 'Ross Sea', 'Weddell Sea',
  'Baltic Sea', 'North Sea', 'Bering Sea', 'Barents Sea',
]);

const ABBREVIATIONS = [[/\bStr\.$/, 'Strait'], [/\bSd\.$/, 'Sound'], [/^B\. /, 'Bay '], [/\bSt\. /, 'Saint ']];

function main() {
  const [srcDir, flag, out] = process.argv.slice(2);
  if (!srcDir || flag !== '--out' || !out) throw new Error('usage: node places/seed-waters.mjs <staged sources dir> --out <draft.tsv>');
  const gj = JSON.parse(readFileSync(join(srcDir, 'ne', 'ne_10m_geography_marine_polys.geojson'), 'utf8'));
  const wdPath = join(HERE, 'curation', 'wikidata-labels.tsv');
  const wd = new Map(existsSync(wdPath) ? readTsv(wdPath).rows.filter((r) => r.key.startsWith('qid:')).map((r) => [r.key.slice(4), r]) : []);

  const seen = new Map();
  const rows = gj.features.map((f) => {
    const p = f.properties;
    const n = (seen.get(p.ne_id) || 0) + 1;
    seen.set(p.ne_id, n);
    const key = n === 1 ? `sea:${p.ne_id}` : `sea:${p.ne_id}-${n}`;
    let en = clean(p.name_en || p.name || '');
    for (const [re, to] of ABBREVIATIONS) en = en.replace(re, to);
    en = titleCase(en);
    const w = wd.get(p.wikidataid || '');
    const ruWd = w?.ru || '';
    const ruNe = clean(p.name_ru || '');
    return {
      key, ne_id: String(p.ne_id), ne_name: clean(p.name || ''), class: p.featurecla, rank: String(p.scalerank),
      name_en: en, name_ru: ruWd || (isRussian(ruNe) ? ruNe : ''),
      short_en: '', short_ru: '', parent: '', whole: '', globe: '', national: '',
      wikidata: p.wikidataid || '',
      note: [ruWd && ruNe && ruWd !== ruNe ? `NE ru: ${ruNe}` : '', !ruWd && ruNe && !isRussian(ruNe) ? `NE ru (not Russian): ${ruNe}` : '',
        w?.en && w.en !== en ? `Wikidata en: ${w.en}` : '', `NE basin: ${p.oceanbasin || ''} / ${p.subbasin || ''}`].filter(Boolean).join('; '),
      _basin: p.oceanbasin || '', _sub: p.subbasin || '', _geom: fromGeoJSON(f.geometry),
    };
  });

  // Shared boundary vertices at 1e-3 degrees: the adjacency of the partition.
  const owners = new Map();
  rows.forEach((r, i) => {
    for (const poly of r._geom) for (const ring of poly) {
      for (let k = 0; k < ring.length; k += 2) {
        const v = `${Math.round(ring[k] * 1000)},${Math.round(ring[k + 1] * 1000)}`;
        if (!owners.has(v)) owners.set(v, new Set());
        owners.get(v).add(i);
      }
    }
  });
  const shared = rows.map(() => new Map());
  for (const set of owners.values()) {
    if (set.size < 2) continue;
    for (const a of set) for (const b of set) if (a !== b) shared[a].set(b, (shared[a].get(b) || 0) + 1);
  }

  const byName = new Map();
  for (const r of rows) {
    for (const nm of [r.ne_name, r.name_en]) if (nm && !byName.has(nm.toLowerCase())) byName.set(nm.toLowerCase(), r);
  }
  const ocean = (name) => rows.find((r) => r.class === 'ocean' && r.ne_name.toLowerCase() === name.toLowerCase());
  const medEast = rows.find((r) => r.ne_id === '1159115321');
  const basinRow = (b) => {
    if (!b) return null;
    if (b === 'Mediterranean Region') return medEast;
    if (b === 'INDIAN OCEAN') return ocean('INDIAN OCEAN');
    return ocean(b) || byName.get(b.toLowerCase()) || null;
  };
  rows.forEach((r, i) => {
    if (r.class === 'ocean') return;
    if (r.ne_name === 'Caspian Sea') return; // landlocked
    const sub = byName.get(r._sub.toLowerCase());
    const basin = basinRow(r._basin);
    let parent = sub && sub !== r ? sub : basin && basin !== r ? basin : null;
    if (!parent) {
      let best = null;
      let bestScore = -1;
      for (const [j, n] of shared[i]) {
        const c = rows[j];
        if (Number(c.rank) > Number(r.rank)) continue;
        const score = n * 10 - Number(c.rank);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      parent = best;
    }
    r.parent = parent ? parent.key : '';
  });

  // Whole water: the five oceans' halves fold into one row each; the Mediterranean basins into the eastern basin's row;
  // unnamed slivers take their parent's whole.
  const np = ocean('North Pacific Ocean');
  const sp = ocean('South Pacific Ocean');
  const na = ocean('North Atlantic Ocean');
  const sa = ocean('South Atlantic Ocean');
  np.name_en = 'Pacific Ocean';
  na.name_en = 'Atlantic Ocean';
  sp.whole = np.key;
  sa.whole = na.key;
  const medWest = rows.find((r) => r.ne_id === '1779567343');
  medWest.whole = medEast.key;
  for (const r of rows) {
    if (r.class === 'ocean' && !r.whole) r.globe = '1';
    if (GLOBE_SEAS.has(r.name_en) && r !== medWest) r.globe = '1';
  }
  for (const r of rows) {
    if (r.ne_name) continue;
    const p = rows.find((x) => x.key === r.parent);
    r.whole = p ? (p.whole || p.key) : '';
    r.name_en = p ? p.name_en : '';
    r.name_ru = p ? p.name_ru : '';
    r.note = `unnamed Natural Earth sliver, shown as its parent; ${r.note}`;
  }

  rows.sort((a, b) => Number(a.rank) - Number(b.rank) || a.class.localeCompare(b.class) || a.ne_name.localeCompare(b.ne_name) || a.key.localeCompare(b.key));
  writeTsv(out, ['key', 'ne_id', 'ne_name', 'class', 'rank', 'name_en', 'name_ru', 'short_en', 'short_ru', 'parent', 'whole', 'globe', 'national', 'wikidata', 'note'], rows);
  console.log(`draft: ${rows.length} rows -> ${out}`);
}

main();
