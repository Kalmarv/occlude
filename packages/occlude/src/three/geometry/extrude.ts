import {checkMade3,faceEdges3,kernelColumn,pairKey,type Columns3,type Made3,type Mesh3,type Provenance3} from './mesh3.js';
import {kindOf,kinds,kindWords,type AnyColumn,type AnyKind} from '../../column.js';
import {add3,cross3,finite3,mul3,sub3,unit3,type Vec3} from '../math.js';

/**
 * Connected-region extrusion. Each connected component of the selection moves
 * as one cap by one vector; every region boundary edge (exactly one selected
 * incident face, including open mesh boundaries and hole loops) grows one
 * planar wall quad. Region-interior points move in place, so unselected
 * geometry stays connected through the duplicated boundary points only.
 *
 * Retained: cap face names, corner names and columns (UVs included), face
 * and edge columns and the fixed cap triangulation. Generated: boundary point
 * copies `['extrude', key, 'point', pointName]`, walls `['extrude', key,
 * 'side', edgeName]` and wall corners `['extrude', key, 'corner', edgeName,
 * local]`. A generated name is minted once: where that name is already held
 * (a corner shared by two parts, or copied by an earlier extrusion) the
 * component index joins it, `['extrude', key, 'point', component,
 * pointName]`, then a counter. Walls come with copied face/corner columns
 * and, where a `uv` corner column exists, a side chart `[loop arclength
 * fraction, 0|1]` named `key:side:component`. Lineage records the
 * operation; no columns are added.
 *
 * Not a Boolean or repair service: a recessed or crossing wall is reported only
 * when the answer is checked and finds invalid topology; self-intersection is
 * not detected.
 */
export interface ExtrudeComponent3 {readonly index:number;readonly faces:readonly number[];readonly vector:Vec3}

/** Where a made row's columns come from: a row of the input's domain (or
 * none, -1), and the values a wall writes over its copy. */
interface Sourced {readonly rows:number[];readonly over:Map<number,Readonly<Record<string,unknown>>>}
const sourced=():Sourced=>({rows:[],over:new Map()});
/** The kernel columns of `cols` on the rows `s` names, a written value where
 * it has one. A written value of another kind than its column refuses as a
 * column refuses one. */
function columnsOf(cols:Columns3,s:Sourced):Record<string,AnyColumn> {
  const out:Record<string,AnyColumn>={};
  for(const [name,column] of Object.entries(cols)){
    if(!kernelColumn(column))continue;
    const kind=kindOf(column),written=[...s.over.values()].some(o=>Object.hasOwn(o,name));
    if(!written&&s.rows.every(r=>r>=0)){out[name]=column.keep(s.rows);continue;}
    out[name]=kind.from(s.rows.map((r,i)=>{
      const over=s.over.get(i);
      if(over!==undefined&&Object.hasOwn(over,name))return sameKind(name,kind,over[name]);
      return r<0?kind.default:column.get(r);
    }));
  }
  return out;
}
/** `value` when it is of `kind`: a wall's side chart is a pair of numbers,
 * its name a string. */
function sameKind(name:string,kind:AnyKind,value:unknown):unknown {
  const own=typeof value==='string'?kinds.string:kinds.vector((value as readonly number[]).length);
  if(own!==kind)throw new Error(`the column '${name}' holds ${kindWords(kind)} on one row and ${kindWords(own)} on another: a column holds one kind`);
  return value;
}

