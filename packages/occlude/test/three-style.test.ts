import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { compileSketchAsync, constructStrokes3, FeatureSelection3, lineArt3, sketchAsync, initOcclude, pen, mm, wobble, dash, render, type Toolkit } from '../src/index.js';
const scene = () => lineArt3({ camera: { kind:'orthographic', span:4, eye:[0,0,5],target:[0,0,0],up:[0,1,0],near:.1,far:10 }, wires:[{id:'wire',points:[[-1,0,0],[0,0,0],[1,0,0]]}],lineSets:[] });
beforeAll(async () => { await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))); });

describe('reusable classified line styles', () => {
  it('shares pending and completed visibility across independent styles and uses ordinary modifiers', async () => {
    let calls = 0, toolkit!: Toolkit;
    const value = scene();
    const run = await compileSketchAsync(sketchAsync({ pens:{ink:pen({width:mm(.3)})} }, async t => {
      toolkit = t;
      const [a,b] = await Promise.all([t.classify3(value),t.classify3(value)]);
      expect(a).toBe(b); expect(await t.classify3(value)).toBe(a);
      const selected = new FeatureSelection3(a).filter(row => row.visible.length > 0);
      const chained = constructStrokes3(a,[{id:'all',stroke:'ink',select:selected}]);
      const separate = constructStrokes3(a,[{id:'all',stroke:'ink',select:selected}],{chain:false});
      expect(chained).toHaveLength(1); expect(separate).toHaveLength(2);
      const marks = t.strokes3(chained,{modifiers:[dash(mm(2),mm(1)),wobble({amount:mm(.1),wavelength:mm(3)})]});
      expect(marks[0].opts.modifiers?.map(m=>m.kind)).toEqual(['dash','wobble']);
      return marks;
    }),undefined,{onStage:event=>{if(event.stage==='classified')calls++;}});
    expect(calls).toBe(1); expect(run.scenes3.size).toBe(1); expect(run.pendingScenes3.size).toBe(0);
    expect(render(run).stats.fragments).toBeGreaterThan(2);
    expect(()=>toolkit.classify3(value)).toThrow('active async compilation');
  });
  it('rejects a selection from another classified snapshot and validates row indices', async () => {
    await compileSketchAsync(sketchAsync({},async t=>{
      const a=await t.classify3(scene()),b=await t.classify3(scene());
      expect(()=>constructStrokes3(a,[{id:'wrong',stroke:'ink',select:new FeatureSelection3(b)}])).toThrow('another classified snapshot');
      expect(()=>new FeatureSelection3(a,[99])).toThrow('invalid');
      return null;
    }));
  });
  it('releases failed pending requests so an explicit retry can succeed', async () => {
    let calls=0;
    const run=await compileSketchAsync(sketchAsync({},async t=>{
      const value=scene();
      await expect(t.classify3(value)).rejects.toThrow('device lost');
      expect((await t.classify3(value)).features.length).toBe(2);
      return null;
    // A failure inside the classification job (here injected at its first stage) must release the pending request.
    }),undefined,{onStage:event=>{if(event.stage==='source'&&++calls===1)throw new Error('device lost');}});
    expect(calls).toBe(2); expect(run.scenes3.size).toBe(1); expect(run.pendingScenes3.size).toBe(0);
  });
});
