/**
 * Fills. The engine generates NO patterns (it decides what survives to
 * paper, never what gets drawn): every fill is sketch-space code run
 * between the two render passes, against the shape's FINAL outline
 * (post-deform, post-cull), then clipped and occluded by the engine like
 * all ink.
 *
 * Two forms, one contract:
 * - `fill('hatch', { … })` references a fill MODULE by name — a
 *   capture-free `fillAsset` with a declared parameter interface. The
 *   built-ins (hatch, crosshatch, stipple, solid) live in this file;
 *   they are ordinary modules with no privileges.
 * - An inline function (`.fill((region, ctx) => …)`) is a plain closure —
 *   it just works, since fills execute in the same runtime as the sketch.
 *
 * A mask is opaque with zero ink — the primitive of hidden-line rendering.
 */

import type { Prim } from './prims.js';
import { positiveLength } from './guard.js';
import { mm, type L } from './units.js';

export type FillSpec =
  | { type: 'use'; name: string; params: Record<string, unknown> }
  | { type: 'custom'; fn: CustomFillFn }
  | { type: 'mask' };

/** The region handed to a fill, in paper mm — the shape's final outline. */
export interface FillRegion {
  bbox: { x: number; y: number; w: number; h: number };
  /** The actual outline: contours of exact primitives, paper mm. */
  path: Prim[][];
  /** Point-in-region test (respects the shape's winding rule). */
  contains(x: number, y: number): boolean;
  /** Region area in mm² (holes subtracted). */
  area: number;
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
  len(l: L): number;
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
  /** Connected line run — one entry instead of n-1 line objects. */
  | { type: 'polyline'; pts: [number, number][] }
  /** An intentional tap. Engine semantics: strictly-inside dots only (edge
   * dots drop), occludable, never routed through tap resolution. */
  | { type: 'dot'; x: number; y: number };

/** A fill module: declared parameter defaults + a pure generator. */
export interface FillAssetDef<P extends Record<string, unknown> = Record<string, unknown>> {
  params: P;
  generate(region: FillRegion, params: P, ctx: FillCtx): CustomPrimitive[];
}

/** Define a fill module (identity — the shape of the contract). */
export function fillAsset<P extends Record<string, unknown>>(
  def: FillAssetDef<P>,
): FillAssetDef<P> {
  return def;
}

/**
 * Use a fill module by name with parameter overrides. Names are literals —
 * computed names defeat scanning and import rewiring.
 */
export function fill(name: string, params: Record<string, unknown> = {}): FillSpec {
  return { type: 'use', name, params };
}

/** Wrap an inline fill function. `.fill(f)` also accepts the function directly. */
export function customFill(fn: CustomFillFn): FillSpec {
  return { type: 'custom', fn };
}

// ---- built-in fill modules --------------------------------------------
// Ordinary fillAssets with no privileges; the algorithms are the former
// Rust engine generators, ported. Shipped names are ink-immutable: an
// ink-affecting change requires a NEW name (law 7 vs package upgrades).

/** Ruling lines for one pass, overshooting the region (the engine clips). */
function rulingLines(
  region: FillRegion,
  spacing: number,
  angleDeg: number,
  offset: number,
  align: 'paper' | 'shape',
): CustomPrimitive[] {
  // Physical floor, then a hard line budget against the bbox diagonal.
  const b = region.bbox;
  const diag = Math.hypot(b.w, b.h);
  const s = Math.max(spacing, 0.02, diag / 100_000);
  const theta = (angleDeg * Math.PI) / 180;
  const dir = [Math.cos(theta), Math.sin(theta)];
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
  const phase =
    align === 'shape'
      ? offset + (b.x + b.w / 2) * nrm[0] + (b.y + b.h / 2) * nrm[1]
      : offset;
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

const hatchAsset = fillAsset({
  params: {
    angle: 0,
    /** L; default 3× the fill pen's nib. */
    spacing: undefined as L | undefined,
    offset: 0,
    align: 'paper' as 'paper' | 'shape',
  },
  generate(region, p, ctx) {
    const spacing =
      (p.spacing !== undefined ? ctx.len(p.spacing) : 3 * ctx.penWidth) * ctx.coarsen;
    return rulingLines(region, spacing, p.angle, p.offset, p.align);
  },
});

const crosshatchAsset = fillAsset({
  params: {
    angles: [0, 90] as number[],
    spacing: undefined as L | undefined,
    offset: 0,
    align: 'paper' as 'paper' | 'shape',
  },
  generate(region, p, ctx) {
    const spacing =
      (p.spacing !== undefined ? ctx.len(p.spacing) : 3 * ctx.penWidth) * ctx.coarsen;
    return p.angles.flatMap((angle) =>
      rulingLines(region, spacing, angle, p.offset, p.align),
    );
  },
});

const solidAsset = fillAsset({
  params: {
    /** Row direction; barely visible once solid, but sets plot direction. */
    angle: 0,
    /** L; default 0.9× the nib so rows overlap into unbroken ink. */
    spacing: undefined as L | undefined,
  },
  generate(region, p, ctx) {
    const spacing =
      (p.spacing !== undefined ? ctx.len(p.spacing) : 0.9 * ctx.penWidth) * ctx.coarsen;
    // Shape-aligned: small shapes fill identically wherever they sit.
    return rulingLines(region, spacing, p.angle, 0, 'shape');
  },
});

const stippleAsset = fillAsset({
  params: {
    density: 0.5,
    /** L; default 2× the fill pen's nib. */
    minDist: undefined as L | undefined,
  },
  generate(region, p, ctx) {
    const minDist =
      (p.minDist !== undefined ? ctx.len(p.minDist) : 2 * ctx.penWidth) * ctx.coarsen;
    // Bridson Poisson-disk over the bbox; the engine keeps only strictly-
    // inside dots, so no containment test is needed here. Same physical
    // floor and grid budget as the old engine generator.
    const b = region.bbox;
    if (!(b.w > 0) || !(b.h > 0) || !Number.isFinite(b.w * b.h)) return [];
    const MAX_CELLS = 4_000_000;
    const r = Math.max(
      minDist / Math.min(1, Math.max(0.05, p.density)),
      0.05,
      Math.sqrt((2 * b.w * b.h) / MAX_CELLS),
    );
    const cell = r / Math.SQRT2;
    const cols = Math.ceil(b.w / cell) + 1;
    const rows = Math.ceil(b.h / cell) + 1;
    const grid = new Int32Array(cols * rows).fill(-1);
    const px: number[] = [];
    const py: number[] = [];
    const active: number[] = [];
    const rnd = ctx.rnd;
    const cellOf = (x: number, y: number): [number, number] => [
      Math.min(cols - 1, Math.floor((x - b.x) / cell)),
      Math.min(rows - 1, Math.floor((y - b.y) / cell)),
    ];
    const fits = (x: number, y: number): boolean => {
      if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return false;
      const [cx, cy] = cellOf(x, y);
      const x0 = Math.max(0, cx - 2);
      const y0 = Math.max(0, cy - 2);
      for (let gy = y0; gy < Math.min(cy + 3, rows); gy++) {
        for (let gx = x0; gx < Math.min(cx + 3, cols); gx++) {
          const idx = grid[gy * cols + gx];
          if (idx >= 0 && Math.hypot(px[idx] - x, py[idx] - y) < r) return false;
        }
      }
      return true;
    };
    const push = (x: number, y: number): void => {
      const idx = px.length;
      px.push(x); py.push(y);
      active.push(idx);
      const [cx, cy] = cellOf(x, y);
      grid[cy * cols + cx] = idx;
    };
    push(b.x + rnd() * b.w, b.y + rnd() * b.h);
    const K = 24;
    while (active.length > 0) {
      const pick = Math.floor(rnd() * active.length) % active.length;
      const bi = active[pick];
      let placed = false;
      for (let t = 0; t < K; t++) {
        const ang = rnd() * 2 * Math.PI;
        const rad = r + rnd() * r;
        const x = px[bi] + Math.cos(ang) * rad;
        const y = py[bi] + Math.sin(ang) * rad;
        if (fits(x, y)) {
          push(x, y);
          placed = true;
          break;
        }
      }
      if (!placed) {
        active[pick] = active[active.length - 1];
        active.pop();
      }
    }
    const out: CustomPrimitive[] = [];
    for (let i = 0; i < px.length; i++) out.push({ type: 'dot', x: px[i], y: py[i] });
    return out;
  },
});

const BUILTIN_FILLS = new Map<string, FillAssetDef<Record<string, unknown>>>([
  ['hatch', hatchAsset as FillAssetDef<Record<string, unknown>>],
  ['crosshatch', crosshatchAsset as FillAssetDef<Record<string, unknown>>],
  ['solid', solidAsset as FillAssetDef<Record<string, unknown>>],
  ['stipple', stippleAsset as FillAssetDef<Record<string, unknown>>],
]);

/** Resolve a fill name: built-ins from the package (server-stored fills
 * join in the storage milestone). */
export function resolveFill(name: string): FillAssetDef<Record<string, unknown>> | undefined {
  return BUILTIN_FILLS.get(name);
}

/** Validate the L-typed params a fill use may carry (mid-edit transients). */
export function validateFillParams(name: string, params: Record<string, unknown>): void {
  for (const key of ['spacing', 'minDist'] as const) {
    if (key in params) positiveLength(name, params[key] as L | undefined);
  }
}

/** Default hatch spacing for a pen: 3× nib width, in mm. */
export function defaultHatchSpacing(penWidth: number): L {
  return mm(3 * penWidth);
}

/** Default stipple min distance for a pen: 2× nib width, in mm. */
export function defaultStippleMinDist(penWidth: number): L {
  return mm(2 * penWidth);
}
