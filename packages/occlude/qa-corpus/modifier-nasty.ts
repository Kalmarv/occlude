import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 'url' }, ({ line, circle, modify, wobble, dash, decimate, fill, times, rnd }) => {
  const nasty = (x: number, y: number) => x < 20 ? -1 : x < 40 ? 2 : x < 60 ? NaN : x < 80 ? Infinity : y / 100;
  const scene = [
    times(40, (k, t) => line(0, t * 100, 100, t * 100)),
    times(8, () => circle(rnd(100), rnd(100), rnd(5, 15), { fill: fill('hatch', { angle: rnd(180), spacing: mm(1) }) })),
  ];
  return [
    modify([wobble({ amount: mm(5), wavelength: mm(0.5) })], scene),        // amount ≫ wavelength
    modify([dash(mm(1), mm(1)), decimate(nasty), wobble({ amount: nasty as any, wavelength: mm(10) })], scene),
    modify([decimate(0), wobble({ amount: 0 }), dash(mm(1e9), mm(0))], scene),  // identity stack
    modify(Array.from({ length: 30 }, (_, i) => i % 2 ? dash(mm(2), mm(0.5)) : decimate(0.01)), scene),
  ];
});
