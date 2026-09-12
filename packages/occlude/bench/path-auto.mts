/** pnpm --filter occlude exec tsx bench/path-auto.mts [wave|recursive] [alternatives] */
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import init, * as core from '../../../crates/occlude-core/pkg/occlude_core.js';
import { compileSketch, encodeScene, renderEncoded, setPaperHint, setPenLibrary, decodePlanBuffer, parseToolpath, estimatePlanMs, type WasmModule } from '../src/index.js';
import { machineTiming, machineTolerance } from '../../occlude-studio/src/drawing.js';
import { optimizeRequest } from '../../occlude-studio/src/optimization-runner.js';
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

const result=await optimizeRequest({buffer:baseline, settings:{tourBudget:200000,pens:s.pens,paper:{w:304.8,h:304.8},bridgeGapMm:s.pens.map(p=>p.width/2)},sourcePlanHash:'benchmark',sourceRange:[0,decodePlanBuffer(baseline).length],options:{tolerance:0.02,maxSegment:10,cornerDegrees:30,gap:0,tourBudget:1000000},auto:{localNib:0.1,missingPercent:0.1,addedPercent:0.5,alternatives:Number(process.argv[3]??8),connections:true},context:{scene:s,prims:raw.prims,frags:raw.frags},pens:s.pens,timing,machineTolerance:tolerance}, stage=>console.log(JSON.stringify({stage,time:performance.now()})));
console.log(JSON.stringify({mode:'auto',computeMs:result.elapsedMs,strategy:result.strategy,stats:[...result.stats],fidelity:result.fidelity,skipped:result.skipped,...result.metrics.optimized,primitives:result.metrics.primitivesAfter}));
if(result.metrics.optimized.totalMs>result.metrics.original.totalMs)throw new Error('Auto increased ETA');
