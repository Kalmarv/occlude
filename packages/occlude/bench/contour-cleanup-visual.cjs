// Run after contour-cleanup.mts. Requires Playwright with Chromium installed.
// node packages/occlude/bench/contour-cleanup-visual.cjs
// Independent raster diagnostic only; production coverage is vector geometry.
const { chromium } = require('playwright-core');
const { PNG } = require('pngjs');
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, 'contour-comparison');
(async () => {
  const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
  const errors=[];
  try {
    const page=await browser.newPage({viewport:{width:6000,height:6000}});
    page.on('pageerror',e=>errors.push(e.message));
    for(const kind of ['contour','solid']){
      const svg=fs.readFileSync(path.join(dir,`cleanup-${kind}.svg`),'utf8');
      await page.setContent('<style>body{margin:0;background:white}svg{width:6000px;height:6000px}</style>'+svg);
      await page.screenshot({path:path.join(dir,`cleanup-${kind}.png`)});
    }
    const c=PNG.sync.read(fs.readFileSync(path.join(dir,'cleanup-contour.png')));
    const s=PNG.sync.read(fs.readFileSync(path.join(dir,'cleanup-solid.png')));
    let missing=0;
    for(let y=1;y<c.height-1;y++)for(let x=1;x<c.width-1;x++){
      const i=(y*c.width+x)*4;
      if(s.data[i]>40||c.data[i]<240)continue;
      let white=true;
      for(let dy=-1;dy<=1&&white;dy++)for(let dx=-1;dx<=1;dx++){
        if(c.data[((y+dy)*c.width+x+dx)*4]<240){white=false;break;}
      }
      if(white)missing++;
    }
    console.log(JSON.stringify({resolutionMm:304.8/6000,solidOnlyMissingPixelsWithWhite3x3:missing,pageErrors:errors}));
    if(missing||errors.length)process.exitCode=1;
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
