import {topology3} from './topology.js';
import {measureFaces3} from './model.js';
import {assembleSurface3,type Surface3,type SurfaceFace3,type SurfaceTriangle3,type SurfacePoint3,type SurfaceCorner3,type Attributes3} from './surface.js';
import {add3,finite3,type Vec3} from '../math.js';

/**
 * Connected-region extrusion. Each connected component of the selection moves
 * as one cap by one vector; every region boundary edge (exactly one selected
 * incident face, including open mesh boundaries and hole loops) grows one
 * planar wall quad. Region-interior points move in place, so unselected
 * geometry stays connected through the duplicated boundary points only.
 *
 * Retained: cap face IDs, corner IDs/attributes (UVs included), face and edge
 * attributes and the fixed cap triangulation. Generated: boundary point copies
 * `['extrude', key, 'point', pointId]`, walls `['extrude', key, 'side', edgeId]`
 * with copied face/corner attributes and, where a `uv` corner column exists, a
 * side chart `[loop arclength fraction, 0|1]` named `key:side:component`.
 * Provenance records the operation; no attribute columns are added.
 *
 * Not a Boolean or repair service: a recessed or crossing wall is reported only
 * when assembly finds invalid topology; self-intersection is not detected.
 */
export interface ExtrudeComponent3 {readonly index:number;readonly faces:readonly number[];readonly vector:Vec3}
const key=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`;
export function extrudeRegion3(surface:Surface3,components:readonly ExtrudeComponent3[],operation='extrude'):Surface3 {
  if(typeof operation!=='string'||!operation)throw new Error('extrusion requires a nonempty key');
  const selected=new Map<number,number>();
  // A component with no vector moves nowhere, and a closed shell has no
  // boundary to raise walls from: drop those and extrude the rest. Dropping one
  // can only free boundary edges for its neighbours, so the pass repeats until
  // every surviving component has a boundary.
  let active=components.filter(c=>{finite3(c.vector);return c.vector.some(n=>n!==0);});
  const topology=topology3(surface),id=(...parts:(string|number)[])=>JSON.stringify(['extrude',operation,...parts]);
  // Boundary edges per component, oriented as the selected face winds them.
  let boundary=active.map(()=>[] as {edge:number;a:number;b:number;face:number}[]);
  for(;;){
    selected.clear();
    active.forEach((c,i)=>{for(const f of c.faces){if(!surface.faces[f])throw new Error('extrusion selects a missing face');if(selected.has(f))throw new Error('extrusion components overlap');selected.set(f,i);}});
    boundary=active.map(()=>[] as {edge:number;a:number;b:number;face:number}[]);
    for(let e=0;e<surface.edges.length;e++){
      const edge=surface.edges[e],owners=edge.faces.filter(f=>selected.has(f));
      if(owners.length!==1)continue;
      const face=surface.faces[owners[0]],vs=face.vertices,i=vs.findIndex((v,j)=>key(v,vs[(j+1)%vs.length])===key(...edge.vertices));
      boundary[selected.get(owners[0])!].push({edge:e,a:vs[i],b:vs[(i+1)%vs.length],face:owners[0]});
    }
    const keep=active.filter((_,i)=>boundary[i].length);
    if(keep.length===active.length)break;
    active=keep;
  }
  if(!selected.size)return surface;
  const points:SurfacePoint3[]=surface.points.map(p=>({...p,position:[...p.position] as Vec3,attributes:structuredClone(p.attributes)}));
  // A point is interior to one component when every incident face is selected
  // in that component; it moves in place. Otherwise each component using it
  // receives a translated copy.
  const copies=new Map<string,number>();
  const interior=new Map<number,number>(),onBoundary=new Set(boundary.flat().flatMap(e=>[e.a,e.b]));
  for(let v=0;v<surface.points.length;v++){
    const faces=topology.pointFaces[v];if(!faces.length||onBoundary.has(v))continue;
    const owners=new Set(faces.map(f=>selected.get(f)));
    if(owners.size===1&&!owners.has(undefined))interior.set(v,[...owners][0]!);
    else if(!owners.has(undefined)&&owners.size>1)throw new Error(`point ${surface.points[v].id} joins extruded regions by vertex only; extrude them separately`);
  }
  const vectors=new Map(active.map((c,i)=>[i,c.vector]));
  const mapped=(v:number,component:number):number=>{
    if(interior.get(v)===component)return v;
    const k=`${component}:${v}`,found=copies.get(k);if(found!==undefined)return found;
    const p=surface.points[v],index=points.length;
    points.push({id:id('point',p.id),position:add3(p.position,vectors.get(component)!),attributes:structuredClone(p.attributes),provenance:{operation:'extrude',parents:[p.id]}});
    copies.set(k,index);return index;
  };
  for(const [v,component] of interior)points[v].position=add3(points[v].position,vectors.get(component)!);
  const faces:SurfaceFace3[]=[],triangles:SurfaceTriangle3[]=[];
  const byFace=surface.faces.map(()=>[] as SurfaceTriangle3[]);surface.triangles.forEach(t=>byFace[t.face].push(t));
  const add=(face:SurfaceFace3,parts:readonly (readonly [number,number,number])[])=>{const i=faces.length;faces.push(face);for(const vertices of parts)triangles.push({face:i,vertices});};
  surface.faces.forEach((f,i)=>{
    const component=selected.get(i);
    if(component===undefined){add({...f},byFace[i].map(t=>t.vertices));return;}
    const remap=(v:number)=>mapped(v,component);
    add({...f,vertices:f.vertices.map(remap),corners:f.corners?.map(c=>({...c,attributes:structuredClone(c.attributes)}))},byFace[i].map(t=>t.vertices.map(remap) as [number,number,number]));
  });
  // Walls follow boundary loops so side charts run continuously around them.
  const parentEdge=new Map<string,number>();
  for(const [ci,edges] of boundary.entries()){
    const component=active[ci],componentIndex=ci,starts=new Map<number,number[]>();
    edges.forEach((e,i)=>{const list=starts.get(e.a)??[];list.push(i);starts.set(e.a,list);});
    const used=new Set<number>();
    for(let first=0;first<edges.length;first++){
      if(used.has(first))continue;
      const loop:number[]=[first];used.add(first);
      for(let current=first;;){
        const candidates=(starts.get(edges[current].b)??[]).filter(i=>!used.has(i));
        if(!candidates.length)break;
        const next=candidates.sort((x,y)=>edges[x].edge-edges[y].edge)[0];used.add(next);loop.push(next);current=next;
        if(edges[current].b===edges[first].a)break;
      }
      const lengths=loop.map(i=>{const e=edges[i];return Math.hypot(...surface.points[e.a].position.map((n,k)=>n-surface.points[e.b].position[k]));});
      const total=lengths.reduce((a,b)=>a+b,0);let along=0;
      loop.forEach((i,j)=>{
        const e=edges[i],face=surface.faces[e.face],u0=total?along/total:0,u1=j===loop.length-1?1:total?(along+lengths[j])/total:0;along+=lengths[j];
        const a=e.a,b=e.b,bTop=mapped(b,componentIndex),aTop=mapped(a,componentIndex);
        const cornerOf=(v:number):SurfaceCorner3|undefined=>face.corners?.[face.vertices.indexOf(v)];
        const corner=(v:number,local:number,uv:readonly [number,number]):SurfaceCorner3=>{
          const source=cornerOf(v),attributes:Attributes3=structuredClone(source?.attributes??{});
          if(Object.hasOwn(attributes,'uv'))attributes.uv=[...uv];
          if(Object.hasOwn(attributes,'chart'))attributes.chart=`${operation}:side:${component.index}`;
          return {id:id('corner',surface.edges[e.edge].id,local),attributes,provenance:{operation:'extrude',parents:source?[source.id]:[]}};
        };
        const faceId=id('side',surface.edges[e.edge].id);
        add({id:faceId,vertices:[a,b,bTop,aTop],corners:[corner(a,0,[u0,0]),corner(b,1,[u1,0]),corner(b,2,[u1,1]),corner(a,3,[u0,1])],attributes:structuredClone(face.attributes),provenance:{operation:'extrude',parents:[face.id,surface.edges[e.edge].id]}},[[a,b,bTop],[a,bTop,aTop]]);
        parentEdge.set(key(aTop,bTop),e.edge);parentEdge.set(key(a,aTop),e.edge);
      });
    }
  }
  const result=assembleSurface3(points,faces,triangles,surface);
  // Generated edges inherit their boundary edge's attributes: the cap copy and
  // the vertical rising from that edge's start vertex.
  const inherited=result.edges.map(edge=>{
    const parent=parentEdge.get(key(...edge.vertices));
    if(parent===undefined||edge.provenance)return edge;
    const source=surface.edges[parent];
    return {...edge,attributes:structuredClone(source.attributes),provenance:{operation:'extrude',parents:[source.id]}};
  });
  return {...result,edges:Object.freeze(inherited)};
}
/** Area-weighted region direction; undefined when the faces cancel. */
export function regionDirection3(surface:Surface3,faces:readonly number[]):{normal?:Vec3;center:Vec3;area:number} {
  const measures=measureFaces3(surface);let sum:Vec3=[0,0,0],center:Vec3=[0,0,0],area=0;
  for(const f of faces){const m=measures[f];sum=add3(sum,[m.normal[0]*m.area,m.normal[1]*m.area,m.normal[2]*m.area]);center=add3(center,[m.center[0]*m.area,m.center[1]*m.area,m.center[2]*m.area]);area+=m.area;}
  const length=Math.hypot(...sum);
  return {normal:area>0&&length>=0.5*area?[sum[0]/length,sum[1]/length,sum[2]/length]:undefined,center:area>0?[center[0]/area,center[1]/area,center[2]/area]:[0,0,0],area};
}
