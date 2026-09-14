import {describe,expect,it,expectTypeOf} from 'vitest';
import {box,circle,cone,cylinder,plane,polyline,revolve,sphere,sweep,torus,instanceOnPoints,type Mesh} from '../src/three/api/index.js';
import {surfaceLocation3} from '../src/three/geometry/location.js';

type UV = readonly [number,number];
type ChartedMesh = Mesh<any,any,any,{readonly uv:UV;readonly chart:string}>;

function corners(mesh:Mesh):readonly {position:readonly [number,number,number];uv:UV;chart:string}[]{
  return mesh.surface.faces.flatMap(face=>face.vertices.map((vertex,localIndex)=>({
    position:mesh.surface.points[vertex].position,
    uv:face.corners![localIndex].attributes.uv as UV,
    chart:face.corners![localIndex].attributes.chart as string,
  })));
}

function checkLocations<C extends {readonly uv:UV;readonly chart:string}>(mesh:Mesh<any,any,any,C>):void {
  const typedUV:UV=mesh.corners.at(0)!.uv;
  const typedChart:string=mesh.corners.at(0)!.chart;
  void typedUV; void typedChart;
  for(let i=0;i<mesh.surface.triangles.length;i++){
    const location=surfaceLocation3(mesh.surface,i,[.2,.3,.5]);
    expect(location.chartStatus).toBe('regular');
    expect(location.uv).toBeDefined();
    expect(location.chart).toEqual(expect.any(String));
  }
}

function positionKey(position:readonly number[]):string{return position.map(value=>value.toPrecision(12)).join(',');}

function seamMultiplicity(mesh:Mesh):number {
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
      [sweep(circle(.4,{segments:8}),polyline([[0,0,0],[0,0,2]]),{caps:true}),['side','start','end']],
      [revolve(polyline([[1,0,-1],[2,0,-1],[2,0,1],[1,0,1]],{closed:true}),{angle:180,segments:8,caps:true}),['side','start','end']],
    ];
    for(const [mesh,required] of fixtures){
      checkLocations(mesh);
      const values=corners(mesh);
      expect(values.length).toBeGreaterThan(0);
      expect(values.every(({uv,chart})=>uv.length===2&&uv.every(Number.isFinite)&&typeof chart==='string')).toBe(true);
      for(const chart of required)expect(new Set(values.map(value=>value.chart)).has(chart)).toBe(true);
    }
    const sixFaceBox=box();
    expect(new Set(sixFaceBox.surface.faces.map(face=>face.corners![0].attributes.chart)).size).toBe(6);
    expect(sixFaceBox.surface.faces.every(face=>new Set(face.corners!.map(c=>c.attributes.chart)).size===1)).toBe(true);
  });

  it('keeps geometric seams shared while representing chart seams in corners',()=>{
    const orb=sphere(1,{segments:8,rings:4}),ring=torus(2,.3,{segments:8,tubeSegments:5});
    expect(new Set(orb.surface.points.filter(point=>Math.hypot(point.position[0],point.position[1])<1e-12).map(pointKey=>positionKey(pointKey.position))).size).toBe(2);
    expect(seamMultiplicity(orb)).toBeGreaterThan(0);
    expect(seamMultiplicity(ring)).toBeGreaterThan(0);
    expect(seamMultiplicity(cylinder(1,2,{segments:8}))).toBeGreaterThan(0);
    expect(seamMultiplicity(cone(1,2,{segments:8}))).toBeGreaterThan(0);
    expect(seamMultiplicity(sweep(circle(.4,{segments:8}),polyline([[0,0,0],[0,0,2]])))).toBeGreaterThan(0);
  });

  it('preserves corner UV values through edits, mirrors, extraction, subdivision and realization',()=>{
    const source=box(2),before=source.surface.faces.flatMap(face=>face.corners!.map(c=>({uv:c.attributes.uv,chart:c.attributes.chart})));
    const edited=source.displace(point=>[0,0,point.x*.1]).translate([2,3,4]);
    expect(edited.surface.faces.flatMap(face=>face.corners!.map(c=>({uv:c.attributes.uv,chart:c.attributes.chart})))).toEqual(before);
    const mirrored=source.scale([-1,1,1]);
    expect(mirrored.surface.faces.map((face,index)=>face.corners!.map(c=>({uv:c.attributes.uv,chart:c.attributes.chart}))).flat()).toEqual(source.surface.faces.map((face,index)=>face.corners!.map(c=>({uv:c.attributes.uv,chart:c.attributes.chart})).reverse()).flat());
    expect(source.faces().filter(face=>face.index===0).extract().surface.faces[0].corners!.map(c=>c.attributes)).toEqual(source.surface.faces[0].corners!.map(c=>c.attributes));
    const refined=source.subdivide();
    expect(refined.surface.faces.flatMap(face=>face.corners!.map(c=>c.attributes.chart)).every(chart=>typeof chart==='string')).toBe(true);
    const realized=instanceOnPoints(source,source.points.filter(point=>point.index<2)).realize();
    expect(realized.surface.faces.flatMap(face=>face.corners!.map(c=>c.attributes.uv)).filter(Boolean)).toHaveLength(before.length*2);
  });

  it('uses profile and path arclength for sweep UVs',()=>{
    const profile=polyline([[0,0,0],[1,0,0],[1,.5,0],[0,.5,0]],{closed:true});
    const path=polyline([[0,0,0],[0,0,1],[0,0,4]]);
    const mesh=sweep(profile,path);
    const first=mesh.surface.faces[0].corners!.map(c=>c.attributes.uv as UV);
    expect(first).toEqual([[0,0],[1/3,0],[1/3,1/4],[0,1/4]]);
    const second=mesh.surface.faces[1].corners!.map(c=>c.attributes.uv as UV);
    expect(second[0][0]).toBeCloseTo(1/3);
    expect(second[1][0]).toBeCloseTo(1/2);
    expect(second[2][1]).toBeCloseTo(1/4);
  });

  it('keeps revolve sweep fractions signed in orientation and profile arclength in v',()=>{
    const profile=polyline([[1,0,0],[2,0,0],[2,0,2],[1,0,2]],{closed:true});
    const positive=revolve(profile,{angle:180,segments:4,caps:true});
    const negative=revolve(profile,{angle:-180,segments:4,caps:true});
    const side=positive.surface.faces[0].corners!.map(c=>c.attributes.uv as UV);
    expect(side.map(uv=>uv[0])).toEqual([0,1/4,1/4,0]);
    expect(side.map(uv=>uv[1])).toEqual([0,0,1/6,1/6]);
    expect(positive.surface.faces.at(-2)!.corners!.every(c=>c.attributes.chart==='start')).toBe(true);
    expect(positive.surface.faces.at(-1)!.corners!.every(c=>c.attributes.chart==='end')).toBe(true);
    expect(negative.surface.faces[0].vertices).toEqual([...positive.surface.faces[0].vertices].reverse());
    expect(negative.surface.faces[0].corners!.every(c=>{
      const uv=c.attributes.uv as UV;return uv[0]>=0&&uv[0]<=1&&uv[1]>=0&&uv[1]<=1;
    })).toBe(true);
  });
});

function pointKey(point:{position:readonly [number,number,number]}):{position:readonly [number,number,number]}{return point;}
