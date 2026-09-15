/** One workload (default woven-vessel), N passes, with the scene's phase
 * timings. Diagnostic only; the benchmark runners stay the reference. */
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as occlude from '../../../packages/occlude/src/index.js';
import {compileSketchAsync,initOcclude,liveExampleToJs,exportSvg} from '../../../packages/occlude/src/index.js';
import {requireFor} from '../../../packages/occlude/tools/inputs.js';
import {workloads} from '../benchmark-surface/workloads.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
await initOcclude(readFileSync(root+'crates/occlude-core/pkg/occlude_core_bg.wasm'));
const wanted=process.env.WORKLOAD??'woven-vessel',passes=Number(process.env.PASSES??2);
const workload=workloads.find(w=>w.name===wanted);
if(!workload)throw new Error(`no workload ${wanted}`);
for(const pass of Array.from({length:passes},(_,i)=>i===0?'cold':'warm')){
  const js=liveExampleToJs(workload.src),module={exports:{} as {default?:unknown}};
  new Function('require','module','exports',js)(requireFor(occlude.DEFAULT_PENS,occlude.DEFAULT_PAPERS),module,module.exports);
  const started=performance.now();
  const run=await compileSketchAsync(module.exports.default as never,{paper:{w:210,h:297},seed:42,library:occlude.DEFAULT_PENS} as never);
  const compileMs=performance.now()-started;
  const svg=exportSvg(run,{} as never);
  const scenes=[...run.scenes3.values()].map(s=>({features:s.features.length,candidates:s.stats.candidates,wallMs:Math.round(s.stats.wallMs),stats:s.stats}));
  console.log(JSON.stringify({pass,compileMs:Math.round(compileMs),svgBytes:svg.length,modeling:run.modeling3.map(m=>({operation:m.operation,backend:m.backend,wallMs:Math.round(m.timings?.wallMs??0),segments:m.hatch?.segments??m.mapping?.outputSegments??m.intersections?.outputSegments})),scenes},null,2));
}
