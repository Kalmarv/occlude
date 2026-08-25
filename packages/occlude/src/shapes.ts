/**
 * Shapes. Every shape function records immediately and returns the Shape for
 * chaining. Chainable methods mutate in place — the record is the object.
 */

import { customFill, type CustomFillFn, type FillSpec } from './fills.js';
import { getState, type TransformOp, type Winding } from './state.js';
import type { L } from './units.js';

export type PathCmd =
  | { op: 'move'; x: L; y: L }
  | { op: 'line'; x: L; y: L }
  | { op: 'bezier'; c0x: L; c0y: L; c1x: L; c1y: L; x: L; y: L }
  | { op: 'quad'; cx: L; cy: L; x: L; y: L }
  | { op: 'arc'; x: L; y: L; r: L }
  | { op: 'close' };

export type ShapeGeom =
  | { kind: 'circle'; x: L; y: L; r: L }
  | { kind: 'ellipse'; x: L; y: L; rx: L; ry: L; rotation: number }
  | { kind: 'rect'; x: L; y: L; w: L; h: L; radius: L }
  | { kind: 'line'; x1: L; y1: L; x2: L; y2: L }
  | { kind: 'ngon'; x: L; y: L; sides: number; r: L; rotation: number }
  | { kind: 'points'; pts: [L, L][] }
  | { kind: 'path'; cmds: PathCmd[]; winding: Winding };

export class Shape {
  readonly geom: ShapeGeom;
  /** Transform chain snapshot at record time (outermost first). */
  readonly transform: TransformOp[];
  /** Active clip region ids at record time. */
  readonly clips: number[];
  strokePen: string | null;
  fillSpec: FillSpec | null = null;
  fillPen: string | null = null;
  zIndex: number;
  /** Draw order index — the z tiebreak and default z. */
  readonly order: number;

  constructor(geom: ShapeGeom, from?: Shape) {
    const s = getState();
    this.geom = geom;
    this.transform = from ? [...from.transform] : [...s.tfChain];
    this.clips = from ? [...from.clips] : [...s.clipStack];
    this.strokePen = from ? from.strokePen : s.currentPen;
    this.order = s.drawIndex++;
    // An explicit z override survives cloning; the default draw-index z is
    // re-assigned so the clone stacks where it was drawn.
    this.zIndex = from && from.zIndex !== from.order ? from.zIndex : this.order;
    if (from) {
      this.fillSpec = from.fillSpec;
      this.fillPen = from.fillPen;
    }
    s.shapes.push(this);
  }

  /**
   * Record a duplicate of this shape (same geometry, transform, clips, pens,
   * fill) at the current draw position, and return it for further chaining.
   */
  clone(): Shape {
    return new Shape(cloneGeom(this.geom), this);
  }

  get closed(): boolean {
    const g = this.geom;
    if (g.kind === 'line') return false;
    if (g.kind === 'points') return true;
    if (g.kind === 'path') return g.cmds.some((c) => c.op === 'close');
    return true;
  }

  /**
   * Make the shape opaque. Throws on open paths — fill needs a region.
   * `fill(false)` is opaque with zero ink (occludes, no fill drawn); the
   * stroke is unaffected.
   */
  fill(spec?: FillSpec | CustomFillFn | false, penName?: string): this {
    if (!this.closed) {
      throw new Error('.fill() on an open path — close() it first (fill requires a closed region)');
    }
    const s = getState();
    if (spec === false) spec = { type: 'mask' };
    if (typeof spec === 'function') spec = customFill(spec);
    this.fillSpec = spec ?? { type: 'hatch', passes: [{ angle: 0, spacing: undefined, offset: 0 }] };
    const p = penName ?? s.currentPen;
    if (!s.penLib.has(p)) {
      throw new Error(`unknown pen '${p}'`);
    }
    this.fillPen = p;
    return this;
  }

  /**
   * Occlude everything beneath this shape but draw nothing at all — no fill
   * ink, no stroke. The hidden-line renderer's workhorse.
   */
  mask(): this {
    return this.fill(false).noStroke();
  }

