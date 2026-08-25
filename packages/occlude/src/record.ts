/**
 * Resolution and lowering: recorded shapes → snapped paper-space primitives.
 *
 * Order per shape: resolve lengths (paper now known) → lower to primitives in
 * drawable-space mm → apply the transform chain → offset into paper → snap to
 * the 0.005 mm grid. Every coordinate is snapped before any geometry op sees
 * it; intersection results downstream are never snapped.
 */

import { apply, conformalScale, det, IDENTITY, isConformal, mul, rotate, scale as mscale, translate, type Mat } from './matrix.js';
import { arcToCubics, snapPrim, type Prim } from './prims.js';
import type { Shape, ShapeGeom, PathCmd } from './shapes.js';
import type { State, TransformOp } from './state.js';
import { resolveLen, type L, type UnitCtx } from './units.js';

export interface Frame {
  /** Drawable (aspect-fitted, margin-inset) area size in mm. */
  inner: UnitCtx;
  /** Paper offset of the drawable origin, mm. */
  offsetX: number;
  offsetY: number;
  origin: 'topLeft' | 'center';
  yUp: boolean;
  /** Paper size, mm. */
  paperW: number;
  paperH: number;
}

/** Compute the drawable frame for a paper choice. */
export function makeFrame(
  state: State,
  paperW: number,
  paperH: number,
  stretch = false,
): Frame {
  const m = (state.marginPct / 100) * Math.min(paperW, paperH);
  const availW = paperW - 2 * m;
  const availH = paperH - 2 * m;
  let innerW = availW;
  let innerH = availH;
  if (state.aspect !== 'paper' && !stretch) {
    const [aw, ah] = state.aspect === 'square' ? [1, 1] : state.aspect;
    const s = Math.min(availW / aw, availH / ah);
    innerW = aw * s;
    innerH = ah * s;
  }
  return {
    inner: { innerW, innerH },
    offsetX: m + (availW - innerW) / 2,
    offsetY: m + (availH - innerH) / 2,
    origin: state.origin,
    yUp: state.yUp,
    paperW,
    paperH,
  };
}

class Resolver {
  constructor(private frame: Frame) {}

  /** Scalar length in mm. */
  len(v: L): number {
    return resolveLen(v, this.frame.inner);
  }

  /**
   * Position in USER space mm (origin/yUp are NOT applied here — they form
   * the outermost matrix, so transforms pivot around the user's origin:
   * `push({ rotate })` with origin 'center' spins in place, not around the
   * paper corner).
   */
  pos(x: L, y: L): [number, number] {
    return [this.len(x), this.len(y)];
  }
}

/** User space → drawable space: the origin/yUp convention as a matrix. */
function userFrameMatrix(frame: Frame): Mat {
  const { innerW, innerH } = frame.inner;
  let m =
    frame.origin === 'center'
      ? translate(innerW / 2, innerH / 2)
      : frame.yUp
        ? translate(0, innerH)
        : IDENTITY;
  if (frame.yUp) {
    m = mul(m, mscale(1, -1));
  }
  return m;
}

function composeChain(chain: TransformOp[], rz: Resolver): Mat {
  let m = IDENTITY;
  for (const op of chain) {
    if (op.translate) {
      // User space: with yUp the outer frame matrix flips the axis, so a
      // positive dy here moves "up" exactly as the user's coordinates do.
      const dx = rz.len(op.translate[0]);
      const dy = rz.len(op.translate[1]);
      m = mul(m, translate(dx, dy));
    }
    if (op.rotate !== undefined && op.rotate !== 0) {
      m = mul(m, rotate((op.rotate * Math.PI) / 180));
    }
    if (op.scale !== undefined) {
      const [sx, sy] = typeof op.scale === 'number' ? [op.scale, op.scale] : op.scale;
      m = mul(m, mscale(sx, sy));
    }
  }
  return m;
}

function transformPrim(p: Prim, m: Mat): Prim[] {
  if (p.t === 'line') {
    const [x0, y0] = apply(m, p.x0, p.y0);
    const [x1, y1] = apply(m, p.x1, p.y1);
    return [{ t: 'line', x0, y0, x1, y1 }];
  }
  if (p.t === 'cubic') {
    const [x0, y0] = apply(m, p.x0, p.y0);
    const [c0x, c0y] = apply(m, p.c0x, p.c0y);
    const [c1x, c1y] = apply(m, p.c1x, p.c1y);
    const [x1, y1] = apply(m, p.x1, p.y1);
    return [{ t: 'cubic', x0, y0, c0x, c0y, c1x, c1y, x1, y1 }];
  }
  // Arc: stays an arc under any conformal transform (rotation, uniform
  // scale, and reflection — the yUp frame is a reflection); only non-uniform
  // scale lowers to cubics, because only then do circles stop being circles.
  if (isConformal(m)) {
    const [cx, cy] = apply(m, p.cx, p.cy);
    const s = conformalScale(m);
    const [px, py] = apply(
      m,
      p.cx + p.r * Math.cos(p.start),
      p.cy + p.r * Math.sin(p.start),
    );
    const start = Math.atan2(py - cy, px - cx);
    // Reflections reverse the angular direction of travel.
    const sweep = det(m) > 0 ? p.sweep : -p.sweep;
    return [{ t: 'arc', cx, cy, r: p.r * s, start, sweep }];
  }
  return arcToCubics(p).flatMap((c) => transformPrim(c, m));
}

