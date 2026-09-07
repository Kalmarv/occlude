import { performance } from 'node:perf_hooks';
import { connect, curve, query } from '../src/index.js';
let s = 5; const rnd = () => ((s = (s * 48271) % 2147483647) / 2147483647) * 100;
const t = (label: string, f: () => unknown) => { const t0 = performance.now(); f(); console.log(label.padEnd(50), (performance.now() - t0).toFixed(0).padStart(7), 'ms'); };
for (const n of [1000, 4000]) {
  const pts = Array.from({ length: n }, () => [rnd(), rnd()] as [number, number]);
  connect.nearest(pts, { count: 3 });
  t(`connect.nearest count 3, ${n} pts`, () => connect.nearest(pts, { count: 3 }));
}
const big = curve(Array.from({ length: 16000 }, (_, i) => [i * 0.1, Math.sin(i * 0.01)] as [number, number]), { closed: false, age: 0 }).edgeAttribute('w', (e) => e.index);
t('resample 16k pts with an edge column', () => big.resample({ spacing: 0.15 }));
const chain = curve(Array.from({ length: 16000 }, (_, i) => [i * 0.01, Math.sin(i * 0.001) * 50] as [number, number]), { closed: false });
const q = query.edges(chain);
t('1000 nearest queries vs 15999 edges', () => { for (let i = 0; i < 1000; i++) q.nearest([rnd(), rnd()], { within: 50 }); });
