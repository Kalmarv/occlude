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
