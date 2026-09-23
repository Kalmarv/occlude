import {describe,it,expect,expectTypeOf,beforeAll} from 'vitest';
import {readFileSync} from 'node:fs';
import {plane,box,curve,pointCloud,query} from 'occlude/3d';
import {initOcclude,sketch,compileSketch} from '../src/index.js';
import type {MeshEdit,CurveEdit,PointEdit} from 'occlude/3d';
beforeAll(async()=>initOcclude(readFileSync(new URL('../../../crates/occlude-core/pkg/occlude_core_bg.wasm',import.meta.url))));

describe('field-map initialization and frozen attribute edits',()=>{
  it('initializes every column from the incoming revision with stable key-order semantics',()=>{
    const original=plane().attributes({energy:()=>2,lag:()=>0});
    const a=original.attributes({energy:p=>p.energy+1,lag:p=>p.energy});
    const b=original.attributes({lag:p=>p.energy,energy:p=>p.energy+1});
    expect(a.points.map(p=>p.attributes)).toEqual(b.points.map(p=>p.attributes));
    expect(a.points.map(p=>[p.energy,p.lag])).toEqual([[3,2],[3,2],[3,2],[3,2]]);
    expectTypeOf(a.points.at(0)!.energy).toEqualTypeOf<number>();
    expect(original.points.at(0)!.energy).toBe(2);
    expect(()=>plane().points.extract().attributes({id:1})).toThrow('reserved');
    expect(()=>pointCloud([]).attributes({x:1})).toThrow('reserved');
  });
  it('supports field maps on edges/faces and the existing face row-patch callback',()=>{
    const source=box().edgeAttributes({rest:e=>e.length,age:()=>0}).faceAttributes({areaCopy:f=>f.area,age:()=>0});
    const out=source.edgeAttributes({age:e=>e.age+1,rest:e=>e.rest+e.age}).faceAttributes({age:f=>f.age+2,areaCopy:f=>f.areaCopy+f.age});
    expect(out.edges.every(e=>e.rest===1&&e.age===1)).toBe(true);
    expect(out.faces.every(f=>f.areaCopy===1&&f.age===2)).toBe(true);
    expect(out.faceAttributes(f=>({label:f.age===2?'ready':'waiting'})).faces.every(f=>f.label==='ready')).toBe(true);
    expectTypeOf(out.faces.at(0)!.areaCopy).toEqualTypeOf<number>();
  });
  it('captures multiple query fields before moving to another revision',()=>{
    const source=plane().translate([0,0,2]),hits=query(plane(4)).batch().nearest(source.points);
    const captured=source.attributes({distance:hits.field((_,hit)=>hit!.distance),height:hits.field((_,hit)=>hit!.position[2])});
    expect(captured.points.every(p=>p.distance===2&&p.height===0)).toBe(true);
    expect(()=>captured.attributes({distance:hits.field((_,hit)=>hit!.distance)})).toThrow('source revision');
  });
  it('preserves declared point transfer policy until explicitly replaced',()=>{
    const source=plane().attributes({category:p=>p.index},{transfer:{category:'nearest'}});
    const updated=source.attribute('category',p=>p.category+10);
    expect(updated.transfers.category).toBe('nearest');
    expect(updated.attributes({category:p=>p.category+1}).transfers.category).toBe('nearest');
    expect(updated.attributes({category:()=>0},{transfer:{category:'interpolate'}}).transfers.category).toBe('interpolate');
    expect(()=>source.attributes({other:0},{transfer:{category:'nearest'}})).toThrow('not being set');
  });
  it('accumulates moves and applies last column writes while every read stays frozen',()=>{
    const source=plane().attributes({age:()=>0,energy:()=>2}).edgeAttributes({age:()=>0}).faceAttributes({age:()=>0});
    let escaped:MeshEdit<{age:number;energy:number},{age:number},{age:number}>|undefined;
    const result=source.steps(3,(current,next)=>{
      escaped=next;
      next.set(current.points,{energy:20});
      next.set(current.points,p=>({age:p.age+1,energy:p.energy+1}));
      next.move(current.points,p=>[0,0,p.energy]);
      next.move(current.points,[0,0,1]);
      next.setEdges(current.edges,e=>({age:e.age+2}));
      next.setFaces(current.faces,f=>({age:f.age+3}));
      expect(current.points.at(0)!.energy).toBe(2+current.iteration);
    },{every:1});
    expect(result.points.every(p=>p.age===3&&p.energy===5&&p.z===12)).toBe(true);
    expect(result.edges.every(e=>e.age===6)).toBe(true);
    expect(result.faces.every(f=>f.age===9)).toBe(true);
    expect(result.history.map(h=>h.geometry.points.at(0)!.energy)).toEqual([2,3,4,5]);
    expect(source.points.at(0)!.energy).toBe(2);
    expect(()=>escaped!.set(source.points,{age:4})).toThrow('closed');
    expect(()=>escaped!.setEdges(source.edges,{age:4})).toThrow('closed');
    expect(()=>escaped!.setFaces(source.faces,{age:4})).toThrow('closed');
  });
  it('checks single-row ownership, initialized schema, and operation atomicity',()=>{
    const source=plane().attributes({age:()=>0,vector:()=>[1,2]}).edgeAttributes({age:()=>0}).faceAttributes({age:()=>0});
    const result=source.steps(1,(current,next)=>{
      expect(()=>next.set(source.points,{age:1})).not.toThrow(); // initial input retains this owned source revision
      expect(()=>next.set(source.translate([0,0,1]).points,{age:3})).toThrow('another mesh revision');
      expect(()=>next.set(current.points,p=>p.index===2?({undeclared:1} as any):({age:99}))).toThrow('initialize');
      expect(()=>next.set(current.points,{age:'bad'} as any)).toThrow('initialized type');
      expect(()=>next.set(current.points,{vector:[1,2,3]})).toThrow('vector dimension');
      next.set(current.points.at(0)!,{age:2});
      next.setEdge(current.edges.at(0)!,{age:3});
      next.setFace(current.faces.at(0)!,{age:4});
      expect(()=>next.set({...current.points.at(0)!},{age:5})).toThrow('expected a point row');
    });
    expect(result.points.map(p=>p.age)).toEqual([2,1,1,1]);
    expect(result.edges.map(e=>e.age)).toEqual([3,0,0,0]);
    expect(result.faces.at(0)!.age).toBe(4);
  });
  it('keeps curve domains honest while reusing frozen point/edge edits',()=>{
    const source=curve([[0,0,0],[1,0,0],[2,0,0]]).attributes({age:()=>0}).edgeAttributes({age:()=>0});
    let escaped:CurveEdit<{age:number},{age:number}>|undefined;
    const result=source.steps(2,(current,next)=>{
      escaped=next;expect('setFaces' in next).toBe(false);
      next.set(current.points,p=>({age:p.age+1}));next.setEdges(current.edges,e=>({age:e.age+2}));
      next.move(current.points,p=>[0,p.age,0]);
    });
    expect(result.points.every(p=>p.age===2&&p.y===1)).toBe(true);expect(result.edges.every(e=>e.age===4)).toBe(true);
    expect(()=>escaped!.set(source.points,{age:2})).toThrow('closed');
  });
  it('retains rich sampled rows in multi-attribute field callbacks',()=>{
    let checked=false;
    compileSketch(sketch({seed:42},t=>{
      const source=plane(2).faceAttribute('floor',true),samples=t.sample(source,{count:6});
      const changed=samples.attributes({height:p=>p.sample.position[2],floor:p=>p.sample.face.floor});
      expect(changed.points.every(p=>p.height===0&&p.floor===true&&p.sample.source===source.surface)).toBe(true);
      expectTypeOf(changed.points.at(0)!.sample.face.floor).toEqualTypeOf<true>();checked=true;return [];
    }));
    expect(checked).toBe(true);
  });
});