const KAPPA = 0.5522847498307936;

/** Lower a shape's geometry to contours of primitives in drawable-space mm. */
function lowerGeom(geom: ShapeGeom, rz: Resolver): Prim[][] {
  switch (geom.kind) {
    case 'circle': {
      const [cx, cy] = rz.pos(geom.x, geom.y);
      const r = rz.len(geom.r);
      return [[
        { t: 'arc', cx, cy, r, start: 0, sweep: Math.PI },
        { t: 'arc', cx, cy, r, start: Math.PI, sweep: Math.PI },
      ]];
    }
    case 'ellipse': {
      const [cx, cy] = rz.pos(geom.x, geom.y);
      const rx = rz.len(geom.rx);
      const ry = rz.len(geom.ry);
      const rot = (geom.rotation * Math.PI) / 180;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const pt = (a: number): [number, number] => {
        const ex = rx * Math.cos(a);
        const ey = ry * Math.sin(a);
        return [cx + ex * cos - ey * sin, cy + ex * sin + ey * cos];
      };
      const tang = (a: number): [number, number] => {
        const tx = -rx * Math.sin(a);
        const ty = ry * Math.cos(a);
        return [tx * cos - ty * sin, tx * sin + ty * cos];
      };
      const prims: Prim[] = [];
      const K = KAPPA;
      for (let i = 0; i < 4; i++) {
        const a0 = (i * Math.PI) / 2;
        const a1 = ((i + 1) * Math.PI) / 2;
        const p0 = pt(a0);
        const p1 = pt(a1);
        const t0 = tang(a0);
        const t1 = tang(a1);
        // Quarter-ellipse cubic: control points along tangents, kappa·(π/2 arc).
        const k = K * (2 / Math.PI) * (a1 - a0);
        prims.push({
          t: 'cubic',
          x0: p0[0], y0: p0[1],
          c0x: p0[0] + t0[0] * k, c0y: p0[1] + t0[1] * k,
          c1x: p1[0] - t1[0] * k, c1y: p1[1] - t1[1] * k,
          x1: p1[0], y1: p1[1],
        });
      }
      return [prims];
    }
    case 'rect': {
      const [ax, ay] = rz.pos(geom.x, geom.y);
      const w = rz.len(geom.w);
      const h = rz.len(geom.h);
      // Normalise to positive extents; contour orientation doesn't matter to
      // the nonzero winding rule.
      const x0 = Math.min(ax, ax + w);
      const x1 = Math.max(ax, ax + w);
      const y0 = Math.min(ay, ay + h);
      const y1 = Math.max(ay, ay + h);
      const r = Math.min(rz.len(geom.radius), (x1 - x0) / 2, (y1 - y0) / 2);
      if (r <= 0) {
        return [[
          { t: 'line', x0, y0, x1, y1: y0 },
          { t: 'line', x0: x1, y0, x1, y1 },
          { t: 'line', x0: x1, y0: y1, x1: x0, y1 },
          { t: 'line', x0, y0: y1, x1: x0, y1: y0 },
        ]];
      }
      // Clockwise (y-down screen): top edge → TR corner → right edge → …
      const half = Math.PI / 2;
      const prims: Prim[] = [
        { t: 'line', x0: x0 + r, y0, x1: x1 - r, y1: y0 },
        { t: 'arc', cx: x1 - r, cy: y0 + r, r, start: -half, sweep: half },
        { t: 'line', x0: x1, y0: y0 + r, x1, y1: y1 - r },
        { t: 'arc', cx: x1 - r, cy: y1 - r, r, start: 0, sweep: half },
        { t: 'line', x0: x1 - r, y0: y1, x1: x0 + r, y1 },
        { t: 'arc', cx: x0 + r, cy: y1 - r, r, start: half, sweep: half },
        { t: 'line', x0, y0: y1 - r, x1: x0, y1: y0 + r },
        { t: 'arc', cx: x0 + r, cy: y0 + r, r, start: Math.PI, sweep: half },
      ];
      return [prims];
    }
    case 'line': {
      const [x0, y0] = rz.pos(geom.x1, geom.y1);
      const [x1, y1] = rz.pos(geom.x2, geom.y2);
      return [[{ t: 'line', x0, y0, x1, y1 }]];
    }
    case 'ngon': {
      const [cx, cy] = rz.pos(geom.x, geom.y);
      const r = rz.len(geom.r);
      const rot = (geom.rotation * Math.PI) / 180 - Math.PI / 2;
      const pts: [number, number][] = [];
      for (let i = 0; i < geom.sides; i++) {
        const a = rot + (i * 2 * Math.PI) / geom.sides;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      return [ptsToLines(pts, true)];
    }
    case 'points': {
      const pts = geom.pts.map(([x, y]) => rz.pos(x, y));
      return [ptsToLines(pts, true)];
    }
    case 'path':
      return lowerPath(geom.cmds, rz);
  }
}

function ptsToLines(pts: [number, number][], close: boolean): Prim[] {
  const prims: Prim[] = [];
  const n = pts.length;
  const end = close ? n : n - 1;
  for (let i = 0; i < end; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % n];
    if (x0 !== x1 || y0 !== y1) {
      prims.push({ t: 'line', x0, y0, x1, y1 });
    }
  }
  return prims;
}

