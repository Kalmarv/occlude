/** Capture the exact store fixture for an independent world-space box oracle. */
import {readFileSync,writeFileSync} from 'node:fs';
import {transformSync} from 'esbuild';
import {requireFor} from './inputs.js';
import {initOcclude,compileSketchAsync,exportSvg,type SketchDef,type Camera3} from '../src/index.js';
import {cameraFrame3} from '../src/three/camera.js';
import {featureSnapshot3} from '../src/three/features/snapshot.js';
import {classifySceneCpu3} from '../src/three/visibility/scene.js';
const root=(process.env.OCCLUDE_PAPER_FIXTURE??'../../development/3d/paper-box-oracle')+'/';
await initOcclude(readFileSync('../../crates/occlude-core/pkg/occlude_core_bg.wasm'));
const source=readFileSync(root+'source.ts','utf8'),module={exports:{} as {default:SketchDef}};
new Function('require','exports','module',transformSync(source,{loader:'ts',format:'cjs'}).code)(requireFor([],[]),module.exports,module);
const exec=await compileSketchAsync(module.exports.default),[scene,classified]=[...exec.scenes3][0];
const saved=classified.frame.camera;
const base={target:saved.target,up:saved.up,near:saved.near,far:saved.far};
const variants:Camera3[]=[saved,
 {...base,kind:'perspective',fovDegrees:40,eye:saved.eye},
 {...base,kind:'orthographic',span:4.6,eye:[7,4,-6]},
 {...base,kind:'perspective',fovDegrees:40,eye:[7,4,-6]}];
const cases=variants.map((camera,index)=>{
 const out=classifySceneCpu3(featureSnapshot3(scene.objects,[],cameraFrame3(camera,classified.frame.paper),exec.frame.inner));
 return {index,camera,features:out.features.filter(r=>!r.feature.curve), curves:out.features.filter(r=>r.feature.curve&&(process.env.OCCLUDE_PAPER_ALL_CURVES==='1'||r.visible.some(([a,b])=>b-a<1e-10)))};
});
writeFileSync(root+'cpu.json',JSON.stringify({paper:classified.frame.paper,objects:scene.objects.map(o=>({id:o.id,surface:o.surface})),cases}));
writeFileSync(root+'cpu.svg',exportSvg(exec));
console.log(JSON.stringify(cases.map(c=>({index:c.index,kind:c.camera.kind,edges:c.features.length}))));
