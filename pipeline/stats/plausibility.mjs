// Plausibility of a build before it is written (XR-1, round 16). ComCat can answer a populated window with nothing (a
// 204, an empty or header-only page: comcat.mjs fetchPage fails those) or with less than it holds (a truncated page).
// Before these checks such a build published zero or shrunken counts, and devices kept them for days (the app's cache
// honours jsDelivr's max-age). The rules are pure functions over plain numbers, so the tests can drive every one.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  COUNT_TOLERANCE, COUNT_SLACK, TOTAL_DROP_TOLERANCE, YEAR_DROP_TOLERANCE, YEAR_DROP_SLACK,
  COUNTRY_DROP_TOLERANCE, COUNTRY_DROP_SLACK,
} from './config.mjs';

/** Adds a histogram ({startYear, counts}) into a Map year -> count. */
export function addHistogram(years, histogram) {
  if (!histogram || !Array.isArray(histogram.counts)) return years;
  histogram.counts.forEach((n, i) => years.set(histogram.startYear + i, (years.get(histogram.startYear + i) ?? 0) + n));
  return years;
}

/**
 * The published build as numbers: `total`, `countries` {ISO3: total}, `years` (Map year -> global count: every country
 * file's histogram plus the unassigned one). Null when there is no index. A country file the index lists but the
 * directory lacks counts as missing (its total stays in `countries`, its years are not added).
 */
export function readPublished(statsDir) {
  const indexFile = join(statsDir, 'index.json');
  if (!existsSync(indexFile)) return null;
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  const years = new Map();
  const missing = [];
  for (const id of Object.keys(index.countries ?? {})) {
    const file = join(statsDir, 'adm0', `${id}.json`);
    if (!existsSync(file)) { missing.push(id); continue; }
    addHistogram(years, JSON.parse(readFileSync(file, 'utf8')).histogram);
  }
  addHistogram(years, index.unassigned?.histogram);
  return { index, total: index.total, countries: index.countries ?? {}, years, missing };
}

const allowedDrop = (previous, tolerance, slack) => Math.max(slack, Math.floor(previous * tolerance));

/**
 * The download of the run's window against ComCat's /count of the same window: a problem (a string) when the download
 * falls short by more than max(COUNT_SLACK, COUNT_TOLERANCE x count), else null.
 */
export function windowCountProblem({ downloaded, comcat, window }) {
  const allowed = allowedDrop(comcat, COUNT_TOLERANCE, COUNT_SLACK);
  if (downloaded >= comcat - allowed) return null;
  return `the download of ${window} holds ${downloaded} events, ComCat's /count of the same window ${comcat} `
    + `(short by ${comcat - downloaded}, at most ${allowed} allowed): a page came back truncated`;
}

/**
 * The new build against the previous published one. `next`: {total, countries, years}. `previous`: readPublished()'s
 * result or null. `comparable`: same since, magnitude floor and event type, and a cutoff no earlier than the previous
 * one (the counts can only grow, apart from ComCat's revisions). `sameAssignment`: the same assignment rule and regions
 * (a country's total is comparable). Returns the problems (strings), empty when the build is plausible. A total of zero
 * is always a problem.
 */
export function plausibilityProblems({ previous, next, comparable, sameAssignment }) {
  const problems = [];
  if (!(next.total > 0)) problems.push(`the build counts ${next.total} earthquakes in all`);
  if (!previous || !comparable) return problems;

  const totalAllowed = Math.floor(previous.total * TOTAL_DROP_TOLERANCE);
  if (next.total < previous.total - totalAllowed) {
    problems.push(`the global total drops from ${previous.total} to ${next.total} (at most ${totalAllowed} allowed, ${TOTAL_DROP_TOLERANCE * 100} %)`);
  }
  const years = [];
  for (const [year, before] of [...previous.years].sort((a, b) => a[0] - b[0])) {
    const now = next.years.get(year) ?? 0;
    const allowed = allowedDrop(before, YEAR_DROP_TOLERANCE, YEAR_DROP_SLACK);
    if (now < before - allowed) years.push(`${year}: ${before} → ${now} (at most ${allowed} fewer)`);
  }
  if (years.length) problems.push(`the global count of ${years.length} year(s) drops: ${years.slice(0, 12).join('; ')}${years.length > 12 ? '; …' : ''}`);
  if (sameAssignment) {
    const countries = [];
    for (const [id, before] of Object.entries(previous.countries).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const now = next.countries[id] ?? 0;
      const allowed = allowedDrop(before, COUNTRY_DROP_TOLERANCE, COUNTRY_DROP_SLACK);
      if (now < before - allowed) countries.push(`${id} ${before} → ${now} (at most ${allowed} fewer)`);
    }
    if (countries.length) problems.push(`the total of ${countries.length} countr${countries.length === 1 ? 'y' : 'ies'} drops: ${countries.slice(0, 12).join('; ')}${countries.length > 12 ? '; …' : ''}`);
  }
  return problems;
}
