import {describe,it,expect,expectTypeOf,beforeAll} from 'vitest';
import {readFileSync} from 'node:fs';
import {plane,box,curve,pointCloud,query} from 'occlude/3d';
import { sketch } from '../src/index.js';
import { initOcclude, compileSketch } from '../src/host.js';
import {toolkit} from './helpers/run.js';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));

describe('column writes read the incoming revision',()=>{
  it('initializes every column from the incoming revision with stable key-order semantics',()=>{
    const original=plane().points.set({energy:()=>2,lag:()=>0});
    const a=original.points.set({energy:p=>p.energy+1,lag:p=>p.energy});
    const b=original.points.set({lag:p=>p.energy,energy:p=>p.energy+1});
    expect(a.points.map(p=>p.attributes)).toEqual(b.points.map(p=>p.attributes));
    expect(a.points.map(p=>[p.energy,p.lag])).toEqual([[3,2],[3,2],[3,2],[3,2]]);
    expectTypeOf(a.points.at(0)!.energy).toEqualTypeOf<number>();
    expect(original.points.at(0)!.energy).toBe(2);
    expect(()=>plane().points.extract().points.set({id:1})).toThrow('reserved');
  });
  it('writes field maps on edges and faces, each reading the rows before the write',()=>{
    const source=box().edges.set({rest:e=>e.length,age:()=>0}).faces.set({areaCopy:f=>f.area,age:()=>0});
    const out=source.edges.set({age:e=>e.age+1,rest:e=>e.rest+e.age}).faces.set({age:f=>f.age+2,areaCopy:f=>f.areaCopy+f.age});
    expect(out.edges.every(e=>e.rest===1&&e.age===1)).toBe(true);
    expect(out.faces.every(f=>f.areaCopy===1&&f.age===2)).toBe(true);
    expect(out.faces.set('label',f=>f.age===2?'ready':'waiting').faces.every(f=>f.label==='ready')).toBe(true);
    expectTypeOf(out.faces.at(0)!.areaCopy).toEqualTypeOf<number>();
  });
  it('captures multiple query fields before moving to another revision',()=>{
    const source=plane().translate([0,0,2]),hits=query(plane(4)).batch().nearest(source.points);
    const captured=source.points.set({distance:hits.field((_,hit)=>hit!.distance),height:hits.field((_,hit)=>hit!.position[2])});
    expect(captured.points.every(p=>p.distance===2&&p.height===0)).toBe(true);
    expect(()=>captured.points.set({distance:hits.field((_,hit)=>hit!.distance)})).toThrow('source revision');
  });
  it('preserves declared point transfer policy until explicitly replaced',()=>{
    const source=plane().points.set({category:p=>p.index},{transfer:{category:'nearest'}});
    const updated=source.points.set('category',p=>p.category+10);
    expect(updated.transfers.category).toBe('nearest');
    expect(updated.points.set({category:p=>p.category+1}).transfers.category).toBe('nearest');
    expect(updated.points.set({category:()=>0},{transfer:{category:'interpolate'}}).transfers.category).toBe('interpolate');
    expect(()=>source.points.set({other:0},{transfer:{category:'nearest'}} as never)).toThrow('not being set');
  });
  it('runs one-argument passes over a mesh: each pass reads what the one before wrote, and history keeps the states',()=>{
    const t=toolkit();
    const source=plane().points.set({age:()=>0,energy:()=>2}).edges.set({age:()=>0}).faces.set({age:()=>0});
    const result=t.steps(3,source,
      m=>m.points.set({age:p=>p.age+1,energy:p=>p.energy+1}),
      m=>m.displace(p=>[0,0,p.energy]),
      m=>m.edges.set('age',e=>e.age+2).faces.set('age',f=>f.age+3),
      {every:1});
    expect(result.points.every(p=>p.age===3&&p.energy===5)).toBe(true);
    expect(result.points.map(p=>p.z)).toEqual([12,12,12,12]);
    expect(result.edges.every(e=>e.age===6)).toBe(true);
    expect(result.faces.every(f=>f.age===9)).toBe(true);
    expect(result.history.map(h=>h.points.at(0)!.energy)).toEqual([2,3,4,5]);
    expect(source.points.at(0)!.energy).toBe(2);
  });
  it('reads a where of another revision by id, and refuses what is not a row of the domain',()=>{
    const source=plane().points.set({age:()=>0,vector:()=>[1,2]}).edges.set({age:()=>0}).faces.set({age:()=>0});
    // Another revision of the same rows is read by id, and lands.
    expect(source.points.set('age',3,source.translate([0,0,1]).points).points.map(p=>p.age)).toEqual([3,3,3,3]);
    expect(()=>source.points.set('age','bad',source.points.at(0)!)).toThrow("'age' would hold a string and a number");
    expect(()=>source.points.set('vector',[1,2,3],source.points.at(0)!)).toThrow("'vector' would hold a vector of 3 and a vector of 2");
    const one=source.points.set('age',2,source.points.at(0)!).edges.set('age',3,source.edges.at(0)!).faces.set('age',4,source.faces.at(0)!);
    expect(one.points.map(p=>p.age)).toEqual([2,0,0,0]);
    expect(one.edges.map(e=>e.age)).toEqual([3,0,0,0]);
    expect(one.faces.at(0)!.age).toBe(4);
    expect(()=>source.points.set('age',5,{...source.points.at(0)!} as never)).toThrow("'age' is not an option; a where is a selection, one row of the geometry, or a predicate");
  });
  it('keeps curve domains honest: points and edges write, the curve keeps its edges',()=>{
    const t=toolkit();
    const source=curve([[0,0,0],[1,0,0],[2,0,0]]).points.set({age:()=>0}).edges.set({age:()=>0});
    expect('faces' in source).toBe(false);
    const result=t.steps(2,source,c=>c.points.set('age',p=>p.age+1).edges.set('age',e=>e.age+2),c=>c.points.set('y',p=>p.y+p.age/2));
    expect(result.points.every(p=>p.age===2&&p.y===1.5)).toBe(true);
    expect(result.edges.every(e=>e.age===4)).toBe(true);
    expect(result.edges.length).toBe(2);
  });
  it('retains rich sampled rows in multi-column field callbacks',()=>{
    let checked=false;
    compileSketch(sketch({seed:42},t=>{
      const source=plane(2).faces.set('floor',true),samples=t.scatter(source,{count:6});
      const changed=samples.points.set({height:p=>p.sample.position[2],floor:p=>p.sample.face.floor});
      expect(changed.points.every(p=>p.height===0&&p.floor===true&&p.sample.source===source.surface)).toBe(true);
      expectTypeOf(changed.points.at(0)!.sample.face.floor).toEqualTypeOf<boolean>();checked=true;return [];
    }));
    expect(checked).toBe(true);
  });
});

