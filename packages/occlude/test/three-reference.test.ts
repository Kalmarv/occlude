import { it, expect } from 'vitest';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

it('matches pinned Blender Line Art coverage and detects a displaced reference segment', () => {
  const directory=mkdtempSync(join(tmpdir(),'occlude-reference-'));
  try{
    for(const name of ['fixtures.json','blender.json'])copyFileSync(new URL(`../../../development/3d/reference/${name}`,import.meta.url),join(directory,name));
    const run=()=>spawnSync(process.execPath,[createRequire(import.meta.url).resolve('tsx/cli'),fileURLToPath(new URL('../tools/compare-blender3.ts',import.meta.url)),directory],{encoding:'utf8'});
    const valid=run();expect(valid.status,valid.stdout+valid.stderr).toBe(0);
    const comparison=JSON.parse(readFileSync(join(directory,'comparison.json'),'utf8'));
    expect(comparison.cases).toHaveLength(8);expect(comparison.passed).toBe(true);
    const path=join(directory,'blender.json'),reference=JSON.parse(readFileSync(path,'utf8'));
    for(const point of reference.cases[0].segments[0])point[0]+=0.1;
    writeFileSync(path,JSON.stringify(reference));
    const displaced=run();expect(displaced.status).not.toBe(0);
    expect(JSON.parse(readFileSync(join(directory,'comparison.json'),'utf8')).passed).toBe(false);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

it('records Freestyle coverage differences while independent rays validate Occlude', () => {
  const directory=mkdtempSync(join(tmpdir(),'occlude-freestyle-'));
  try {
    for(const name of ['fixtures.json','freestyle.json'])copyFileSync(new URL(`../../../development/3d/reference/${name}`,import.meta.url),join(directory,name));
    const run=spawnSync(process.execPath,[createRequire(import.meta.url).resolve('tsx/cli'),fileURLToPath(new URL('../tools/compare-blender3.ts',import.meta.url)),directory,'-','freestyle'],{encoding:'utf8'});
    expect(run.status).toBe(1); // Strict comparator must not silently bless known mismatches.
    const comparison=JSON.parse(readFileSync(join(directory,'freestyle-comparison.json'),'utf8'));
    expect(comparison.cases).toHaveLength(8);
    expect(comparison.cases.filter((c:{passed:boolean})=>c.passed)).toHaveLength(6);
    const different=comparison.cases.filter((c:{passed:boolean})=>!c.passed);
    expect(different.map((c:{id:string;visibility:string})=>[c.id,c.visibility])).toEqual([['crossing-boxes','visible'],['crossing-boxes','hidden']]);
    expect(different[0].extraMm).toBeCloseTo(6.8599434,5);
    expect(different[0].missingMm).toBeCloseTo(11.6596714,5);
    expect(different[1].extraMm).toBeCloseTo(11.6596714,5);
    expect(different[1].missingMm).toBeCloseTo(6.8599548,5);
    expect(comparison.cases.reduce((n:number,c:{rayChecks:number})=>n+c.rayChecks,0)).toBe(174);
    // Canonical shared-edge roots close the perspective cube's false visible
    // gap and merge its adjoining hidden runs. Surviving runs have interiors;
    // coverage differences and their independent ray checks remain explicit.
    expect(comparison.cases.reduce((n:number,c:{unrepresentableInteriorSamples:number})=>n+c.unrepresentableInteriorSamples,0)).toBe(0);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

it('matches Freestyle constant physical width and color with an actual Occlude SVG', async () => {
  const {initOcclude,sketch,pen,paper,mm,box3,lineArt3,compileSketchAsync,exportSvg}=await import('../src/index.js');
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url)));
  const reference=JSON.parse(readFileSync(new URL('../../../development/3d/reference/freestyle.json',import.meta.url),'utf8'));
  let vertices=0;
  for(const c of reference.cases) {
    expect(c.strokes.length).toBeGreaterThan(0);
    for(const stroke of c.strokes) {
      expect(stroke.widthsMm.length).toBe(stroke.colors.length);
      for(const width of stroke.widthsMm) { expect(width).toBeCloseTo(.3,7); vertices++; }
      for(const color of stroke.colors)for(let i=0;i<3;i++)expect(color[i]).toBeCloseTo([.2,.4,.6][i],7);
    }
  }
  expect(vertices).toBeGreaterThan(100);
  const svg=exportSvg(await compileSketchAsync(sketch({paper:paper({width:mm(100),height:mm(100)}),margin:0,pens:{ink:pen({width:mm(.3),color:'#336699'})}},()=>lineArt3({objects:[{id:'cube',surface:box3([2,2,2])}],camera:{kind:'orthographic',span:5,eye:[5,7,6],target:[0,0,0],near:.1,far:30},lineSets:[{id:'visible',stroke:'ink'}]}))));
  expect(svg).toContain('stroke-width="0.3"'); expect(svg.toLowerCase()).toContain('#336699');
});
