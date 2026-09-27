import {describe,expect,it,expectTypeOf} from 'vitest';
import {mesh3} from '../src/three/geometry/mesh3.js';
import {box,cone,cylinder,plane,curve,revolve,sphere,sweep,torus,instanceOnPoints,parametricCurve} from '../src/three/api/index.js';
import {surfaceLocation3} from '../src/three/geometry/location.js';
import {rowColumns3} from '../src/three/geometry/model.js';
import {circle3} from './helpers/surfaces.js';
import type {Material} from '../src/material.js';

type UV = readonly [number,number];
type ChartedMesh = Material;

function corners(mesh:Material):readonly {position:readonly [number,number,number];uv:UV;chart:string}[]{
  return mesh.faces.map(face=>face.corners.map(c=>({
    position:[c.point.x,c.point.y,c.point.z] as const,
    uv:c.uv as UV,
    chart:c.chart as string,
  }))).flat();
}

/** Each face's corners, their uv and chart. */
const charts=(mesh:Material)=>mesh.faces.map(face=>face.corners.map(c=>({uv:c.uv,chart:c.chart})));
/** Face `f`'s corners, every column a kernel reads of each. */
function cornerColumns(mesh:Material,f:number){
  const read=mesh3(mesh),out=[];
  for(let c=read.cornerStart[f];c<read.cornerStart[f+1];c++)out.push(rowColumns3(read,'corners',c));
  return out;
}

function checkLocations<C extends {readonly uv:UV;readonly chart:string}>(mesh:Material):void {
  const typedUV:UV=mesh.corners.at(0)!.uv;
  const typedChart:string=mesh.corners.at(0)!.chart;
  void typedUV; void typedChart;
  for(let i=0;i<mesh3(mesh).triangleCount;i++){
    const location=surfaceLocation3(mesh3(mesh),i,[.2,.3,.5]);
    expect(location.chartStatus).toBe('regular');
    expect(location.uv).toBeDefined();
    expect(location.chart).toEqual(expect.any(String));
  }
}

function positionKey(position:readonly number[]):string{return position.map(value=>value.toPrecision(12)).join(',');}

function seamMultiplicity(mesh:Material):number {
  const byPosition=new Map<string,Set<string>>();
  for(const corner of corners(mesh)){
    const key=positionKey(corner.position),values=byPosition.get(key)??new Set<string>();
    values.add(JSON.stringify(corner.uv));byPosition.set(key,values);
  }
  return [...byPosition.values()].filter(values=>values.size>1).length;
}

