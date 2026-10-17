// GeoNames town rules shared by the stage, the Wikidata freeze and the build (README, "Towns").

/** The cities5000 rule (GeoNames readme): population > 5000, a seat of a first-order division, a capital, a seat of government. */
export const isCities5000 = (pop, fcode) => pop > 5000 || fcode === 'PPLA' || fcode === 'PPLC' || fcode === 'PPLG';

/** Feature codes the pack drops: historical, abandoned, destroyed places and religious centres. */
export const DROPPED_FCODES = new Set(['PPLH', 'PPLQ', 'PPLW', 'PPLCH']);

/** Seats of a first-order division, capitals and seats of government: GeoNames keeps them in cities5000 at any size. */
export const SEAT_FCODES = new Set(['PPLA', 'PPLC', 'PPLG']);

/**
 * Whether a cities1000 row belongs to the town set at `minPopulation`: every row at 1000 or below (cities1000), else a
 * population above the threshold or a seat (SEAT_FCODES), which at 5000 is exactly GeoNames' cities5000 set (owner
 * decision Q4: towns of 5,000 people or more, plus the seats of first-order divisions, whatever their size).
 */
export function keepTown(pop, fcode, minPopulation) {
  if (DROPPED_FCODES.has(fcode)) return false;
  if (minPopulation <= 1000) return true;
  return pop > minPopulation || SEAT_FCODES.has(fcode);
}
