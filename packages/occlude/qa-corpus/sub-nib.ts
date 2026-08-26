import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 'url' }, ({ line, circle, rect, hatch, stipple, dash, times, rnd }) => [
  times(400, () => circle(rnd(100), rnd(100), rnd(0.02, 0.6))),                // sub-nib circles
  times(30, (k) => line(5, 5 + k * 0.3, 95, 5 + k * 0.3)),                     // lines closer than nib
  rect(20, 30, 60, 0.2, { fill: hatch(90, mm(0.3)) }),                         // rect thinner than nib, hatch denser than nib
  circle(50, 60, 20, { fill: stipple(0.95) }),                                  // dot fill below nib spacing
  times(40, () => circle(rnd(100), rnd(100), rnd(1, 3), { opaque: true })),    // comb: chops lines into sub-nib bits
  dash(mm(0.2), mm(0.1), circle(50, 60, 30)),                                   // dashes below nib
  circle(30, 30, 0),                                                            // zero radius
  line(70, 70, 70, 70),                                                         // zero length
]);
