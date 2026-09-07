import { performance } from 'node:perf_hooks';
import { curve } from '../src/index.js';
for (const n of [4000, 8000, 16000]) {
  const base = curve(Array.from({ length: n }, (_, i) => [i * 0.1, Math.sin(i * 0.01)] as [number, number]), { closed: false });
  const copy = base.edgeAttribute('w', (e) => e.index);
  const dist = base.edgeAttribute('w', (e) => e.index, { transfer: 'distribute' });
  for (const [label, m] of [['copy', copy], ['distribute', dist]] as const) {
    const times: number[] = [];
    for (let r = 0; r < 5; r++) { const t0 = performance.now(); m.resample({ spacing: 0.15 }); times.push(performance.now() - t0); }
    times.sort((a, b) => a - b);
    console.log(`resample ${String(n).padStart(5)} ${label.padEnd(10)} median ${times[2].toFixed(1)} ms`);
  }
}
