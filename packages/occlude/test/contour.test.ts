import { readFileSync } from 'node:fs';
import { beforeAll, expect, it } from 'vitest';
import { circle, rect, fill, mm, mask, clip, dash, decimate, modify, sketch, render, plan, planToolpath, selectAll, initOcclude, evalPrim, planSvg, planGcode } from '../src/index.js';

beforeAll(async () => {
  await initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url)));
});
const draw = (shape: ReturnType<typeof circle>) => render(sketch({ aspect: [1,1], seed:42 }, () => shape), { paper:'Square20' });

it('resolves native spacing and generates connected runs through real WASM', async () => {
  for (const shape of [circle(50,50,35,{stroke:false,fill:fill('contour')}),rect(10,15,80,70,10,{stroke:false,fill:fill('contour')})]) {
    const result = draw(shape);
    expect(result.stats.contour?.fallbacks).toBe(0);
    expect(result.stats.contour?.validationSplits).toBe(0);
    const ordered = await plan(result,{bridge:false});
    expect(ordered.chains.length).toBeLessThanOrEqual(2);
    expect(result.stats.contour?.contours).toBeGreaterThan(100);
    for (const chain of ordered.chains) for (let i=1;i<chain.prims.length;i++) {
      const a=evalPrim(chain.prims[i-1],1), b=evalPrim(chain.prims[i],0);
      expect(Math.hypot(a[0]-b[0],a[1]-b[1])).toBeLessThan(1e-8);
    }
    const flat=planToolpath(ordered,selectAll(ordered),0.025);
    expect(flat.length).toBe(ordered.chains.length);
    expect(planSvg(ordered,selectAll(ordered),result.pens)).toContain('<path');
    expect(planGcode(ordered,selectAll(ordered),result.pens).length).toBeGreaterThan(0);
    expect((await plan(draw(shape),{bridge:false})).buffer).toEqual(ordered.buffer);
  }
});

it('rejects invalid spacing and meaningless parameters', () => {
  for (const spacing of [0,-1,NaN,Infinity]) {
    expect(()=>draw(circle(50,50,20,{fill:fill('contour',{spacing})}))).toThrow(/spacing/);
  }
  expect(()=>draw(circle(50,50,20,{fill:fill('contour',{angle:45})}))).toThrow(/unsupported parameter/);
  expect(draw(circle(50,50,20,{stroke:false,fill:fill('contour',{spacing:mm(2)})})).frags.length).toBeGreaterThan(0);
});

it('constructs islands before generating and respects nested clips', async () => {
  const result=render(sketch({aspect:[1,1]},()=>[
    clip(rect(10,10,80,80),clip(circle(50,50,42),rect(0,0,100,100,{stroke:false,fill:fill('contour')}))),
    mask(rect(48,0,4,100)),
  ]),{paper:'Square20'});
  const ordered=await plan(result);
  expect(ordered.chains.length).toBeGreaterThanOrEqual(2);
  // The slit occupies x=96..104 mm in this zero-margin Square20 frame.
  for (const chain of ordered.chains) {
    const positions=chain.prims.flatMap(p=>Array.from({length:9},(_,i)=>evalPrim(p,i/8)));
    const xs=positions.map(p=>p[0]);
    expect(xs.every(x=>x<=96+1e-6) || xs.every(x=>x>=104-1e-6)).toBe(true);
  }
});

it('does not heal intentional dash or decimation breaks', async () => {
  for (const modifier of [dash(mm(1),mm(0.1)),decimate({fill:0.25})]) {
    const result=render(sketch({aspect:[1,1],seed:42},()=>modify([modifier],circle(50,50,15,{stroke:false,fill:fill('contour')}))),{paper:'Square20'});
    const normal=await plan(result);
    const unbridged=await plan(result,{bridge:false});
    expect(normal.chains.length).toBeGreaterThan(2);
    expect(normal.chains.length).toBe(unbridged.chains.length);
  }
});

it('uses the fill pen independently and preserves sub-nib remnants', async () => {
  const r=draw(circle(50,50,0.04,{stroke:false,fill:fill('contour',{spacing:mm(2)})}));
  expect(r.frags.length).toBeGreaterThan(0);
  expect(r.frags.every(f=>f.dot)).toBe(true);
  const pens=draw(circle(50,50,10,{pen:'pigma-01-black',fillPen:'pigma-05-black',fill:fill('contour')}));
  expect(new Set(pens.frags.map(f=>pens.pens[f.pen].name)).size).toBe(2);
  expect((await plan(pens)).chains.length).toBeGreaterThanOrEqual(2);
});

it('revalidates wobble against the original visible area', async () => {
  const {wobble}=await import('../src/index.js');
  const r=render(sketch({aspect:[1,1],seed:42},()=>wobble(mm(1),circle(50,50,10,{stroke:false,fill:fill('contour')}))),{paper:'Square20'});
  expect(r.frags.length).toBeGreaterThan(0);
  for(const f of r.frags)for(let i=0;i<=4;i++){
    const [x,y]=evalPrim(f.geom,i/4);expect(Math.hypot(x-100,y-100)).toBeLessThanOrEqual(20+1e-7);
  }
  const p=await plan(r);
  for(const c of p.chains)for(let i=1;i<c.prims.length;i++){
    const a=evalPrim(c.prims[i-1],1),b=evalPrim(c.prims[i],0);expect(Math.hypot(a[0]-b[0],a[1]-b[1])).toBeLessThan(1e-8);
  }
});

it('handles mirrored, nonuniformly scaled cubic outlines and pre-smoothing', async () => {
  const {path,group,smooth}=await import('../src/index.js');
  const source=path().moveTo(25,30).bezierTo(25,5,80,20,75,50).bezierTo(90,85,20,85,25,30).close().build({stroke:false,fill:fill('contour')});
  const def=sketch({aspect:[1,1],seed:42},()=>group({origin:[50,50],scale:[-0.8,1.1],rotate:17},smooth(1,source)));
  const a=render(def,{paper:'Square20'}),b=render(def,{paper:'Square20'});
  expect(a.frags.length).toBeGreaterThan(0);
  expect(Array.from(a.raw.prims).every(Number.isFinite)).toBe(true);
  expect(a.raw.prims).toEqual(b.raw.prims);
  expect((await plan(a)).buffer).toEqual((await plan(b)).buffer);
});
