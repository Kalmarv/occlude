/** Benchmark-only follow-up: per-chain timing choices after joining. */
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import init, * as core from '../../../crates/occlude-core/pkg/occlude_core.js';
import { compileSketch, encodeScene, renderEncoded, setPaperHint, setPenLibrary, decodePlanBuffer, encodePlanBuffer, parseToolpath, estimatePlanMs, type WasmModule } from '../src/index.js';
import { machineTiming, machineTolerance } from '../../occlude-studio/src/drawing.js';
import wave from './path-optimization-wave.ts';
import recursive from './path-optimization-recursive.ts';
const which=process.argv[2]??'wave';
const pen={name:'hop',width:0.4,color:'#ff295e',feed:3000,penDown:0,penUp:5,penDelay:600};
const profile=JSON.parse(readFileSync(new URL('./path-optimization-profile.json',import.meta.url),'utf8'));
console.log(JSON.stringify({runtime:process.version,cpu:cpus()[0].model,fixture:which,paper:[304.8,304.8],pen,profile}));
await init(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));
setPenLibrary([pen]);setPaperHint(304.8,304.8);compileSketch(which==='recursive'?recursive:wave);
const s=encodeScene({paper:{paper:{w:304.8,h:304.8}}});
const start=performance.now();const raw=renderEncoded(core as unknown as WasmModule,s);
const baseline=core.wasm_plan(raw.prims,raw.frags,s.pensJson,200000,-1);
console.log(JSON.stringify({renderAndPlanMs:performance.now()-start,fragments:raw.frags.length/9}));
const tolerance=machineTolerance(profile,s.pens),timing=machineTiming(profile);
function measure(buffer:Float64Array){const chains=decodePlanBuffer(buffer);const flat=parseToolpath(core.wasm_plan_toolpath(buffer,tolerance,0,chains.length));return {...estimatePlanMs(flat,i=>s.pens[i],timing),primitives:chains.reduce((n,c)=>n+c.prims.length,0)};}
console.log(JSON.stringify({mode:'original',...measure(baseline)}));
const p=core.wasm_prepare(s.prims,s.contours,s.shapesU32,s.shapesF64,s.mods,s.fieldData,s.fieldUses,s.domainList,s.clipList,s.clipsU32,s.pensJson,s.paperArr,s.seed,s.coarsen,0);

try {
  for (const gap of [0, 1]) {
    const joined = p.optimize_plan(baseline, raw.prims, raw.frags, 0, 10, 30, gap, 1000000);
    let source: Float64Array;
    try { source = joined.plan; } finally { joined.free(); }
    const started = performance.now();
    const chains = decodePlanBuffer(source);
    const selected = [...chains];
    const flattened = (buffer: Float64Array) => parseToolpath(core.wasm_plan_toolpath(buffer, tolerance, 0, chains.length));
    const drawCost = (c: ReturnType<typeof flattened>[number]) => estimatePlanMs([c], i => s.pens[i], timing).drawMs;
    const costs = flattened(source).map(drawCost);
    let replacements = 0;
    for (const eps of [0.1, 0.025, 0.00625]) {
      const candidate = core.wasm_optimize_plan(source, eps, 10, 30, 0);
      try {
        const buffer = candidate.plan, fitted = decodePlanBuffer(buffer), flat = flattened(buffer);
        if (fitted.length !== chains.length) throw new Error('Fitting changed chain count');
        for (let i = 0; i < chains.length; i++) {
          const cost = drawCost(flat[i]);
          if (cost + 0.000001 < costs[i]) { costs[i] = cost; selected[i] = fitted[i]; replacements++; }
        }
      } finally { candidate.free(); }
    }
    const hybrid = encodePlanBuffer(selected);
    const originalMetrics = measure(source), hybridMetrics = measure(hybrid);
    console.log(JSON.stringify({ mode: 'per-chain-fitting', gap, computeMs: performance.now()-started, replacements,
      changedChains: selected.filter((c,i)=>c!==chains[i]).length,
      savedMs: originalMetrics.totalMs-hybridMetrics.totalMs, original: originalMetrics, optimized: hybridMetrics }));
  }
} finally { p.free(); }
