/**
 * The one write on the 3D collections: `set(column, value, where?, opts?)`
 * and `set({ … }, where?, opts?)` on mesh points, edges, faces and corners,
 * on point and curve geometry, on samples and on instances; and the history
 * a `t.steps` run keeps through `withHistory`.
 */
import {describe,expect,it} from 'vitest';
import {plane,box,pointCloud,curve,grid,instanceOnPoints,type Mesh} from '../src/three/api/index.js';
import {scatterSurface} from '../src/three/api/sampling.js';
import {toolkit} from './helpers/run.js';

const sheet=()=>plane(2,2).subdivide(2);

describe('mesh points.set',()=>{
  it('writes a number, a string, a boolean and a vector on every point',()=>{
    const m=sheet().points.set({h:(p)=>p.x+p.y,name:'a',on:true,dir:[0,0,1]});
    expect(m.points.every(p=>p.h===p.x+p.y&&p.name==='a'&&p.on===true)).toBe(true);
    expect(m.points.at(0)!.dir).toEqual([0,0,1]);
    expect(Object.isFrozen(m.points.at(0)!.dir)).toBe(true);
  });
  it('answers a new mesh and leaves the input as it was',()=>{
    const a=sheet(),b=a.points.set('h',1);
    expect(b).not.toBe(a);
    expect(a.points.at(0)!.attributes).not.toHaveProperty('h');
  });
  it('writes only where a predicate, a selection or one row says',()=>{
    const m=sheet().points.set('h',0);
    const byPredicate=m.points.set('h',1,(p)=>p.x>0);
    expect(byPredicate.points.filter(p=>p.h===1).length).toBe(m.points.filter(p=>p.x>0).length);
    const right=m.points.filter(p=>p.x>0);
    const bySelection=m.points.set('h',2,right);
    expect(bySelection.points.filter(p=>p.h===2).map(p=>p.id)).toEqual(right.map(p=>p.id));
    const one=m.points.at(3)!;
    const byRow=m.points.set('h',3,one);
    expect(byRow.points.filter(p=>p.h===3).map(p=>p.id)).toEqual([one.id]);
  });
  it('reads a selection or a row of an earlier revision by id, and a gone row names nothing',()=>{
    const first=sheet().points.set('h',0),picked=first.points.filter(p=>p.x<0);
    const later=first.displace([0,0,1]);
    const out=later.points.set('h',1,picked);
    expect(out.points.filter(p=>p.h===1).map(p=>p.id)).toEqual(picked.map(p=>p.id));
    const faces=box(1).faces,top=faces.at(0)!;
    const extracted=faces.filter(f=>f.index>0).extract();
    expect(extracted.faces.set('k',1,top).faces.every(f=>f.attributes.k===undefined)).toBe(true);
  });
  it('writes the members of a selection, and where narrows among them',()=>{
    const m=sheet().points.set('h',0),left=m.points.filter(p=>p.x<0);
    const out=left.set('h',1,(p)=>p.y<0);
    expect(out.points.filter(p=>p.h===1).map(p=>p.id)).toEqual(left.filter(p=>p.y<0).map(p=>p.id));
  });
  it('reads every function against the rows as they were before the write',()=>{
    const m=sheet().points.set({u:1,w:2});
    const swapped=m.points.set({u:(p)=>p.w,w:(p)=>p.u});
    expect(swapped.points.every(p=>p.u===2&&p.w===1)).toBe(true);
    // Neighbours are read before the write too: one mean, not a sweep.
    const spike=m.points.set('u',(p)=>p.index===12?9:0);
    const spread=spike.points.set('u',(p)=>Math.max(p.u,...p.adjacent.map(q=>q.u)));
    expect(spread.points.filter(p=>p.u===9).length).toBe(1+spike.points.at(12)!.adjacent.length);
  });
  it('moves points through x, y and z',()=>{
    const m=sheet(),out=m.points.set('z',(p)=>p.x>0?1:0);
    expect(out.points.every(p=>p.z===(m.points.at(p.index)!.x>0?1:0))).toBe(true);
    expect(out.faces.length).toBe(m.faces.length);
    expect(()=>m.points.set('z','up' as never)).toThrow("'z' is a position and takes a number");
  });
  it('leaves a row as it was for a value that is not finite, or no value',()=>{
    const m=sheet().points.set('h',5);
    const out=m.points.set({h:(p)=>p.index===0?NaN:p.index===1?undefined as never:1,v:(p)=>p.index===2?[1,Infinity]:[1,2]});
    expect(out.points.at(0)!.h).toBe(5);
    expect(out.points.at(1)!.h).toBe(5);
    expect(out.points.at(3)!.h).toBe(1);
    expect(out.points.at(2)!.attributes).not.toHaveProperty('v');
    expect(out.points.at(3)!.v).toEqual([1,2]);
  });
  it('writes nothing for a where that names nothing, and answers the same mesh',()=>{
    const m=sheet().points.set('h',0);
    expect(m.points.set('h',1,undefined)).toBe(m);
    expect(m.points.set('h',1,()=>false)).toBe(m);
    expect(m.points.set('h',1,m.points.filter(()=>false))).toBe(m);
  });
  it('keeps one kind per column: a partial write of another kind is refused by name',()=>{
    const m=sheet().points.set('h',0);
    expect(()=>m.points.set('h','x',(p)=>p.index===0)).toThrow("'h' would hold a string and a number");
    expect(()=>m.points.set('h',(p)=>p.index===0?1:'x')).toThrow("'h' would hold a number and a string");
    expect(()=>m.points.set('v',(p)=>p.index===0?[1,2]:[1,2,3])).toThrow("'v' would hold a vector of 2 and a vector of 3");
    // Every row written: the column changes kind.
    expect(m.points.set('h','x').points.every(p=>p.h==='x')).toBe(true);
  });
  it('a new column written on a subset stays missing elsewhere',()=>{
    const out=sheet().points.set('tag','top',(p)=>p.y>0);
    expect(out.points.filter(p=>p.y<=0).every(p=>!Object.hasOwn(p.attributes,'tag'))).toBe(true);
  });
  it('refuses reserved names, wrong values and a stray where by name',()=>{
    const m=sheet();
    expect(()=>m.points.set('id',1)).toThrow('reserved or empty geometry attribute name: id');
    expect(()=>m.points.set('h',{a:1} as never)).toThrow("the value of 'h' is a number, a string, a boolean or a numeric vector");
    expect(()=>m.points.set('h',['a'] as never)).toThrow("'h' is a vector of numbers");
    expect(()=>m.points.set('h',1,m.faces as never)).toThrow('where is a face selection; this writes points');
    expect(()=>m.points.set('h',1,m.faces.at(0) as never)).toThrow('where is a face row; this writes points');
    expect(()=>m.points.set('h',1,42 as never)).toThrow('a where is a point selection, one point row, or a predicate');
    expect(()=>(m.points.set as (...args:unknown[])=>unknown)('h')).toThrow("'h' needs a value");
    expect(()=>m.points.set(7 as never,1)).toThrow('give a column and a value, or a record');
    expect(()=>m.points.set('h',()=>Promise.resolve(1) as never)).toThrow('answered a promise');
  });
  it('declares a transfer policy in opts: nearest survives refinement, setting keeps it, an explicit default restores it',()=>{
    const m=sheet().points.set('cat',(p)=>p.x>0?1:0,{transfer:'nearest'});
    expect(m.transfers.cat).toBe('nearest');
    expect(m.subdivide(1).points.every(p=>p.cat===0||p.cat===1)).toBe(true);
    const kept=m.points.set('cat',(p)=>p.x>0?0:1);
    expect(kept.transfers.cat).toBe('nearest');
    const restored=m.points.set('cat',(p)=>p.cat,undefined as never,{transfer:'interpolate'});
    // An undefined where names nothing, so nothing is written or declared.
    expect(restored.transfers.cat).toBe('nearest');
    expect(m.points.set('cat',(p)=>p.cat,m.points,{transfer:'interpolate'}).transfers.cat).toBe('interpolate');
    const both=sheet().points.set({u:(p)=>p.x,w:1},{transfer:{w:'nearest'}});
    expect(both.transfers).toEqual({w:'nearest'});
  });
  it('refuses a transfer that is not a policy, names a column not set, or names a position',()=>{
    const m=sheet();
    expect(()=>m.points.set('u',1,{transfer:'mean' as never})).toThrow("the transfer of 'u' is 'interpolate' or 'nearest'");
    expect(()=>m.points.set({u:1},{transfer:{w:'nearest'} as never})).toThrow("transfer names 'w', which is not being set");
    expect(()=>m.points.set('u',1,{transfer:{u:'nearest'}} as never)).toThrow("transfer is the policy of 'u', a word");
    expect(()=>m.points.set('z',1,{transfer:'nearest'})).toThrow("'z' is a position, not a column with a transfer policy");
    expect(()=>m.points.set('u',1,{fallback:0} as never)).toThrow("'fallback' is not an option (a 3D face column has no fallback)");
  });
});

