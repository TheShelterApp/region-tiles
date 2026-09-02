// ISO3 canonicalization: map Natural Earth's non-standard codes onto the
// canonical ISO3 used by the geoBoundaries ADM2 filenames.
import { ISO_ALIAS } from '../../config.mjs';

/** Canonical ISO3 for a Natural Earth adm0_a3 / ADM0_A3 code. */
export function canonIso(code) {
  if (!code) return null;
  const up = String(code).toUpperCase();
  return ISO_ALIAS[up] || up;
}

/** Pull an ISO3 out of a Natural Earth admin-0 feature's properties. */
export function iso3FromAdmin0(props) {
  // NE 10m admin-0 uses ADM0_A3 (sometimes lowercase keys in mirrors).
  const raw =
    props.ADM0_A3 || props.adm0_a3 || props.ISO_A3 || props.iso_a3 ||
    props.SOV_A3 || props.sov_a3 || props.GU_A3 || props.gu_a3;
  return canonIso(raw);
}

/** Pull a display name out of a Natural Earth admin-0 feature's properties. */
export function nameFromAdmin0(props) {
  return props.ADMIN || props.admin || props.NAME || props.name || props.NAME_LONG || props.name_long || '';
}
