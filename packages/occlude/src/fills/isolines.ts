// Built-in fill 'isolines' — contour lines of a field inside the region: the
// same marching squares as t.isolines, run over the region's bbox on a field
// the runtime has already anchored (`align`), clipped and occluded by the
// engine like all ink. Each contour is one polyline — one pen stroke.
import { fillAsset, type CustomPrimitive } from '../fillModule.js';
import { isolinesOf } from '../isolines.js';
import type { FieldFn } from '../shapes.js';
import { mm, type L } from '../units.js';

export default fillAsset({
  params: {
    /** The field to contour, sampled in the region's coordinates. Default:
     * the y coordinate itself (paper mm), so the fill reads as level lines
     * until you hand it your field. */
    field: ((x: number, y: number) => y) as FieldFn,
    /** Explicit levels; else one contour every `spacing` in field value, on
     * multiples of it — adjacent same-spec fills tile. */
    levels: undefined as number[] | undefined,
    spacing: 3,
    /** Sampling step (a length); default 2× the fill pen's nib. */
    step: undefined as L | undefined,
    align: 'paper' as 'paper' | 'shape',
  },
  generate(region, p, ctx) {
    if (typeof p.field !== 'function') {
      throw new Error("fill('isolines') needs a field: fill('isolines', { field, spacing })");
    }
    const step = (p.step !== undefined ? ctx.len(p.step) : 2 * ctx.penWidth) * ctx.coarsen;
    const b = region.bbox;
    if (!(b.w > 0) || !(b.h > 0)) return [];
    let levels = p.levels;
    if (!levels) {
      if (!(p.spacing > 0)) throw new Error("fill('isolines'): spacing must be positive");
      // The field's range over the bbox at the sampling step, then every
      // `spacing` on multiples of it. Absent (non-finite) samples are skipped.
      const gw = Math.max(2, Math.ceil(b.w / step) + 1);
      const gh = Math.max(2, Math.ceil(b.h / step) + 1);
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = 0; j < gh; j++) {
        for (let i = 0; i < gw; i++) {
          const v = p.field(b.x + i * step, b.y + j * step);
          if (Number.isFinite(v)) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
      if (!(hi > lo)) return [];
      levels = [];
      for (let k = Math.ceil(lo / p.spacing); k * p.spacing <= hi && levels.length < 10_000; k++) {
        levels.push(k * p.spacing);
      }
    }
    const env = { bounds: b, len: (l: L) => ctx.len(l) };
    const out: CustomPrimitive[] = [];
    for (const c of isolinesOf(env, p.field, levels, { step: mm(step) }).flat()) {
      if (c.pts.length < 2) continue;
      const pts = c.closed ? [...c.pts, c.pts[0]] : c.pts;
      out.push({ type: 'polyline', pts });
    }
    return out;
  },
});
