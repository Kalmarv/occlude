/** Bounded polygonal disc sweeps. All union incidence is owned by Clipper's
 * integer arrangement; rounded analytic intersections are never welded. */
import ClipperLib from 'clipper-lib';
import { orient2d } from 'robust-predicates';
export interface Envelope {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  ra: number;
  rb: number;
  va: number;
  vb: number;
  edge: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export type Candidate = { vertex?: number; edge?: number; t?: number };
export interface BoundaryVertex {
  x: number;
  y: number;
  cands: Candidate[];
}
type P = { X: number; Y: number };

function hull(points: P[]): P[] {
  points.sort((a, b) => a.X - b.X || a.Y - b.Y);
  const cross = (a: P, b: P, c: P) => -orient2d(a.X, a.Y, b.X, b.Y, c.X, c.Y);
  const half = (ps: P[]) => {
    const out: P[] = [];
    for (const p of ps) {
      while (
        out.length > 1 &&
        cross(out[out.length - 2], out[out.length - 1], p) <= 0
      )
        out.pop();
      out.push(p);
    }
    return out;
  };
  const a = half(points),
    b = half(points.slice().reverse());
  return a.slice(0, -1).concat(b.slice(0, -1));
}

export function polygonUnion(
  inputs: Envelope[],
  tolerance: number,
  provenance: boolean,
): BoundaryVertex[][] {
  let minRadius = Infinity,
    ox = Infinity,
    oy = Infinity;
  for (const h of inputs) {
    if (h.ra > 0) minRadius = Math.min(minRadius, h.ra);
    if (h.rb > 0) minRadius = Math.min(minRadius, h.rb);
    ox = Math.min(ox, h.ax, h.bx);
    oy = Math.min(oy, h.ay, h.by);
  }
  // Keep isolated small marks representable even with a coarse user tolerance.
  // Powers of two make scaling exact; two grid units fit comfortably inside
  // the reserved quantization budget. Features below the grid can disappear.
  const grid =
    2 ** Math.floor(Math.log2(Math.min(tolerance / 64, minRadius / 1024)));
  if (!Number.isFinite(grid) || grid <= 0)
    throw new Error('thicken: tolerance exceeds coordinate precision');
  const paths: P[][] = [],
    seen = new Set<string>();
  let work = 0;
  const point = (x: number, y: number): P => {
    const X = Math.round((x - ox) / grid),
      Y = Math.round((y - oy) / grid);
    if (
      !Number.isSafeInteger(X) ||
      !Number.isSafeInteger(Y) ||
      Math.max(Math.abs(X), Math.abs(Y)) > 2 ** 50
    )
      throw new Error('thicken: coordinate range exceeds polygon grid budget');
    if (
      Math.abs(ox + X * grid - x) > tolerance / 8 ||
      Math.abs(oy + Y * grid - y) > tolerance / 8
    )
      throw new Error(
        'thicken: coordinates cannot represent the requested tolerance',
      );
    return { X, Y };
  };
  for (const h of inputs) {
    const a = `${h.ax},${h.ay},${h.ra}`,
      b = `${h.bx},${h.by},${h.rb}`,
      key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pts: P[] = [];
    for (const [x, y, r] of [
      [h.ax, h.ay, h.ra],
      [h.bx, h.by, h.rb],
    ]) {
      if (r === 0) {
        pts.push(point(x, y));
        continue;
      }
      const error = Math.min(tolerance / 4, r / 64);
      const n =
        4 * Math.ceil(Math.max(16, Math.PI / Math.acos(1 - error / r)) / 4);
      work += n;
      if (!Number.isFinite(n) || work > 1_000_000)
        throw new Error('thicken: polygon construction budget exceeded');
      for (let j = 0; j < n; j++) {
        const angle = (2 * Math.PI * j) / n;
        pts.push(point(x + r * Math.cos(angle), y + r * Math.sin(angle)));
      }
    }
    const path = hull(pts);
    if (path.length < 3)
      throw new Error('thicken: coordinates cannot represent a positive-radius boundary');
    paths.push(path);
  }
  const clipper = new ClipperLib.Clipper();
  clipper.StrictlySimple = true;
  clipper.PreserveCollinear = provenance;
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
  const result: P[][] = [];
  if (
    !clipper.Execute(
      ClipperLib.ClipType.ctUnion,
      result,
      ClipperLib.PolyFillType.pftNonZero,
      ClipperLib.PolyFillType.pftNonZero,
    )
  )
    throw new Error('thicken: polygon union failed');
  // Clipping can remove collinear source junctions. Restore those exact
  // integer vertices for callback attribution, without altering the boundary.
  let splitWork = 0;
  if (provenance) {
    const points = [
      ...new Map(paths.flat().map((p) => [`${p.X},${p.Y}`, p])).values(),
    ].sort((a, b) => a.X - b.X || a.Y - b.Y);
    for (let ri = 0; ri < result.length; ri++) {
      const path = result[ri],
        expanded: P[] = [];
      for (let i = 0; i < path.length; i++) {
        const a = path[i],
          b = path[(i + 1) % path.length],
          lo = Math.min(a.X, b.X),
          hi = Math.max(a.X, b.X);
        let left = 0,
          right = points.length;
        while (left < right) {
          const mid = (left + right) >>> 1;
          if (points[mid].X < lo) left = mid + 1;
          else right = mid;
        }
        const between: P[] = [];
        for (let j = left; j < points.length && points[j].X <= hi; j++) {
          if (++splitWork > 100_000_000)
            throw new Error('thicken: provenance split budget exceeded');
          const p = points[j];
          if (
            p.Y < Math.min(a.Y, b.Y) ||
            p.Y > Math.max(a.Y, b.Y) ||
            (p.X === a.X && p.Y === a.Y) ||
            (p.X === b.X && p.Y === b.Y)
          )
            continue;
          if (orient2d(a.X, a.Y, b.X, b.Y, p.X, p.Y) === 0) between.push(p);
        }
        between.sort(
          (p, q) => (p.X - q.X) * (b.X - a.X) + (p.Y - q.Y) * (b.Y - a.Y),
        );
        expanded.push(a, ...between);
      }
      result[ri] = expanded;
    }
  }
  let comparisons = 0;
  return result.map((path) =>
    path.map((p) => {
      const x = ox + p.X * grid,
        y = oy + p.Y * grid,
        cands: Candidate[] = [];
      if (provenance) {
        const found = new Set<string>();
        for (const h of inputs) {
          if (++comparisons > 100_000_000)
            throw new Error('thicken: provenance budget exceeded');
          if (
            x < h.minX - tolerance ||
            x > h.maxX + tolerance ||
            y < h.minY - tolerance ||
            y > h.maxY + tolerance
          )
            continue;
          const dx = h.bx - h.ax,
            dy = h.by - h.ay,
            dr = h.rb - h.ra,
            qx = x - h.ax,
            qy = y - h.ay,
            A = dx * dx + dy * dy - dr * dr;
          const D = qx * dx + qy * dy + h.ra * dr;
          const t =
            A > 0
              ? Math.max(0, Math.min(1, D / A))
              : Math.hypot(qx, qy) - h.ra <=
                  Math.hypot(x - h.bx, y - h.by) - h.rb
                ? 0
                : 1;
          const distance = Math.abs(
            Math.hypot(qx - t * dx, qy - t * dy) - (h.ra + t * dr),
          );
          if (distance > tolerance / 2 + grid * 4) continue;
          const c: Candidate =
            t === 0
              ? { vertex: h.va }
              : t === 1
                ? { vertex: h.vb }
                : { edge: h.edge, t };
          const key =
            c.vertex === undefined ? `e${c.edge}:${c.t}` : `v${c.vertex}`;
          if (!found.has(key)) {
            found.add(key);
            cands.push(c);
          }
        }
        if (!cands.length)
          throw new Error('thicken: could not attribute polygon boundary');
      }
      return { x, y, cands };
    }),
  );
}
