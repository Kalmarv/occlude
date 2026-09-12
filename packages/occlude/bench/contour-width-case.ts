// One process per width lets the caller enforce Studio's 20-second render gate.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { initOcclude, setPenLibrary, DEFAULT_PENS, render, plan, evalPrim } from '../src/index.js';
import fixture from './fixtures/thicken-contour-residual.js';
await initOcclude(readFileSync(process.env.BENCH_WASM || new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
const width = Number(process.argv[2]);
setPenLibrary(DEFAULT_PENS.map(p => ({ ...p, width })));
const start = performance.now();
try {
  const result = render(fixture, { paper: { paper: { w: 304.8, h: 304.8 } } });
  const renderMs = performance.now() - start;
  console.log(JSON.stringify({stage:'render',width,renderMs,fragments:result.frags.length,contour:result.stats.contour}));
  const p = await plan(result);
  const planMs = performance.now()-start-renderMs;
  let maxGap = 0;
  for(const c of p.chains) for(let i=0;i<c.prims.length;i++) {
    const end=evalPrim(c.prims[i],1);
    if(!end.every(Number.isFinite)) throw Error('nonfinite decoded plan');
    if(i) { const prev=evalPrim(c.prims[i-1],1), next=evalPrim(c.prims[i],0);
      maxGap=Math.max(maxGap,Math.hypot(prev[0]-next[0],prev[1]-next[1])); }
  }
  if(maxGap>1e-8) throw Error(`discontinuous decoded plan: ${maxGap} mm`);
  console.log(JSON.stringify({stage:'plan',width,renderMs,planMs,runs:p.chains.length,maxGap}));
} catch(e) { console.log(JSON.stringify({width,error:String(e),ms:performance.now()-start})); process.exitCode=1; }
