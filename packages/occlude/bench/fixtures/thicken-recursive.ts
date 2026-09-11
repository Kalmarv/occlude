// Recursive overlapping boundaries: retain the centre as a hole when filled.
import { sketch, append, thicken, polygon, fill } from 'occlude';
import type { Material } from 'occlude';

export default sketch({ aspect: [1, 1], margin: 6, seed: 42 }, (t) => {
  const b = t.bounds();
  const size = 40;
  const radius = 2;
  const levels = 1;
  const initial = t.material(t.rect(b.cx - size / 2, b.cy - size / 2, size, size));
  const subdivide = (width: number, source: Material, level: number): Material => {
    if (level < 0) return source;
    const shapes = source.along().map(p =>
      t.rect(p.x - width / 4, p.y - width / 4, width / 2, width / 2));
    const combined = shapes.reduce((m, shape) => append(m, t.material(shape)), source);
    return subdivide(width / 2, combined, level - 1);
  };
  return polygon(thicken(subdivide(size, initial, levels), { radius }), {
    fill: fill('hatch'),
  });
});
