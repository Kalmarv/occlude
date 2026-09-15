/** Headless CPU reference: each workload twice in one process (cold, then warm). */
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as occlude from '../../src/index.js';
import {compileSketchAsync,initOcclude,liveExampleToJs,exportSvg} from '../../src/index.js';
import {requireFor} from '../../tools/inputs.js';
import {workloads} from './workloads.mjs';
const root=fileURLToPath(new URL('../../../../',import.meta.url));
await initOcclude(readFileSync(root+'crates/occlude-core/pkg/occlude_core_bg.wasm'));
const rows=[];
for(const {name,src} of workloads){
  const runs=[];
  for(const pass of ['cold','warm']){
    const js=liveExampleToJs(src),module={exports:{} as {default?:unknown}};
    new Function('require','module','exports',js)(requireFor(occlude.DEFAULT_PENS,occlude.DEFAULT_PAPERS),module,module.exports);
    const started=performance.now();
    const run=await compileSketchAsync(module.exports.default as never,{paper:{w:210,h:297},seed:42,library:occlude.DEFAULT_PENS} as never);
    const compileMs=performance.now()-started,svgStarted=performance.now(),svg=exportSvg(run,{} as never),svgMs=performance.now()-svgStarted;
    const scenes=[...run.scenes3.values()].map(s=>({features:s.features.length,candidates:s.stats.candidates,wallMs:Math.round(s.stats.wallMs)}));
    runs.push({pass,compileMs:Math.round(compileMs),svgMs:Math.round(svgMs),svgBytes:svg.length,modeling:run.modeling3.map(m=>({operation:m.operation,backend:m.backend,wallMs:Math.round(m.timings?.wallMs??0),segments:m.hatch?.segments??m.mapping?.outputSegments??m.intersections?.outputSegments,traces:m.hatch?.traces,toneLocations:m.hatch?.tone.locations,toneBackend:m.hatch?.tone.backend})),scenes});
  }
  rows.push({name,runs});console.log(name,JSON.stringify(runs.map(r=>[r.pass,r.compileMs,r.modeling.map(m=>`${m.operation}:${m.wallMs}ms/${m.segments}`).join(' ')])));
}
writeFileSync(new URL('./results/cpu.json',import.meta.url),JSON.stringify({hardware:'headless node, CPU reference, no GPU',node:process.version,rows},null,2)+'\n');
