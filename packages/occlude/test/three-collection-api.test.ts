import {describe,it,expect,expectTypeOf} from 'vitest';
import {plane,box,pointCloud,instanceOnPoints} from 'occlude/3d';

describe('source-bound collection selection algebra',()=>{
  it('uses source order for sets and complements, even inside a group',()=>{
    const source=plane().subdivide(2).attribute('value',p=>p.index);
    const all=source.points,a=all.filter(p=>p.index%2===0),b=all.filter(p=>p.index%3===0);
    const ids=(s:typeof all)=>s.map(p=>p.index);
    expect(ids(b.union(a))).toEqual(ids(all.filter(p=>p.index%2===0||p.index%3===0)));
    expect(ids(a.intersect(b))).toEqual([0,6,12,18,24]);
    expect(ids(a.subtract(b))).toEqual([2,4,8,10,14,16,20,22]);
    expect(ids(a.union(a.complement()))).toEqual(ids(all));
    expect(a.intersect(a.complement()).length).toBe(0);
    expect(ids(a.complement().complement())).toEqual(ids(a));
    const group=all.groupBy(p=>p.index%2)[0];
    expect(group.complement().length+group.length).toBe(all.length);
    expectTypeOf(a.union(b).at(0)!.value).toEqualTypeOf<number>();
    expect(a.union(b).extract().points.length).toBe(a.union(b).length);
  });
  it('short-circuits predicates with selection-relative indices',()=>{
    const points=pointCloud([[0,0,0],[1,0,0],[2,0,0]]).points.filter(p=>p.x>0);
    const seen:number[]=[];
    expect(points.find((p,i)=>{seen.push(i);return p.x===1;})?.x).toBe(1);
    expect(seen).toEqual([0]);
    expect(points.some(p=>p.x===2)).toBe(true);expect(points.every(p=>p.x>0)).toBe(true);
    expect(points.filter(()=>false).every(()=>false)).toBe(true);
    expect(points.filter(()=>false).some(()=>true)).toBe(false);
  });
  it('recognizes owned rows across fresh collection access, rejecting copied IDs',()=>{
    const source=box().faceAttribute('label','side');
    const selected=source.faces.filter(f=>f.index===0);
    expect(selected.has(source.faces.at(0)!)).toBe(true);
    expect(selected.has(source.faces.at(1)!)).toBe(false);
    // A row of another revision is asked about by its id (spec 58, G3-29).
    expect(selected.has(source.translate([0,0,1]).faces.at(0)!)).toBe(true);
    expect(selected.has(source.translate([0,0,1]).faces.at(1)!)).toBe(false);
    expect(()=>selected.has({...selected.at(0)!})).toThrow('expected a face row');
    expect(()=>selected.has(source.points.at(0)! as any)).toThrow('received point');
  });
  it('resolves set operations across revisions by id, and rejects another domain',()=>{
    const a=plane(),b=a.translate([0,0,0]);
    expect(a.points.union(b.points).length).toBe(a.points.length);
    expect(a.points.intersect(b.points).length).toBe(a.points.length);
    expect(a.points.subtract(b.points).length).toBe(0);
    for(const op of ['union','intersect','subtract'] as const){
      expect(()=>a.points[op](a.faces as any)).toThrow('same domain');
      expect(a.points.filter(()=>false)[op](b.points.filter(()=>false)).length).toBe(0);
    }
  });
  it('applies the same contracts to point, curve and instance data',()=>{
    const source=box(),curves=source.edges.extract();
    expect(curves.edges.filter(e=>e.index<3).complement().length).toBe(9);
    const instances=instanceOnPoints(plane(),pointCloud([[0,0,0],[1,0,0]]).points);
    const first=instances.instances.filter(p=>p.index===0);
    expect(first.union(first.complement()).length).toBe(2);
    expect(first.has(instances.instances.at(0)!)).toBe(true);
    expect(first.extract().length).toBe(1);
  });
});
