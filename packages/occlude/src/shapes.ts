/**
 * Shapes. Every shape function records immediately and returns the Shape for
 * chaining. Chainable methods mutate in place — the record is the object.
 */

import { customFill, type CustomFillFn, type FillSpec } from './fills.js';
import type { Execution, TransformOp, Winding } from './execution.js';
import type { L } from './units.js';

export type PathCmd =
  | { op: 'move'; x: L; y: L }
  /** `geodesic`: the segment is the geodesic of the sketch's space between
   * its ends — what a material edge with `geodesic = 1` draws. */
  | { op: 'line'; x: L; y: L; geodesic?: true }
  | { op: 'bezier'; c0x: L; c0y: L; c1x: L; c1y: L; x: L; y: L }
  | { op: 'quad'; cx: L; cy: L; x: L; y: L }
  | { op: 'arc'; x: L; y: L; r: L; large?: boolean }
  | { op: 'close'; geodesic?: true };

/**
 * A field: a scalar that varies over the page. Called with user coordinates
 * (the same bare units the sketch draws in) at encode time and rasterised —
 * any parameter that accepts one samples it by position instead of using
 * one constant everywhere.
 */
export type FieldFn = (x: number, y: number) => number;

/**
 * A field whose value is a LENGTH: a number in user units, or a tagged
 * length such as `mm(0.3)` — the engine resolves each sample against the
 * frame, the same laziness a constant tagged length gets. Modifier params
 * that take a length (`wobble` amount) accept this; a field for a 0…1 param
 * (`decimate`, `wobble` wavelength) is a `FieldFn`.
 */
export type LengthFn = (x: number, y: number) => number | L;

/**
 * A vector field: a displacement (in user units) that varies over the page.
 * Drives `deform` — sampled at encode time in user coordinates.
 */
export type VectorFieldFn = (x: number, y: number) => [number, number];

/**
 * One entry of a shape's modifier stack — a plain value made by the
 * modifier constructors (`decimate(p)`, `wobble(amt)`, …). Post-stage
 * entries run over the shape's final ink after occlusion, in stack order.
 */
/** Where a modifier's field params are anchored: `'paper'` (default)
 * samples in paper coordinates; `'shape'` anchors the field to the shape —
 * A = G ∘ C: the shape's intrinsic bbox centre is field (0, 0) and the
 * field turns with the motif's explicit transforms. */
export type FieldAlign = 'paper' | 'shape';

export type ModifierValue =
  | {
      readonly __occludeModifier: true;
      readonly kind: 'decimate';
      stroke: number | FieldFn;
      fill: number | FieldFn;
      align?: FieldAlign;
    }
  | {
      readonly __occludeModifier: true;
      readonly kind: 'wobble';
      amount: L | LengthFn;
      wavelength?: L;
      align?: FieldAlign;
    }
  | { readonly __occludeModifier: true; readonly kind: 'dash'; len: L; gap: L; offset?: L }
  | { readonly __occludeModifier: true; readonly kind: 'smooth'; passes: number }
  | {
      readonly __occludeModifier: true;
      readonly kind: 'roughen';
      amount: L | FieldFn;
      detail?: L;
      align?: FieldAlign;
    }
  | {
      readonly __occludeModifier: true;
      readonly kind: 'deform';
      field: VectorFieldFn;
      detail?: L;
      align?: FieldAlign;
    };

export type ShapeGeom =
  | { kind: 'circle'; x: L; y: L; r: L }
  | { kind: 'ellipse'; x: L; y: L; rx: L; ry: L; rotation: number }
  | { kind: 'rect'; x: L; y: L; w: L; h: L; radius: L; anchor?: 'corner' | 'center' }
  | { kind: 'line'; x1: L; y1: L; x2: L; y2: L }
  | { kind: 'ngon'; x: L; y: L; sides: number; r: L; rotation: number }
  | { kind: 'points'; pts: [L, L][] }
  | { kind: 'path'; cmds: PathCmd[]; winding: Winding }
  /** The area of another shape (`polygon(circle(…))`): lowered through the
   * same lowerer as the shape itself, at record time, when the run's frame
   * is known — so a shape is an area input anywhere, with no run in hand. */
  | { kind: 'area'; of: { geom: ShapeGeom; opts: TransformOp }; winding: Winding };

