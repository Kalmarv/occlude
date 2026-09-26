import { surface3, type Surface3 } from '../../src/three/geometry/surface.js';
import type { Vec3 } from '../../src/three/math.js';

/** A flat grid of `columns × rows` quads, `size` across and centred on the
 * origin, as a raw `Surface3`: the fixture the kernel tests build their
 * inputs from. A sketch builds the same sheet with `plane().subdivide()`. */
export function gridSurface(columns: number, rows: number, size: readonly [number, number] = [1, 1]): Surface3 {
  const positions: Vec3[] = [], faces: number[][] = [];
  for (let y = 0; y <= rows; y++) for (let x = 0; x <= columns; x++) positions.push([(x / columns - 0.5) * size[0], (y / rows - 0.5) * size[1], 0]);
  for (let y = 0; y < rows; y++) for (let x = 0; x < columns; x++) { const p = y * (columns + 1) + x; faces.push([p, p + 1, p + columns + 2, p + columns + 1]); }
  return surface3(positions, faces);
}
