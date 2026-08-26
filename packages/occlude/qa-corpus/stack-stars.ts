import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 'url' }, ({ rect, circle, path, modify, roughen, smooth, deform, noiseField, hatch, times, rnd }) => {
  const star = (cx: number, cy: number, n: number) => {
    const p = path();
    for (let i = 0; i < n * 2; i++) {
      const a = (i / (n * 2)) * Math.PI * 2, r = i % 2 ? 4 : 12;
      i ? p.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r) : p.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    return p.close().build();
  };
  const stacks = [
    [roughen(mm(2), mm(1)), smooth(3)],               // detail > amount: fracture beyond resample
    [smooth(3), roughen(mm(2), mm(1))],
    [roughen(mm(1), mm(3)), roughen(mm(1), mm(3))],   // double roughen
    [smooth(6)],                                       // near-spline; perimeter must shrink
    [deform(noiseField(4, 6)), smooth(2), roughen(mm(0.5), mm(1))],
    [smooth(2), deform(noiseField(4, 6)), roughen(mm(0.5), mm(1))],
  ];
  return stacks.map((st, k) => modify(st, [
    star(20 + (k % 3) * 30, 25 + Math.floor(k / 3) * 45, 5 + Math.floor(rnd(6))),
    rect(20 + (k % 3) * 30 - 6, 25 + Math.floor(k / 3) * 45 + 14, 12, 3, { fill: hatch(60, mm(0.8)), opaque: true }),
  ]));
});