describe('mesh edges, faces and corners set',()=>{
  it('edges: every value kind, a where, no transfer',()=>{
    const m=box(1),marked=m.edges.filter(e=>e.length>0).at(0)!;
    const out=m.edges.set({w:(e)=>e.length,label:'rim',on:false,v:[1,2]}).edges.set('hot',true,marked);
    expect(out.edges.every(e=>e.w===e.length&&e.label==='rim'&&e.on===false)).toBe(true);
    expect(out.edges.filter(e=>e.hot===true).map(e=>e.id)).toEqual([marked.id]);
    expect(()=>m.edges.set('w',1,{transfer:'nearest'} as never)).toThrow("a mesh's edge columns carry no transfer policy");
  });
  it('faces: a predicate, a selection, a row, and children inherit after subdivide',()=>{
    const m=box(1),up=m.faces.filter(f=>f.normal[2]>0.5);
    const out=m.faces.set('zone',0).faces.set('zone',2,up).faces.set('name',(f)=>f.normal[0]>0.5?'east':'other');
    expect(out.faces.filter(f=>f.zone===2).map(f=>f.id)).toEqual(up.map(f=>f.id));
    expect(out.faces.filter(f=>f.name==='east').length).toBe(1);
    expect(out.subdivide(1).faces.filter(f=>f.zone===2).length).toBe(4);
    expect(()=>m.faces.set('zone',1,{transfer:'nearest'} as never)).toThrow("a mesh's face columns carry no transfer policy");
  });
  it('corners: a vector column with a declared transfer',()=>{
    const m=plane(1,1),out=m.corners.set('tone',(c)=>[c.localIndex,0],{transfer:'nearest'});
    expect(out.corners.map(c=>c.tone)).toEqual([[0,0],[1,0],[2,0],[3,0]]);
    expect(out.cornerTransfers.tone).toBe('nearest');
    const one=out.corners.at(2)!;
    expect(out.corners.set('tone',[9,9],one).corners.map(c=>c.tone[0])).toEqual([0,1,9,3]);
  });
  it('keeps the recorded radial centre, the pen and the key',()=>{
    const m=box(1,{key:'b',pen:'red'});
    const out=m.faces.set('k',1);
    expect(out.key).toBe('b');expect(out.pen).toBe('red');
  });
});

