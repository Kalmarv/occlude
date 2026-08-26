import { sketch } from 'occlude';

export default sketch({ aspect: 'square', margin: 8 }, ({ line, circle, deform, times, stream }) => {
  const swirl = (x: number, y: number): [number, number] => {
    const dx = x - 50, dy = y - 50;
    const d = Math.hypot(dx, dy) || 1;
    const k = 14 * Math.exp(-d / 28) / d;
    return [-dy * k, dx * k];
  };
  const s = stream('discs');
  return [
    deform(swirl, times(34, (k, t) => line(0, t * 100, 100, t * 100))),
    deform(swirl, times(34, (k, t) => line(t * 100, 0, t * 100, 100))),
    deform(swirl, times(12, () => circle(s.rnd(15, 85), s.rnd(15, 85), s.rnd(4, 11), { opaque: true }))),
  ];
});
