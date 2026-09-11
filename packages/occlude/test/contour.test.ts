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
    // Cleanup may lift rather than taking an out-and-back detour from a loop.
    expect(ordered.chains.length).toBeLessThanOrEqual(4);
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

it('preserves displacement outside the source consistently across fill types', async () => {
  const {wobble}=await import('../src/index.js');
  for (const kind of ['solid', 'hatch', 'contour']) {
    const r=render(sketch({aspect:[1,1],seed:42},()=>wobble(mm(2),circle(50,50,10,{stroke:false,fill:fill(kind)}))),{paper:'Square20'});
    const p=await plan(r);
    const distances=p.chains.flatMap(c=>c.prims.flatMap(prim=>Array.from({length:9},(_,i)=>{
      const [x,y]=evalPrim(prim,i/8); return Math.hypot(x-100,y-100);
    })));
    expect(Math.max(...distances),kind).toBeGreaterThan(20.1);
    for(const c of p.chains)for(let i=1;i<c.prims.length;i++){
      const a=evalPrim(c.prims[i-1],1),b=evalPrim(c.prims[i],0);
      expect(Math.hypot(a[0]-b[0],a[1]-b[1])).toBeLessThan(1e-8);
    }
  }
});

it('covers an attached sub-nib finger in the final decoded plan', async () => {
  const {path}=await import('../src/index.js');
  const shape=path().moveTo(20,30).lineTo(60,30).lineTo(60,49.95)
    .lineTo(80,49.95).lineTo(80,50.05).lineTo(60,50.05)
    .lineTo(60,70).lineTo(20,70).close().build({stroke:false,fill:fill('contour')});
  const result=draw(shape);
  expect(result.stats.contour?.contours).toBeGreaterThan(0);
  const decoded=await plan(result);
  const lines=planToolpath(decoded,selectAll(decoded),0.001);
  // Sample the actual finger, including its tip and both edges. Do not filter
  // samples through erosion: the whole 0.2 mm finger disappears in that inset.
  for(let ix=0;ix<=400;ix++)for(let iy=0;iy<=4;iy++){
    const x=120+ix*0.1,y=99.9+iy*0.05;
    let nearest=Infinity;
    for(const line of lines)for(let i=2;i<line.pts.length;i+=2){
      const ax=line.pts[i-2],ay=line.pts[i-1],bx=line.pts[i],by=line.pts[i+1];
      const dx=bx-ax,dy=by-ay;
      const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)||0));
      nearest=Math.min(nearest,Math.hypot(x-ax-t*dx,y-ay-t*dy));
    }
    expect(nearest,`finger at ${x},${y}`).toBeLessThanOrEqual(result.pens[0].width/2+0.01);
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

it('covers the curved remnant between opposing contours in the decoded plan', async () => {
  // A 1.125 mm annular band with a 0.45 mm nib leaves a thin curved remnant.
  // Fixed-axis residual hatch rows used to miss its tapered intersections.
  const r=render(sketch({aspect:[1,1],seed:42},()=>[
    circle(50,50,20,{stroke:false,fill:fill('contour'),fillPen:'pigma-05-black'}),
    mask(circle(50,50,18.875)),
  ]),{paper:{paper:{w:100,h:100}}});
  const p=await plan(r);
  const flat=planToolpath(p,selectAll(p),0.001);
  expect(r.stats.contour?.residualPatches).toBeGreaterThan(0);
  expect(p.chains.length).toBeLessThan(10);
  for(let i=0;i<2400;i++)for(const offset of [-0.05,0,0.05]){
    const angle=i*Math.PI/1200,rad=19.4375+offset;
    const x=50+rad*Math.cos(angle),y=50+rad*Math.sin(angle);
    let nearest=Infinity;
    for(const c of flat){
      if(c.dot){nearest=Math.min(nearest,Math.hypot(x-c.pts[0],y-c.pts[1]));continue;}
      for(let j=2;j<c.pts.length;j+=2){
        const ax=c.pts[j-2],ay=c.pts[j-1],dx=c.pts[j]-ax,dy=c.pts[j+1]-ay;
        const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)||0));
        nearest=Math.min(nearest,Math.hypot(x-ax-t*dx,y-ay-t*dy));
      }
    }
    expect(nearest,`uncovered curved strip at ${x},${y}`).toBeLessThanOrEqual(0.235);
  }
  for(const chain of p.chains)for(let i=1;i<chain.prims.length;i++){
    const a=evalPrim(chain.prims[i-1],1),b=evalPrim(chain.prims[i],0);
    expect(Math.hypot(a[0]-b[0],a[1]-b[1])).toBeLessThan(1e-8);
  }
});

it('does not collapse a short inset loop into a tap that loses its footprint', async () => {
  const r=render(sketch({aspect:[1,1],seed:42},()=>circle(50,50,0.28,{
    stroke:false,fill:fill('contour'),fillPen:'pigma-05-black',
  })),{paper:{paper:{w:100,h:100}}});
  const p=await plan(r);
  expect(p.chains.some(c=>!c.dot)).toBe(true);
  const flat=planToolpath(p,selectAll(p),0.0001);
  for(let i=0;i<360;i++){
    const a=i*Math.PI/180,x=50+0.28*Math.cos(a),y=50+0.28*Math.sin(a);
    let nearest=Infinity;
    for(const c of flat)for(let j=2;j<c.pts.length;j+=2){
      const ax=c.pts[j-2],ay=c.pts[j-1],dx=c.pts[j]-ax,dy=c.pts[j+1]-ay;
      const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy)||0));
      nearest=Math.min(nearest,Math.hypot(x-ax-t*dx,y-ay-t*dy));
    }
    expect(nearest).toBeLessThanOrEqual(0.235);
  }
});


it('keeps an intact duplicate outline after decimating a contour-filled shape', async () => {
  for (const fraction of [0.3, 1]) {
    const result = render(sketch({aspect:[1,1],seed:42}, () => [
      decimate(fraction, rect(20,20,60,60,{fill:fill('contour')})),
      rect(20,20,60,60),
    ]), {paper:'Square20'});
    const ordered = await plan(result, {bridge:false});
    let perimeter = 0;
    for (const chain of ordered.chains) for (const p of chain.prims) {
      const a = evalPrim(p,0), b = evalPrim(p,1);
      const onEdge = [40,160].some(edge =>
        (Math.abs(a[0]-edge)<1e-8 && Math.abs(b[0]-edge)<1e-8) ||
        (Math.abs(a[1]-edge)<1e-8 && Math.abs(b[1]-edge)<1e-8));
      if (onEdge) perimeter += Math.hypot(b[0]-a[0],b[1]-a[1]);
    }
    expect(perimeter).toBeCloseTo(480,7);
  }
});
