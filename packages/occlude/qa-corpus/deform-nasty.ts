import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 'url' }, ({ line, circle, rect, deform, noiseField, times, rnd }) => {
  const f = 3 + rnd(12);
  const ripple = (x: number, y: number): [number, number] =>
    [0, 6 * Math.sin(x * f)];                                    // wavelength ≈ 2π/f units
  const step = (x: number, y: number): [number, number] =>
    [x > 50 ? 8 : -8, 0];                                        // discontinuity at x=50
  const spike = (x: number, y: number): [number, number] => {
    const d = Math.hypot(x - 50, y - 50) || 1e-9;
    return [(x - 50) / d * 40 / (d + 0.5), (y - 50) / d * 40 / (d + 0.5)];  // singular at centre
  };
  return [
    deform(ripple, times(20, (k, t) => line(0, t * 100, 100, t * 100))),
    deform(step, times(20, (k, t) => line(0, t * 100, 100, t * 100))),
    deform(spike, circle(50, 50, 0.3, { opaque: true })),        // tiny circle sitting on the singularity
    deform(spike, rect(49.5, 49.5, 1, 1)),
    deform(noiseField(30, 0.5), circle(50, 50, 30, { opaque: true })), // huge amount, tiny wavelength: self-intersecting silhouette
  ];
});
