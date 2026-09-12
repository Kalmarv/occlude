// Run serially: node bench/contour-sdf-compare.cjs <experimental.wasm> <out-dir>
// Uses one warmup + three timed renders per sketch/engine. The 20-second
// Studio gate is reported per render; slower diagnostic runs may finish so
// the comparison still includes their SVG and plot ETA.
const {spawnSync}=require('node:child_process');
const {mkdirSync,copyFileSync,readFileSync,writeFileSync,mkdtempSync,rmSync}=require('node:fs');
const {createHash}=require('node:crypto');const {cpus,tmpdir}=require('node:os');
const {buildSync}=require('esbuild');const path=require('node:path');
const sdf=path.resolve(process.argv[2]);const out=path.resolve(process.argv[3]||'/tmp/occlude-sdf-comparison');
mkdirSync(out,{recursive:true});
// Keep the bundled runner beside the original entry so its import.meta.url
// paths still resolve pens and the production WASM correctly.
const entry=path.join(__dirname,'.sdf-comparison-runner.mjs');
const snapshots=mkdtempSync(path.join(tmpdir(),'occlude-sdf-'));
const current=path.join(snapshots,'current.wasm');const experimental=path.join(snapshots,'sdf.wasm');
copyFileSync(path.resolve(__dirname,'../../../crates/occlude-core/pkg/occlude_core_bg.wasm'),current);copyFileSync(sdf,experimental);
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const environment={runtime:process.version,cpu:cpus()[0]?.model,currentWasm:sha(current),sdfWasm:sha(experimental),warmup:1,samples:3,studioGateMs:20000};
writeFileSync(path.join(out,'environment.json'),JSON.stringify(environment,null,2)+'\n');
try {
 buildSync({entryPoints:[path.join(__dirname,'contour-sdf-case.ts')],outfile:entry,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
 const jobs=[];
 for(const name of ['variable','constant','radial'])for(const engine of ['current','sdf'])jobs.push({name,engine,width:name==='variable'?0.45:0.4,samples:3,intact:false});
 for(const engine of ['current','sdf'])jobs.push({name:'variable',engine,width:0.45,samples:1,intact:true});
 for(const job of jobs){
  if(process.env.SKIP_CURRENT && job.engine==='current')continue;
  const fixture=path.join(__dirname,`fixtures/contour-sdf/recursive-${job.name}.ts`);
  const result=spawnSync(process.execPath,[entry,fixture,job.engine,out,String(job.width),String(job.samples)],{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,env:{...process.env,BENCH_WASM:job.engine==='current'?current:experimental,...(job.intact?{NO_MODIFIERS:'1'}:{})}});
  const stem=`recursive-${job.name}${job.intact?'-intact':''}-${job.engine}`;
  writeFileSync(path.join(out,stem+'.jsonl'),result.stdout||'');
  process.stdout.write(result.stdout||'');
  if(result.status || result.error)console.log(JSON.stringify({job,error:result.error?.message||result.stderr}));
 }
}finally{rmSync(entry,{force:true});rmSync(snapshots,{recursive:true,force:true});}