/** Is this geometry a closed region? An empty path is the empty region:
 * trivially closed (no boundary), so a generator that produced nothing
 * (isolines above the field max, say) still fills/clips as a no-op instead
 * of throwing. */
export function geomClosed(g: ShapeGeom): boolean {
  if (g.kind === 'line') return false;
  if (g.kind === 'points' || g.kind === 'area') return true;
  if (g.kind === 'path') return g.cmds.length === 0 || g.cmds.some((c) => c.op === 'close');
  return true;
}

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
  /** Endpoint-join tolerance (unresolved length); undefined = no bridging. */
  bridge?: import('./units.js').L;
  preserveStroke = false;
  strokeSeed?: number;
  strokeRanges?: readonly (readonly [number, number])[];
  /** Ordered modifier stack; post-stage entries run after occlusion. */
  modifiers: ModifierValue[] = [];
  /** Draw order index — the z tiebreak and default z. */
  readonly order: number;

  /** The run this shape is recorded in. */
  readonly run: Execution;

  constructor(geom: ShapeGeom, run: Execution, from?: Shape) {
    const s = run;
    this.run = run;
    this.geom = geom;
    this.transform = from ? [...from.transform] : [...s.tfChain];
    this.clips = from ? [...from.clips] : [...s.clipStack];
    this.strokePen = from ? from.strokePen : s.currentPen;
    this.order = s.drawIndex++;
    // An explicit z override survives cloning; the default draw-index z is
    // re-assigned so the clone stacks where it was drawn.
    this.zIndex = from && from.zIndex !== from.order ? from.zIndex : this.order;
    if (from) {
      this.preserveStroke = from.preserveStroke;
      this.strokeSeed = from.strokeSeed;
      this.strokeRanges = from.strokeRanges?.map(r => [...r] as [number, number]);
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
    return new Shape(cloneGeom(this.geom), this.run, this);
  }

  get closed(): boolean {
    return geomClosed(this.geom);
  }

  /**
   * Make the shape opaque — it now hides what's beneath it. Throws on open
   * paths (fill needs a region).
   *
   * - `.fill()` — filled, no texture: occludes, only the stroke draws.
   * - `.fill(spec, pen?)` — occludes and draws the fill texture.
   * - `.fill(false)` — clears the fill: transparent again, stops occluding
   *   (symmetric with `.stroke(false)`).
   */
  fill(spec?: FillSpec | CustomFillFn | false, penName?: string): this {
    if (spec === false) {
      this.fillSpec = null;
      this.fillPen = null;
      return this;
    }
    if (!this.closed) {
      throw new Error('.fill() on an open path — close() it first (fill requires a closed region)');
    }
    if (typeof spec === 'function') spec = customFill(spec);
    this.fillSpec = spec ?? { type: 'mask' };
    this.fillPen = this.run.penOrThrow(penName ?? this.run.currentPen);
    return this;
  }

  /**
   * Occlude everything beneath this shape but draw nothing at all — no fill
   * ink, no stroke. The hidden-line renderer's workhorse.
   */
  mask(): this {
    return this.fill().noStroke();
  }

  /** Outline pen, or `false` for fill-only. */
  stroke(p: string | false): this {
    if (p === false) {
      this.strokePen = null;
      return this;
    }
    this.strokePen = this.run.penOrThrow(p);
    return this;
  }

  noStroke(): this {
    return this.stroke(false);
  }

  /** Set stroke and fill pen together. */
  pen(p: string): this {
    this.run.penOrThrow(p);
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

/** Deep copy of a geometry record (paths and point lists are mutable). */
function cloneGeom(geom: ShapeGeom): ShapeGeom {
  switch (geom.kind) {
    case 'path':
      return { ...geom, cmds: geom.cmds.map((c) => ({ ...c })) };
    case 'points':
      return { ...geom, pts: geom.pts.map(([x, y]) => [x, y] as [typeof x, typeof y]) };
    case 'area':
      return { ...geom, of: { geom: cloneGeom(geom.of.geom), opts: { ...geom.of.opts } } };
    default:
      return { ...geom };
  }
}
