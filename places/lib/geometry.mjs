// Geometry for the place-names pack: the schema-1 geometry codec, Douglas-Peucker, point in polygon, distances.
//
// The iOS reader (Projects/Dependencies/PlaceNames) implements the same arithmetic. The formulas below are part of the
// pack's contract (README, "Lookups"): the release gate compares the two implementations answer for answer.
//
// Coordinates are longitude/latitude degrees, WGS84. A ring is a flat array [x0, y0, x1, y1, ...] without the closing
// vertex. A polygon is [outerRing, ...holes]; a geometry is a list of polygons.

/** Kilometres per degree of a great circle (mean Earth radius 6,371.0088 km). */
export const KM_PER_DEG = (Math.PI * 6371.0088) / 180;

// ---- codec ----------------------------------------------------------------------------------------------------------
// Schema 1 geometry blob: varint(polygons); per polygon varint(rings); per ring varint(vertices) followed by
// vertices x (zigzag(dx), zigzag(dy)) of the quantised coordinates round(lon * q), round(lat * q), each delta taken from
// the ring's previous vertex (the first from 0, 0). Unsigned LEB128 varints; zigzag(v) = v >= 0 ? 2v : -2v - 1.

function pushVarint(out, v) {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`varint: ${v}`);
  while (v >= 128) {
    out.push((v % 128) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

const zigzag = (v) => (v >= 0 ? 2 * v : -2 * v - 1);
const unzigzag = (u) => (u % 2 === 0 ? u / 2 : -(u + 1) / 2);

/** Encode quantised polygons ([[Int ring flat arrays]]) into a schema-1 blob. */
export function encodeGeometry(qpolys) {
  const out = [];
  pushVarint(out, qpolys.length);
  for (const poly of qpolys) {
    pushVarint(out, poly.length);
    for (const ring of poly) {
      const n = ring.length / 2;
      pushVarint(out, n);
      let px = 0;
      let py = 0;
      for (let i = 0; i < n; i++) {
        const x = ring[2 * i];
        const y = ring[2 * i + 1];
        pushVarint(out, zigzag(x - px));
        pushVarint(out, zigzag(y - py));
        px = x;
        py = y;
      }
    }
  }
  return Buffer.from(out);
}

/** Decode a schema-1 blob into quantised polygons (Int32Array rings). Throws on a truncated or overlong blob. */
export function decodeGeometry(buf) {
  let off = 0;
  const read = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (off >= buf.length) throw new Error('geometry: truncated');
      const b = buf[off++];
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
      if (mul > 2 ** 49) throw new Error('geometry: varint too long');
    }
  };
  const polys = [];
  const np = read();
  for (let p = 0; p < np; p++) {
    const rings = [];
    const nr = read();
    for (let r = 0; r < nr; r++) {
      const n = read();
      const ring = new Int32Array(2 * n);
      let x = 0;
      let y = 0;
      for (let i = 0; i < n; i++) {
        x += unzigzag(read());
        y += unzigzag(read());
        ring[2 * i] = x;
        ring[2 * i + 1] = y;
      }
      rings.push(ring);
    }
    polys.push(rings);
  }
  if (off !== buf.length) throw new Error(`geometry: ${buf.length - off} trailing bytes`);
  return polys;
}

/** GeoJSON Polygon/MultiPolygon -> polygons of flat rings in degrees, closing vertices dropped. */
export function fromGeoJSON(geom) {
  if (!geom) return [];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return polys.map((poly) => poly.map((ring) => {
    const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1) : ring;
    const a = new Float64Array(pts.length * 2);
    pts.forEach(([x, y], i) => {
      a[2 * i] = x;
      a[2 * i + 1] = y;
    });
    return a;
  }));
}

/** Quantise degree polygons at q (100000 = 1e-5 deg, 10000 = 1e-4 deg). Consecutive duplicate vertices are kept. */
export function quantise(polys, q) {
  return polys.map((poly) => poly.map((ring) => {
    const out = new Int32Array(ring.length);
    for (let i = 0; i < ring.length; i++) out[i] = Math.round(ring[i] * q);
    return out;
  }));
}

export function countVertices(polys) {
  let n = 0;
  for (const poly of polys) for (const ring of poly) n += ring.length / 2;
  return n;
}

/** [minLng, minLat, maxLng, maxLat] of polygons in degrees (outer rings). */
export function bboxOf(polys, q = 1) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of polys) {
    const r = poly[0];
    if (!r) continue;
    for (let i = 0; i < r.length; i += 2) {
      const x = r[i] / q;
      const y = r[i + 1] / q;
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  }
  return b;
}

// ---- simplification ---------------------------------------------------------------------------------------------------

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return qx * qx + qy * qy;
}

/**
 * Douglas-Peucker on an open ring (closing vertex dropped), tolerance in degrees, planar. The ring's first and last
 * vertices are kept; a result with fewer than 3 vertices returns the ring unchanged.
 */