describe('point and sampled point runs',()=>{
  it('runs passes over point geometry and records point-only history',()=>{
    const t=toolkit();
    const source=pointCloud([[1,0,0],[2,0,0]]).points.set('age',0).withKey('points');
    const result=t.steps(2,source,
      g=>g.points.set({age:p=>p.age+1}).points.set({y:p=>p.y+p.age+1}),
      g=>g.displace([0,0,1]),
      {every:1});
    expect(result.points.map(p=>[p.x,p.y,p.z,p.age])).toEqual([[1,5,2,2],[2,5,2,2]]);
    expect(result.history.map(s=>s.points.at(0)!.age)).toEqual([0,1,2]);
    expect(result.key).toBe('points');
    expect(result.points.set('age',4).history).toEqual([]);
    expect(result.withKey('copy').history).toEqual(result.history);
    const rotated=pointCloud([[2,0,0]]).rotate([0,0,90],[1,0,0]).scale([2,3,4],[1,0,0]);
    expect(rotated.points.at(0)!.x).toBeCloseTo(1);
    expect(rotated.points.at(0)!.y).toBeCloseTo(3);
  });
  it('rejects asynchronous values, and reads another revision of the same points by id',()=>{
    const source=pointCloud([[0,0,0]]).points.set('age',0);
    expect(()=>source.points.set('age',(async()=>1) as never)).toThrow('synchronous');
    expect(source.points.set('age',1,source.translate([1,0,0]).points).points.at(0)!.age).toBe(1);
    expect(()=>plane().faces.set('age',(async()=>1) as never)).toThrow('synchronous');
  });
  it('preserves typed captured surface interpretation in sample runs and history',()=>{
    let checked=false;
    compileSketch(sketch({seed:42},t=>{
      const target=plane(2).faces.set('floor',true);
      const samples=t.scatter(target,{count:4}).points.set('age',0);
      const result=t.steps(2,samples,s=>{
        expectTypeOf(s.points.at(0)!.sample.face.floor).toEqualTypeOf<boolean>();
        return s.points.set({age:p=>p.age+Number(p.sample.face.floor),z:p=>p.z+p.sample.normal[2]});
      },{every:1});
      expect(result.points.every(p=>p.age===2&&p.z===2&&p.sample.position[2]===0)).toBe(true);
      expect(result.history.map(s=>s.points.at(0)!.sample.source)).toEqual([target.surface,target.surface,target.surface]);
      expectTypeOf(result.history[0].points.at(0)!.sample.face.floor).toEqualTypeOf<boolean>();
      expect(result.points.set('age',5).history).toEqual([]);
      expect(result.rotate([0,90,0]).scale([2,1,1]).points.every(p=>p.sample.source===target.surface)).toBe(true);
      checked=true;return [];
    }));
    expect(checked).toBe(true);
  });
});