function lowerPath(cmds: PathCmd[], rz: Resolver): Prim[][] {
  const contours: Prim[][] = [];
  let current: Prim[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const flush = () => {
    if (current.length > 0) contours.push(current);
    current = [];
  };
  for (const cmd of cmds) {
    switch (cmd.op) {
      case 'move': {
        flush();
        [cx, cy] = rz.pos(cmd.x, cmd.y);
        sx = cx;
        sy = cy;
        break;
      }
      case 'line': {
        const [x, y] = rz.pos(cmd.x, cmd.y);
        current.push({ t: 'line', x0: cx, y0: cy, x1: x, y1: y });
        cx = x;
        cy = y;
        break;
      }
      case 'bezier': {
        const [c0x, c0y] = rz.pos(cmd.c0x, cmd.c0y);
        const [c1x, c1y] = rz.pos(cmd.c1x, cmd.c1y);
        const [x, y] = rz.pos(cmd.x, cmd.y);
        current.push({ t: 'cubic', x0: cx, y0: cy, c0x, c0y, c1x, c1y, x1: x, y1: y });
        cx = x;
        cy = y;
        break;
      }
      case 'quad': {
        // Exact degree elevation.
        const [qx, qy] = rz.pos(cmd.cx, cmd.cy);
        const [x, y] = rz.pos(cmd.x, cmd.y);
        current.push({
          t: 'cubic',
          x0: cx, y0: cy,
          c0x: cx + (2 / 3) * (qx - cx), c0y: cy + (2 / 3) * (qy - cy),
          c1x: x + (2 / 3) * (qx - x), c1y: y + (2 / 3) * (qy - y),
          x1: x, y1: y,
        });
        cx = x;
        cy = y;
        break;
      }
      case 'arc': {
        const [x, y] = rz.pos(cmd.x, cmd.y);
        const r = rz.len(cmd.r);
        const arc = arcThrough(cx, cy, x, y, r);
        current.push(arc);
        cx = x;
        cy = y;
        break;
      }
      case 'close': {
        if (Math.abs(cx - sx) > 1e-12 || Math.abs(cy - sy) > 1e-12) {
          current.push({ t: 'line', x0: cx, y0: cy, x1: sx, y1: sy });
          cx = sx;
          cy = sy;
        }
        flush();
        break;
      }
    }
  }
  flush();
  return contours;
}

/**
 * Minor arc from (x0,y0) to (x1,y1) with radius |r|. The sign of r picks the
 * side of the chord the centre sits on. |r| below half the chord is clamped
 * to a semicircle.
 */
function arcThrough(x0: number, y0: number, x1: number, y1: number, r: number): Prim {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  const ar = Math.max(Math.abs(r), d / 2);
  const h = Math.sqrt(Math.max(0, ar * ar - (d * d) / 4));
  const side = Math.sign(r) || 1;
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  // Perp of the travel direction.
  const px = (-dy / d) * h * side;
  const py = (dx / d) * h * side;
  const cx = mx + px;
  const cy = my + py;
  const start = Math.atan2(y0 - cy, x0 - cx);
  const end = Math.atan2(y1 - cy, x1 - cx);
  let sweep = end - start;
  // Minor arc: wrap into (-π, π].
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  return { t: 'arc', cx, cy, r: ar, start, sweep };
}

export interface LoweredShape {
  shape: Shape;
  /** Snapped paper-space contours. */
  contours: Prim[][];
  convex: boolean;
}

/** Full lowering of one shape into snapped paper-space primitives. */
export function lowerShape(shape: Shape, frame: Frame): LoweredShape {
  const rz = new Resolver(frame);
  // paper offset ∘ user frame (origin/yUp) ∘ transform chain: the chain acts
  // in user coordinates, so its rotations pivot around the user's origin.
  const m = mul(
    translate(frame.offsetX, frame.offsetY),
    mul(userFrameMatrix(frame), composeChain(shape.transform, rz)),
  );
  const contours = lowerGeom(shape.geom, rz).map((contour) =>
    contour.flatMap((p) => transformPrim(p, m)).map(snapPrim),
  );
  const convex = isConvexGeom(shape.geom);
  return { shape, contours, convex };
}

function isConvexGeom(geom: ShapeGeom): boolean {
  switch (geom.kind) {
    case 'circle':
    case 'ellipse':
    case 'rect':
    case 'ngon':
      return true;
    case 'points':
    case 'path':
    case 'line':
      return false; // the core detects convex all-line contours itself
  }
}