describe('point and curve geometry set',()=>{
  it('point geometry: columns, a where, and positions',()=>{
    const g=pointCloud([[0,0,0],[1,0,0],[2,0,0]]);
    const out=g.points.set({h:(p)=>p.x*2,tag:'p',on:(p)=>p.x>0,v:[0,1]}).points.set('z',5,(p)=>p.index===1);
    expect(out.points.map(p=>p.h)).toEqual([0,2,4]);
    expect(out.points.map(p=>p.z)).toEqual([0,5,0]);
    expect(out.points.map(p=>p.on)).toEqual([false,true,true]);
    expect(()=>g.points.set('h',1,{transfer:'nearest'} as never)).toThrow("point geometry's columns carry no transfer policy");
  });
  it('curve geometry: points and edges keep the curve',()=>{
    const c=curve([[0,0,0],[1,0,0],[2,1,0]]);
    const out=c.points.set('w',(p)=>p.index).edges.set('seg',(e)=>e.index===0?'first':'rest');
    expect(out.points.map(p=>p.w)).toEqual([0,1,2]);
    expect(out.edges.map(e=>e.seg)).toEqual(['first','rest']);
    expect(out.edges.length).toBe(2);
    const lifted=out.points.set('z',1,out.points.at(2)!);
    expect(lifted.points.at(2)!.z).toBe(1);
    expect(lifted.edges.length).toBe(2);
  });
  it('grid points write as point geometry',()=>{
    const g=grid({cols:3,rows:3});
    expect(g.points.set('h',1).points.every(p=>p.h===1)).toBe(true);
  });
  it('samples keep their captured sample through a write',()=>{
    let i=0;const rnd=()=>((i++*0.618034)%1);
    const s=scatterSurface(plane(2,2),{count:5},{rnd});
    const out=s.points.set('h',(p)=>p.sample.face.index).points.set('z',1);
    expect(out.points.every(p=>p.h===p.sample.face.index&&p.z===1)).toBe(true);
    expect(out.target).toBe(s.target);
  });
  it('instances: a column on the instance rows, placements kept; transform is not a column',()=>{
    const inst=instanceOnPoints(box(0.2),pointCloud([[0,0,0],[1,0,0]]));
    const out=inst.instances.set('size',(r)=>r.index+1);
    expect(out.rows.map(r=>r.size)).toEqual([1,2]);
    expect(out.rows.map(r=>r.transform)).toEqual(inst.rows.map(r=>r.transform));
    expect(()=>inst.instances.set('transform',1 as never)).toThrow("'transform' is not a column");
  });
});

