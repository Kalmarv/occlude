/**
 * Resolution and lowering: recorded shapes → snapped paper-space primitives.
 *
 * Order per shape: resolve lengths (paper now known) → lower to primitives in
 * drawable-space mm → apply the transform chain → offset into paper → snap to
 * the 0.005 mm grid. Every coordinate is snapped before any geometry op sees
 * it; intersection results downstream are never snapped.
 */

import { geomClosed } from './shapes.js';
import { apply, conformalScale, det, IDENTITY, invert, isConformal, mul, rotate, scale as mscale, translate, type Mat } from './matrix.js';
import { arcToCubics, flattenPrim, snapPrim, type Prim } from './prims.js';
import type { ModifierValue, Shape, ShapeGeom, PathCmd } from './shapes.js';
import type { Execution, TransformOp } from './execution.js';
import type { Placement } from './placement.js';
import { euclideanSpace, fromSheet, geodesicBowOf, INK_TOL, type Space } from './space.js';
import type { Vec } from './vec.js';
import { chordMiddle, POLE_EPS } from './chord.js';
import { resolveLen, type L, type UnitCtx } from './units.js';

export interface Frame {
  /** Drawable (aspect-fitted, margin-inset) area size in mm. */
  inner: UnitCtx;
  /** Paper offset of the drawable origin, mm. */
  offsetX: number;
  offsetY: number;
  origin: 'topLeft' | 'center';
  yUp: boolean;
  rectMode: 'corner' | 'center';
  /** Paper size, mm. */
  paperW: number;
  paperH: number;
  /**
   * The run's geometry. Absent — which is what a Euclidean run leaves —
   * is the flat plane and the literal lowering every sketch has always
   * run.
   *
   * It is attached NON-ENUMERABLY, because a frame is transport: the
   * studio's render worker posts `scene.frame` to the main thread, and a
   * record of closures cannot be structured-cloned; tests compare two runs'
   * frames with a deep equality that reads functions by reference. Neither
   * sees this field, and `frame.space` reads it as any other.
   */
  readonly space?: Space;
}

/** What the frame needs of a run — the paper-independent part. An
 * `Execution` satisfies it, and so does a plain literal, which is what lets
 * the frame math be exercised on its own. */
export type FrameInput = Pick<Execution, 'marginPct' | 'aspect' | 'origin' | 'yUp' | 'rectMode'> & { space?: Space };

/** Compute the drawable frame for a paper choice. */
export function makeFrame(
  state: FrameInput,
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
  const frame: Frame = {
    inner: { innerW, innerH },
    offsetX: m + (availW - innerW) / 2,
    offsetY: m + (availH - innerH) / 2,
    origin: state.origin,
    yUp: state.yUp,
    rectMode: state.rectMode,
    paperW,
    paperH,
  };
  // A flat run's frame is the object it has always been, key for key. Only
  // a curved one carries the space, and then out of sight of transport (see
  // `Frame.space`).
  if (state.space !== undefined && state.space.kind !== 'euclidean') {
    Object.defineProperty(frame, 'space', { value: state.space, enumerable: false });
  }
  return frame;
}

/** The run's geometry when it is not the flat plane, else null: the one
 * test both lowering doors branch on. */
function curvedSpace(frame: Frame): Space | null {
  const s = frame.space;
  return s !== undefined && s.kind !== 'euclidean' ? s : null;
}

/** The flat plane's record, for a FLAT sketch that holds a placement: its
 * `project` is the identity and its `geodesic` is the straight midpoint, so
 * the placed lowering below reads it and does the right thing without a
 * second code path. A flat sketch with no placement never touches it. */
const FLAT = euclideanSpace();

class Resolver {
  constructor(readonly frame: Frame) {}

  get rectMode(): 'corner' | 'center' {
    return this.frame.rectMode;
  }

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

/**
 * Inverse of the user→paper mapping (frame origin/yUp, no transform chain):
 * paper mm → user coordinates in bare units. Used to sample field functions
 * over the page in the coordinates the sketch was written in.
 */
export function paperToUser(frame: Frame): (x: number, y: number) => [number, number] {
  const { innerW, innerH } = frame.inner;
  const unit = Math.min(innerW, innerH) / 100;
  return (px, py) => {
    let lx = px - frame.offsetX;
    let ly = py - frame.offsetY;
    if (frame.origin === 'center') {
      lx -= innerW / 2;
      ly -= innerH / 2;
    } else if (frame.yUp) {
      ly -= innerH;
    }
    if (frame.yUp) ly = -ly;
    return [lx / unit, ly / unit];
  };
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
    // `origin` is the pivot for rotate and scale: the op is
    // T(origin) · R · S · T(-origin), inside the op's own translate. The
    // toolkit has already resolved every word to a point (see `pinOrigin`
    // in api.ts), in user coordinates.
    if (op.origin !== undefined && !Array.isArray(op.origin)) {
      throw new Error(`origin reached the lowerer unresolved (${JSON.stringify(op.origin)}) — a shape's origin is resolved by the toolkit`);
    }
    const pivot: [number, number] | null =
      op.origin === undefined ? null : [rz.len(op.origin[0]), rz.len(op.origin[1])];
    if (pivot) m = mul(m, translate(pivot[0], pivot[1]));
    if (op.rotate !== undefined && op.rotate !== 0) {
      m = mul(m, rotate((op.rotate * Math.PI) / 180));
    }
    if (op.scale !== undefined) {
      const [sx, sy] = typeof op.scale === 'number' ? [op.scale, op.scale] : op.scale;
      m = mul(m, mscale(sx, sy));
    }
    if (pivot) m = mul(m, translate(-pivot[0], -pivot[1]));
  }
  return m;
}

/** One element of a transform chain that holds a placement: an affine run
 * folded to a matrix, or a placement between two of them. */
type ChainStep = { mat: Mat; place?: undefined } | { place: Placement; mat?: undefined };

/**
 * The chain as `A0 · P1 · A1 · P2 · A2 …`, outermost first (which is what
 * `tfChain` is): the affine runs folded by `composeChain`, the placements
 * between them, and the INNERMOST run handed back on its own.
 *
 * That innermost run is where the shape's own vertices are placed, and — in
 * a curved sketch — where `placedContours` samples its edges as steps. With
 * no placement in the chain `outer` is empty and `inner` is the whole chain
 * folded exactly as `composeChain` always folded it, matrix for matrix, so
 * the old code path is the old code path.
 */
