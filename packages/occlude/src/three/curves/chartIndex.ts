import type {Surface3} from '../geometry/surface.js';
import {triangleCorners3} from '../geometry/corners.js';
import {WorldIndex3,worldBounds3} from '../geometry/bounds.js';
import {triangulationJob3} from '../geometry/triangulation.js';
import {point,orientPoint,type H} from '../geometry/exact.js';
import type {UV2} from './chartClip.js';

export interface ChartTriangle3 {readonly triangle:number;readonly chart:string|number;readonly uv:readonly [UV2,UV2,UV2];readonly component:number}
export interface ChartIndex3 {readonly rows:readonly ChartTriangle3[];readonly index:WorldIndex3}
const cache=new WeakMap<Surface3,Map<string,ChartIndex3>>();
/** At most four coordinate configurations per live immutable surface. */
export function* chartIndexJob3(surface:Surface3,uvName='uv',chartName='chart',selected?:string|number):Generator<void,ChartIndex3> {
  const key=JSON.stringify([uvName,chartName,selected??null]),entries=cache.get(surface),previous=entries?.get(key);
  if(previous)return previous;
  const topology=yield*triangulationJob3(surface);
  const rows:ChartTriangle3[]=[],byTriangle=new Map<number,number>();
  for(let i=0;i<surface.triangles.length;i++){
    const face=surface.faces[surface.triangles[i].face],corners=triangleCorners3(surface,i).map(c=>face.corners![c]);
    const names=corners.map(c=>c.attributes[chartName]??'default');
    if(names.some(n=>n!==names[0])||!['string','number'].includes(typeof names[0]))throw new Error('surface mapping triangle crosses chart identities');
    if(selected===undefined||names[0]===selected){
      const values=corners.map(c=>c.attributes[uvName]);
      if(values.some(uv=>!Array.isArray(uv)||uv.length!==2||!uv.every(Number.isFinite)))throw new Error(`surface mapping requires finite corner pairs in ${uvName}`);
      const uv=values.map(v=>Object.freeze([...(v as readonly number[])])) as unknown as readonly [UV2,UV2,UV2];
      const exact=uv.map(p=>point([p[0],p[1],0])) as unknown as readonly [H,H,H];
      if(orientPoint(...exact,2)===0n)throw new Error(`surface mapping has a degenerate UV triangle on face ${face.id}`);
      byTriangle.set(i,rows.length);rows.push({triangle:i,chart:names[0] as string|number,uv,component:-1});
    }
    if((i&127)===127)yield;
  }
  // Chart identity and actual adjacency partition disconnected sheets. UV
  // discontinuities remain per-triangle values; periodic seams need not cut
  // the underlying physical component.
  let component=0;
  for(let i=0;i<rows.length;i++){
    if(rows[i].component>=0)continue;
    const queue=[i];rows[i]={...rows[i],component};
    for(let j=0;j<queue.length;j++){
      const row=rows[queue[j]];
      for(const neighbor of topology.neighbors[row.triangle]){
        const index=byTriangle.get(neighbor);
        if(index!==undefined&&rows[index].component<0&&rows[index].chart===row.chart){rows[index]={...rows[index],component};queue.push(index);}
      }
      if((j&127)===127)yield;
    }
    component++;
  }
  const bounds=rows.map(row=>worldBounds3(row.uv.map(p=>[p[0],p[1],0]))),index=yield*WorldIndex3.build(bounds);
  const value=Object.freeze({rows:Object.freeze(rows.map(row=>Object.freeze(row))),index});
  const next=entries??new Map<string,ChartIndex3>();
  if(next.size>=4)next.delete(next.keys().next().value!);
  next.set(key,value);cache.set(surface,next);return value;
}
