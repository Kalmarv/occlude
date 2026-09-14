import type { FeatureSnapshot3 } from '../features/snapshot.js';

/** All resolved pens are included because retained classifications can be
 * interpreted with another pen later in the same execution. */
export function paperBudget3(widths: Iterable<number>): number {
  let budget = .005;
  for (const width of widths) {
    if (!(width > 0) || !Number.isFinite(width)) throw new Error('3D precision requires positive finite pen widths');
    budget = Math.min(budget, Math.max(Number.MIN_VALUE, width / 20));
  }
  return budget;
}

/** Bound paper displacement per unit of clipped source parameter. Perspective
 * speed peaks at the nearer endpoint, including features outside the page.
 * Half the paper budget is assigned to interval reconstruction; the remainder
 * is reserved for f64 projection. This is not an arbitrary-magnitude guarantee. */
export function intervalTolerance3(snapshot: FeatureSnapshot3, paperToleranceMm: number, ceiling = 1e-5): number {
  if (!(paperToleranceMm > 0) || !Number.isFinite(paperToleranceMm)) throw new Error('paper tolerance must be positive and finite');
  if (!(ceiling > 0) || !Number.isFinite(ceiling)) throw new Error('parameter tolerance must be positive and finite');
  const { camera, paper } = snapshot.frame;
  let speed = 0;
  for (const { a, b } of snapshot.features) {
    let derivative: number;
    if (camera.kind === 'orthographic') {
      derivative = Math.hypot(b[0] - a[0], b[1] - a[1]) / camera.span * paper.height;
    } else {
      const da = -a[2], db = -b[2];
      const projected = Math.hypot(b[0] / db - a[0] / da, b[1] / db - a[1] / da);
      derivative = projected * (Math.max(da, db) / Math.min(da, db)) * (paper.height / (2 * Math.tan(camera.fovDegrees * Math.PI / 360)));
    }
    // Overflow cannot justify accepting coarse f32 endpoints. A subnormal
    // tolerance becomes zero in WGSL, routing uncertain cuts to the CPU.
    speed = Math.max(speed, Number.isNaN(derivative) ? Infinity : derivative);
  }
  return Math.max(Number.MIN_VALUE, Math.min(ceiling, speed === 0 ? ceiling : paperToleranceMm / 2 / speed));
}
