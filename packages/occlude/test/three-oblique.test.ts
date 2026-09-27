import {readFileSync} from 'node:fs';
import {beforeAll,it,expect} from 'vitest';
import { sketch, pen, mm } from '../src/index.js';
import { initOcclude, compileSketchAsync, render } from '../src/host.js';
import {cameraFrame3,toCamera3,toPaper3,type Camera3} from '../src/three/camera.js';
import {box,view,perspective} from 'occlude/3d';

beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));
const config={seed:42,margin:0,pens:{ink:pen({width:mm(.25),color:'#112233'})}};
const paper={x:0,y:0,width:100,height:100};
/** A level camera: the eye and the target share a height, so the back vector
 * is horizontal and world verticals project vertical under any shift. */
const level={eye:[0,-14,1] as const,target:[0,0,1] as const,fovDegrees:55};
/** A tall box standing on the ground, taller than a level frame can hold. */
const corners=[-1,1].flatMap(x=>[-1,1].flatMap(y=>[0,8].map(z=>[x,y,z] as const)));
const papers=(camera:Camera3):readonly (readonly [number,number])[]=>{
  const frame=cameraFrame3(camera,paper);
  return corners.map(p=>toPaper3(frame,toCamera3(frame,[...p])));
};

it('is a perspective camera when nothing is shifted',()=>{
  const straight=perspective({...level}),same=perspective({...level,shift:[0,0]});
  expect(same.kind).toBe('perspective');
  expect(same).toEqual(straight);
  expect(perspective({...level,shift:[0,.1]}).kind).toBe('oblique');
  expect(papers(same)).toEqual(papers(straight));
});

it('draws the same ink as perspective when nothing is shifted',async()=>{
  const subject=box([2,1,8]).translate([0,0,4]);
  const straight=await compileSketchAsync(sketch(config,()=>view(subject,{camera:perspective({...level}),pen:'ink'})));
  const same=await compileSketchAsync(sketch(config,()=>view(subject,{camera:perspective({...level,shift:[0,0]}),pen:'ink'})));
  expect(render(straight).raw.frags.length).toBeGreaterThan(0);
  expect(render(same).raw.prims).toEqual(render(straight).raw.prims);
  expect(render(same).raw.frags).toEqual(render(straight).raw.frags);
});

it('keeps verticals vertical and moves the frame, not the eye',()=>{
  const shifted=perspective({...level,shift:[0,.4]}),straight=perspective({...level});
  const [before,after]=[papers(straight),papers(shifted)];
  // Each corner keeps its paper x and moves down the page by four tenths of
  // the frame: the frame went up over the scene by the same amount.
  after.forEach((p,i)=>{expect(p[0]).toBe(before[i][0]);expect(p[1]).toBeCloseTo(before[i][1]+.4*paper.height,10);});
  // A vertical of the box: bottom and top corners share one paper x.
  for(let i=0;i<after.length;i+=2)expect(after[i][0]).toBe(after[i+1][0]);
  // The top of the box is above the level frame, and the shift brings it in
  // without taking the bottom out.
  const inside=(rows:readonly (readonly [number,number])[],z:number)=>rows.filter((_,i)=>corners[i][2]===z).every(p=>p[1]>=0&&p[1]<=paper.height);
  expect(inside(before,8)).toBe(false);
  expect(inside(after,8)).toBe(true);
  expect(inside(after,0)).toBe(true);
});

it('shifts right as well, and repeats exactly',()=>{
  const right=papers(perspective({...level,shift:[.25,0]})),straight=papers(perspective({...level}));
  right.forEach((p,i)=>{expect(p[0]).toBeCloseTo(straight[i][0]-.25*paper.width,10);expect(p[1]).toBe(straight[i][1]);});
  expect(papers(perspective({...level,shift:[.25,-.1]}))).toEqual(papers(perspective({...level,shift:[.25,-.1]})));
});

it('holds its own shift and refuses one it cannot use',()=>{
  const shift:[number,number]=[.1,.2];
  const camera=perspective({...level,shift});
  shift[0]=9;
  expect(camera.kind==='oblique'&&camera.shift[0]).toBe(.1);
  expect(()=>perspective({...level,shift:[0,NaN]})).toThrow('perspective shift');
  expect(()=>perspective({...level,shift:[0,Infinity]})).toThrow('perspective shift');
  expect(()=>perspective({...level,shift:[0,.4],fovDegrees:0})).toThrow('FOV');
});

it('still hides what stands behind', async()=>{
  const front=box(2).translate([0,0,1]),back=box(2).translate([0,4,1]);
  let hidden=0,visible=0;
  const drawing=view([front,back],{camera:perspective({eye:[0,-12,1],target:[0,0,1],fovDegrees:45,shift:[0,.3]}),pen:'ink'},lines=>{
    hidden=lines.hidden.length;visible=lines.visible.length;return [];
  });
  await compileSketchAsync(sketch(config,()=>drawing));
  expect(visible).toBeGreaterThan(0);
  expect(hidden).toBeGreaterThan(0);
});
