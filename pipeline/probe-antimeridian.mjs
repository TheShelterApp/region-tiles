// Edge-case probe: points on/near the antimeridian and poles, where planar
// point-in-polygon can misbehave for dateline-spanning countries.
import { resolveAll } from './lib/resolve.mjs';

const POINTS = [
  [-18.14, 178.44, 'FJI', 'Suva, Fiji (east of dateline)'],
  [-16.80, 179.99, 'FJI', 'Fiji, just west of +180'],
  [64.73, 177.51, 'RUS', 'Anadyr, Chukotka (far-east Russia, near +180)'],
  [51.88, 177.19, 'USA', 'Adak, Aleutian Islands (near +180)'],
  [-43.95, -176.56, 'NZL', 'Chatham Islands, NZ (just east of -180)'],
  [-13.83, -171.77, 'WSM', 'Apia, Samoa'],
  [-21.21, -175.20, 'TON', 'Nukuʻalofa, Tonga'],
  [71.29, -156.79, 'USA', 'Utqiagvik/Barrow, Alaska (Arctic)'],
  [-77.85, 166.67, 'ATA', 'McMurdo, Antarctica (polar)'],
  [78.22, 15.65, 'NOR', 'Longyearbyen, Svalbard (Arctic)'],
  [66.05, -17.34, 'ISL', 'Akureyri, Iceland'],
];

let miss = 0;
for (const [lat, lng, iso, label] of POINTS) {
  const r = resolveAll(lat, lng);
  const good = r.adm0 && r.adm1 && r.adm2 && (!iso || r.adm0 === iso);
  if (!good) miss++;
  console.log(`${good ? '  ✓' : '  ✗'} ${label}: adm0=${r.adm0} adm1=${r.adm1} adm2=${r.adm2}${iso && r.adm0 !== iso ? ` (expected ${iso})` : ''}`);
}
console.log(miss ? `\n${miss} antimeridian/polar point(s) misresolved` : '\nAll antimeridian/polar points resolved as expected');
