/** One isolated WASM comparison process. See contour-sdf-report.md. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { transformSync } from 'esbuild';
import * as occlude from '../src/index.js';
import { numericLoops } from '../src/boundary.js';
const [fixture, engine='current', out='/tmp/occlude-sdf-comparison', widthArg, samplesArg='3'] = process.argv.slice(2);
const wasm = process.env.BENCH_WASM || new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url);
await occlude.initOcclude(readFileSync(wasm));
const pens = JSON.parse(readFileSync(process.env.BENCH_PENS || new URL('./fixtures/contour-sdf/pens.json',import.meta.url),'utf8'));
if (widthArg) for(const p of pens) p.width=Number(widthArg);
occlude.setPenLibrary(pens);
let source = readFileSync(resolve(fixture),'utf8');
if(process.env.NO_MODIFIERS) source=source.replace(/decimate\(0\.[35],/g,'decimate(0,').replace(', polygon(thick))];', ')];').replace("fill: fill('contour')", "stroke: false, fill: fill('contour')");
if(process.env.SOLID) source=source.replaceAll("fill('contour')","fill('solid')");
source=source.replace('  return [', '  globalThis.__sdfBoundary = thick; return [');
const module={exports:{} as {default:occlude.SketchDef}};
new Function('require','exports','module',transformSync(source,{loader:'ts',format:'cjs'}).code)(()=>occlude,module.exports,module);
const def=module.exports.default;
const name=basename(fixture,'.ts')+(process.env.NO_MODIFIERS?'-intact':'');
mkdirSync(out,{recursive:true});
const renderMs:number[]=[],planMs:number[]=[];
let referenceHash:string|undefined;
for(let i=0;i<=Number(samplesArg);i++) {
 console.log(JSON.stringify({stage:"start",name,engine,sample:i}));
 const start=performance.now();
 try {
  const result=occlude.render(def,{paper:{paper:{w:304.8,h:304.8}}});
  const generated=performance.now();
  console.log(JSON.stringify({stage:'render',name,engine,sample:i,renderMs:generated-start,fragments:result.frags.length,diagnostics:result.stats.contour}));
  const {buffer,settings}=occlude.planBuffer(result);
  const planned=performance.now();
  const planSha256=createHash('sha256').update(new Uint8Array(buffer.buffer,buffer.byteOffset,buffer.byteLength)).digest('hex');
  if(referenceHash && planSha256!==referenceHash) throw Error('identical input produced a different encoded plan');
  referenceHash=planSha256;
  if(i || Number(samplesArg) === 0) {renderMs.push(generated-start);planMs.push(planned-generated);}
  if(i!==Number(samplesArg)) continue;
  const value=occlude.planValue(buffer,settings,'sdf-comparison');
  let maxGap=0;
  for(const chain of value.chains) for(let j=0;j<chain.prims.length;j++) {
   const p=chain.prims[j], a=occlude.evalPrim(p,0), b=occlude.evalPrim(p,1);
   if(![...a,...b].every(Number.isFinite)) throw Error('nonfinite plan coordinate');
   if(j) {const prev=occlude.evalPrim(chain.prims[j-1],1);maxGap=Math.max(maxGap,Math.hypot(a[0]-prev[0],a[1]-prev[1]));}
  }
  if(maxGap>1e-8) throw Error(`decoded plan gap ${maxGap} mm`);
  const flat=occlude.planToolpath(value,occlude.selectAll(value),0.025);
  const eta=occlude.estimatePlanMs(flat,pi=>result.pens[pi],{acceleration:1000,travelAcceleration:2000,travelFeed:6000,junctionDeviation:0.02,minimumCruiseRatio:0.5});
  let inkMm=0,travelMm=0,x=0,y=0;
  for(const c of flat){travelMm+=Math.hypot(c.pts[0]-x,c.pts[1]-y);for(let j=2;j<c.pts.length;j+=2)inkMm+=Math.hypot(c.pts[j]-c.pts[j-2],c.pts[j+1]-c.pts[j-1]);x=c.pts.at(-2)!;y=c.pts.at(-1)!;}
  if (!process.env.NO_ARTIFACTS) {
  const svg=occlude.planSvg(value,occlude.selectAll(value),result.pens,{background:'#fff'});
  writeFileSync(resolve(out,`${name}-${engine}.svg`),svg);
  const loops=numericLoops((globalThis as any).__sdfBoundary,'SDF comparison');
  const d=loops.map(r=>'M'+r.map(p=>p.join(',')).join('L')+'Z').join('');
  // These square fixtures use the 0..100 sketch frame. Drawable clipping is
  // 5 percent on each side, matching the native scene's explicit bounds.
  writeFileSync(resolve(out,`${name}-area.svg`),`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="white"/><defs><clipPath id="bounds"><rect x="5" y="5" width="90" height="90"/></clipPath></defs><g clip-path="url(#bounds)"><path d="${d}" transform="translate(5 5) scale(0.9)" fill="black" fill-rule="evenodd"/></g></svg>`);
  writeFileSync(resolve(out,`${name}-${engine}-paths.svg`),svg.replace('</svg>','<style>path {stroke-width:0.055;stroke:#193f50}</style></svg>'));
  }
  const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {median:v[Math.floor(v.length/2)],tail:v.at(-1)}};
  const row={name,engine,width:widthArg||'saved pens',paperMm:304.8,seed:42,samples:Math.max(1,Number(samplesArg)),warmup:Number(samplesArg)>0?1:0,renderMs:stats(renderMs),planMs:stats(planMs),runs:flat.length,internalLifts:Math.max(0,flat.length-1),inkMm,travelMm,etaMinutes:eta.totalMs/60000,primitives:value.chains.reduce((s,c)=>s+c.prims.length,0),planBytes:buffer.byteLength,planSha256,maxGap,diagnostics:result.stats.contour};
  writeFileSync(resolve(out,`${name}-${engine}.json`),JSON.stringify(row,null,2)+'\n');console.log(JSON.stringify(row));
 } catch(error) {
  const row={name,engine,sample:i,error:String(error),elapsedMs:performance.now()-start};
  writeFileSync(resolve(out,`${name}-${engine}.json`),JSON.stringify(row,null,2)+'\n');console.log(JSON.stringify(row));process.exitCode=1;break;
 }
}
