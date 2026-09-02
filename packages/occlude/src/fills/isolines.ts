// Built-in fill 'isolines' — contour lines inside the region. By default
// the contours of the region's OWN boundary distance: concentric insets
// every `spacing` millimetres, following the outline however it bends.
// Given a `field`, the contours of that field instead (levels every
// `spacing` in field value), for lines that follow a landscape shared
// across shapes. The same marching squares as t.isolines, over the region,
// clipped and occluded by the engine like all ink; each contour is one
// polyline — one pen stroke.
import { fillAsset, type CustomPrimitive } from '../fillModule.js';
import { distanceTo } from '../distance.js';
import { isolinesOf } from '../isolines.js';
import type { FieldFn } from '../shapes.js';
import { mm, type L } from '../units.js';

export default fillAsset({
  params: {
    /** A field to contour, sampled in the region's coordinates (anchored by
     * `align` like any fill field param). Absent: the region's own signed
     * boundary distance, positive inside, in mm. */
    field: undefined as FieldFn | undefined,
    /** Contour interval: mm of inset for the own-boundary default (3× the
     * nib if absent), field value for a given field (0.1 if absent). Levels
     * sit on multiples of it, so adjacent same-spec fills tile. */
    spacing: undefined as number | undefined,
    /** Explicit levels instead of `spacing`. */
    levels: undefined as number[] | undefined,
    /** Sampling step (a length); default 2× the fill pen's nib. */
    step: undefined as L | undefined,
    align: 'paper' as 'paper' | 'shape',
  },
  generate(region, p, ctx) {
    const b = region.bbox;
    if (!(b.w > 0) || !(b.h > 0)) return [];
    const own = typeof p.field !== 'function';
    const field: FieldFn = own ? distanceTo(region.loops) : (p.field as FieldFn);
    const step = (p.step !== undefined ? ctx.len(p.step) : 2 * ctx.penWidth) * ctx.coarsen;
    let levels = p.levels;
    if (!levels) {
      const spacing = p.spacing ?? (own ? 3 * ctx.penWidth : 0.1);
      if (!(spacing > 0)) throw new Error("fill('isolines'): spacing must be positive");
      // The field's range over the bbox at the sampling step, then every
      // `spacing` on multiples of it. For the own-boundary distance only
      // the inside (positive) levels exist: 0 is the outline itself.
      const gw = Math.max(2, Math.ceil(b.w / step) + 1);
      const gh = Math.max(2, Math.ceil(b.h / step) + 1);
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = 0; j < gh; j++) {
        for (let i = 0; i < gw; i++) {
          const v = field(b.x + i * step, b.y + j * step);
          if (Number.isFinite(v)) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
      if (!(hi > lo)) return [];
      levels = [];
      const k0 = own ? 1 : Math.ceil(lo / spacing);
      for (let k = k0; k * spacing <= hi && levels.length < 10_000; k++) levels.push(k * spacing);
    }
    if (levels.length === 0) return [];
    const env = { bounds: b, len: (l: L) => ctx.len(l) };
    const out: CustomPrimitive[] = [];
    for (const c of isolinesOf(env, field, levels, { step: mm(step) }).flat()) {
      if (c.pts.length < 2) continue;
      const pts = c.closed ? [...c.pts, c.pts[0]] : c.pts;
      out.push({ type: 'polyline', pts });
    }
    return out;
  },
});
