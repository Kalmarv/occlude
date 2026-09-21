// Bench case 'globe contours' (tools/bench.ts): Caleb's globe sketch, 2026-09-20 —
// two near-coincident Goldberg shells, the exact classifier's worst case.

import { sketch, pen, mm } from 'occlude';
import { geodesic, sphere, view, perspective, isolines } from 'occlude/3d';

export default sketch(
  { aspect: [1, 1], pens: { ink: pen({ width: mm(0.3), color: '#18202A' }) } },
  async (t) => {
    const pbase = geodesic(1, { frequency: [20, 20] }).dual();
    const water = pbase.scale(0.99);
    const terrainDisplace = (p) => {
      const noise = t.noise(p.x * 2, p.y * 2, p.z * 2);
      const noise2 = t.noise(p.x * 4, p.y * 4, p.z * 4);
      const noise3 = t.noise(p.x * 10, p.y * 10, p.z * 10);
      return (noise * 0.6 + noise2 * 0.3 + noise3 * 0.1) * 0.12;
    };
    const terrain = pbase.displace((p) => terrainDisplace(p)).style({ creaseAngle: 180 });
    const levels = isolines(terrain, (p) => Math.hypot(p.x, p.y, p.z), { count: 20 });
    const coastline = await t.intersections(water, terrain);
    return view([water, terrain, levels, coastline], {
      camera: perspective({ eye: [8.59782, -0.703966, -1.55822], target: [0, 0, 0], fovDegrees: 19.5622 }),
      stroke: 'ink',
      creaseAngle: 180,
    });
  },
);
