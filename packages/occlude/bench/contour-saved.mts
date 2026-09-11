// Actual artwork comparison, using the saved pen library. No saved sketch is edited.
// pnpm --filter occlude exec tsx bench/contour-saved.mts
import {readFileSync,writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {transformSync} from 'esbuild';
import * as o from '../src/index.js';
await o.initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));
o.setPenLibrary(JSON.parse(readFileSync(new URL('./fixtures/contour/pens.json',import.meta.url),'utf8')));
const report=[];
for(const variant of ['solid','native']){
 const source=readFileSync(new URL(`./fixtures/contour/contours-3-${variant}.ts`,import.meta.url),'utf8');
 const js=transformSync(source,{loader:'ts',format:'cjs'}).code;
 const module={exports:{} as {default:o.SketchDef}};
 new Function('require','exports','module',js)((n:string)=>{if(n==='occlude')return o;throw Error(n)},module.exports,module);
 const generation:number[]=[],planning:number[]=[];
 let row:Record<string,unknown>={};
 for(let i=0;i<4;i++){
  const t=performance.now();const r=o.render(module.exports.default,{paper:'A4'});const a=performance.now();
  const p=await o.plan(r);const b=performance.now();
  if(i){generation.push(a-t);planning.push(b-a)}
  if(i===3){
   const flat=o.planToolpath(p,o.selectAll(p),0.025);
   const estimate=o.estimatePlanMs(flat,pi=>r.pens[pi],{travelFeed:6000,acceleration:1000,travelAcceleration:2000,junctionDeviation:0.02,minimumCruiseRatio:0.5});
   row={variant,runs:p.chains.length,etaMinutes:estimate.totalMs/60000,diagnostics:r.stats.contour,primitives:p.chains.reduce((s,c)=>s+c.prims.length,0)};
   writeFileSync(new URL(`./contour-comparison/saved-contours-${variant}.svg`,import.meta.url),o.planSvg(p,o.selectAll(p),r.pens));
  }
 }
 generation.sort((a,b)=>a-b);planning.sort((a,b)=>a-b);
 row.generationMs={median:generation[1],tail:generation[2]};row.planningMs={median:planning[1],tail:planning[2]};report.push(row);console.log(JSON.stringify(row));
}
writeFileSync(new URL('./contour-saved-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
