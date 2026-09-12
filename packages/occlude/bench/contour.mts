/** Reproduce fill-only comparisons: pnpm --filter occlude exec tsx bench/contour.mts
 * Production WASM; one warmup + five samples. All variants use the shared
 * estimator and identical geometry, seed, paper, and pen. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { cpus, platform, arch } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setWasm } from '../src/render.js';
import { performance } from 'node:perf_hooks';
import { sketch, circle, rect, path, mask, fill, mm, render, evalPrim, initOcclude, planBuffer, planValue, planSvg, planToolpath, selectAll, estimatePlanMs, DEFAULT_PENS, setPenLibrary } from '../src/index.js';

const wasm = process.env.BENCH_WASM || new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url);
if (process.env.BENCH_BINDINGS) {
  const core = await import(pathToFileURL(resolve(process.env.BENCH_BINDINGS)).href);
  await core.default({ module_or_path: readFileSync(wasm) });
  setWasm(core as never);
} else {
  await initOcclude(readFileSync(wasm));
}
setPenLibrary(structuredClone(DEFAULT_PENS));
const repeats=Number(process.env.SAMPLES??5);
const cases=['disc','rounded-rectangle','annulus','many-holes','U','dumbbell','small','repeated'];
const variants=['solid','bridged-solid','contour'];
function inside(name:string,px:number,py:number):boolean {
 const x=px/2.1,y=(py-43.5)/2.1;
 const disc=(cx:number,cy:number,r:number)=>Math.hypot(x-cx,y-cy)<=r+1e-8;
 const box=(x0:number,y0:number,x1:number,y1:number)=>x>=x0-1e-8&&x<=x1+1e-8&&y>=y0-1e-8&&y<=y1+1e-8;
 const rounded=(w:number,h:number,r:number)=>{const a=Math.abs(x-50)-(w/2-r),b=Math.abs(y-50)-(h/2-r);return Math.hypot(Math.max(a,0),Math.max(b,0))+Math.min(Math.max(a,b),0)<=r+1e-8};
 if(name==='disc')return disc(50,50,40);
 if(name==='rounded-rectangle')return rounded(84,76,10);
 if(name==='annulus')return disc(50,50,40)&&!disc(50,50,18-1e-8);
 if(name==='many-holes')return rounded(84,84,8)&&Array.from({length:16},(_,i)=>!disc(20+(i%4)*20,20+Math.floor(i/4)*20,5-1e-8)).every(Boolean);
 if(name==='U')return box(10,10,90,90)&&!(x>32&&x<68&&y<66);
 if(name==='dumbbell')return box(10,15,40,85)||box(60,15,90,85)||box(40,44,60,56);
 if(name==='small')return disc(50,50,4);
 return Array.from({length:100},(_,i)=>disc(5+(i%10)*10,5+Math.floor(i/10)*10,3)).some(Boolean);
}
const results=[];
const output=process.env.BENCH_OUT ? pathToFileURL(resolve(process.env.BENCH_OUT) + '/') : new URL('./contour-comparison/',import.meta.url);mkdirSync(output,{recursive:true});
const cards:string[]=[];
for (const name of cases) for (const variant of variants) {
  const opts={stroke:false,fill:fill(variant==='contour'?'contour':'solid'),fillPen:'pigma-05-black',...(variant==='bridged-solid'?{bridge:mm(0.5)}:{})};
  const def=sketch({aspect:[1,1],seed:42},()=>{
    switch(name){
      case 'disc':return circle(50,50,40,opts);
      case 'rounded-rectangle':return rect(8,12,84,76,10,opts);
      case 'small':return circle(50,50,4,opts);
      case 'annulus':return [circle(50,50,40,opts),mask(circle(50,50,18))];
      case 'many-holes':return [rect(8,8,84,84,8,opts),...Array.from({length:16},(_,i)=>mask(circle(20+(i%4)*20,20+Math.floor(i/4)*20,5)))];
      case 'U':return path().moveTo(10,10).lineTo(32,10).lineTo(32,66).lineTo(68,66).lineTo(68,10).lineTo(90,10).lineTo(90,90).lineTo(10,90).close().build(opts);
      case 'dumbbell':return path().moveTo(10,15).lineTo(40,15).lineTo(40,44).lineTo(60,44).lineTo(60,15).lineTo(90,15).lineTo(90,85).lineTo(60,85).lineTo(60,56).lineTo(40,56).lineTo(40,85).lineTo(10,85).close().build(opts);
      default:return Array.from({length:100},(_,i)=>circle(5+(i%10)*10,5+Math.floor(i/10)*10,3,opts));
    }
  });
  const generation:number[]=[],planning:number[]=[];
  let row:Record<string,unknown>={};
  for(let i=0;i<=repeats;i++){
    const start=performance.now(); const result=render(def,{paper:'A4'}); const generated=performance.now();
    const {buffer,settings}=planBuffer(result); const planned=performance.now();
    if(i) {generation.push(generated-start);planning.push(planned-generated);}
    if(i===repeats){
      const value=planValue(buffer,settings,'benchmark'); const flat=planToolpath(value,selectAll(value),0.025);
      const estimate=estimatePlanMs(flat,pi=>result.pens[pi],{acceleration:1000,travelAcceleration:2000,travelFeed:6000,junctionDeviation:0.02,minimumCruiseRatio:0.5});
      let ink=0,travel=0,x=0,y=0;
      for(const c of flat){travel+=Math.hypot(c.pts[0]-x,c.pts[1]-y);for(let j=2;j<c.pts.length;j+=2)ink+=Math.hypot(c.pts[j]-c.pts[j-2],c.pts[j+1]-c.pts[j-1]);x=c.pts.at(-2)!;y=c.pts.at(-1)!;}
      const svg=planSvg(value,selectAll(value),result.pens,{background:'#fff'});
      writeFileSync(new URL(`${name}-${variant}.svg`,output),svg);
      const thin=svg.replace('</svg>','<style>path { stroke-width: 0.07; stroke: #20485a; }</style></svg>');
      writeFileSync(new URL(`${name}-${variant}-paths.svg`,output),thin);
      cards.push(`<article><h3>${name} · ${variant}</h3><div>${flat.length} runs · ${(estimate.totalMs/60000).toFixed(1)} min · ${(ink/1000).toFixed(1)} m ink</div><a href="${name}-${variant}-paths.svg"><img loading="lazy" src="${name}-${variant}-paths.svg" data-paths="${name}-${variant}-paths.svg" data-ink="${name}-${variant}.svg"></a></article>`);
      const bridges=result.frags.filter(f=>f.bridge);
      const sampledOutsideBridges=bridges.filter(f=>Array.from({length:33},(_,j)=>evalPrim(f.geom,j/32)).some(([x,y])=>!inside(name,x,y))).length;
      row={name,variant,genericBridges:bridges.length,sampledOutsideBridges,runs:flat.length,internalLifts:Math.max(0,flat.length-1),inkMm:ink,travelMm:travel,etaMinutes:estimate.totalMs/60000,primitives:value.chains.reduce((s,c)=>s+c.prims.length,0),planBytes:buffer.byteLength,transferBytes:result.raw.prims.byteLength+result.raw.frags.byteLength,diagnostics:result.stats.contour};
    }
  }
  const stats=(xs:number[])=>{xs.sort((a,b)=>a-b);return{median:xs[Math.floor(xs.length/2)],tail:xs.at(-1)}};
  row.generationMs=stats(generation);row.planningMs=stats(planning);results.push(row);console.log(JSON.stringify(row));
}
const report={runtime:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,samples:repeats,warmup:1,paper:'A4',pen:'pigma-05-black',seed:42,timing:{acceleration:1000,travelAcceleration:2000,travelFeed:6000,junctionDeviation:0.02,minimumCruiseRatio:0.5},results};
writeFileSync(process.env.BENCH_OUT ? new URL('results.json',output) : new URL('./contour-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');

writeFileSync(new URL('index.html',output),`<!doctype html><meta charset="utf-8"><title>Contour fill comparisons</title><style>body{font:15px system-ui;margin:24px;background:#eef1ef;color:#19332e}h1{font-size:26px}button{font:inherit;padding:8px 16px;margin-bottom:20px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}article{background:white;padding:16px;border-radius:8px}h3{margin:0 0 6px;font-size:17px}img{display:block;width:100%;height:340px;object-fit:contain}article div{color:#49655d;font-variant-numeric:tabular-nums}@media(max-width:800px){main{grid-template-columns:1fr}}</style><h1>Solid → bridged solid → contour</h1><p>Same geometry, A4 paper, Pigma 05 pen and seed 42. Thin paths reveal the motion; ink view shows the actual nib footprint. Click a drawing to zoom.</p><button id="toggle">Show ink footprint</button><main>${cards.join('')}</main><script>let ink=false;document.querySelector('#toggle').onclick=()=>{ink=!ink;document.querySelectorAll('img').forEach(i=>i.src=ink?i.dataset.ink:i.dataset.paths);document.querySelector('#toggle').textContent=ink?'Show thin toolpaths':'Show ink footprint'}</script>`);
