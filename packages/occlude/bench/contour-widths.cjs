// pnpm --filter occlude exec node bench/contour-widths.cjs [first hundredth] [last hundredth]
// Snapshot glue, library and WASM so rebuilding during a sweep cannot mix builds.
// Each isolated render + decoded-plan check has a 20s process limit.
const {spawnSync}=require('node:child_process');
const {mkdtempSync,copyFileSync,readFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {createHash}=require('node:crypto');
const {buildSync}=require('esbuild');
const path=require('node:path');
const dir=mkdtempSync(path.join(tmpdir(),'occlude-contour-widths-'));
try {
  const wasm=path.join(dir,'core.wasm');
  copyFileSync(path.resolve(__dirname,'../../../crates/occlude-core/pkg/occlude_core_bg.wasm'),wasm);
  const entry=path.join(dir,'case.mjs');
  buildSync({entryPoints:[path.join(__dirname,'contour-width-case.ts')],outfile:entry,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
  console.log(JSON.stringify({stage:'environment',runtime:process.version,wasmSha256:createHash('sha256').update(readFileSync(wasm)).digest('hex')}));
  for(let n=Number(process.argv[2]||1);n<=Number(process.argv[3]||100);n++){
    const r=spawnSync(process.execPath,[entry,String(n/100)],{encoding:'utf8',timeout:20000,maxBuffer:2**20,env:{...process.env,BENCH_WASM:wasm}});
    process.stdout.write(r.stdout||'');
    if(r.error||r.signal)console.log(JSON.stringify({width:n/100,error:r.error?.code==='ETIMEDOUT'?'20 second timeout':String(r.error||r.signal)}));
    else if(r.status&&!r.stdout)console.log(JSON.stringify({width:n/100,error:r.stderr}));
  }
} finally { rmSync(dir,{recursive:true,force:true}); }
