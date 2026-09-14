import {describe,it,expect,expectTypeOf} from 'vitest';
import {grid,cone,instanceOnPoints} from 'occlude/3d';
describe('model-space point grid',()=>{
 it('replaces the original 6 by 6 placement exactly',()=>{
   const sites=grid({cols:6,rows:6,spacing:1.2});
   expect(sites.points.map(p=>[p.x,p.y,p.z])).toEqual(Array.from({length:36},(_,i)=>[((i%6)-2.5)*1.2,(Math.floor(i/6)-2.5)*1.2,0]));
   expect(sites.points.map(p=>p.id)).toEqual(Array.from({length:36},(_,i)=>`p${i}`));
   expectTypeOf(sites.points.at(0)!.i).toEqualTypeOf<number>();
   expect(sites.points.every(p=>p.k===0&&p.i===p.index%6&&p.j===Math.floor(p.index/6))).toBe(true);
 });
 it('supports independent spacing and ordinary layer selections and transforms',()=>{
   const sites=grid({cols:2,rows:3,layers:2,spacing:[2,3,4],key:'sites'});
   expect(sites.points.map(p=>[p.x,p.y,p.z])).toEqual([[-1,-3,-2],[1,-3,-2],[-1,0,-2],[1,0,-2],[-1,3,-2],[1,3,-2],[-1,-3,2],[1,-3,2],[-1,0,2],[1,0,2],[-1,3,2],[1,3,2]]);
   const layer=sites.points.filter(p=>p.k===1);
   expect(layer.extract().points.every(p=>p.k===1&&p.z===2)).toBe(true);
   expect(instanceOnPoints(cone(),layer).length).toBe(6);
   expect(sites.translate([1,0,0]).points.at(0)!.x).toBe(0);
   expect(sites.key).toBe('sites');expect('faces' in sites).toBe(false);
 });
 it('handles empty/single grids and rejects invalid dimensions and capacity',()=>{
   expect(grid({cols:0,rows:3}).points.length).toBe(0);
   expect(grid({cols:1,rows:1,layers:1}).surface.points[0].position).toEqual([0,0,0]);
   expect(()=>grid({cols:1.5,rows:2})).toThrow('integer');
   expect(()=>grid({cols:1,rows:-1})).toThrow('integer');
   expect(()=>grid({cols:1000,rows:1000})).toThrow('budget');
   expect(()=>grid({cols:2,rows:2,maxPoints:3})).toThrow('budget');
   expect(()=>grid({cols:2,rows:2,spacing:0})).toThrow('positive');
 });
});