describe('history through withHistory',()=>{
  it('a mesh keeps the states it is handed, and every other operation starts none',()=>{
    const a=sheet(),b=a.displace([0,0,1]),kept=b.withHistory([a,b]);
    expect(kept.history).toEqual([a,b]);
    expect(Object.isFrozen(kept.history)).toBe(true);
    expect(kept.points.set('h',1).history).toEqual([]);
    expect(kept.withKey('k').history).toEqual([a,b]);
    expect(kept.style({pen:'red'}).history).toEqual([a,b]);
    expect(a.history).toEqual([]);
  });
  it('point and curve geometry and samples keep theirs, as their own kind',()=>{
    const p=pointCloud([[0,0,0]]),q=p.withHistory([p]);
    expect(q.history).toEqual([p]);
    const c=curve([[0,0,0],[1,0,0]]),d=c.withHistory([c]);
    expect(d.history).toEqual([c]);expect(d.edges.length).toBe(1);
    let i=0;const s=scatterSurface(plane(1,1),{count:2},{rnd:()=>((i++*0.37)%1)});
    const kept=s.withHistory([s]);
    expect(kept.constructor).toBe(s.constructor);
    expect(kept.history).toEqual([s]);
    expect(kept.points.at(0)!.sample).toBeDefined();
  });
  it('t.steps over a mesh runs one-argument passes and keeps history with { every }',()=>{
    const t=toolkit();
    const start=sheet().points.set('h',0);
    const lift=(m:Mesh<any,any,any,any>)=>m.points.set('h',(p)=>p.h+1).displace((p)=>[0,0,p.x>0?0.1:0]);
    const out=t.steps(4,start,lift,{every:2});
    expect(out.points.every(p=>p.h===4)).toBe(true);
    expect(out.history.map(m=>m.points.at(0)!.h)).toEqual([0,2,4]);
    expect(out.history.at(-1)!.points.map(p=>p.z)).toEqual(out.points.map(p=>p.z));
    expect(t.steps(3,start,lift).history).toEqual([]);
  });
});
