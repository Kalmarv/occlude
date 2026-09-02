/**
 * The fill-module contract: what a fill receives, what it returns, and the
 * `fillAsset` shape that makes a fill a storable, capture-free FILE.
 *
 * Lives apart from fills.ts so the built-in fill files (src/fills/*.ts) can
 * import it without a module cycle — they are ordinary fill files with no
 * privileges, and the studio's Clone hands their exact text to the artist.
 */

import type { Prim } from './prims.js';

/** The region handed to a fill, in paper mm — the shape's final outline. */
export interface FillRegion {
  bbox: { x: number; y: number; w: number; h: number };
  /** The actual outline: contours of exact primitives, paper mm. */
  path: Prim[][];
  /** Point-in-region test (respects the shape's winding rule). */
  contains(x: number, y: number): boolean;
}

/** Everything a fill may read besides its region and params. */
export interface FillCtx {
  /** Fill pen nib width, mm. */
  penWidth: number;
  /** Seeded per-fill sub-stream — isolated from the sketch's main stream. */
  rnd: () => number;
  /** Draft-quality hint (1 = exact); fills MAY coarsen spacing by it. */
  coarsen: number;
  /** Resolve a length (mm()/w()/h()/bare %) to paper mm. */
  len(l: import('./units.js').L): number;
  /** Shape anchor A = G ∘ C compiled to paper: the affine from shape-local
   * mm (origin at the shape's intrinsic bbox centre, axes turned by the
   * motif's explicit transforms, including mirrors) to paper mm — the SAME
   * transform the runtime anchors field params with under `align:
   * 'shape'`. `rotation` (degrees) is a convenience read of the x-axis
   * image; `rulings` transforms its direction through the full linear
   * part, so a mirrored motif mirrors its texture. Identity-plus-centre for
   * a coordinate-placed shape: halftone dots keep identical marks. */
  anchor: FillAnchor;
}

/** An affine shape-local mm → paper mm: (x', y') = (a x + c y + e, b x + d y + f). */
export interface FillAnchor {
  a: number; b: number; c: number; d: number; e: number; f: number;
  rotation: number;
}

/**
 * A fill function: returns marks in paper mm. Primitives are clipped to the
 * region and occluded like everything else, so overshooting the boundary is
 * fine — `contains` is for generation efficiency, not correctness. Fills
 * must be pure functions of (region, params, ctx); determinism is contract.
 */
export type CustomFillFn = (region: FillRegion, ctx: FillCtx) => CustomPrimitive[];

export type CustomPrimitive =
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'arc'; cx: number; cy: number; r: number; start: number; sweep: number }
  | {
      type: 'cubic';
      x1: number; y1: number;
      cx1: number; cy1: number;
      cx2: number; cy2: number;
      x2: number; y2: number;
    }
  /** Connected line run — ONE pen stroke: the nib rule judges it whole. */
  | { type: 'polyline'; pts: [number, number][] }
  /** An intentional tap. Engine semantics: strictly-inside dots only (edge
   * dots drop), occludable, never routed through tap resolution. */
  | { type: 'dot'; x: number; y: number };

/** A fill module: declared parameter defaults + a pure generator. */
export interface FillAssetDef<P extends Record<string, unknown> = Record<string, unknown>> {
  params: P;
  generate(region: FillRegion, params: P, ctx: FillCtx): CustomPrimitive[];
}

/** Define a fill module (identity — the shape of the contract). A fill FILE
 * is `export default fillAsset({ params, generate })`, imports nothing but
 * occlude, and captures nothing — which is what makes it storable. */
export function fillAsset<P extends Record<string, unknown>>(
  def: FillAssetDef<P>,
): FillAssetDef<P> {
  return def;
}

export interface RulingOpts {
  /** Line spacing in paper mm. */
  spacing: number;
  /** Degrees; 0 = horizontal. */
  angle?: number;
  /** Phase offset along the ruling normal, mm. */
  offset?: number;
  /** 'paper' (default): one paper-wide grid every same-spec fill samples,
   * so adjacent shapes tile. 'shape': anchor the ruling to the shape —
   * centred on it, its direction carried through `anchor`'s linear part
   * (a rotated motif's rulings turn, a mirrored one's mirror) — so small
   * shapes get identical marks wherever they sit. */
  align?: 'paper' | 'shape';
  /** The shape anchor (`ctx.anchor`), consulted for `align: 'shape'`.
   * Without it, shape alignment falls back to the region's bbox centre
   * and the raw angle. */
  anchor?: FillAnchor;
}

/**
 * Parallel ruling lines across a region's bbox, overshooting it (the engine
 * clips exactly) — the primitive under hatch, crosshatch, and solid, and a
 * building block for your own fills. Physical floor of 0.02 mm and a hard
 * line budget against the bbox diagonal.
 */
export function rulings(region: FillRegion, opts: RulingOpts): CustomPrimitive[] {
  const angleDeg = opts.angle ?? 0;
  const offset = opts.offset ?? 0;
  const align = opts.align ?? 'paper';
  const b = region.bbox;
  const diag = Math.hypot(b.w, b.h);
  const s = Math.max(opts.spacing, 0.02, diag / 100_000);
  const theta = (angleDeg * Math.PI) / 180;
  let dir = [Math.cos(theta), Math.sin(theta)];
  const A = align === 'shape' ? opts.anchor : undefined;
  if (A) {
    // Direction through the anchor's linear part, renormalised: rotation
    // turns it, a mirror flips it, non-uniform scale tilts it — the
    // spacing (a magnitude) never changes.
    const tx = A.a * dir[0] + A.c * dir[1];
    const ty = A.b * dir[0] + A.d * dir[1];
    const tm = Math.hypot(tx, ty);
    if (tm > 0) dir = [tx / tm, ty / tm];
  }
  const nrm = [-dir[1], dir[0]];
  const corners: [number, number][] = [
    [b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h],
  ];
  let omin = Infinity, omax = -Infinity, dmin = Infinity, dmax = -Infinity;
  for (const [cx, cy] of corners) {
    const o = cx * nrm[0] + cy * nrm[1];
    const d = cx * dir[0] + cy * dir[1];
    omin = Math.min(omin, o); omax = Math.max(omax, o);
    dmin = Math.min(dmin, d); dmax = Math.max(dmax, d);
  }
  // Phase: paper-anchored rulings are multiples of spacing in paper space
  // (adjacent same-spec fills align); shape-anchored ones centre the
  // ruling on the region, so small shapes render identically anywhere.
  const [ax, ay] = A ? [A.e, A.f] : [b.x + b.w / 2, b.y + b.h / 2];
  const phase = align === 'shape' ? offset + ax * nrm[0] + ay * nrm[1] : offset;
  const k0 = Math.ceil((omin - phase) / s);
  const k1 = Math.floor((omax - phase) / s);
  const pad = s * 0.5;
  const out: CustomPrimitive[] = [];
  for (let k = k0; k <= k1; k++) {
    const o = k * s + phase;
    out.push({
      type: 'line',
      x1: nrm[0] * o + dir[0] * (dmin - pad),
      y1: nrm[1] * o + dir[1] * (dmin - pad),
      x2: nrm[0] * o + dir[0] * (dmax + pad),
      y2: nrm[1] * o + dir[1] * (dmax + pad),
    });
  }
  return out;
}
