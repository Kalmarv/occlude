/**
 * TS-side primitive representation, mirroring the core's Line/Arc/Cubic.
 * Values are paper-space millimetres.
 */

export type Prim =
  | { t: 'line'; x0: number; y0: number; x1: number; y1: number }
  | { t: 'arc'; cx: number; cy: number; r: number; start: number; sweep: number }
  | {
      t: 'cubic';
      x0: number; y0: number;
      c0x: number; c0y: number;
      c1x: number; c1y: number;
      x1: number; y1: number;
    };

export const SNAP_GRID = 0.005;

export function snap(v: number): number {
  return Math.round(v / SNAP_GRID) * SNAP_GRID;
}

export function snapPrim(p: Prim): Prim {
  switch (p.t) {
    case 'line':
      return { t: 'line', x0: snap(p.x0), y0: snap(p.y0), x1: snap(p.x1), y1: snap(p.y1) };
    case 'arc':
      return { ...p, cx: snap(p.cx), cy: snap(p.cy), r: snap(p.r) };
    case 'cubic':
      return {
        t: 'cubic',
        x0: snap(p.x0), y0: snap(p.y0),
        c0x: snap(p.c0x), c0y: snap(p.c0y),
        c1x: snap(p.c1x), c1y: snap(p.c1y),
        x1: snap(p.x1), y1: snap(p.y1),
      };
  }
}

export function evalPrim(p: Prim, t: number): [number, number] {
  switch (p.t) {
    case 'line':
      return [p.x0 + (p.x1 - p.x0) * t, p.y0 + (p.y1 - p.y0) * t];
    case 'arc': {
      const a = p.start + t * p.sweep;
      return [p.cx + p.r * Math.cos(a), p.cy + p.r * Math.sin(a)];
    }
    case 'cubic': {
      const mt = 1 - t;
      const a = mt * mt * mt;
      const b = 3 * mt * mt * t;
      const c = 3 * mt * t * t;
      const d = t * t * t;
      return [
        a * p.x0 + b * p.c0x + c * p.c1x + d * p.x1,
        a * p.y0 + b * p.c0y + c * p.c1y + d * p.y1,
      ];
    }
  }
}

/** Exact sub-primitive on [t0, t1]. */
export function subPrim(p: Prim, t0: number, t1: number): Prim {
  switch (p.t) {
    case 'line': {
      const [x0, y0] = evalPrim(p, t0);
      const [x1, y1] = evalPrim(p, t1);
      return { t: 'line', x0, y0, x1, y1 };
    }
    case 'arc':
      return {
        t: 'arc',
        cx: p.cx,
        cy: p.cy,
        r: p.r,
        start: p.start + t0 * p.sweep,
        sweep: (t1 - t0) * p.sweep,
      };
    case 'cubic': {
      // Two-stage de Casteljau extraction.
      const right = splitCubic(p, t0)[1];
      if (Math.abs(1 - t0) < 1e-15) return right;
      const u = (t1 - t0) / (1 - t0);
      return splitCubic(right, u)[0];
    }
  }
}

function splitCubic(
  p: Extract<Prim, { t: 'cubic' }>,
  t: number,
): [Extract<Prim, { t: 'cubic' }>, Extract<Prim, { t: 'cubic' }>] {
  const lerp = (ax: number, ay: number, bx: number, by: number): [number, number] => [
    ax + (bx - ax) * t,
    ay + (by - ay) * t,
  ];
  const ab = lerp(p.x0, p.y0, p.c0x, p.c0y);
  const bc = lerp(p.c0x, p.c0y, p.c1x, p.c1y);
  const cd = lerp(p.c1x, p.c1y, p.x1, p.y1);
  const abbc = lerp(ab[0], ab[1], bc[0], bc[1]);
  const bccd = lerp(bc[0], bc[1], cd[0], cd[1]);
  const mid = lerp(abbc[0], abbc[1], bccd[0], bccd[1]);
  return [
    { t: 'cubic', x0: p.x0, y0: p.y0, c0x: ab[0], c0y: ab[1], c1x: abbc[0], c1y: abbc[1], x1: mid[0], y1: mid[1] },
    { t: 'cubic', x0: mid[0], y0: mid[1], c0x: bccd[0], c0y: bccd[1], c1x: cd[0], c1y: cd[1], x1: p.x1, y1: p.y1 },
  ];
}