describe('primitive UV charts',()=>{
  it('provides regular typed UV locations and named charts for every generator',()=>{
    const fixtures:[ChartedMesh,string[]][]=[
      [plane(),['plane']],
      [box(),[]],
      [sphere(1,{segments:8,rings:4}),['sphere']],
      [cylinder(1,2,{segments:8}),['side','bottom','top']],
      [cone(1,2,{segments:8}),['side','bottom']],
      [torus(2,.3,{segments:8,tubeSegments:5}),['torus']],
      [sweep(circle3(.4,{segments:8}),curve([[0,0,0],[0,0,2]]),{caps:true}),['side','start','end']],
      [revolve(curve([[1,0,-1],[2,0,-1],[2,0,1],[1,0,1]],{closed:true}),{angle:180,segments:8,caps:true}),['side','start','end']],
    ];
    for(const [mesh,required] of fixtures){
      checkLocations(mesh);
      const values=corners(mesh);
      expect(values.length).toBeGreaterThan(0);
      expect(values.every(({uv,chart})=>uv.length===2&&uv.every(Number.isFinite)&&typeof chart==='string')).toBe(true);
      for(const chart of required)expect(new Set(values.map(value=>value.chart)).has(chart)).toBe(true);
    }
    const sixFaceBox=box();
    expect(new Set(sixFaceBox.faces.map(face=>face.corners.at(0)!.chart)).size).toBe(6);
    expect(sixFaceBox.faces.every(face=>new Set(face.corners.map(c=>c.chart)).size===1)).toBe(true);
  });

  it('keeps geometric seams shared while representing chart seams in corners',()=>{
    const orb=sphere(1,{segments:8,rings:4}),ring=torus(2,.3,{segments:8,tubeSegments:5});
    expect(new Set(orb.points.filter(point=>Math.hypot(point.x,point.y)<1e-12).map(point=>positionKey([point.x,point.y,point.z]))).size).toBe(2);
    expect(seamMultiplicity(orb)).toBeGreaterThan(0);
    expect(seamMultiplicity(ring)).toBeGreaterThan(0);
    expect(seamMultiplicity(cylinder(1,2,{segments:8}))).toBeGreaterThan(0);
    expect(seamMultiplicity(cone(1,2,{segments:8}))).toBeGreaterThan(0);
    expect(seamMultiplicity(sweep(circle3(.4,{segments:8}),curve([[0,0,0],[0,0,2]])))).toBeGreaterThan(0);
  });

  it('preserves corner UV values through edits, mirrors, extraction, subdivision and realization',()=>{
    const source=box(2),before=charts(source).flat();
    const edited=source.displace(point=>[0,0,point.x*.1]).translate([2,3,4]);
    expect(charts(edited).flat()).toEqual(before);
    const mirrored=source.scale([-1,1,1]);
    expect(charts(mirrored).flat()).toEqual(charts(source).map(face=>face.reverse()).flat());
    expect(cornerColumns(source.faces.filter(face=>face.index===0).extract(),0)).toEqual(cornerColumns(source,0));
    const refined=source.subdivide();
    expect(refined.corners.map(c=>c.chart).every(chart=>typeof chart==='string')).toBe(true);
    const realized=instanceOnPoints(source,source.points.filter(point=>point.index<2)).realize();
    expect(realized.corners.map(c=>c.uv).filter(Boolean)).toHaveLength(before.length*2);
  });

  it('uses profile and path arclength for sweep UVs',()=>{
    const profile=curve([[0,0,0],[1,0,0],[1,.5,0],[0,.5,0]],{closed:true});
    const path=curve([[0,0,0],[0,0,1],[0,0,4]]);
    const mesh=sweep(profile,path);
    const first=mesh.faces.at(0)!.corners.map(c=>c.uv as UV);
    expect(first).toEqual([[0,0],[1/3,0],[1/3,1/4],[0,1/4]]);
    const second=mesh.faces.at(1)!.corners.map(c=>c.uv as UV);
    expect(second[0][0]).toBeCloseTo(1/3);
    expect(second[1][0]).toBeCloseTo(1/2);
    expect(second[2][1]).toBeCloseTo(1/4);
  });

  it('keeps revolve sweep fractions signed in orientation and profile arclength in v',()=>{
    const profile=curve([[1,0,0],[2,0,0],[2,0,2],[1,0,2]],{closed:true});
    const positive=revolve(profile,{angle:180,segments:4,caps:true});
    const negative=revolve(profile,{angle:-180,segments:4,caps:true});
    const side=positive.faces.at(0)!.corners.map(c=>c.uv as UV);
    expect(side.map(uv=>uv[0])).toEqual([0,1/4,1/4,0]);
    expect(side.map(uv=>uv[1])).toEqual([0,0,1/6,1/6]);
    const count=positive.faces.length;
    expect(positive.faces.at(count-2)!.corners.every(c=>c.chart==='start')).toBe(true);
    expect(positive.faces.at(count-1)!.corners.every(c=>c.chart==='end')).toBe(true);
    const loop=(m:Material)=>m.faces.at(0)!.corners.map(c=>c.point.index);
    expect(loop(negative)).toEqual([...loop(positive)].reverse());
    expect(negative.faces.at(0)!.corners.every(c=>{
      const uv=c.uv as UV;return uv[0]>=0&&uv[0]<=1&&uv[1]>=0&&uv[1]<=1;
    })).toBe(true);
  });
});
