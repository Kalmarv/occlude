// User's recursive radial-radius contour texture, fixed at seed 42 for comparison.
import { sketch, append, decimate, thicken, polygon, fill } from 'occlude';
import type { Material } from 'occlude';

export default sketch({ aspect: [1, 1], margin: 5, seed: 42 }, (t) => {
  const b = t.bounds();
  const size = 50;
  const levels = 3;
  const initial = t.material(t.rect(b.cx - size / 2, b.cy - size / 2, size, size));
  const subdivide = (width: number, source: Material, level: number): Material => {
    if (level < 0) return source;
    const shapes = source.along().map(p =>
      t.rect(p.x - width / 4, p.y - width / 4, width / 2, width / 2));
    const combined = shapes.reduce((m, shape) => append(m, t.material(shape)), source);
    return subdivide(width / 2, combined, level - 1);
  };
  const thick = thicken(subdivide(size, initial, levels), { radius: p => t.map(Math.hypot(p.x - 50, p.y - 50), 0, 50, 0.01, 2) });
  return [t.group({ pen: 'hop' }, decimate(0.5, polygon(thick, { fill: fill('contour') })), polygon(thick))];
});