function splitChain(chain: readonly TransformOp[], rz: Resolver): { outer: ChainStep[]; inner: Mat } {
  const outer: ChainStep[] = [];
  let run: TransformOp[] = [];
  for (const op of chain) {
    if (op.placement === undefined) {
      run.push(op);
      continue;
    }
    if (run.length > 0) {
      outer.push({ mat: composeChain(run, rz) });
      run = [];
    }
    outer.push({ place: op.placement });
  }
  return { outer, inner: composeChain(run, rz) };
}

/**
 * The chain elements OUTSIDE the innermost run, as one map on SKETCH
 * coordinates — the bare numbers a sketch writes, which is drawable
 * millimetres divided by the unit.
 *
 * They run innermost first, which is the END of the outermost-first list: a
 * point under `A0 · P1 · A1` has already been placed by `A1`, so `P1` acts
 * on it next and `A0` last. A placement acts in drawable coordinates, which
 * is what a sketch coordinate is. An affine run acts in USER coordinates,
 * so it goes through the frame's origin/yUp convention and back again,
 * exactly as `lowerToUserContours` does around `placedContours`.
 *
 * Null when there is nothing outside the innermost run, which is every
 * chain a sketch has ever written until now.
 */
function chainMap(outer: readonly ChainStep[], frame: Frame): ((p: readonly [number, number]) => [number, number]) | null {
  if (outer.length === 0) return null;
  const userFrame = userFrameMatrix(frame);
  const back = invert(userFrame);
  const unit = unitMm(frame);
  const steps = outer
    .slice()
    .reverse()
    .map((step) => {
      if (step.place) {
        const p = step.place;
        return (q: readonly [number, number]): [number, number] => {
          const out = p.point(q);
          return [out[0], out[1]];
        };
      }
      const m = step.mat;
      return (q: readonly [number, number]): [number, number] => {
        const [ux, uy] = apply(back, q[0] * unit, q[1] * unit);
        const [vx2, vy2] = apply(m, ux, uy);
        const [dx, dy] = apply(userFrame, vx2, vy2);
        return [dx / unit, dy / unit];
      };
    });
  return (p) => {
    let q: [number, number] = [p[0], p[1]];
    for (const f of steps) q = f(q);
    return q;
  };
}

/** Can the chain outside the innermost run bend a chord?
 *
 * In a curved sketch, yes, whatever it holds. An isometry carries a
 * geodesic onto a geodesic but NOT a coordinate segment onto a coordinate
 * segment, and an edge is the image of its coordinate segment — so a
 * chord sampled to tolerance where it was written is not sampled to
 * tolerance where it is drawn, and the chart magnifies differently there
 * too. The image of an edge is the image of its source curve, sampled on
 * the sheet after the move.
 *
 * In a flat sketch a placement of the plane's own is an isometry of the
 * sheet, and the sheet is the drawing: a chord sampled to tolerance stays
 * one, exactly. An affine run outside a placement and a placement through
 * another space's door (a `spaceOf(…).model` the sketch built itself) can
 * still bend it there. */
function chainBends(outer: readonly ChainStep[], space: Space): boolean {
  if (space.kind !== 'euclidean') return outer.length > 0;
  return outer.some((step) => (step.place ? step.place.door.id !== space.model.id : true));
}

