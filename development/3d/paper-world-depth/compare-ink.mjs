/** Bundle the unchanged docs runner against old/new visibility sources only. */
import {build} from '../../../packages/occlude/node_modules/esbuild/lib/main.js';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd(),out=resolve(root,'development/3d/paper-world-depth/ink');await mkdir(out,{recursive:true});
const md=await readFile('docs/three.md','utf8'),source=[...md.matchAll(/```ts live([^\n]*)\n([\s\S]*?)```/g)][16][2];
const entry=`
import {readFileSync,writeFileSync} from 'node:fs';
import {compileSketchAsync,initOcclude,exportSvg,DEFAULT_PENS,DEFAULT_PAPERS,liveExampleToJs,docsPaper,parseLiveMeta,paperSize} from ${JSON.stringify(resolve(root,'packages/occlude/src/index.ts'))};
import {requireFor} from ${JSON.stringify(resolve(root,'packages/occlude/tools/inputs.ts'))};
import {transformSurface3} from ${JSON.stringify(resolve(root,'packages/occlude/src/three/geometry/model.ts'))};
await initOcclude(readFileSync(${JSON.stringify(resolve(root,'crates/occlude-core/pkg/occlude_core_bg.wasm'))}));
const module={exports:{}};
new Function('require','exports','module',liveExampleToJs(${JSON.stringify(source)}))(requireFor(DEFAULT_PENS,DEFAULT_PAPERS),module.exports,module);
const sheet=docsPaper(parseLiveMeta('')),options={paper:sheet,marginPct:5,seed:'42',library:structuredClone(DEFAULT_PENS)};
const run=await compileSketchAsync(module.exports.default,{...options,paper:paperSize(sheet)});
writeFileSync(process.argv[2],exportSvg(run,options));
writeFileSync(process.argv[2]+'.json',JSON.stringify([...run.scenes3.values()].flatMap(s=>s.features.map(r=>({id:r.feature.id,a:r.feature.a,b:r.feature.b,basis:r.feature.basis,support:r.feature.support,hidden:r.hidden,visible:r.visible})))));
writeFileSync(process.argv[2]+'.world.json',JSON.stringify([...run.scenes3].map(([scene,classified])=>({camera:classified.frame.camera,triangles:scene.objects.flatMap(o=>{const s=o.transform?transformSurface3(o.surface,o.transform):o.surface;return s.triangles.map(t=>({id:JSON.stringify([o.id,s.faces[t.face].id,...t.vertices.map(i=>s.points[i].id)]),points:t.vertices.map(i=>s.points[i].position)}));})}))));
`;
const reports=[];
for(const name of ['before','after']){
 const plugins=name==='before'?[{name:'previous-visibility',setup(build){build.onLoad({filter:/\/three\/(features\/snapshot|visibility\/interval)\.ts$/},args=>({contents:execFileSync('git',['show','0acbd61:'+args.path.slice(root.length+1)],{encoding:'utf8'}),loader:'ts'}));}}]:[];
 const target=out+'/'+name+'.mjs';await build({stdin:{contents:entry,resolveDir:root,sourcefile:'ink-comparison.ts',loader:'ts'},outfile:target,bundle:true,platform:'node',format:'esm',plugins,banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"},logLevel:'silent'});
 execFileSync(process.execPath,[target,out+'/'+name+'.svg'],{stdio:'pipe'});
 const svg=await readFile(out+'/'+name+'.svg');reports.push({name,sha256:createHash('sha256').update(svg).digest('hex'),bytes:svg.length});
}
await writeFile(out+'/hashes.json',JSON.stringify(reports,null,2));console.log(reports);
