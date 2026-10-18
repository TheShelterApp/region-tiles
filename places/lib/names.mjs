// Name hygiene for the place-names pack (README, "Names"). The build applies `clean` to every name it writes;
// verify.mjs check 5 refuses a pack whose names break the rules.

// A stress mark after a Cyrillic letter (NFD). Latin accents are not touched: in NFD an acute accent is U+0301 too.
const STRESS = /([\u0400-\u04FF])\u0301/g;
const CYRILLIC = /[\u0400-\u04FF\u0500-\u052F]/;
// Letters of other Cyrillic alphabets that Russian does not use (Ukrainian, Belarusian, Serbian, Macedonian, Kazakh,
// Tatar...): a name containing one is not Russian.
const NON_RUSSIAN_CYRILLIC = /[\u0406\u0456\u0407\u0457\u0404\u0454\u0490\u0491\u040E\u045E\u0402\u0452\u0408\u0458\u0409\u0459\u040A\u045A\u040B\u045B\u040F\u045F\u0403\u0453\u040C\u045C\u0405\u0455\u04D8\u04D9\u0492\u0493\u049A\u049B\u04A2\u04A3\u04E8\u04E9\u04B0\u04B1\u04AE\u04AF\u04BA\u04BB\u04C0\u04CF]/;
const LATIN_LETTER = /[A-Za-z\u00C0-\u024F]/;