export function extrudeRegion3(mesh:Mesh3,components:readonly ExtrudeComponent3[],operation='extrude'):Made3|undefined {
  if(typeof operation!=='string'||!operation)throw new Error('extrusion requires a nonempty key');
  const selected=new Map<number,number>();
  // A component with no vector moves nowhere, and a closed shell has no
  // boundary to raise walls from: drop those and extrude the rest. Dropping one
  // can only free boundary edges for its neighbours, so the pass repeats until
  // every surviving component has a boundary.
  let active=components.filter(c=>{finite3(c.vector,'extrude');return c.vector.some(n=>n!==0);});
  const names=mesh.names,loops=mesh.loops,edgeFaces=mesh.edgeFaces,id=(...parts:(string|number)[])=>JSON.stringify(['extrude',operation,...parts]);
  // Boundary edges per component, oriented as the selected face winds them.
  let boundary=active.map(()=>[] as {edge:number;a:number;b:number;face:number}[]);
  for(;;){
    selected.clear();
    active.forEach((c,i)=>{for(const f of c.faces){if(!(f>=0&&f<mesh.faceCount))throw new Error('extrusion selects a missing face');if(selected.has(f))throw new Error('extrusion components overlap');selected.set(f,i);}});
    boundary=active.map(()=>[] as {edge:number;a:number;b:number;face:number}[]);
    for(let e=0;e<mesh.edgeCount;e++){
      const owners=edgeFaces[e].filter(f=>selected.has(f));
      if(owners.length!==1)continue;
      const vs=loops[owners[0]],key=pairKey(mesh.edges[2*e],mesh.edges[2*e+1]),i=vs.findIndex((v,j)=>pairKey(v,vs[(j+1)%vs.length])===key);
      boundary[selected.get(owners[0])!].push({edge:e,a:vs[i],b:vs[(i+1)%vs.length],face:owners[0]});
    }
    const keep=active.filter((_,i)=>boundary[i].length);
    if(keep.length===active.length)break;
    active=keep;
  }
  if(!selected.size)return undefined;
  const x=Array.from(mesh.x),y=Array.from(mesh.y),z=Array.from(mesh.z);
  const pointNames=[...names.points],pointLineage:(Provenance3|undefined)[]=new Array(mesh.n).fill(undefined);
  const pointRows=Array.from({length:mesh.n},(_,i)=>i);
  // A point is interior to one component when every incident face is selected
  // in that component; it moves in place. Otherwise each component using it
  // receives a translated copy.
  const copies=new Map<string,number>();
  const interior=new Map<number,number>(),onBoundary=new Set(boundary.flat().flatMap(e=>[e.a,e.b]));
  const pointFaces=mesh.pointFaces;
  for(let v=0;v<mesh.n;v++){
    const faces=pointFaces[v];if(!faces.length||onBoundary.has(v))continue;
    const owners=new Set(faces.map(f=>selected.get(f)));
    if(owners.has(undefined))continue;
    // Interior to one component: it moves in place. Several components that
    // meet only at this point (a non-manifold vertex, no boundary edge
    // through it) separate there: the first keeps the point, each other one
    // takes a copy — what extruding them one call at a time gives.
    interior.set(v,Math.min(...owners as Set<number>));
  }
  // A minted name is never one the input or this call already holds: the
  // plain name first (unchanged for every copy that has no rival), then the
  // name with the component, then a counter. Two parts sharing a corner, or a
  // second call reaching a corner an earlier call copied, stay distinct.
  const taken={point:new Set(names.points),face:new Set(names.faces),corner:new Set(names.corners)};
  const mint=(domain:keyof typeof taken,component:number,kind:string,...rest:(string|number)[]):string=>{
    const ids=taken[domain];let name=id(kind,...rest);
    if(ids.has(name))name=id(kind,component,...rest);
    for(let n=1;ids.has(name);n++)name=id(kind,component,...rest,n);
    ids.add(name);return name;
  };
  const vectors=new Map(active.map((c,i)=>[i,c.vector]));
  const mapped=(v:number,component:number):number=>{
    if(interior.get(v)===component)return v;
    const k=`${component}:${v}`,found=copies.get(k);if(found!==undefined)return found;
    const index=x.length,p=add3(mesh.position(v),vectors.get(component)!);
    x.push(p[0]);y.push(p[1]);z.push(p[2]);
    pointNames.push(mint('point',active[component].index,'point',names.points[v]));
    pointLineage.push({operation:'extrude',parents:[names.points[v]]});
    pointRows.push(v);
    copies.set(k,index);return index;
  };
  for(const [v,component] of interior){const p=add3(mesh.position(v),vectors.get(component)!);x[v]=p[0];y[v]=p[1];z[v]=p[2];}
  const faceLoops:number[][]=[],triangles:(readonly number[])[]=[],faceNames:string[]=[],faceLineage:(Provenance3|undefined)[]=[];
  const cornerNames:string[]=[],cornerLineage:(Provenance3|undefined)[]=[];
  const faceCols=sourced(),cornerCols=sourced();
  // Each face keeps its name, corners, columns and fixed triangles; a
  // selected one walks its component's points.
  loops.forEach((loop,f)=>{
    const component=selected.get(f);
    faceLoops.push(component===undefined?[...loop]:loop.map(v=>mapped(v,component)));
    triangles.push(mesh.localTriangles(f));
    faceNames.push(names.faces[f]);faceLineage.push(undefined);faceCols.rows.push(f);
    for(let c=mesh.cornerStart[f];c<mesh.cornerStart[f+1];c++){cornerNames.push(names.corners[c]);cornerLineage.push(undefined);cornerCols.rows.push(c);}
  });
  const chartColumn=(cols:Columns3)=>Object.hasOwn(cols,'chart')&&kernelColumn(cols.chart);
  const cornerChart=chartColumn(mesh.cols.corners),cornerUv=Object.hasOwn(mesh.cols.corners,'uv')&&kernelColumn(mesh.cols.corners.uv),faceChart=chartColumn(mesh.cols.faces);
  // Walls follow boundary loops so side charts run continuously around them.
  const parentEdge=new Map<number,number>();
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
      const lengths=loop.map(i=>{const e=edges[i],a=mesh.position(e.a),b=mesh.position(e.b);return Math.hypot(...a.map((n,k)=>n-b[k]));});
      const total=lengths.reduce((a,b)=>a+b,0);let along=0;
      loop.forEach((i,j)=>{
        const e=edges[i],u0=total?along/total:0,u1=j===loop.length-1?1:total?(along+lengths[j])/total:0;along+=lengths[j];
        const a=e.a,b=e.b,bTop=mapped(b,componentIndex),aTop=mapped(a,componentIndex),edgeName=names.edges[e.edge],faceLoop=loops[e.face],first=mesh.cornerStart[e.face];
        const chart=`${operation}:side:${component.index}`;
        const corner=(v:number,local:number,uv:readonly [number,number])=>{
          const source=first+faceLoop.indexOf(v),over:Record<string,unknown>={};
          if(cornerUv)over.uv=[...uv];
          if(cornerChart)over.chart=chart;
          cornerCols.over.set(cornerCols.rows.length,over);cornerCols.rows.push(source);
          cornerNames.push(mint('corner',component.index,'corner',edgeName,local));
          cornerLineage.push({operation:'extrude',parents:[names.corners[source]]});
        };
        corner(a,0,[u0,0]);corner(b,1,[u1,0]);corner(b,2,[u1,1]);corner(a,3,[u0,1]);
        // A wall is built with the side chart, so its face column names it too.
        if(faceChart)faceCols.over.set(faceCols.rows.length,{chart});
        faceCols.rows.push(e.face);
        faceNames.push(mint('face',component.index,'side',edgeName));
        faceLineage.push({operation:'extrude',parents:[edgeName]});
        faceLoops.push([a,b,bTop,aTop]);triangles.push([0,1,2,0,2,3]);
        parentEdge.set(pairKey(aTop,bTop),e.edge);parentEdge.set(pairKey(a,aTop),e.edge);
      });
    }
  }
  // The edges as assembly derives them from the input's: a kept edge keeps
  // its name and columns. A generated edge inherits its boundary edge's
  // columns: the cap copy and the vertical rising from that edge's start.
  const derived=faceEdges3(faceLoops,pointNames,mesh),edgeCount=derived.edges.length/2;
  const edgeRows:number[]=[],edgeLineage:(Provenance3|undefined)[]=[];
  for(let e=0;e<edgeCount;e++){
    const kept=derived.kept[e];
    const parent=kept>=0?undefined:parentEdge.get(pairKey(derived.edges[2*e],derived.edges[2*e+1]));
    edgeRows.push(kept>=0?kept:parent??-1);
    edgeLineage.push(parent===undefined?undefined:{operation:'extrude',parents:[names.edges[parent]]});
  }
  const cols=mesh.cols;
  const made:Made3={
    x,y,z,
    names:{points:pointNames,edges:derived.names,faces:faceNames,corners:cornerNames},
    loops:faceLoops,triangles,edges:derived.edges,
    cols:{points:columnsOf(cols.points,{rows:pointRows,over:new Map()}),edges:columnsOf(cols.edges,{rows:edgeRows,over:new Map()}),faces:columnsOf(cols.faces,faceCols),corners:columnsOf(cols.corners,cornerCols)},
    lineage:{points:pointLineage,edges:edgeLineage,faces:faceLineage,corners:cornerLineage},
  };
  checkMade3(made);
  return made;
}
/** A face's unit normal, area and area centroid over its fixed triangles: a
 * face with none has no normal and the mean of its points for a centroid. */
