import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 'url' }, ({ circle, rect, hatch, times, rnd }) => [
  times(3000, (k) => circle(50, 50, 30 - k * 0.01, { opaque: true })),          // 3000 concentric opaque
  times(2500, (k) => rect((k % 50) * 2, Math.floor(k / 50) * 2, 1, 1, { fill: hatch(45, mm(0.4)) })), // 2500 disjoint
  times(200, () => rect(rnd(100), rnd(100), 40, 40, { rotate: rnd(360), fill: hatch(rnd(180), mm(0.6)), scale: [rnd(0.2, 2), rnd(0.2, 2)] })), // non-uniform scale
]);
