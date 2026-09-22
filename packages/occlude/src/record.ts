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
import type { Shape, ShapeGeom, PathCmd } from './shapes.js';
import type { Execution, TransformOp } from './execution.js';
import type { Placement } from './placement.js';
import { euclideanSpace, type Space } from './space.js';
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
    // T(origin) · R · S · T(-origin), inside the op's own translate.
    // The chain runs in user coordinates, so 'center' — the drawable's
    // middle — depends on where the frame puts the user origin: under
    // origin 'center' that origin IS the sheet's middle, so the pivot is
    // [0, 0]; under topLeft/yUp it is the half-size away. (yUp only flips
    // the axis in the outer frame matrix, so it pivots like topLeft.)
    const { innerW, innerH } = rz.frame.inner;
    const pivot: [number, number] | null =
      op.origin === undefined
        ? null
        : op.origin === 'center'
          ? rz.frame.origin === 'center'
            ? [0, 0]
            : [innerW / 2, innerH / 2]
          : [rz.len(op.origin[0]), rz.len(op.origin[1])];
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

/** Can the chain outside the innermost run bend a chord? A placement whose
 * door is the sketch's OWN model cannot — it is an isometry of the very
 * space the sampling was judged in — and every other element might. */
function chainBends(outer: readonly ChainStep[], space: Space): boolean {
  return outer.some((step) => (step.place ? step.place.door.id !== space.model.id : true));
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
      return lowerToUserContours(geom.of.geom, { translate: o.translate, rotate: o.rotate, scale: o.scale, origin: o.origin }, rz.frame)
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
        const arc = arcThrough(cx, cy, x, y, r, cmd.large === true);
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

/** One bare user unit in mm (percent of the drawable's short side). */
export function unitMm(frame: Frame): number {
  return Math.min(frame.inner.innerW, frame.inner.innerH) / 100;
}

/** How finely a curved space is sampled, in mm: the tolerance
 * `lowerToUserContours` has always used for a curve, and a quarter of the
 * thinnest nib the library ships. */
const SPACE_TOL = 0.05;
/** An edge that will not sit inside `tol` after this many halvings is one
 * the sheet cannot show anyway. */
const SPACE_DEPTH = 12;

/** How closely the far-side boundary is pinned when a stroke leaves the
 * sheet: a halving each time, so the cut lands within a millionth of the
 * segment it happened on. */
const EDGE_STEPS = 20;

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

/**
 * A shape's contours PLACED in a curved space (design §10): the anchor and
 * its offsets, each offset a step from the anchor.
 *
 * A SKETCH COORDINATE IS A POSITION BY STEPS from the drawable's centre —
 * x along the base geodesic, then y along the perpendicular geodesic there
 * — so a shape's anchor, wherever the transform chain puts it, is placed
 * by those steps, and every point of the shape is its own offset from that
 * anchor taken as steps in the frame carried there. The arithmetic is one
 * line, because the coordinates already say it: a point is placed where
 * its own numbers name. Nothing is bent: an EDGE is the image of the flat
 * edge under that placement, which is what `m.map` does to any map.
 *
 * Only two things then have to be worked out. The flat outline is sampled
 * at `tol` as it always was, and each flat segment is HALVED again until
 * the projected chord holds the projected image within `tol` — the same
 * adaptive sampling a curve gets, in the flat parameter. And a `line`
 * names the shortest path between its two ends, so it is the one word
 * whose edge is the space's geodesic; every other straight run is the
 * image of a straight run.
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
  refine = true,
  /**
   * The rest of the transform chain — the placements and the affine runs
   * outside the innermost one — as a map on sketch coordinates.
   */
  through?: (p: readonly [number, number]) => [number, number],
  /**
   * Does that rest BEND a chord? An isometry of the sketch's own space
   * carries a chord sampled to tolerance onto a chord sampled to
   * tolerance, so it asks for no resampling at all and the sample set is
   * the one the material door already hands back. Anything else — a
   * picture door on a flat sheet, an affine run outside a placement — is
   * measured on the drawn image instead: the deviation below then reads
   * `project(through(p))`, in SHEET millimetres, against the `tol` the
   * caller already compares in (0.05 mm for ink, a quarter of the
   * thinnest nib the library ships), down to `SPACE_DEPTH` halvings and
   * no complaint at the bottom.
   */
  bends = true,
): [number, number][][] {
  const unit = unitMm(frame);
  /** The map the SAMPLING is judged through: the rest of the chain only
   * where the rest of the chain can bend a chord. */
  const bent = through && bends ? through : null;
  const sheet = (p: readonly [number, number]): [number, number] => {
    const q = space.project(bent ? bent(p) : p);
    return [q[0] * unit, q[1] * unit];
  };
  /** A sketch point, through the rest of the chain, back in drawable mm. */
  const placed = (p: readonly [number, number]): [number, number] => {
    const q = through ? through(p) : p;
    return [q[0] * unit, q[1] * unit];
  };
  // The one word that asks for a geodesic asks for it by name, in every
  // projection — and under one that draws a geodesic straight there is
  // nothing left to sample.
  const geodesicEdge = geom.kind === 'line';
  const mid = geodesicEdge
    ? (a: [number, number], b: [number, number]): [number, number] => {
      const g = space.geodesic(a, b, 0.5);
      return [g[0], g[1]];
    }
    : (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return raw.map((contour) => {
    const prims = contour.flatMap((p) => transformPrim(p, toDrawable));
    const flat: [number, number][] = [];
    for (const q of prims) {
      const fp = flattenPrim(q, tol);
      for (let i = flat.length > 0 ? 1 : 0; i < fp.length; i++) flat.push(fp[i]);
    }
    // A piece the sketch could not place — a NaN radius from a field that
    // says "not a place", most often — draws nothing, and nothing throws.
    for (const [x, y] of flat) if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    // A straight geodesic under a straight chart has nothing left to
    // sample — unless a placement stands between the sample and the sheet,
    // which is the one thing that can bend it again.
    if (flat.length === 0 || (geodesicEdge && space.straight && !bent) || !refine) {
      return through ? flat.map(([x, y]) => placed([x / unit, y / unit])) : flat;
    }
    const pts = flat.map(([x, y]) => [x / unit, y / unit] as [number, number]);
    const out: [number, number][] = [pts[0]];
    const halve = (
      a: [number, number], b: [number, number],
      pa: [number, number], pb: [number, number], depth: number,
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
      halve(a, m, pa, pm, depth + 1);
      halve(m, b, pm, pb, depth + 1);
    };
    for (let i = 1; i < pts.length; i++) halve(pts[i - 1], pts[i], sheet(pts[i - 1]), sheet(pts[i]), 0);
    return out.map(placed);
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
  opts: TransformOp,
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
  opts: TransformOp,
  frame: Frame,
  tol = 0.05,
): { pts: [number, number][]; closed: boolean }[] {
  const rz = new Resolver(frame);
  const { outer, inner: m } = splitChain([opts], rz);
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
    return placedContours(
      geom, lowerGeom(geom, rz), mul(userFrame, m), frame, space, tol, true,
      through ?? undefined, chainBends(outer, space),
    ).map((pts) => {
      const user = pts.map(([x, y]) => apply(back, x, y));
      let closed = wholeClosed;
      if (geom.kind === 'path') {
        const a = user[0];
        const z = user[user.length - 1];
        closed = user.length > 2 && !!a && !!z && Math.abs(a[0] - z[0]) <= 1e-9 && Math.abs(a[1] - z[1]) <= 1e-9;
      }
      return { pts: user, closed };
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
  const refine = shape.strokeRanges === undefined;
  const contours = space
    // Place, sample to tolerance, project, then offset into paper and snap
    // — the same steps the sketch-time door takes, with the projection that
    // only ink needs.
    ? placedContours(
      shape.geom, raw, toDrawable, frame, space, SPACE_TOL, refine,
      through ?? undefined, chainBends(outer, space),
    )
      // One contour in, one contour out wherever the whole of it has a
      // place on the sheet — which is every projection of the hyperbolic
      // space. A hemisphere chart can cut one contour into several, and
      // then each piece is a contour of its own.
      .flatMap((pts) => projectRuns(pts, space, unitMm(frame)).map((run) => {
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
  const convex = isConvexGeom(shape.geom);
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
  return { shape, contours, convex, anchor };
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