export function simplifyRing(a, tol) {
  const n = a.length / 2;
  if (n <= 4 || tol <= 0) return a;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [s, e] = stack.pop();
    let worst = -1;
    let wi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist2(a[2 * i], a[2 * i + 1], a[2 * s], a[2 * s + 1], a[2 * e], a[2 * e + 1]);
      if (d > worst) {
        worst = d;
        wi = i;
      }
    }
    if (wi >= 0 && worst > t2) {
      keep[wi] = 1;
      stack.push([s, wi], [wi, e]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(a[2 * i], a[2 * i + 1]);
  return out.length >= 6 ? Float64Array.from(out) : a;
}

/** Simplify every outer ring at `tol` and drop the holes (the marine layer: land is decided by the outlines first). */
export function simplifyOuter(polys, tol) {
  return polys.map((poly) => [simplifyRing(poly[0], tol)]);
}

/** Simplify every ring at `tol`, keeping holes. */
export function simplifyAll(polys, tol) {
  return polys.map((poly) => poly.map((ring) => simplifyRing(ring, tol)));
}

// ---- lookups ----------------------------------------------------------------------------------------------------------
// The point is compared in quantised units: X = lon * q, Y = lat * q, as doubles (no rounding), against the integer
// vertices. Even-odd over all rings of a polygon (holes flip); a geometry holds the point when any polygon does.

/** Even-odd ray cast of (X, Y) against one ring in quantised units. */
export function ringContains(ring, X, Y) {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[2 * i];
    const yi = ring[2 * i + 1];
    const xj = ring[2 * j];
    const yj = ring[2 * j + 1];
    if ((yi > Y) !== (yj > Y) && X < ((xj - xi) * (Y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonContains(poly, X, Y) {
  let inside = false;
  for (const ring of poly) if (ringContains(ring, X, Y)) inside = !inside;
  return inside;
}

/**
 * The distance in km from (lon, lat) to the nearest edge of a quantised polygon set, by point-to-segment distance in
 * a local equirectangular plane around the point: x = (lonV - lon) * cos(lat), y = latV - lat, in degrees, times
 * KM_PER_DEG. Near the antimeridian the point is also tested at lon +/- 360. Returns Infinity when nothing is within
 * `maxKm` of the polygons' boxes (callers pass boxes in `boxes`, one per polygon, in degrees).
 */
export function distanceKm(qpolys, boxes, q, lon, lat, maxKm) {
  const k = Math.cos((lat * Math.PI) / 180);
  const kk = Math.max(k, 1e-6);
  const mdLat = maxKm / KM_PER_DEG;
  const mdLon = mdLat / kk;
  let best = Infinity;
  for (const shift of [0, 360, -360]) {
    const x0 = lon + shift;
    if (shift !== 0 && Math.abs(x0) > 180 + mdLon) continue;
    for (let p = 0; p < qpolys.length; p++) {
      const b = boxes[p];
      if (x0 < b[0] - mdLon || x0 > b[2] + mdLon || lat < b[1] - mdLat || lat > b[3] + mdLat) continue;
      for (const ring of qpolys[p]) {
        const n = ring.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const ax = (ring[2 * j] / q - x0) * k;
          const ay = ring[2 * j + 1] / q - lat;
          const bx = (ring[2 * i] / q - x0) * k;
          const by = ring[2 * i + 1] / q - lat;
          const d = segDist2(0, 0, ax, ay, bx, by);
          if (d < best) best = d;
        }
      }
    }
  }
  return Math.sqrt(best) * KM_PER_DEG;
}

/** Great-circle distance in km (haversine, mean Earth radius). */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r;
  const dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The 1-degree cell of a point: (floor(lat) + 90) * 360 + floor(lon) + 180, with lat 90 and lon 180 clamped in. */
export function cellOf(lat, lon) {
  const la = Math.min(179, Math.max(0, Math.floor(lat) + 90));
  const lo = Math.min(359, Math.max(0, Math.floor(lon) + 180));
  return la * 360 + lo;
}

/** Fibonacci lattice: n points uniform on the sphere, as [lat, lon] (R1's definition). */
export function fibonacci(n) {
  const pts = [];
  const g = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * i + 1) / n;
    const lat = (Math.asin(z) * 180) / Math.PI;
    let lon = ((i * g * 180) / Math.PI) % 360;
    if (lon > 180) lon -= 360;
    pts.push([lat, lon]);
  }
  return pts;
}

/** Planar area in km2 of a quantised polygon (outer minus holes), lon scaled by the cosine of each edge's mean lat. */
export function areaKm2(poly, q) {
  let total = 0;
  poly.forEach((ring, ri) => {
    const n = ring.length / 2;
    let s = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yj = ring[2 * j + 1] / q;
      const yi = ring[2 * i + 1] / q;
      const k = Math.cos((((yi + yj) / 2) * Math.PI) / 180);
      s += (ring[2 * j] / q) * k * yi - (ring[2 * i] / q) * k * yj;
    }
    const a = Math.abs(s / 2) * KM_PER_DEG * KM_PER_DEG;
    total += ri === 0 ? a : -a;
  });
  return total;
}

/** mulberry32: a small seeded generator for reproducible samples. */
export function rng(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