function transformPrim(p: Prim, m: Mat): Prim[] {
  if (p.t === 'line') {
    const [x0, y0] = apply(m, p.x0, p.y0);
    const [x1, y1] = apply(m, p.x1, p.y1);
    return [p.geodesic ? { t: 'line', x0, y0, x1, y1, geodesic: true } : { t: 'line', x0, y0, x1, y1 }];
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
      let [ax, ay] = rz.pos(geom.x, geom.y);
      const w = rz.len(geom.w);
      const h = rz.len(geom.h);
      if ((geom.anchor ?? rz.rectMode) === 'center') {
        ax -= w / 2;
        ay -= h / 2;
      }
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
    case 'area': {
      // The other shape's outline through this same lowerer, with its own
      // transform opts applied, flattened to closed loops of lines: exactly
      // what `t.material(shape)` reads, and what `polygon(loops)` would
      // have been handed had the loops been computed first.
      const o = geom.of.opts;
      return lowerToUserContours(geom.of.geom, { translate: o.translate, rotate: o.rotate, scale: o.scale, origin: o.origin as TransformOp['origin'] }, rz.frame)
        .map((c) => {
          // A closed outline comes back with its start repeated at the end
          // (as `t.material(shape)` also strips): the ring closes with an
          // edge, never a hair of float noise.
          let pts = c.pts;
          const a = pts[0];
          const z = pts[pts.length - 1];
          if (pts.length > 1 && Math.abs(a[0] - z[0]) <= 1e-9 && Math.abs(a[1] - z[1]) <= 1e-9) pts = pts.slice(0, -1);
          return ptsToLines(pts, true);
        })
        .filter((c) => c.length > 0);
    }
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
        current.push(cmd.geodesic ? { t: 'line', x0: cx, y0: cy, x1: x, y1: y, geodesic: true } : { t: 'line', x0: cx, y0: cy, x1: x, y1: y });
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
        const arc = arcThrough(cx, cy, x, y, r, cmd.large === true);
        current.push(arc);
        cx = x;
        cy = y;
        break;
      }
      case 'close': {
        if (Math.abs(cx - sx) > 1e-12 || Math.abs(cy - sy) > 1e-12) {
          current.push(cmd.geodesic ? { t: 'line', x0: cx, y0: cy, x1: sx, y1: sy, geodesic: true } : { t: 'line', x0: cx, y0: cy, x1: sx, y1: sy });
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
 * Arc from (x0,y0) to (x1,y1) with radius |r|. The sign of r picks the
 * side of the chord the centre sits on. |r| below half the chord is clamped
 * to a semicircle. The minor arc unless `large`, which takes the long way
 * round the same centre — so it turns the other way and sweeps 2π less.
 */
function arcThrough(x0: number, y0: number, x1: number, y1: number, r: number, large = false): Prim {
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
  // The other arc about the same centre: the rest of the circle, walked
  // the other way round.
  if (large && sweep !== 0) sweep -= Math.sign(sweep) * 2 * Math.PI;
  return { t: 'arc', cx, cy, r: ar, start, sweep };
}

export interface LoweredShape {
  shape: Shape;
  /** Snapped paper-space contours. */
  contours: Prim[][];
  convex: boolean;
  /** The shape anchor A = G ∘ C compiled to paper: shape-local mm (origin
   * at the intrinsic bbox centre, axes turned by the explicit transforms)
   * → paper mm. Identity-plus-centre for coordinate-placed shapes. */
  anchor: Mat;
  /** The modifier stack the ENGINE runs: the shape's own, less any
   * `smooth` a curved space already ran on the flat outline. */
  modifiers: readonly ModifierValue[];
}

/** User-space mm → paper mm: the paper offset and the origin/yUp frame. */
export function userToPaperMatrix(frame: Frame): Mat {
  return mul(translate(frame.offsetX, frame.offsetY), userFrameMatrix(frame));
}

/** User coordinates in bare units (what a material holds) → paper mm,
 * through the frame's origin/yUp convention and the drawable offset. No
 * drawing transform is applied: a `group({ translate })` around the ink
 * does not move the material. */
export function userUnitsToPaper(frame: Frame): (x: number, y: number) => [number, number] {
  const m = userToPaperMatrix(frame);
  const unit = unitMm(frame);
  return (x, y) => apply(m, x * unit, y * unit);
}

/** The sketch frame both ways: `toUnits` takes a paper point (mm) to the
 * sketch point drawn there, in drawable units under the origin/yUp
 * convention; `toPaper` takes a sketch point to the paper. In a curved space
 * the paper shows the space through its projection, so the two go through
 * `fromSheet` and `project`; a paper point where the sheet shows no place of
 * the space answers a non-finite pair. */
export interface FrameMaps {
  toUnits(px: number, py: number): Vec;
  toPaper(x: number, y: number): Vec;
}

export function frameMaps(frame: Frame): FrameMaps {
  const unit = unitMm(frame);
  const userToPaper = userToPaperMatrix(frame);
  const space = frame.space !== undefined && frame.space.kind !== 'euclidean' ? frame.space : null;
  if (!space) {
    const paperToUnits = mul(mscale(1 / unit, 1 / unit), invert(userToPaper));
    return {
      toUnits: (px, py) => apply(paperToUnits, px, py),
      toPaper: (x, y) => apply(userToPaper, x * unit, y * unit),
    };
  }
  const userToDrawable = mul(translate(-frame.offsetX, -frame.offsetY), userToPaper);
  const drawableToUser = invert(userToDrawable);
  return {
    toUnits: (px, py) => {
      const [x, y] = fromSheet(space, [(px - frame.offsetX) / unit, (py - frame.offsetY) / unit]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [NaN, NaN];
      const [ux, uy] = apply(drawableToUser, x * unit, y * unit);
      return [ux / unit, uy / unit];
    },
    toPaper: (x, y) => {
      const [dx, dy] = apply(userToDrawable, x * unit, y * unit);
      const q = space.project([dx / unit, dy / unit]);
      return [q[0] * unit + frame.offsetX, q[1] * unit + frame.offsetY];
    },
  };
}

/** One bare user unit in mm (percent of the drawable's short side). */
export function unitMm(frame: Frame): number {
  return Math.min(frame.inner.innerW, frame.inner.innerH) / 100;
}

/** An edge that will not sit inside `tol` after this many halvings is one
 * the sheet cannot show anyway. */
const SPACE_DEPTH = 12;

/**
 * The bow, in the space's own metric, a stored chord of a geodesic may
 * keep: `tol` (mm on the sheet, the ink's 0.05 by default) where the
 * drawable's chart is widest (`geodesicBowOf`). The run's own space
 * carries it on its door, computed once when the toolkit resolved it, and
 * that is the number read here; a space built with no paper carries none,
 * and the frame supplies what the door could not. The `line` material
 * door, a tiling's walls and `m.transform` are all sampled to it.
 */
export function geodesicBow(space: Space, frame: Frame, tol = INK_TOL): number {
  const bow = space.model.bow;
  if (bow !== undefined) return bow * (tol / INK_TOL);
  const reach = Math.hypot(frame.inner.innerW, frame.inner.innerH) / 2 / unitMm(frame);
  return geodesicBowOf(space, unitMm(frame), reach, tol);
}

/** How closely the far-side boundary is pinned when a stroke leaves the
 * sheet: a halving each time, so the cut lands within a millionth of the
 * segment it happened on. */
const EDGE_STEPS = 20;

/**
 * An open polyline on a sphere — a STROKE — its x coordinates made
 * CONTINUOUS in place.
 *
 * The sphere's x is the azimuth times `ell`, so it comes round every
 * `period` and tears where it does: the largest x and the smallest name one
 * line. A stroke's segment between two sketch points is the segment between
 * the NEAREST names of its ends, so each point takes the name within half a
 * period of the point before it — already moved, so a run that crosses the
 * tear goes on past it and does not jump back. An AREA's loop is not read
 * this way: it keeps the side its winding names (see `placedContours`).
 * Everything downstream reads x through `sin` and `cos`, which come round
 * too, so a name outside the principal range is as good a place as one in
 * it.
 */
function shortWay(pts: [number, number][], period: number): void {
  const half = period / 2;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i][0] - pts[i - 1][0];
    if (Math.abs(d) > half) pts[i] = [pts[i][0] - period * Math.round(d / period), pts[i][1]];
  }
}

/**
 * A polyline on a sphere, a point ON A POLE given the names of its
 * neighbours.
 *
 * The sphere's y is the latitude times `ell` from the base geodesic, and at
 * `±π/2` every x names the same point: the pole has no azimuth, so the x
 * it carries is noise. A segment to it is the segment to its nearest name,
 * which is the one with the previous point's x — a meridian, and a
 * meridian is a geodesic — and a segment from it the one with the next
 * point's x. So a pole point between two others becomes two points, one
 * name each; the run between them lies on the pole row and its image is
 * the pole itself. A pole point at an end of the run takes the one
 * neighbour it has, and a run of pole points reads the nearest points off
 * the pole on each side. Nothing else moves. `seg` carries each segment's
 * flags (`SEG_CURVE`, `SEG_GEODESIC`) along; the run along the pole row
 * has none.
 */
function poleNames(pts: [number, number][], seg: number[], cy: number, ell: number): { pts: [number, number][]; seg: number[] } {
  const onPole = (p: readonly [number, number]): number => {
    const b = (p[1] - cy) / ell;
    return Math.abs(Math.PI / 2 - Math.abs(b)) < POLE_EPS ? Math.sign(b) : 0;
  };
  if (!pts.some((p) => onPole(p) !== 0)) return { pts, seg };
  const out: [number, number][] = [];
  // `outSeg[k]` is the segment `out[k] → out[k + 1]`, as `seg` is.
  const outSeg: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    // The segment into this point, from the last one kept.
    if (out.length > 0) outSeg.push(seg[i - 1]);
    const pole = onPole(pts[i]);
    if (pole === 0) {
      out.push(pts[i]);
      continue;
    }
    const y = cy + (pole * ell * Math.PI) / 2;
    let j = i + 1;
    while (j < pts.length && onPole(pts[j]) !== 0) j++;
    const before = out.length > 0 ? out[out.length - 1][0] : undefined;
    const after = j < pts.length ? pts[j][0] : undefined;
    const into = before ?? after ?? pts[i][0];
    const from = after ?? into;
    out.push([into, y]);
    // The run between the two names lies on the pole row: its image is the
    // pole itself, no curve to follow.
    if (from !== into) {
      outSeg.push(0);
      out.push([from, y]);
    }
    // The run of pole points is one point with two names; the segment out
    // of it is the one out of the run's last point.
    i = j - 1;
  }
  return { pts: out, seg: outSeg };
}

/**
 * The chart points of one contour, projected, and CUT where the sheet
 * runs out.
 *
 * Every projection of the hyperbolic space covers the whole space, so this
 * hands back one run and does nothing else. The gnomonic and orthographic
 * charts of a sphere show ONE HEMISPHERE, and a point on the far side has
 * no place on the sheet at all: 2D has no occlusion, so the far side is
 * dropped, not hidden. The stroke ends where it crosses the equator —
 * found by halving along the drawn edge itself, not by clipping against a
 * circle standing in for one — and picks up again where it comes back.
 */
function projectRuns(pts: readonly [number, number][], space: Space, unit: number): [number, number][][] {
  const sheet = (p: readonly [number, number]): [number, number] => {
    const q = space.project([p[0] / unit, p[1] / unit]);
    return [q[0] * unit, q[1] * unit];
  };
  const on = (q: readonly [number, number]): boolean => Number.isFinite(q[0]) && Number.isFinite(q[1]);
  /** The last point of `a → b` that is still on the sheet, `a` being on
   * it and `b` not. The two are neighbours in a sampling the placement
   * already refined, so the edge between them is walked in the sketch's
   * own coordinates — the drawn curve, not a geodesic standing in. */
  const edge = (a: readonly [number, number], b: readonly [number, number]): [number, number] => {
    let lo = 0;
    let hi = 1;
    const at = (t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (let i = 0; i < EDGE_STEPS; i++) {
      const mid = (lo + hi) / 2;
      if (on(sheet(at(mid)))) lo = mid;
      else hi = mid;
    }
    return sheet(at(lo));
  };
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  let prev: [number, number] | null = null;
  let prevOn = false;
  for (const p of pts) {
    const q = sheet(p);
    const here = on(q);
    if (here) {
      if (prev && !prevOn) run.push(edge(p, prev));
      run.push(q);
    } else if (prev && prevOn) {
      run.push(edge(prev, p));
      if (run.length > 1) runs.push(run);
      run = [];
    }
    prev = p;
    prevOn = here;
  }
  if (run.length > 1) runs.push(run);
  return runs;
}

/** A flat segment's flags: a piece of a curve the shape draws (sampled by
 * `'curves'`), and a geodesic of the space between its ends (a path
 * segment a material edge with `geodesic = 1` wrote). */
const SEG_CURVE = 1;
const SEG_GEODESIC = 2;

/** How much of an outline the placement samples. `'all'` samples every
 * edge to the tolerance: the ink, and the sketch-time doors that read an
 * area's boundary. `'curves'` keeps a straight edge whole and samples only
 * what the shape draws as a curve — `t.material(shape)`, whose vertices
 * are the shape's own. `'none'` samples nothing: the 3D projector's chords
 * are already fine, and a stroke range addresses them by index. */
export type Refine = 'all' | 'curves' | 'none';

/** One placed outline: its points, and — for a circle or an ellipse — the
 * curve itself between two of them. `curve(seg, t)` is the point of the
 * drawn curve a fraction `t` of the way from `pts[seg]` to the next point,
 * ON the curve and not on the chord between them. */
interface PlacedContour {
  pts: [number, number][];
  curve?: (seg: number, t: number) => [number, number];
  /** Segment by segment: is it a geodesic of the space? The round kinds'
   * and a `line`'s edges are, and a path segment that says so; every other
   * edge is the image of its coordinate segment. */
  geodesic?: boolean[];
}

/**
 * A ROUND shape's placement in a curved space (design §10): its points are
 * steps from its anchor. The point at angle θ of `circle(c, r)` is
 * `space.exp(c, r·(cos θ, sin θ))` in the frame at `c` — the circle of the
 * space, every point at distance `r` from `c` — an ellipse the same with
 * `(rx cos θ, ry sin θ)` turned by its rotation, and an ngon the same at
 * its corners. The shape's own transform turns and lengthens the steps.
 *
 * Null for every other shape, whose points are placed where their own
 * numbers name, and in the flat plane, where a step is addition and
 * nothing moves.
 *
 * `step` takes a flat point (sketch coordinates) to its place: its offset
 * from the anchor, taken as a step. `onCurve` takes a flat point to the
 * point of the flat curve at the same angle, so a sample between two
 * vertices lands on the curve and not on their chord; an ngon's outline
 * has no curve, and a smoothed outline is no longer the circle.
 */
function roundPlacing(
  geom: ShapeGeom,
  toDrawable: Mat,
  frame: Frame,
  space: Space,
  smoothed: boolean,
): { anchor: [number, number]; step: (p: readonly [number, number]) => [number, number]; onCurve?: (p: readonly [number, number]) => [number, number] } | null {
  if (space.kind === 'euclidean') return null;
  if (geom.kind !== 'circle' && geom.kind !== 'ellipse' && geom.kind !== 'ngon') return null;
  const rz = new Resolver(frame);
  const unit = unitMm(frame);
  const [cx, cy] = rz.pos(geom.x, geom.y);
  const [ax, ay] = apply(toDrawable, cx, cy);
  const anchor: [number, number] = [ax / unit, ay / unit];
  const step = (p: readonly [number, number]): [number, number] => {
    const q = space.exp(anchor, [p[0] - anchor[0], p[1] - anchor[1]]);
    return [q[0], q[1]];
  };
  if (geom.kind === 'ngon' || smoothed) return { anchor, step };
  const lin: Mat = { ...toDrawable, e: 0, f: 0 };
  const inv = invert(lin);
  if (![inv.a, inv.b, inv.c, inv.d].every(Number.isFinite)) return { anchor, step };
  const rx = Math.abs(rz.len(geom.kind === 'circle' ? geom.r : geom.rx));
  const ry = Math.abs(rz.len(geom.kind === 'circle' ? geom.r : geom.ry));
  const rot = geom.kind === 'ellipse' ? (geom.rotation * Math.PI) / 180 : 0;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const onCurve = (p: readonly [number, number]): [number, number] => {
    // Back into the shape's own axes, the angle there, and out again.
    const [ux, uy] = apply(inv, (p[0] - anchor[0]) * unit, (p[1] - anchor[1]) * unit);
    const lx = ux * cos + uy * sin;
    const ly = -ux * sin + uy * cos;
    const a = Math.atan2(ly * rx, lx * ry);
    const ex = rx * Math.cos(a);
    const ey = ry * Math.sin(a);
    const [qx, qy] = apply(lin, ex * cos - ey * sin, ex * sin + ey * cos);
    return [anchor[0] + qx / unit, anchor[1] + qy / unit];
  };
  return { anchor, step, onCurve };
}

/** Are the edges between a shape's placed corners the space's geodesics?
 * A `line` names the shortest path between its ends, and an ngon in a
 * curved space is its stepped corners joined the shortest way — the
 * regular polygon of the space. A smoothed ngon has no corners left. */
function geodesicEdges(geom: ShapeGeom, space: Space, smoothed: boolean): boolean {
  return geom.kind === 'line' || (geom.kind === 'ngon' && space.kind !== 'euclidean' && !smoothed);
}

/**
 * Chaikin corner cutting on a polyline in drawable mm: pass for pass the
 * engine's own (`chaikin` in pipeline.rs, after `contour_polyline` drops
 * a closed outline's repeated start), so a smoothed shape placed in a
 * curved space is the smoothed flat shape, placed. The closed outline
 * comes back closed on its start again, as the lowering hands it on.
 */
function chaikin(pts: [number, number][], passes: readonly number[], closed: boolean): [number, number][] {
  let poly = pts;
  if (closed && poly.length > 1) {
    const a = poly[0];
    const z = poly[poly.length - 1];
    if (Math.hypot(a[0] - z[0], a[1] - z[1]) < 1e-9) poly = poly.slice(0, -1);
  }
  for (const n of passes) {
    for (let k = 0; k < n; k++) {
      const m = poly.length;
      if (m < 3) break;
      const out: [number, number][] = [];
      const cut = (a: readonly [number, number], b: readonly [number, number]): void => {
        out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      };
      if (closed) {
        for (let i = 0; i < m; i++) cut(poly[i], poly[(i + 1) % m]);
      } else {
        out.push(poly[0]);
        for (let i = 0; i < m - 1; i++) cut(poly[i], poly[i + 1]);
        out.push(poly[m - 1]);
      }
      poly = out;
    }
  }
  return closed && poly.length > 1 ? [...poly, poly[0]] : poly;
}

/**
 * A shape's contours PLACED in a curved space (design §10): the anchor and
 * its offsets, each offset a step from the anchor.
 *
 * A SKETCH COORDINATE IS A POSITION BY STEPS from the drawable's centre —
 * x along the base geodesic, then y along the perpendicular geodesic there.
 * A rect, a path, a polygon and text are placed where their own numbers
 * name, so walls stay shared and a grid stays a grid: their points ARE
 * sketch coordinates, and an EDGE is the image of the flat edge under that
 * placement, which is what `m.map` does to any map. A ROUND shape —
 * circle, ellipse, ngon — is steps from its anchor instead
 * (`roundPlacing`): off the base geodesic the two readings differ, and
 * only the steps give the circle of the space. An ngon's edges and a
 * `line` are geodesics (`geodesicEdges`).
 *
 * Then only the sampling has to be worked out. The flat outline is
 * flattened at `tol` as it always was, and each segment is HALVED again
 * until the projected chord holds the projected image within `tol` — the
 * same adaptive sampling a curve gets, in the flat parameter. A circle's
 * or an ellipse's new points are taken on the flat curve itself, so every
 * point of the placed outline is on the curve of the space.
 *
 * The points come back in drawable millimetres and in SKETCH coordinates:
 * they are the numbers a sketch can keep computing with, which is what
 * `t.material`, `t.sample`, `within` and `polygon` hand back. The
 * PROJECTION is the ink door's last step, so a drawing is projected once
 * and a material is never projected at all.
 *
 * Both doors enter here: `lowerShape` for ink and `lowerToUserContours` for
 * the sketch-time doors.
 */
function placedContours(
  geom: ShapeGeom,
  raw: Prim[][],
  toDrawable: Mat,
  frame: Frame,
  space: Space,
  tol: number,
  refine: Refine = 'all',
  /**
   * The rest of the transform chain — the placements and the affine runs
   * outside the innermost one — as a map on sketch coordinates.
   */
  through?: (p: readonly [number, number]) => [number, number],
  /**
   * Does that rest BEND a chord (see `chainBends`)? A flat sketch's own
   * placement does not, so the sample set is the one the material door
   * already hands back. Anything else — every placement in a curved
   * sketch, an affine run outside a placement, another space's door — is
   * measured on the drawn image instead: the deviation below then reads
   * `project(through(p))`, in SHEET millimetres, against the `tol` the
   * caller already compares in (0.05 mm for ink, a quarter of the
   * thinnest nib the library ships), down to `SPACE_DEPTH` halvings and
   * no complaint at the bottom.
   */
  bends = true,
  /**
   * The bow, in the space's metric, a stored chord of a geodesic may keep
   * (`geodesicBow`). Given, and the edge a geodesic, each chord is judged
   * by how far its own middle — named the way the ink names it — stands
   * from the geodesic's middle, and not on the sheet here: the chord is
   * STORED, and a placement may carry it anywhere.
   */
  bow?: number,
  /**
   * The `smooth` passes the ink door lifted off the shape's modifiers
   * (`liftSmooth`): Chaikin runs on the FLAT outline, before the
   * placement, so it rounds the shape's corners and not the samples of
   * its image.
   */
  smooth?: readonly number[],
): PlacedContour[] {
  const unit = unitMm(frame);
  /** The map the SAMPLING is judged through: the rest of the chain only
   * where the rest of the chain can bend a chord. */
  const bent = through && bends ? through : null;
  const smoothed = smooth !== undefined && smooth.length > 0;
  const round = roundPlacing(geom, toDrawable, frame, space, smoothed);
  // The words that ask for a geodesic ask for it by name, in every
  // projection — and under one that draws a geodesic straight there is
  // nothing left to sample.
  const geodesicEdge = geodesicEdges(geom, space, smoothed);
  // Where the halving works. A geodesic edge runs between PLACED corners,
  // so an ngon's corners are stepped first and halved in place; every
  // other outline is halved in its flat parameter and stepped after.
  const before = geodesicEdge && round ? round.step : null;
  const after = !geodesicEdge && round ? round.step : null;
  const onCurve = !geodesicEdge ? round?.onCurve : undefined;
  const sheet = (p: readonly [number, number]): [number, number] => {
    const w = after ? after(p) : p;
    const q = space.project(bent ? bent(w) : w);
    return [q[0] * unit, q[1] * unit];
  };
  /** A sketch point, through the rest of the chain, back in drawable mm. */
  const placed = (p: readonly [number, number]): [number, number] => {
    const q = through ? through(p) : p;
    return [q[0] * unit, q[1] * unit];
  };
  const mid = geodesicEdge
    ? (a: [number, number], b: [number, number]): [number, number] => {
      const g = space.geodesic(a, b, 0.5);
      return [g[0], g[1]];
    }
    : onCurve
      ? (a: [number, number], b: [number, number]): [number, number] => onCurve([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])
      : (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // On a sphere x comes round every `period`. A stepped point comes back
  // with the name the space gives it; each is renamed within half a period
  // of the one before it, from the anchor on, so a round outline's numbers
  // run on as its drawing does.
  const period = 2 * Math.PI * space.radius;
  const named = (pts: [number, number][]): [number, number][] => {
    if (!round || !(space.curvature > 0)) return pts;
    let ref = round.anchor;
    return pts.map((q) => {
      const r: [number, number] = [q[0] - period * Math.round((q[0] - ref[0]) / period), q[1]];
      ref = r;
      return r;
    });
  };
  const wholeClosed = geomClosed(geom);
  return raw.map((contour): PlacedContour => {
    const prims = contour.flatMap((p) => transformPrim(p, toDrawable));
    let flat: [number, number][] = [];
    // `seg[i]` flags the segment `flat[i] → flat[i + 1]`: a piece of a curve
    // the shape draws or a straight edge of it, and a geodesic or not.
    let seg: number[] = [];
    for (const q of prims) {
      const fp = flattenPrim(q, tol);
      const flags = q.t !== 'line' ? SEG_CURVE : q.geodesic ? SEG_GEODESIC : 0;
      for (let i = flat.length > 0 ? 1 : 0; i < fp.length; i++) {
        if (flat.length > 0) seg.push(flags);
        flat.push(fp[i]);
      }
    }
    if (smooth !== undefined && smoothed) {
      flat = chaikin(flat, smooth, wholeClosed);
      seg = flat.slice(1).map(() => SEG_CURVE);
    }
    // A piece the sketch could not place — a NaN radius from a field that
    // says "not a place", most often — draws nothing, and nothing throws.
    for (const [x, y] of flat) if (!Number.isFinite(x) || !Number.isFinite(y)) return { pts: [] };
    // On a sphere x comes round, so one line has two names. A pole has
    // every x for a name, so a segment to it or from it takes its
    // neighbour's and runs along the meridian. A STROKE's author drew the
    // segment between two names, so the segment is the short way. An
    // AREA's loop keeps the side its winding names: it is walked as drawn,
    // and an edge longer than half the circumference runs the long way,
    // because that is where the drawn edge goes. A geodesic knows both,
    // and a stepped point is renamed after it is placed.
    if (space.curvature > 0 && !geodesicEdge && !round) {
      ({ pts: flat, seg } = poleNames(flat, seg, space.center[1] * unit, space.radius * unit));
      const a = flat[0];
      const z = flat[flat.length - 1];
      const closed = wholeClosed && (geom.kind !== 'path' || (flat.length > 2 && Math.abs(a[0] - z[0]) <= 1e-9 && Math.abs(a[1] - z[1]) <= 1e-9));
      if (!closed) shortWay(flat, 2 * Math.PI * space.radius * unit);
    }
    // A straight geodesic under a straight chart has nothing left to
    // sample — unless a placement stands between the sample and the sheet,
    // which is the one thing that can bend it again.
    if (flat.length === 0 || (geodesicEdge && space.straight && !bent && !before) || refine === 'none') {
      if (!round) {
        const pts = through ? flat.map(([x, y]) => placed([x / unit, y / unit])) : flat;
        return geodesicEdge ? { pts, geodesic: pts.slice(1).map(() => true) } : { pts };
      }
    }
    const src = flat.map(([x, y]) => [x / unit, y / unit] as [number, number]);
    const pts = before ? src.map(before) : onCurve ? src.map(onCurve) : src;
    const out: [number, number][] = pts.length > 0 ? [pts[0]] : [];
    /** Is segment `i - 1 → i` a geodesic of the space? */
    const geodesicAt = (i: number): boolean => geodesicEdge || (seg[i - 1] & SEG_GEODESIC) !== 0;
    /** Is segment `i - 1 → i` one this refinement samples? A geodesic under
     * a chart that draws it straight has nothing to sample. */
    const sampled = (i: number): boolean =>
      refine === 'all' ? !(geodesicAt(i) && space.straight && !bent) : refine === 'curves' && (seg[i - 1] & SEG_CURVE) !== 0;
    /** The midpoint a segment is halved at: on the geodesic for a segment
     * that is one, else the shape's own. */
    const geodesicMid = (a: [number, number], b: [number, number]): [number, number] => {
      const g = space.geodesic(a, b, 0.5);
      return [g[0], g[1]];
    };
    const midAt = (i: number) => (!geodesicEdge && geodesicAt(i) ? geodesicMid : mid);
    // Each output segment's geodesic flag, from the segment it is a piece of.
    const outGeodesic: boolean[] = [];
    const record = (i: number, before: number): void => {
      const g = round !== null || geodesicAt(i);
      for (let k = before; k < out.length; k++) outGeodesic.push(g);
    };
    if (bow !== undefined && geodesicEdge && !through) {
      const chordMid = chordMiddle(space.model);
      const stored = (a: [number, number], b: [number, number], depth: number): void => {
        const m = mid(a, b);
        if (depth >= SPACE_DEPTH || !(space.distance(chordMid(a, b), m) > bow)) {
          out.push(b);
          return;
        }
        stored(a, m, depth + 1);
        stored(m, b, depth + 1);
      };
      for (let i = 1; i < pts.length; i++) {
        const n0 = out.length;
        if (sampled(i)) stored(pts[i - 1], pts[i], 0);
        else out.push(pts[i]);
        record(i, n0);
      }
    } else {
      const halve = (
        a: [number, number], b: [number, number],
        pa: [number, number], pb: [number, number], depth: number,
        mid: (a: [number, number], b: [number, number]) => [number, number],
      ): void => {
        const m = mid(a, b);
        const pm = sheet(m);
        // How far the projected chord runs from the projected image: the
        // distance from the image's middle to the chord itself, not to the
        // chord's middle — a projection need not carry the one to the other.
        const dx = pb[0] - pa[0];
        const dy = pb[1] - pa[1];
        const len = Math.hypot(dx, dy);
        const dev = len > 0
          ? Math.abs(dx * (pm[1] - pa[1]) - dy * (pm[0] - pa[0])) / len
          : Math.hypot(pm[0] - pa[0], pm[1] - pa[1]);
        // A segment that has a place on the sheet at one end and none at the
        // other crosses the edge of a hemisphere chart somewhere inside it.
        // The deviation says nothing there (it is NaN), so the crossing is
        // hunted down by halving instead, and the piece that does have a
        // place is sampled like any other.
        const together = Number.isFinite(pa[0]) === Number.isFinite(pm[0]) && Number.isFinite(pm[0]) === Number.isFinite(pb[0]);
        if ((together && !(dev > tol)) || depth >= SPACE_DEPTH) {
          out.push(b);
          return;
        }
        halve(a, m, pa, pm, depth + 1, mid);
        halve(m, b, pm, pb, depth + 1, mid);
      };
      for (let i = 1; i < pts.length; i++) {
        const n0 = out.length;
        if (sampled(i)) halve(pts[i - 1], pts[i], sheet(pts[i - 1]), sheet(pts[i]), 0, midAt(i));
        else out.push(pts[i]);
        record(i, n0);
      }
    }
    const here = named(after ? out.map(after) : out);
    const geodesic = outGeodesic.some((g) => g) ? outGeodesic : undefined;
    if (!onCurve || !after) return geodesic ? { pts: here.map(placed), geodesic } : { pts: here.map(placed) };
    const n = out.length;
    return {
      pts: here.map(placed),
      ...(geodesic ? { geodesic } : {}),
      curve: (seg, t) => {
        const a = out[seg];
        const b = out[(seg + 1) % n];
        const q = after(onCurve([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
        const ref = here[seg];
        return placed(space.curvature > 0 ? [q[0] - period * Math.round((q[0] - ref[0]) / period), q[1]] : q);
      },
    };
  });
}

/**
 * The frame-less half of `lowerShape`, for sketch-time consumers: a
 * declarative shape value's geometry plus its OWN transform opts, lowered by
 * the one lowerer and flattened to loops in user-space mm — no paper offset,
 * no origin/yUp (those are the outer frame). `within()` tests points here,
 * so its containment agrees with what the shape actually inks: rectMode,
 * arc commands, curve flattening, all one geometry language.
 */
export function lowerToUserLoops(
  geom: ShapeGeom,
  opts: TransformOp | readonly TransformOp[],
  frame: Frame,
  tol = 0.05,
): [number, number][][] {
  return lowerToUserContours(geom, opts, frame, tol).map((c) => c.pts);
}

/** `lowerToUserLoops` with each contour's OWN closure: a path's closed
 * subpath (its `close` lands back on its start) is closed, an open one
 * is open, whatever its neighbours do; every other geometry closes as a
 * whole. Sampling reads this, so a path holding a square and an L gives
 * a ring and a chain. */
export function lowerToUserContours(
  geom: ShapeGeom,
  /** The shape's own op, or a chain of them outermost first — a group's
   * transform over the shape's own, which is how a group is an area. */
  opts: TransformOp | readonly TransformOp[],
  frame: Frame,
  tol = 0.05,
  /** `'curves'` keeps a straight edge whole: the shape's own vertices,
   * which is what `t.material(shape)` hands back (see `Refine`). In the
   * flat plane nothing is sampled but a curve, so the two are one. */
  refine: Exclude<Refine, 'none'> = 'all',
): { pts: [number, number][]; closed: boolean; curve?: (seg: number, t: number) => [number, number]; geodesic?: boolean[] }[] {
  const rz = new Resolver(frame);
  const { outer, inner: m } = splitChain(Array.isArray(opts) ? opts : [opts as TransformOp], rz);
  const wholeClosed = geomClosed(geom);
  const through = chainMap(outer, frame);
  // A placement is a map of the sheet, so a chain that holds one is placed
  // and sampled even in a flat sketch, where the plane's own record
  // projects with the identity.
  const space = curvedSpace(frame) ?? (through ? FLAT : null);
  if (space) {
    // The placement lives in DRAWABLE space, so the origin/yUp convention
    // comes in and goes back out again around it; this door answers in user
    // mm, as it always has.
    const userFrame = userFrameMatrix(frame);
    const back = invert(userFrame);
    // A geodesic edge is stored as chords of its geodesic, and a stored
    // chord is judged in the metric, where no placement can change it.
    const bow = geodesicEdges(geom, space, false) && space !== FLAT ? geodesicBow(space, frame, tol) : undefined;
    return placedContours(
      geom, lowerGeom(geom, rz), mul(userFrame, m), frame, space, tol, refine,
      through ?? undefined, chainBends(outer, space), bow,
    ).map(({ pts, curve, geodesic }) => {
      const user = pts.map(([x, y]) => apply(back, x, y));
      let closed = wholeClosed;
      if (geom.kind === 'path') {
        const a = user[0];
        const z = user[user.length - 1];
        closed = user.length > 2 && !!a && !!z && Math.abs(a[0] - z[0]) <= 1e-9 && Math.abs(a[1] - z[1]) <= 1e-9;
      }
      return {
        pts: user,
        closed,
        ...(curve ? { curve: (seg: number, t: number) => apply(back, ...curve(seg, t)) } : {}),
        ...(geodesic ? { geodesic } : {}),
      };
    });
  }
  return lowerGeom(geom, rz).map((contour) => {
    const pts: [number, number][] = [];
    for (const p of contour) {
      for (const q of transformPrim(p, m)) {
        const fp = flattenPrim(q, tol);
        for (let i = pts.length > 0 ? 1 : 0; i < fp.length; i++) pts.push(fp[i]);
      }
    }
    let closed = wholeClosed;
    if (geom.kind === 'path') {
      const a = pts[0];
      const z = pts[pts.length - 1];
      closed = pts.length > 2 && !!a && !!z && Math.abs(a[0] - z[0]) <= 1e-9 && Math.abs(a[1] - z[1]) <= 1e-9;
    }
    return { pts, closed };
  });
}

/** A bare user-space point in the mm space `lowerToUserLoops` produces —
 * resolved exactly as the lowerer resolves positions. */
export function userPointMm(x: L, y: L, frame: Frame): [number, number] {
  return new Resolver(frame).pos(x, y);
}

/** Full lowering of one shape into snapped paper-space primitives. */
export function lowerShape(shape: Shape, frame: Frame): LoweredShape {
  const rz = new Resolver(frame);
  // The chain as affine runs separated by placements. With no placement in
  // it `inner` is the whole chain and every line below is the line it was.
  const { outer, inner } = splitChain(shape.transform, rz);
  const through = chainMap(outer, frame);
  // paper offset ∘ user frame (origin/yUp) ∘ transform chain: the chain acts
  // in user coordinates, so its rotations pivot around the user's origin.
  const chain = mul(userToPaperMatrix(frame), inner);
  const raw = lowerGeom(shape.geom, rz);
  // A placement bends the sheet even where the sketch's own geometry does
  // not, so a flat sketch holding one takes the placed path too.
  const space = curvedSpace(frame) ?? (through ? FLAT : null);
  const toDrawable = space ? mul(userFrameMatrix(frame), inner) : IDENTITY;
  // A shape that names ranges along its own polyline keeps its own
  // vertices: inserting samples would renumber the segments those ranges
  // address. Its chords come from the 3D projector already fine, so it is
  // placed and not refined.
  const refine = shape.strokeRanges === undefined ? 'all' : 'none';
  // In a curved space `smooth` rounds the FLAT outline, before the
  // placement; the engine runs what is left of the stack.
  const lift = space && space !== FLAT && refine === 'all' ? liftSmooth(shape.modifiers) : null;
  const contours = space
    // Place, sample to tolerance, project, then offset into paper and snap
    // — the same steps the sketch-time door takes, with the projection that
    // only ink needs.
    ? placedContours(
      shape.geom, raw, toDrawable, frame, space, INK_TOL, refine,
      through ?? undefined, chainBends(outer, space), undefined, lift?.passes,
    )
      // One contour in, one contour out wherever the whole of it has a
      // place on the sheet — which is every projection of the hyperbolic
      // space. A hemisphere chart can cut one contour into several, and
      // then each piece is a contour of its own.
      .flatMap(({ pts }) => projectRuns(pts, space, unitMm(frame)).map((run) => {
        const out: Prim[] = [];
        let prev: [number, number] | null = null;
        for (const [x, y] of run) {
          const here: [number, number] = [x + frame.offsetX, y + frame.offsetY];
          // One segment in, one segment out — the flat door never drops a
          // degenerate primitive either, and a shape's segment count is a
          // protocol its stroke ranges read.
          if (prev) out.push(snapPrim({ t: 'line', x0: prev[0], y0: prev[1], x1: here[0], y1: here[1] }));
          prev = here;
        }
        return out;
      }))
    : raw.map((contour) =>
      contour.flatMap((p) => transformPrim(p, chain)).map(snapPrim),
    );
  // A convex outline stays convex under the flat plane's own maps. Under a
  // chart it need not: an ngon's geodesic edges bow in on the Poincaré
  // disk, so a curved space makes no promise and the engine measures.
  const convex = space && space !== FLAT ? false : isConvexGeom(shape.geom);
  // C: the intrinsic bbox centre (pre-transform) — the one anchor every
  // shape kind has, and a fixed point of the shape under G.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of raw) {
    for (const p of c) {
      for (const [x, y] of flattenPrim(p, 0.05)) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y);
        x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }
  const centre = Number.isFinite(x0) ? translate((x0 + x1) / 2, (y0 + y1) / 2) : IDENTITY;
  const anchor = mul(chain, centre);
  // The anchor is where a fill's own frame sits, and `dots` reads its
  // ORIGIN as the place of the tap. Under a curved space the drawing moved,
  // so the origin moves with it: the shape's centre through the space,
  // with the anchor's axes left as the transform chain set them.
  if (space && Number.isFinite(x0)) {
    const unit = unitMm(frame);
    const [dx, dy] = apply(toDrawable, (x0 + x1) / 2, (y0 + y1) / 2);
    // The anchor goes through the very same chain elements the contours
    // did, so a fill's frame and a `dots` tap land with the shape.
    const at: [number, number] = [dx / unit, dy / unit];
    const q = space.project(through ? through(at) : at);
    // A centre on the far side of a hemisphere chart has no place on the
    // sheet; the transform chain's own origin stands, and the contours are
    // gone anyway.
    if (Number.isFinite(q[0]) && Number.isFinite(q[1])) {
      anchor.e = q[0] * unit + frame.offsetX;
      anchor.f = q[1] * unit + frame.offsetY;
    }
  }
  return { shape, contours, convex, anchor, modifiers: lift?.rest ?? shape.modifiers };
}

/**
 * The `smooth` entries a curved space runs on the flat outline, and the
 * stack the engine runs after them. A smooth is lifted only where the
 * engine would have run it on the shape's own outline: before any
 * `roughen` or `deform`, which move the points it would round. The post
 * stage (decimate, wobble, dash) runs after every pre-stage entry
 * whatever the order, so it stays where it is. Passes are clamped as the
 * engine clamps them (1 to 8). Null when there is nothing to lift, and
 * the stack is then the shape's own array.
 */
function liftSmooth(mods: readonly ModifierValue[]): { passes: number[]; rest: ModifierValue[] } | null {
  const passes: number[] = [];
  const rest: ModifierValue[] = [];
  let moved = false;
  for (const m of mods) {
    if (m.kind === 'roughen' || m.kind === 'deform') moved = true;
    if (m.kind === 'smooth' && !moved) passes.push(Math.min(8, Math.max(1, Math.round(m.passes))));
    else rest.push(m);
  }
  return passes.length > 0 ? { passes, rest } : null;
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
    case 'area':
      return false; // the core detects convex all-line contours itself
  }
}
