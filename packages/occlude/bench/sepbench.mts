import { performance } from 'node:perf_hooks';
import { curve, force, neighbours } from '../src/index.js';
const N = 5000;
const ring = curve(Array.from({ length: N }, (_, i) => { const a = (i / N) * Math.PI * 2; return [50 + Math.cos(a) * 20 + Math.sin(i) * 0.3, 50 + Math.sin(a) * 20] as [number, number]; }), { age: 0 });
const pts = ring.points;
const cur = force.separation(ring, { radius: 2, excludeConnected: true });
let t0 = performance.now(); for (const p of pts) cur(p); console.log('current separation (views + closures)', (performance.now() - t0).toFixed(1), 'ms');
// a typed-array kernel: uniform grid, no per-pair allocation, output into Float64Arrays
function kernel(x: Float64Array, y: Float64Array, radius: number, adj: (i: number) => readonly number[], ox: Float64Array, oy: Float64Array) {
  const n = x.length; const cell = radius; let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < n; i++) { if (x[i] < minx) minx = x[i]; if (x[i] > maxx) maxx = x[i]; if (y[i] < miny) miny = y[i]; if (y[i] > maxy) maxy = y[i]; }
  const cols = Math.floor((maxx - minx) / cell) + 1, rows = Math.floor((maxy - miny) / cell) + 1;
  const head = new Int32Array(cols * rows).fill(-1), next = new Int32Array(n);
  for (let i = 0; i < n; i++) { const c = Math.floor((x[i] - minx) / cell) + Math.floor((y[i] - miny) / cell) * cols; next[i] = head[c]; head[c] = i; }
  const r2 = radius * radius;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor((x[i] - minx) / cell), cy = Math.floor((y[i] - miny) / cell); let fx = 0, fy = 0; const a = adj(i);
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(rows - 1, cy + 1); gy++) for (let gx = Math.max(0, cx - 1); gx <= Math.min(cols - 1, cx + 1); gx++) {
      for (let j = head[gy * cols + gx]; j !== -1; j = next[j]) {
        if (j === i) continue; const dx = x[i] - x[j], dy = y[i] - y[j]; const d2 = dx * dx + dy * dy; if (d2 >= r2 || d2 === 0) continue;
        if (a.includes(j)) continue; const d = Math.sqrt(d2); const w = (radius - d) / radius; fx += (dx / d) * w; fy += (dy / d) * w;
      }
    }
    ox[i] = fx; oy[i] = fy;
  }
}
const ox = new Float64Array(N), oy = new Float64Array(N);
t0 = performance.now(); kernel(ring.x, ring.y, 2, (i) => ring.connected(i), ox, oy); console.log('typed-array JS kernel (grid, no allocation)', (performance.now() - t0).toFixed(1), 'ms');
t0 = performance.now(); for (let k = 0; k < 5; k++) kernel(ring.x, ring.y, 2, (i) => ring.connected(i), ox, oy); console.log('  warm ×5 avg', ((performance.now() - t0) / 5).toFixed(1), 'ms');
// how many neighbours per point on this ring?