/** Convert an arc to cubic segments (for non-conformal transforms). */
export function arcToCubics(a: Extract<Prim, { t: 'arc' }>): Prim[] {
  const segs = Math.max(1, Math.ceil(Math.abs(a.sweep) / (Math.PI / 2)));
  const out: Prim[] = [];
  for (let i = 0; i < segs; i++) {
    const a0 = a.start + (a.sweep * i) / segs;
    const a1 = a.start + (a.sweep * (i + 1)) / segs;
    const d = a1 - a0;
    const k = (4 / 3) * Math.tan(d / 4);
    const cos0 = Math.cos(a0);
    const sin0 = Math.sin(a0);
    const cos1 = Math.cos(a1);
    const sin1 = Math.sin(a1);
    out.push({
      t: 'cubic',
      x0: a.cx + a.r * cos0,
      y0: a.cy + a.r * sin0,
      c0x: a.cx + a.r * (cos0 - k * sin0),
      c0y: a.cy + a.r * (sin0 + k * cos0),
      c1x: a.cx + a.r * (cos1 + k * sin1),
      c1y: a.cy + a.r * (sin1 - k * cos1),
      x1: a.cx + a.r * cos1,
      y1: a.cy + a.r * sin1,
    });
  }
  return out;
}

/** Adaptive flatten to points (including both endpoints), max deviation tol mm. */
export function flattenPrim(p: Prim, tol = 0.05): [number, number][] {
  switch (p.t) {
    case 'line':
      return [
        [p.x0, p.y0],
        [p.x1, p.y1],
      ];
    case 'arc': {
      const dtheta = p.r > tol ? 2 * Math.acos(1 - tol / p.r) : Math.PI / 2;
      const n = Math.max(1, Math.ceil(Math.abs(p.sweep) / dtheta));
      const pts: [number, number][] = [];
      for (let i = 0; i <= n; i++) {
        const a = p.start + (p.sweep * i) / n;
        pts.push([p.cx + p.r * Math.cos(a), p.cy + p.r * Math.sin(a)]);
      }
      return pts;
    }
    case 'cubic': {
      const pts: [number, number][] = [[p.x0, p.y0]];
      const rec = (c: Extract<Prim, { t: 'cubic' }>, depth: number): void => {
        const dx = c.x1 - c.x0;
        const dy = c.y1 - c.y0;
        const dl = Math.hypot(dx, dy);
        const dev =
          dl < 1e-12
            ? Math.hypot(c.c0x - c.x0, c.c0y - c.y0) +
              Math.hypot(c.c1x - c.x0, c.c1y - c.y0)
            : Math.max(
                Math.abs(dx * (c.c0y - c.y0) - dy * (c.c0x - c.x0)) / dl,
                Math.abs(dx * (c.c1y - c.y0) - dy * (c.c1x - c.x0)) / dl,
              );
        if (dev <= tol || depth > 16) {
          pts.push([c.x1, c.y1]);
          return;
        }
        const [l, r] = [subPrim(c, 0, 0.5), subPrim(c, 0.5, 1)] as [
          Extract<Prim, { t: 'cubic' }>,
          Extract<Prim, { t: 'cubic' }>,
        ];
        rec(l, depth + 1);
        rec(r, depth + 1);
      };
      rec(p, 0);
      return pts;
    }
  }
}

export function primBBox(p: Prim): { x0: number; y0: number; x1: number; y1: number } {
  // Conservative control-hull bbox — fine for the uses on the TS side
  // (custom-fill region info); the core computes exact boxes.
  let xs: number[];
  let ys: number[];
  switch (p.t) {
    case 'line':
      xs = [p.x0, p.x1];
      ys = [p.y0, p.y1];
      break;
    case 'arc':
      xs = [p.cx - p.r, p.cx + p.r];
      ys = [p.cy - p.r, p.cy + p.r];
      break;
    case 'cubic':
      xs = [p.x0, p.c0x, p.c1x, p.x1];
      ys = [p.y0, p.c0y, p.c1y, p.y1];
      break;
  }
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}
