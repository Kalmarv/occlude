// node bench/contour-sdf-visual.cjs <artifact-directory>
const {chromium}=require('playwright-core');
const fs=require('node:fs');const path=require('node:path');
const dir=path.resolve(process.argv[2]);
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const page=await browser.newPage({viewport:{width:1800,height:1050}});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const names=['recursive-variable','recursive-constant','recursive-radial'];
 const cards=[];
 for(const name of names){
  let sections='';
  for(const engine of ['current','sdf']){
   const file=path.join(dir,`${name}-${engine}.svg`);if(!fs.existsSync(file))continue;
   const row=JSON.parse(fs.readFileSync(path.join(dir,`${name}-${engine}.json`),'utf8'));
   const svg=fs.readFileSync(file,'utf8');
   sections+=`<article><h2>${engine==='current'?'Current contour':'SDF prototype'}</h2><p>${row.renderMs?.median?.toFixed(0)||'?'} ms render · ${row.runs} runs · ${row.etaMinutes?.toFixed(1)} min ETA</p>${svg}</article>`;
  }
  const html=`<!doctype html><meta charset="utf-8"><title>${name}</title><style>body{font:16px system-ui;background:#e8e8e4;color:#20352d;margin:20px}h1{margin:0 0 8px;font-size:23px}h2{margin:0;font-size:20px}p{margin:6px 0 10px}main{display:grid;grid-template-columns:1fr 1fr;gap:20px}article{padding:16px;background:white;border-radius:10px}svg{display:block;width:100%;height:840px}</style><h1>${name} — same sketch, 12-inch paper, seed 42</h1><p>Existing modifiers retained. SDF uses separate loops and short overlapping gap marks.</p><main>${sections}</main>`;
  fs.writeFileSync(path.join(dir,`${name}.html`),html);await page.setContent(html);await page.screenshot({path:path.join(dir,`${name}.png`)});
  cards.push(`<li><a href="${name}.html">${name}</a></li>`);
 }
 fs.writeFileSync(path.join(dir,'index.html'),`<!doctype html><meta charset="utf-8"><title>Contour / SDF comparison</title><h1>Contour / SDF comparison</h1><ul>${cards.join('')}</ul>`);
 console.log(JSON.stringify({pageErrors:errors}));await browser.close();if(errors.length)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1});
