/** Exact user artwork, seed 291377256, 12-inch square paper.
 * pnpm --filter occlude exec tsx bench/contour-cleanup.mts
 * Requires the original beach-house-key.jpg in the studio assets directory.
 * The image is not redistributed with this fixture. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {cpus,platform,arch} from 'node:os';
import {transformSync} from 'esbuild';
import * as o from '../src/index.js';
import {preloadAssetsFromDisk} from '../tools/asset-preload.js';
import {dumpSceneFiles} from '../tools/scene-dump.js';
await o.initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));
o.setPenLibrary(JSON.parse(readFileSync(new URL('./fixtures/contour/beach-house-pens.json',import.meta.url),'utf8')));
o.setPaperHint(304.8,304.8);
const original=readFileSync(new URL('./fixtures/contour/beach-house.ts',import.meta.url),'utf8');
preloadAssetsFromDisk(original);
const output=new URL('./contour-comparison/',import.meta.url);mkdirSync(output,{recursive:true});
const results=[];
for(const variant of ['solid','bridged-solid','contour']){
 let source=original.replace('margin: 5','margin: 5, seed: 291377256').replaceAll("fill('contour')",`fill('${variant==='contour'?'contour':'solid'}')`);
 if(variant==='bridged-solid')source="import { mm } from 'occlude';\n"+source.replace('polygon(cs, {','polygon(cs, { bridge: levels.indexOf(cs.key) % 2 === 0 ? undefined : mm(0.8),');
 const js=transformSync(source,{loader:'ts',format:'cjs'}).code;
 const module={exports:{} as {default:o.SketchDef}};
 new Function('require','exports','module',js)((n:string)=>{if(n==='occlude')return o;throw Error(n)},module.exports,module);
 const generation:number[]=[],planning:number[]=[];
 let row:Record<string,unknown>={};
 const samples=Number(process.env.SAMPLES??3);
 for(let i=0;i<=samples;i++){
  const start=performance.now();
  const r=o.render(module.exports.default,{paper:{paper:{w:304.8,h:304.8}}});
  const generated=performance.now();const p=await o.plan(r);const planned=performance.now();
  if(i){generation.push(generated-start);planning.push(planned-generated);}
  if(i===samples){
   const flat=o.planToolpath(p,o.selectAll(p),0.025);
   const estimate=o.estimatePlanMs(flat,pi=>r.pens[pi],{travelFeed:6000,acceleration:1000,travelAcceleration:2000,junctionDeviation:0.02,minimumCruiseRatio:0.5});
   let ink=0,travel=0,x=0,y=0;
   for(const c of flat){travel+=Math.hypot(c.pts[0]-x,c.pts[1]-y);for(let j=2;j<c.pts.length;j+=2)ink+=Math.hypot(c.pts[j]-c.pts[j-2],c.pts[j+1]-c.pts[j-1]);x=c.pts.at(-2)!;y=c.pts.at(-1)!;}
   row={variant,runs:p.chains.length,inkMm:ink,travelMm:travel,etaMinutes:estimate.totalMs/60000,diagnostics:r.stats.contour,genericBridgePrimitives:r.frags.filter(f=>f.bridge).length,primitives:p.chains.reduce((s,c)=>s+c.prims.length,0)};
   writeFileSync(new URL(`cleanup-${variant}.svg`,output),o.planSvg(p,o.selectAll(p),r.pens,{background:'#fff'}));
   writeFileSync(new URL(`cleanup-${variant}-paths.svg`,output),o.planSvg(p,o.selectAll(p),r.pens,{background:'#fff'}).replace('</svg>','<style>path{stroke-width:0.07}</style></svg>'));
  }
 }
 const timing=(values:number[])=>{values.sort((a,b)=>a-b);return{median:values[Math.floor(values.length/2)],tail:values.at(-1)}};
 if(process.env.DUMP_SCENES){
  const dir=new URL(`cleanup-${variant}-dump/`,output);mkdirSync(dir,{recursive:true});
  for(const [name,data] of Object.entries(dumpSceneFiles(js,{paper:{paper:{w:304.8,h:304.8}}})))writeFileSync(new URL(name,dir),data);
 }
 row.generationMs=timing(generation);row.planningMs=timing(planning);results.push(row);console.log(JSON.stringify(row));
}
writeFileSync(new URL('./contour-cleanup-results.json',import.meta.url),JSON.stringify({runtime:process.version,hardware:cpus()[0].model,platform:`${platform()} ${arch()}`,paperMm:[304.8,304.8],seed:291377256,results},null,2)+'\n');
