// GeoNames town rules shared by the stage, the Wikidata freeze and the build (README, "Towns").

/** The cities5000 rule (GeoNames readme): population > 5000, a seat of a first-order division, a capital, a seat of government. */
export const isCities5000 = (pop, fcode) => pop > 5000 || fcode === 'PPLA' || fcode === 'PPLC' || fcode === 'PPLG';

/** Feature codes the pack drops: historical, abandoned, destroyed places and religious centres. */
export const DROPPED_FCODES = new Set(['PPLH', 'PPLQ', 'PPLW', 'PPLCH']);

/** Whether a cities1000 row belongs to the town set at `minPopulation` (5000 = the cities5000 set, 1000 = all). */
export function keepTown(pop, fcode, minPopulation) {
  if (DROPPED_FCODES.has(fcode)) return false;
  if (minPopulation >= 5000) return isCities5000(pop, fcode);
  return true;
}