  /** Outline pen, or `false` for fill-only. */
  stroke(p: string | false): this {
    if (p === false) {
      this.strokePen = null;
      return this;
    }
    if (!getState().penLib.has(p)) {
      throw new Error(`unknown pen '${p}'`);
    }
    this.strokePen = p;
    return this;
  }

  noStroke(): this {
    return this.stroke(false);
  }

  /** Set stroke and fill pen together. */
  pen(p: string): this {
    if (!getState().penLib.has(p)) {
      throw new Error(`unknown pen '${p}'`);
    }
    this.strokePen = p;
    if (this.fillSpec) this.fillPen = p;
    return this;
  }

  /** Explicit stacking override; default z is draw index. */
  z(n: number): this {
    this.zIndex = n;
    return this;
  }
}

export function circle(x: L, y: L, r: L): Shape {
  return new Shape({ kind: 'circle', x, y, r });
}

export function ellipse(x: L, y: L, rx: L, ry: L, rotation = 0): Shape {
  return new Shape({ kind: 'ellipse', x, y, rx, ry, rotation });
}

export function rect(x: L, y: L, w: L, h: L, radius: L = 0): Shape {
  return new Shape({ kind: 'rect', x, y, w, h, radius });
}

export function line(x1: L, y1: L, x2: L, y2: L): Shape {
  return new Shape({ kind: 'line', x1, y1, x2, y2 });
}

export function polygon(x: L, y: L, sides: number, r: L, rotation?: number): Shape;
export function polygon(points: [L, L][]): Shape;
export function polygon(
  a: L | [L, L][],
  y?: L,
  sides?: number,
  r?: L,
  rotation = 0,
): Shape {
  if (Array.isArray(a)) {
    return new Shape({ kind: 'points', pts: a });
  }
  return new Shape({
    kind: 'ngon',
    x: a,
    y: y as L,
    sides: sides as number,
    r: r as L,
    rotation,
  });
}

/** Deep copy of a geometry record (paths and point lists are mutable). */
function cloneGeom(geom: ShapeGeom): ShapeGeom {
  switch (geom.kind) {
    case 'path':
      return { ...geom, cmds: geom.cmds.map((c) => ({ ...c })) };
    case 'points':
      return { ...geom, pts: geom.pts.map(([x, y]) => [x, y] as [typeof x, typeof y]) };
    default:
      return { ...geom };
  }
}

export class PathBuilder extends Shape {
  private cmds: PathCmd[];

  constructor(winding: Winding, from?: PathBuilder) {
    const cmds: PathCmd[] = from ? from.cmds.map((c) => ({ ...c })) : [];
    super({ kind: 'path', cmds, winding }, from);
    this.cmds = cmds;
  }

  /** Record a duplicate that keeps the builder API for further segments. */
  override clone(): PathBuilder {
    const winding = (this.geom as Extract<ShapeGeom, { kind: 'path' }>).winding;
    return new PathBuilder(winding, this);
  }

  moveTo(x: L, y: L): this {
    this.cmds.push({ op: 'move', x, y });
    return this;
  }

  lineTo(x: L, y: L): this {
    this.cmds.push({ op: 'line', x, y });
    return this;
  }

  bezierTo(c0x: L, c0y: L, c1x: L, c1y: L, x: L, y: L): this {
    this.cmds.push({ op: 'bezier', c0x, c0y, c1x, c1y, x, y });
    return this;
  }

  quadTo(cx: L, cy: L, x: L, y: L): this {
    this.cmds.push({ op: 'quad', cx, cy, x, y });
    return this;
  }

  /**
   * Circular arc from the current point to (x, y) with radius r. Positive r
   * bulges right of the travel direction, negative r bulges left; the minor
   * arc is drawn.
   */
  arcTo(x: L, y: L, r: L): this {
    this.cmds.push({ op: 'arc', x, y, r });
    return this;
  }

  close(): this {
    this.cmds.push({ op: 'close' });
    return this;
  }
}

export function path(opts: { winding?: Winding } = {}): PathBuilder {
  return new PathBuilder(opts.winding ?? 'nonzero');
}
