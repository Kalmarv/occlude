// Each render has Studio's 20-second deadline. Run widths serially in isolated
// processes so a synchronous WASM timeout cannot prevent later cases running.
// node contour-sdf-widths.cjs <wasm> <fixture> <output.jsonl> [1,10,45,100]
const {spawn}=require('node:child_process');
const {buildSync}=require('esbuild');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const [wasm,fixture,output,selection]=process.argv.slice(2);
const widths=selection?selection.split(',').map(Number):Array.from({length:100},(_,i)=>i+1);
const entry=path.join(__dirname,`.sdf-width-runner-${process.pid}.mjs`);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'occlude-sdf-widths-'));
(async()=>{
 buildSync({entryPoints:[path.join(__dirname,'contour-sdf-case.ts')],outfile:entry,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
 fs.writeFileSync(output,'');
 for(const hundredths of widths){
  const width=hundredths/100;
  const result=await new Promise(resolve=>{
   const child=spawn(process.execPath,[entry,path.resolve(fixture),'sdf',temp,String(width),'0'],{env:{...process.env,BENCH_WASM:path.resolve(wasm),NO_ARTIFACTS:'1'},stdio:['ignore','pipe','pipe']});
   let pending='',stderr='',render,final,timedOut=false;
   let timer=setTimeout(()=>{timedOut=true;child.kill();},30000);
   child.stdout.on('data',chunk=>{
    pending+=chunk.toString();let end;
    while((end=pending.indexOf('\n'))>=0){
     const line=pending.slice(0,end);pending=pending.slice(end+1);
     try {const row=JSON.parse(line);
      if(row.stage==='start'){clearTimeout(timer);timer=setTimeout(()=>{timedOut=true;child.kill();},20000);}
      else if(row.stage==='render'){render=row;clearTimeout(timer);timer=setTimeout(()=>{timedOut=true;child.kill();},30000);}
      else if(row.error || row.runs!==undefined)final=row;
     }catch{}
    }
   });
   child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-4000);});
   child.on('error',error=>{clearTimeout(timer);resolve({width,error:String(error)});});
   child.on('close',(code,signal)=>{
    clearTimeout(timer);
    resolve({...(final||{}),width,...(render?{samples:1,warmup:0}:{}),...(render?{renderMs:render.renderMs,fragments:render.fragments}:{}),
     ...(timedOut?{error:render?'planning exceeded 30 seconds':'render exceeded 20 seconds'}:code!==0&&!final?{error:stderr||`exit ${code}, signal ${signal}`}:{})});
   });
  });
  fs.appendFileSync(output,JSON.stringify(result)+'\n');console.log(JSON.stringify(result));
 }
})().finally(()=>{fs.rmSync(entry,{force:true});fs.rmSync(temp,{recursive:true,force:true});}).catch(error=>{console.error(error);process.exitCode=1;});
