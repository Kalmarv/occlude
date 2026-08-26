import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 'url' }, ({ circle, line, hatch, stipple, stream, times, rnd, noise, modify, wobble, decimate, dash }) => {
  const a = stream('a'), b = stream('b');
  const shared = times(300, () => circle(rnd(100), rnd(100), rnd(2, 8), { fill: hatch(rnd(180), mm(0.8)), z: Math.floor(rnd(3)) }));  // z ties: sort stability
  return [
    shared,
    times(300, () => circle(a.rnd(100), a.rnd(100), 1.5, { fill: stipple(b.rnd()) })),
    modify([dash(mm(1), mm(0.5)), decimate((x, y) => noise(x, y) * 0.5), wobble({ amount: (x, y) => noise(y, x) * 2, wavelength: mm(7) })],
      times(60, (k, t) => line(0, t * 100, 100, t * 100))),
  ];
});