function faceMeasure3(mesh:Mesh3,f:number):{normal:Vec3;center:Vec3;area:number} {
  let normal:Vec3=[0,0,0],center:Vec3=[0,0,0],area=0;
  const start=mesh.faceTriangleStart;
  for(let t=start[f];t<start[f+1];t++){
    const [a,b,c]=mesh.triangle(t).map(v=>mesh.position(v)),n=cross3(sub3(b,a),sub3(c,a)),w=Math.hypot(...n)/2;
    normal=add3(normal,n);area+=w;center=add3(center,mul3(add3(add3(a,b),c),w/3));
  }
  const length=Math.hypot(...normal),loop=mesh.loops[f];
  return {
    normal:length>0&&Number.isFinite(length)?unit3(normal):[0,0,0],
    center:area>0?mul3(center,1/area):loop.length?mul3(loop.reduce((sum,v)=>add3(sum,mesh.position(v)),[0,0,0] as Vec3),1/loop.length):[0,0,0],
    area,
  };
}
/** Area-weighted region direction; undefined when the faces cancel. */
export function regionDirection3(mesh:Mesh3,faces:readonly number[]):{normal?:Vec3;center:Vec3;area:number} {
  let sum:Vec3=[0,0,0],center:Vec3=[0,0,0],area=0;
  for(const f of faces){const m=faceMeasure3(mesh,f);sum=add3(sum,[m.normal[0]*m.area,m.normal[1]*m.area,m.normal[2]*m.area]);center=add3(center,[m.center[0]*m.area,m.center[1]*m.area,m.center[2]*m.area]);area+=m.area;}
  const length=Math.hypot(...sum);
  return {normal:area>0&&length>=0.5*area?[sum[0]/length,sum[1]/length,sum[2]/length]:undefined,center:area>0?[center[0]/area,center[1]/area,center[2]/area]:[0,0,0],area};
}
