// User's recursive variable-radius contour comparison, fixed at seed 42 for comparison.
import { sketch, append, decimate, polygon, fill, group, map, rect } from 'occlude';
import type { Material } from 'occlude';

export default sketch({ aspect: [1, 1], margin: 5, seed: 42 }, (t) => {
  const b = t.bounds();
  const size = 50;
  const levels = 3;
  const initial = t.material(rect(b.cx - size / 2, b.cy - size / 2, size, size));
  const subdivide = (width: number, source: Material, level: number): Material => {
    if (level < 0) return source;
    const shapes = source.along().points.map(p =>
      rect(p.x - width / 4, p.y - width / 4, width / 2, width / 2));
    const combined = shapes.reduce((m, shape) => append(m, t.material(shape)), source);
    return subdivide(width / 2, combined, level - 1);
  };
  const thick = subdivide(size, initial, levels).thicken({ radius: p => map(p.x, 0, 100, 0.01, 1) });
  return [group({ pen: 'micron-01' }, polygon(thick, { fill: fill('contour'), modifiers: [decimate(0.3)] }), polygon(thick))];
});
