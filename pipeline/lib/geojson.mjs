// Geometry helpers operating directly on GeoJSON coordinate arrays.
// Kept dependency-free and fast (no turf) for the hot ADM2->ADM1 join.
//
// Conventions: coordinates are [lng, lat] (WGS84). A Polygon geometry has
// coordinates = [ring, ...]; a MultiPolygon has coordinates = [[ring, ...], ...].
// A "ring" is an array of [lng, lat] pairs.

/** Iterate every polygon (array-of-rings) in a Polygon/MultiPolygon geometry. */
export function eachPolygon(geometry, cb) {
  if (!geometry) return;
  if (geometry.type === 'Polygon') {
    cb(geometry.coordinates);
  } else if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) cb(poly);
  }
}

/** Axis-aligned bounding box [minX, minY, maxX, maxY] over all coords. */
export function bbox(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  eachPolygon(geometry, (poly) => {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  });
  return [minX, minY, maxX, maxY];
}

/** Shoelace signed area of a single ring, in squared degrees (planar). */
export function ringSignedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a / 2;
}

/** |outer| - sum(|holes|) for one polygon (array-of-rings), squared degrees. */
export function polygonArea(poly) {
  if (!poly.length) return 0;
  let area = Math.abs(ringSignedArea(poly[0]));
  for (let i = 1; i < poly.length; i++) area -= Math.abs(ringSignedArea(poly[i]));
  return area;
}

/** Total vertex (coordinate pair) count across a geometry. */
export function countVertices(geometry) {
  let n = 0;
  eachPolygon(geometry, (poly) => {
    for (const ring of poly) n += ring.length;
  });
  return n;
}

/**
 * Round all coordinates in-place to `precision` decimals, dropping consecutive
 * duplicates. Rings that collapse below 4 points (an invalid GeoJSON ring) are
 * dropped; a polygon whose outer ring collapses is dropped entirely.
 */
export function roundCoords(geometry, precision) {
  const f = 10 ** precision;
  const round = (v) => Math.round(v * f) / f;
  const roundRing = (ring) => {
    const out = [];
    let prevX, prevY;
    for (const [x, y] of ring) {
      const rx = round(x), ry = round(y);
      if (rx !== prevX || ry !== prevY) { out.push([rx, ry]); prevX = rx; prevY = ry; }
    }
    if (out.length) {
      const [fx, fy] = out[0];
      const [lx, ly] = out[out.length - 1];
      if (fx !== lx || fy !== ly) out.push([fx, fy]);
    }
    return out.length >= 4 ? out : null; // a valid polygon ring needs >=4 positions
  };
  const roundPoly = (poly) => {
    const outer = roundRing(poly[0]);
    if (!outer) return null; // outer ring collapsed -> drop the whole polygon
    const rings = [outer];
    for (let i = 1; i < poly.length; i++) { const h = roundRing(poly[i]); if (h) rings.push(h); }
    return rings;
  };
  if (geometry.type === 'Polygon') {
    geometry.coordinates = roundPoly(geometry.coordinates) || [];
  } else if (geometry.type === 'MultiPolygon') {
    const polys = [];
    for (const poly of geometry.coordinates) { const rp = roundPoly(poly); if (rp) polys.push(rp); }
    geometry.coordinates = polys;
  }
  return geometry;
}

/** Even-odd point-in-rings test across ALL rings of a polygon (handles holes). */
export function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/** Point-in-geometry for Polygon / MultiPolygon (true if inside any polygon). */
export function pointInGeometry(x, y, geometry) {
  if (geometry.type === 'Polygon') return pointInRings(x, y, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    for (const poly of geometry.coordinates) if (pointInRings(x, y, poly)) return true;
  }
  return false;
}

/**
 * A representative point GUARANTEED to lie inside the geometry (point-on-surface).
 * Strategy: pick the largest polygon; try its outer-ring centroid; if that is not
 * inside (concave / holes), scanline at the centroid latitude and take the midpoint
 * of the widest interior span.
 */
export function representativePoint(geometry) {
  // Largest polygon by area.
  let best = null, bestArea = -1;
  eachPolygon(geometry, (poly) => {
    const a = polygonArea(poly);
    if (a > bestArea) { bestArea = a; best = poly; }
  });
  if (!best) {
    // Degenerate: fall back to first coord.
    const bb = bbox(geometry);
    return [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
  }
  const outer = best[0];
  // Centroid of the outer ring.
  let cx = 0, cy = 0;
  for (const [x, y] of outer) { cx += x; cy += y; }
  cx /= outer.length; cy /= outer.length;
  if (pointInRings(cx, cy, best)) return [cx, cy];

  // Scanline at y = cy: collect x-crossings across all rings of `best`.
  const y = cy;
  const xs = [];
  for (const ring of best) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][1], yj = ring[j][1];
      if ((yi > y) !== (yj > y)) {
        const xi = ring[i][0], xj = ring[j][0];
        xs.push(((xj - xi) * (y - yi)) / (yj - yi) + xi);
      }
    }
  }
  xs.sort((a, b) => a - b);
  // Interior spans are between crossing pairs (0-1, 2-3, ...); pick the widest.
  let wx = cx, wgap = -1;
  for (let i = 0; i + 1 < xs.length; i += 2) {
    const gap = xs[i + 1] - xs[i];
    if (gap > wgap) { wgap = gap; wx = (xs[i] + xs[i + 1]) / 2; }
  }
  return [wx, y];
}

/** True if bbox [minX,minY,maxX,maxY] contains point (x,y). */
export function bboxContains(bb, x, y) {
  return x >= bb[0] && x <= bb[2] && y >= bb[1] && y <= bb[3];
}

// Distance helpers use an equirectangular metric: pass `kx = cos(lat)` so that
// longitude degrees are scaled to match latitude degrees near the query point.
// Distances are only ever compared (ranking), so the units are arbitrary as long
// as the cos(lat) anisotropy is applied consistently. Default kx=1 (planar).

/** Cosine-of-latitude scale factor for the equirectangular metric (clamped). */
export function latScale(lat) {
  return Math.max(0.01, Math.cos((lat * Math.PI) / 180));
}

/** Squared distance from a point to a bbox (0 if inside), equirectangular. */
export function bboxDist2(bb, x, y, kx = 1) {
  const dx = (x < bb[0] ? bb[0] - x : x > bb[2] ? x - bb[2] : 0) * kx;
  const dy = y < bb[1] ? bb[1] - y : y > bb[3] ? y - bb[3] : 0;
  return dx * dx + dy * dy;
}

/** Squared distance from point (px,py) to segment (ax,ay)-(bx,by), equirectangular. */
export function pointSegDist2(px, py, ax, ay, bx, by, kx = 1) {
  const Ax = ax * kx, Bx = bx * kx, Px = px * kx;
  const dx = Bx - Ax, dy = by - ay;
  if (dx === 0 && dy === 0) return (Px - Ax) ** 2 + (py - ay) ** 2;
  let t = ((Px - Ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = Ax + t * dx, cy = ay + t * dy;
  return (Px - cx) ** 2 + (py - cy) ** 2;
}

/** Min squared distance from a point to any edge of a geometry, equirectangular. */
export function nearestEdgeDist2(x, y, geometry, kx = 1) {
  let best = Infinity;
  eachPolygon(geometry, (poly) => {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const d = pointSegDist2(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1], kx);
        if (d < best) best = d;
      }
    }
  });
  return best;
}