/** Strip the U+0301 stress marks of Cyrillic names, normalise to NFC, collapse runs of whitespace, trim. */
export function clean(s) {
  if (s == null) return '';
  return String(s).normalize('NFD').replace(STRESS, '$1').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export const hasCyrillic = (s) => CYRILLIC.test(s || '');

/** A Russian name: Cyrillic, no letters of other Cyrillic alphabets, no Latin letters but Roman numerals ("\u0413\u0435\u043E\u0440\u0433\u0430 VI"). */
export function isRussian(s) {
  if (!s || !CYRILLIC.test(s) || NON_RUSSIAN_CYRILLIC.test(s)) return false;
  return !LATIN_LETTER.test(s.replace(/\b[IVXLCDM]+\b/g, ''));
}

/** A name written in capitals only ("INDIAN OCEAN"); abbreviations of up to 4 letters ("USA", "UAE") do not count. */
export function isAllCaps(s) {
  const letters = (s || '').replace(/[^\p{L}]/gu, '');
  return letters.length > 4 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

/** Letters of a script other than Latin (Cyrillic, Greek, Arabic, Hebrew, CJK...): not an English title. */
export const hasNonLatinLetters = (s) => /[^\p{Script=Latin}\P{L}]/u.test(s || '');

/** "INDIAN OCEAN" -> "Indian Ocean"; the small words of English names stay lower case. */
export function titleCase(s) {
  if (!isAllCaps(s)) return s;
  const small = new Set(['of', 'the', 'and', 'de', 'la', 'del', 'du']);
  return s.toLowerCase().split(' ').map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** Countries whose GeoNames names romanise Cyrillic (BGN/PCGN), where an apostrophe stands for the soft sign. */
export const SOFT_SIGN_COUNTRIES = new Set([
  'RU', 'UA', 'BY', 'KZ', 'KG', 'TJ', 'UZ', 'TM', 'AZ', 'AM', 'GE', 'MD', 'MN', 'BG',
]);

/**
 * Romanisation apostrophes that English titles do not write: "Mil'kovo" -> "Milkovo", "Ust'-Kut" -> "Ust-Kut". Applied
 * to the names of SOFT_SIGN_COUNTRIES only: elsewhere an apostrophe is part of the spelling (O'Higgins, L'Aquila,
 * Ma'ale Adumim). An apostrophe after two or more letters and before a lower-case letter, a hyphen or the end of the
 * word is dropped ("Ryazan'" -> "Ryazan", "Homyel'" -> "Homyel"; final architecture 2.1, name hygiene).
 */
export function cleanRomanisation(s, iso2) {
  if (!SOFT_SIGN_COUNTRIES.has(iso2)) return s || '';
  return (s || '').replace(/(\p{L}{2,})['\u2019\u02BC\u02B9\u2018`](?=[\p{Ll}-]|(?![\p{L}\p{N}]))/gu, '$1');
}

/**
 * Countries whose GeoNames names are BGN/PCGN romanisations of Arabic, Persian or South Asian scripts, with macrons,
 * dots and ayn/hamza marks that English titles do not write ("Hyder\u0101b\u0101d", "\u1E28awall\u012B", "Ta\u2019if").
 */
export const ROMANISED_MARKS_COUNTRIES = new Set([
  'IR', 'AF', 'PK', 'IN', 'BD', 'NP', 'LK', 'IQ', 'SY', 'SA', 'YE', 'OM', 'AE', 'QA', 'BH', 'KW', 'JO', 'LB', 'EG', 'LY',
  'TN', 'DZ', 'MA', 'SD', 'MR', 'PS', 'EH', 'TJ',
]);
/** Greek transliterations keep the tonos as an acute accent ("Ier\u00E1petra"); English titles drop it. */
export const GREEK_COUNTRIES = new Set(['GR', 'CY']);

/**
 * Apple's English style for town names, applied after the romanisation cleanup:
 * - Japan: no Hepburn macrons ("Hachioji", "Chofu", where GeoNames writes "Hachi\u014Dji", "Ch\u014Dfu");
 * - ROMANISED_MARKS_COUNTRIES: no macrons, dots, cedillas or breves on Latin letters, no ayn/hamza marks ("Hyderabad");
 * - Greece and Cyprus: no accents on vowels ("Ierapetra");
 * - everywhere: a typographic apostrophe becomes an ASCII one.
 * Other languages keep their letters ("Kahramanmara\u015F", "Krak\u00F3w", "Chill\u00E1n"), as Apple writes them.
 */
export function appleStyle(s, iso2) {
  let out = s || '';
  const strip = (re) => {
    out = out.normalize('NFD').replace(re, '').normalize('NFC');
  };
  if (iso2 === 'JP') strip(/(?<=[AEIOUaeiou][\u0300-\u036F]*)[\u0304\u0302]/g);
  if (ROMANISED_MARKS_COUNTRIES.has(iso2)) {
    strip(/(?<=[A-Za-z][\u0300-\u036F]*)[\u0304\u0323\u0307\u0327\u032E\u0331\u0306\u0302\u0301\u0300]/g);
    // Ayn and hamza marks inside a word and at its end ("Ta'if" -> "Taif", "Fayfa'" -> "Fayfa").
    out = out.replace(/(?<=\p{L})[\u02BB\u02BC\u2018\u2019'`](?=\p{L}|(?![\p{L}\p{N}]))/gu, '').replace(/[\u02BB\u02BC\u2018]/g, '');
  }
  if (GREEK_COUNTRIES.has(iso2)) strip(/(?<=[AEIOUYaeiouy][\u0300-\u036F]*)[\u0301\u0308]/g);
  return out.replace(/[\u2019\u02BC]/g, "'");
}

/**
 * The administrative suffix GeoNames' English names carry in Korea, North Korea and China ("Goyang-si", "Hwasun-gun",
 * "Zhu Cheng City", "Jeju City") and Japan ("Nara-shi", "Nishi-Tokyo-shi"): an English title, as Apple writes it, has
 * none. Elsewhere " City" is part of the name (Quezon City, Oklahoma City, New Taipei City).
 */
export function stripAdminSuffix(s, iso2) {
  let out = s || '';
  if (iso2 === 'KR' || iso2 === 'KP') out = out.replace(/(?<=\p{L}{2})(-si|-gun| City)$/u, '');
  else if (iso2 === 'CN') out = out.replace(/(?<=\p{L}{2}) City$/u, '');
  else if (iso2 === 'JP') out = out.replace(/(?<=\p{L}{2})-shi$/u, '');
  return out;
}

/** Words of an administrative unit that an English town title does not carry ("Kawasaki City", "Ota-ku", "Gmina X"). */
const ADMIN_WORDS = /\b(City|city|District|district|Township|Municipality|Gmina|Village|Town|Prefecture|County|Shi|Ku)\b|-(ku|shi|gun|machi|cho|mura)\b|D\.C\./;

/** Letters only, without diacritics and case: "Krak\u00F3w" and "Krakow" compare equal. */
const skeleton = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036F]/g, '').replace(/[^\p{L}]/gu, '').toLowerCase();

/** A name's letters and digits without diacritics, case or a leading Arabic article ("Al Fayyum" ~ "Faiyum"). */
export function nameSkeleton(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036F]/g, '').toLowerCase()
    .replace(/(^|[\s-])(al|el|ash|as|ad|an|ar|at|az|ath|ez|es|ed|en|er|et)[\s-]/g, '$1').replace(/[^\p{L}\p{N}]/gu, '');
}

function levenshtein(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** How alike two names are, 0..1: 1 when one skeleton contains the other (4 letters or more), else 1 - edit distance / length. */
export function nameSimilarity(a, b) {
  const x = nameSkeleton(a);
  const y = nameSkeleton(b);
  if (!x || !y) return 0;
  if (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))) return 1;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

/**
 * Whether GeoNames' preferred English alternate should replace the town's name: an exonym (Cologne for K\u00F6ln,
 * Mecca for Makkah), not a copy without diacritics (Krakow), not an administrative form (Kawasaki City, Ota-ku).
 */
export function isEnglishExonym(name, alt) {
  if (!alt || alt === name) return false;
  if (skeleton(alt) === skeleton(name)) return false;
  if (ADMIN_WORDS.test(alt) && !ADMIN_WORDS.test(name)) return false;
  return true;
}

/**
 * The first letter in capitals, as a title starts ("La Nucia", "Uezd Tszyai" for "uezd Tszyai"), except names whose
 * lower-case start is part of the spelling: isiZulu locatives ("eManzimtoti") and Dutch "'s-" / "'t".
 */
export function capitalizeFirst(s) {
  if (!s || /^e\p{Lu}/u.test(s) || /^['\u2019]/.test(s)) return s || '';
  const first = s.match(/\p{L}/u);
  if (!first || first.index !== 0) return s;
  return s.charAt(0).toLocaleUpperCase('en') + s.slice(1);
}

/** Problems of one name, as short codes (empty when the name is clean). */
export function nameProblems(s, { language }) {
  const out = [];
  if (s == null || s === '') return out;
  if (s !== s.trim()) out.push('outer-space');
  if (/\s{2,}/.test(s)) out.push('double-space');
  if (/\u0301/.test(s)) out.push('stress-mark');
  if (/[\t\n\r]/.test(s)) out.push('control');
  if (isAllCaps(s)) out.push('all-caps');
  if (/^\p{Ll}/u.test(s) && capitalizeFirst(s) !== s) out.push('lower-case-start');
  if (language === 'en' && hasCyrillic(s)) out.push('cyrillic-in-en');
  if (language === 'ru' && !isRussian(s)) out.push('not-russian');
  return out;
}