describe('point and sampled point passes',()=>{
  it('accumulates moves with frozen state and records point-only history',()=>{
    const source=pointCloud([[1,0,0],[2,0,0]]).attributes({age:0}).withKey('points');
    let escaped:PointEdit<any,any>|undefined;
    const result=source.steps(2,(current,next)=>{
      escaped=next;
      expect('setEdges' in next).toBe(false);
      next.set(current.points,p=>({age:p.age+1}));
      next.move(current.points,p=>[0,p.age,0]);
      next.move(current.points,[0,1,0]);
    },(current,next)=>next.move(current.points,[0,0,1]),{every:1});
    expect(result.points.map(p=>[p.x,p.y,p.z,p.age])).toEqual([[1,3,2,2],[2,3,2,2]]);
    expect(result.history.map(s=>[s.iteration,s.geometry.points.at(0)!.age])).toEqual([[0,0],[1,1],[2,2]]);
    expect(result.key).toBe('points');
    expect(()=>escaped!.set(source.points,{age:3})).toThrow('closed');
    expect(result.attributes({age:4}).history).toEqual([]);
    expect(result.withKey('copy').history).toEqual(result.history);
    const rotated=pointCloud([[2,0,0]]).rotate([0,0,90],[1,0,0]).scale([2,3,4],[1,0,0]);
    expect(rotated.points.at(0)!.x).toBeCloseTo(1);
    expect(rotated.points.at(0)!.y).toBeCloseTo(3);
  });
  it('rejects asynchronous patches and escaped point revisions',()=>{
    const source=pointCloud([[0,0,0]]).attributes({age:0});
    expect(()=>source.steps(1,async()=>{})).toThrow('synchronous');
    expect(()=>source.steps(1,(current,next)=>next.set(current.points,(async()=>({age:1})) as any))).toThrow('synchronous');
    expect(()=>source.steps(1,(_,next)=>next.set(source.translate([1,0,0]).points,{age:1}))).toThrow('another point revision');
    expect(()=>plane().faceAttributes((async()=>({age:1})) as any)).toThrow('synchronous');
  });
  it('preserves typed captured surface interpretation in sample steps and history',()=>{
    let checked=false;
    compileSketch(sketch({seed:42},t=>{
      const target=plane(2).faceAttribute('floor',true);
      const samples=t.sample(target,{count:4}).attributes({age:0});
      const result=samples.steps(2,(current,next)=>{
        expectTypeOf(current.points.at(0)!.sample.face.floor).toEqualTypeOf<true>();
        next.set(current.points,p=>({age:p.age+Number(p.sample.face.floor)}));
        next.move(current.points,p=>p.sample.normal);
      },{every:1});
      expect(result.points.every(p=>p.age===2&&p.z===2&&p.sample.position[2]===0)).toBe(true);
      expect(result.history.map(s=>s.geometry.points.at(0)!.sample.source)).toEqual([target.surface,target.surface,target.surface]);
      expectTypeOf(result.history[0].geometry.points.at(0)!.sample.face.floor).toEqualTypeOf<true>();
      expect(result.attributes({age:5}).history).toEqual([]);
      expect(result.rotate([0,90,0]).scale([2,1,1]).points.every(p=>p.sample.source===target.surface)).toBe(true);
      checked=true;return [];
    }));
    expect(checked).toBe(true);
  });
});
