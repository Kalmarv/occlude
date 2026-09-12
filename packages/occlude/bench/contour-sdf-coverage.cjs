// Independent raster diagnostics of the actual unmodified SVG ink. The target
// is the full original thickened material (not an erosion that loses fingers).
// Distances are 8-neighbour chamfer distances to occupied pixels, not an exact
// vector Hausdorff bound. Native tests separately sample vector centerlines.
const {chromium}=require('playwright-core');const {PNG}=require('pngjs');
const fs=require('node:fs');const path=require('node:path');
const dir=path.resolve(process.argv[2]);const size=Number(process.env.SIZE||6000);
function distance(mask){
 const d=new Float32Array(size*size);for(let i=0;i<d.length;i++)d[i]=mask[i]?0:1e9;
 const diag=Math.SQRT2;
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const i=y*size+x;let v=d[i];if(x)v=Math.min(v,d[i-1]+1);if(y){v=Math.min(v,d[i-size]+1);if(x)v=Math.min(v,d[i-size-1]+diag);if(x+1<size)v=Math.min(v,d[i-size+1]+diag);}d[i]=v;
 }
 for(let y=size-1;y>=0;y--)for(let x=size-1;x>=0;x--){
  const i=y*size+x;let v=d[i];if(x+1<size)v=Math.min(v,d[i+1]+1);if(y+1<size){v=Math.min(v,d[i+size]+1);if(x)v=Math.min(v,d[i+size-1]+diag);if(x+1<size)v=Math.min(v,d[i+size+1]+diag);}d[i]=v;
 }return d;
}
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:size,height:size}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function mask(file){
  const svg=fs.readFileSync(path.join(dir,file),'utf8');
  await page.setContent(`<style>body{margin:0;background:white}svg{display:block;width:${size}px;height:${size}px}</style>`+svg);
  const png=PNG.sync.read(await page.screenshot());const out=new Uint8Array(size*size);
  for(let i=0;i<out.length;i++)out[i]=Math.min(png.data[4*i],png.data[4*i+1],png.data[4*i+2])<128?1:0;
  return out;
 }
 const name='recursive-variable-intact';
 const area=await mask(`${name}-area.svg`);const toArea=distance(area);const results=[];
 for(const engine of ['current','sdf']){
  const ink=await mask(`${name}-${engine}.svg`);const toInk=distance(ink);
  let missing=0,excess=0,maxMissing=0,maxExcess=0,areaPixels=0;
  for(let i=0;i<ink.length;i++){
   if(area[i]){areaPixels++;if(!ink[i]){missing++;maxMissing=Math.max(maxMissing,toInk[i]);}}
   if(ink[i]&&!area[i]){excess++;maxExcess=Math.max(maxExcess,toArea[i]);}
  }
  results.push({engine,areaPixels,missingPixels:missing,excessPixels:excess,maxDistanceToInkMm:maxMissing*304.8/size,maxDistanceOutsideAreaMm:maxExcess*304.8/size});
 }
 const result={size,resolutionMm:304.8/size,method:'thresholded SVG raster / 8-neighbour chamfer',pageErrors:errors,results};
 fs.writeFileSync(path.join(dir,'coverage.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 await browser.close();if(errors.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
