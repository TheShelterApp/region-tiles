// The lattice regression (final architecture section 3.3, check 7): the answers of a pack at a Fibonacci lattice of
// points on all three tiers in English and Russian, and the diff between two packs (normally the previous release,
// whose bytes are committed under places/dist/<version>/, and the candidate).
//
// usage:
//   node places/lattice.mjs answers <core.gz> <detail.gz> --out <lattice.tsv.gz> [--n 100000]
//   node places/lattice.mjs diff <old core.gz> <old detail.gz> <new core.gz> <new detail.gz> --report <diff.md>
//        [--n 100000] [--accepted places/accepted-diffs.md] [--max-share 0.005]
// `diff` exits 1 when more than --max-share of the answers of any tier change without a matching line in the accepted
// file. An accepted line is a list item with a code span `tier old-key new-key`, where a key may be `*`.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resolver } from './resolve.mjs';
import { fibonacci } from './lib/geometry.mjs';
import { gzipDeterministic, ensureDir } from './lib/io.mjs';
import { dirname } from 'node:path';

export const TIERS = ['globe', 'regional', 'city'];

/** Every lattice point's answer per tier: [{ lat, lon, globe: {key, en, ru}, regional: ..., city: ... }]. */
export function latticeAnswers(resolver, n) {
  const pts = fibonacci(n);
  return pts.map(([lat, lon]) => {
    const row = { lat, lon };
    for (const tier of TIERS) {
      const en = resolver.resolve({ lat, lon, tier, language: 'en' });
      const ru = resolver.resolve({ lat, lon, tier, language: 'ru' });
      row[tier] = en ? { key: en.key, en: en.name ?? '', ru: ru?.name ?? '' } : { key: '', en: '', ru: '' };
    }
    return row;
  });
}

export function parseAccepted(path) {
  if (!path || !existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*[-*]\s+`(globe|regional|city)\s+(\S+)\s+(\S+)`/);
    if (m) out.push({ tier: m[1], from: m[2], to: m[3] });
  }
  return out;
}

const matches = (acc, tier, from, to) => acc.some((a) => a.tier === tier && (a.from === '*' || a.from === from) && (a.to === '*' || a.to === to));

/** Compare two lattices: per tier the changed answers, grouped by (old key, new key), and the unaccepted share. */
export function diffLattices(oldRows, newRows, accepted = []) {
  const res = {};
  for (const tier of TIERS) {
    const groups = new Map();
    let changed = 0;
    let unaccepted = 0;
    let names = 0;
    for (let i = 0; i < oldRows.length; i++) {
      const a = oldRows[i][tier];
      const b = newRows[i][tier];
      const keyChange = a.key !== b.key;
      const nameChange = !keyChange && (a.en !== b.en || a.ru !== b.ru);
      if (!keyChange && !nameChange) continue;
      changed++;
      if (nameChange) names++;
      const from = keyChange ? a.key : `${a.key} "${a.en}" / "${a.ru}"`;
      const to = keyChange ? b.key : `"${b.en}" / "${b.ru}"`;
      const g = `${from}\u0000${to}`;
      if (!groups.has(g)) groups.set(g, { from, to, kind: keyChange ? kindOf(a.key, b.key) : 'name', n: 0, example: [oldRows[i].lat, oldRows[i].lon] });
      groups.get(g).n++;
      if (!matches(accepted, tier, a.key, b.key)) unaccepted++;
    }
    res[tier] = { points: oldRows.length, changed, nameOnly: names, unaccepted, unacceptedShare: unaccepted / oldRows.length,
      groups: [...groups.values()].sort((x, y) => y.n - x.n) };
  }
  return res;
}

function kindOf(a, b) {
  const t = (k) => (k || 'none').split(':')[0];
  return `${t(a)} -> ${t(b)}`;
}

export function diffMarkdown(diff, title) {
  const lines = [`# ${title}`, ''];
  for (const tier of TIERS) {
    const d = diff[tier];
    lines.push(`## ${tier}: ${d.changed} of ${d.points} answers changed (${(100 * d.changed / d.points).toFixed(3)} %), ` +
      `${d.nameOnly} by name only, ${d.unaccepted} not accepted (${(100 * d.unacceptedShare).toFixed(3)} %)`, '');
    if (!d.groups.length) {
      lines.push('No change.', '');
      continue;
    }
    lines.push('| Points | Kind | Old | New | Example (lat, lon) |', '|---|---|---|---|---|');
    for (const g of d.groups.slice(0, 400)) {
      lines.push(`| ${g.n} | ${g.kind} | ${g.from} | ${g.to} | ${g.example[0].toFixed(4)}, ${g.example[1].toFixed(4)} |`);
    }
    if (d.groups.length > 400) lines.push(`| ... | ${d.groups.length - 400} more groups | | | |`);
    lines.push('');
  }
  return lines.join('\n');
}

export function latticeTsv(rows) {
  const out = ['lat\tlon\tglobe_key\tglobe_en\tglobe_ru\tregional_key\tregional_en\tregional_ru\tcity_key\tcity_en\tcity_ru'];
  for (const r of rows) {
    out.push([r.lat.toFixed(6), r.lon.toFixed(6), ...TIERS.flatMap((t) => [r[t].key, r[t].en, r[t].ru])].join('\t'));
  }
  return out.join('\n') + '\n';
}

function opts(argv) {
  const pos = [];
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, o };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, o } = opts(rest);
  const n = Number(o.n || 100000);
  if (cmd === 'answers') {
    const rows = latticeAnswers(Resolver.fromParts(pos[0], pos[1]), n);
    ensureDir(dirname(o.out));
    writeFileSync(o.out, gzipDeterministic(Buffer.from(latticeTsv(rows))));
    console.log(`lattice: ${rows.length} points x 3 tiers -> ${o.out}`);
  } else if (cmd === 'diff') {
    const t0 = Date.now();
    const oldRows = latticeAnswers(Resolver.fromParts(pos[0], pos[1]), n);
    const newRows = latticeAnswers(Resolver.fromParts(pos[2], pos[3]), n);
    const diff = diffLattices(oldRows, newRows, parseAccepted(o.accepted));
    const md = diffMarkdown(diff, `Lattice diff (${n} points, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    if (o.report) {
      ensureDir(dirname(o.report));
      writeFileSync(o.report, md);
    }
    const max = Number(o['max-share'] || 0.005);
    let fail = false;
    for (const tier of TIERS) {
      const d = diff[tier];
      console.log(`${tier}: ${d.changed} changed, ${d.unaccepted} not accepted (${(100 * d.unacceptedShare).toFixed(3)} %)`);
      if (d.unacceptedShare > max) fail = true;
    }
    if (fail) {
      console.error(`FAIL: more than ${(100 * max).toFixed(2)} % of a tier's answers changed without a line in the accepted diffs`);
      process.exit(1);
    }
  } else {
    console.error('usage: lattice.mjs answers|diff ...');
    process.exit(2);
  }
}
