/**
 * warp: move part of a drawing and let the rest of it follow.
 *
 * `deform(field)` moves every point independently. That is the right tool for
 * grain and drift, and the wrong one for "pull this corner out": a field has no
 * way to know that a stroke should turn as it stretches, or that a hatch should
 * stay evenly spaced, because it never sees more than one point at a time.
 *
 * A cage does. Every point of the drawing is written once and for all as a
 * fixed weighted combination of the cage's corners — mean value coordinates,
 * which are a closed form, need no solve, and are defined everywhere in the
 * plane. Move the corners and the combination is simply re-evaluated, so the
 * drawing goes with them: strokes turn, spacing opens and closes, and a shape
 * that was a circle comes out as a believable squashed circle rather than a
 * sheared one.
 *
 * `from` and `to` are loops — arrays of points, or any material a chain can be
 * read from — with the same number of corners. There is no cage *type*: a cage
 * is two loops, the way an area here is an input rather than a type.
 *
 * Points outside the cage are carried too, and honestly: mean value
 * coordinates are defined there, so the drawing does not have to be contained.
 * They are only well behaved near it, and a point far outside a badly moved
 * cage can be sent somewhere surprising — which is a property of the
 * coordinates, not a failure to check.
 *
 * Pure: no seed, no paper, no units. Structure is untouched — edges, columns
 * and row order all survive; this moves points and nothing else.
 */

import { Material, material as makeMaterial } from './material.js';

export type Corner = readonly [number, number];

export interface WarpOpts {
  /** The cage as it was, one loop of corners. */
  from: readonly Corner[] | Material;
  /** The same cage, moved. Same number of corners, in the same order. */
  to: readonly Corner[] | Material;
}

function corners(v: readonly Corner[] | Material, what: string): [number, number][] {
  if (v && typeof v === 'object' && 'x' in v && 'y' in v && typeof (v as Material).n === 'number') {
    const m = v as Material;
    return Array.from({ length: m.n }, (_, i) => [m.x[i], m.y[i]] as [number, number]);
  }
  if (!Array.isArray(v)) throw new Error(`warp: { ${what} } must be a loop of corners, or a material to read one from`);
  return v.map((p, i) => {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new Error(`warp: { ${what} } corner ${i} is not a finite [x, y]`);
    return [p[0], p[1]] as [number, number];
  });
}

export function warp(m: Material, opts: WarpOpts): Material {
  const src = makeMaterial(m);
  const a = corners(opts?.from, 'from');
  const b = corners(opts?.to, 'to');
  if (a.length !== b.length) throw new Error(`warp: the cage has ${a.length} corners and the moved cage ${b.length} — they must match, corner for corner`);
  // A cage of fewer than three corners encloses nothing and bends nothing:
  // the material comes through as it is.
  if (a.length < 3) return src;
  const n = a.length;

  const x = new Float64Array(src.n);
  const y = new Float64Array(src.n);
  const w = new Float64Array(n);
  for (let i = 0; i < src.n; i++) {
    const px = src.x[i];
    const py = src.y[i];
    let total = 0;
    let onCorner = -1;
    // Half-angle tangents of the wedge each cage edge subtends at this point.
    // The weight of a corner is the two half-tangents either side of it over
    // its distance — the closed form, no solve.
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    const r = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      dx[j] = a[j][0] - px;
      dy[j] = a[j][1] - py;
      r[j] = Math.hypot(dx[j], dy[j]);
      if (r[j] === 0) onCorner = j;
    }
    if (onCorner >= 0) {
      // Sitting exactly on a corner: it is that corner, and goes where it goes.
      x[i] = b[onCorner][0];
      y[i] = b[onCorner][1];
      continue;
    }
    const half = new Float64Array(n);
    let onEdge = -1;
    let edgeT = 0;
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const cosA = (dx[j] * dx[k] + dy[j] * dy[k]) / (r[j] * r[k]);
      const sinA = (dx[j] * dy[k] - dy[j] * dx[k]) / (r[j] * r[k]);
      // Exactly on the edge between j and k: the wedge is a straight angle and
      // the half-tangent runs away. The point is a plain blend of its two ends.
      if (sinA === 0 && cosA < 0) {
        onEdge = j;
        edgeT = r[j] / (r[j] + r[k]);
        break;
      }
      half[j] = sinA === 0 ? 0 : (1 - cosA) / sinA; // tan(A / 2)
    }
    if (onEdge >= 0) {
      const k = (onEdge + 1) % n;
      x[i] = b[onEdge][0] + (b[k][0] - b[onEdge][0]) * edgeT;
      y[i] = b[onEdge][1] + (b[k][1] - b[onEdge][1]) * edgeT;
      continue;
    }
    for (let j = 0; j < n; j++) {
      const prev = (j + n - 1) % n;
      w[j] = (half[prev] + half[j]) / r[j];
      total += w[j];
    }
    if (!(Math.abs(total) > 0) || !Number.isFinite(total)) {
      x[i] = px;
      y[i] = py;
      continue;
    }
    let nx = 0;
    let ny = 0;
    for (let j = 0; j < n; j++) {
      nx += (w[j] / total) * b[j][0];
      ny += (w[j] / total) * b[j][1];
    }
    x[i] = nx;
    y[i] = ny;
  }
  return new Material(
    x, y,
    Object.fromEntries(Object.entries(src.attrs).map(([k, col]) => [k, Float64Array.from(col)])),
    Uint32Array.from(src.edgeList), src.iteration, src.history,
    Object.fromEntries(Object.entries(src.edgeAttrs).map(([k, col]) => [k, Float64Array.from(col)])),
    { ...src.transfers }, { ...src.edgeTransfers },
  );
}
