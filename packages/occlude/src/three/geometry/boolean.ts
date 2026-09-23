import {orient2d} from 'robust-predicates';
import {assembleSurface3,type Attribute3,type Attributes3,type Surface3,type SurfaceFace3,type SurfacePoint3,type SurfaceTriangle3} from './surface.js';
import {add3,cross3,dot3,mul3,sub3,type Vec3} from '../math.js';
import {pointNumber,triangleWeights,type H} from './exact.js';
import {coplanarContact3,type TriangleContact3} from '../curves/contact.js';
import {bindingTriangle3,surfaceBinding3,type SurfaceBinding3} from '../curves/network.js';
import {intersectionContactsJob3,type PreparedIntersectionSource3} from '../curves/intersectionContacts.js';
import {runGeometryJob3} from './job.js';
import {worldBounds3,type WorldBounds3} from './bounds.js';

/** The three solid operations, named by what they answer, not by a branded
 * algorithm: what is in either solid, what is in the first and not the second,
 * what is in both. */
export type BooleanOperation3='unite'|'subtract'|'common';

/** Where a patch of one solid sits with respect to the other: outside it,
 * inside it, or lying on its boundary with the two outward normals agreeing
 * or opposing. A patch is never partly one and partly another: every triangle
 * is cut along the exact seam before it is classified. */
const OUTSIDE=0,INSIDE=1,ON_SAME=2,ON_OPPOSITE=3;
type Placement=typeof OUTSIDE|typeof INSIDE|typeof ON_SAME|typeof ON_OPPOSITE;
/** Which placements each operation keeps, first solid then second. The second
 * solid's kept faces are turned inside out for `subtract`: the bite's wall
 * faces into the hole it leaves. */
const KEEP:Record<BooleanOperation3,readonly [readonly Placement[],readonly Placement[]]>={
  unite:[[OUTSIDE,ON_SAME],[OUTSIDE]],
  common:[[INSIDE,ON_SAME],[INSIDE]],
  subtract:[[OUTSIDE,ON_OPPOSITE],[INSIDE]],
};

type Vec2=readonly [number,number];
const ekey=(a:number,b:number)=>a<b?`${a}:${b}`:`${b}:${a}`;
/** Positive for a counterclockwise turn: the robust determinant, whose sign
 * this package reports the other way round (see `surface.ts`). */
const turn2=(a:Vec2,b:Vec2,c:Vec2)=>-orient2d(a[0],a[1],b[0],b[1],c[0],c[1]);
/** The seam is exact, but the SOLIDS it runs over are not: a sphere's meridian
 * that means to lie in a box's diagonal plane misses it by an ulp, and the true
 * seam then carries a segment a fraction of an ulp long. Vertices within this
 * fraction of the scene are one vertex, which retires those segments before
 * they reach the triangulator. By the same rule, a triangle whose corners all
 * lie within it of another triangle's plane lies in that plane (see
 * `coplanarOverlaps`). Anything larger is real geometry and is kept. */
const WELD=1e-10;

interface Side {
  readonly surface:Surface3;
  readonly binding:SurfaceBinding3;
  readonly prepared:PreparedIntersectionSource3;
  /** Source point index to pool vertex. */
  readonly vertices:number[];
  /** Triangle index to its three pool vertices. */
  readonly corners:(readonly number[])[];
  readonly normals:Vec3[];
  /** Triangle index to the seam points strictly inside it. */
  readonly interior:Map<number,Set<number>>;
  /** Triangle index to the seam segments that must survive as edges. */
  readonly cuts:Map<number,[number,number][]>;
  /** Triangle index to the coplanar overlaps that cover part of it. */
  readonly overlaps:Map<number,{polygon:number[];normal:Vec3}[]>;
}

function openEdgeCount(surface:Surface3):number{return surface.edges.filter(e=>e.faces.length!==2).length;}
/** Distance from a point to a segment, which is how far a seam point is from
 * being ON the edge of the triangle it landed in. */
function toSegment(p:Vec3,a:Vec3,b:Vec3):number {
  const along=sub3(b,a),length=dot3(along,along);
  const t=length>0?Math.max(0,Math.min(1,dot3(sub3(p,a),along)/length)):0;
  return Math.hypot(...sub3(p,add3(a,mul3(along,t))));
}

/** Exact mesh boolean. Both inputs are closed manifold solids; the result is
 * their union, difference or intersection, assembled from the parts of each
 * input's own triangles, cut along the exact intersection curve.
 *
 * The seam is computed in exact rational arithmetic by the same triangle
 * contact kernel the intersection curves use, so a cut point is the true
 * point, not a tolerance away from it. Each cut triangle is retriangulated in
 * its own plane with the seam as constrained edges, every patch is classified
 * against the other solid, and the kept patches are welded by position.
 *
 * KNOWN LIMIT: the result is checked for edge manifoldness and closure, not for
 * vertex manifoldness. Two solids that touch at a single VERTEX — two boxes
 * corner to corner — unite to a closed surface that is pinched at that vertex,
 * and that surface is returned instead of refused. Two solids that touch along
 * an EDGE are caught, because the edge then carries four faces. */
export function booleanSurface3(operation:BooleanOperation3,first:Surface3,second:Surface3):Surface3 {
  for(const [value,which] of [[first,'first'],[second,'second']] as const){
    if(!value||typeof value!=='object'||!Array.isArray(value.faces)||!Array.isArray(value.triangles))throw new Error(`${operation}: the ${which} value is not a mesh`);
    const open=openEdgeCount(value);
    if(open)throw new Error(`${operation}: the ${which} mesh is not closed (${open} boundary edges)`);
    const drawn=new Set(value.triangles.map(t=>t.face));
    if(value.faces.some((_,i)=>!drawn.has(i)))throw new Error(`${operation}: the ${which} mesh has a face with no triangles`);
  }
  const bindings=[surfaceBinding3(first),surfaceBinding3(second)] as const;
  const contacts=runGeometryJob3(intersectionContactsJob3(bindings[0],bindings[1])).value;

  // One pool of welded vertices for both solids. A vertex the two solids share
  // keeps the first solid's identity and columns.
  const positions:Vec3[]=[],ids:string[]=[],attributes:Attributes3[]=[],pool=new Map<string,number[]>();
  // Minted identity goes in a generation that nothing the inputs already carry
  // can be in, so the same operation twice over the same solids — the second
  // bite of `box.subtract(a).subtract(b)` — mints past the first bite instead
  // of colliding with it. The generation is read off the inputs, so it is the
  // same number every time the sketch runs.
  const taken=[first,second].flatMap(s=>[...s.points.map(p=>p.id),...s.faces.map(f=>f.id)]);
  let generation=0;
  while(taken.some(id=>id.startsWith(`${JSON.stringify([operation,generation]).slice(0,-1)},`)))generation++;
  const mint=(...parts:(string|number)[])=>JSON.stringify([operation,generation,...parts]);
  const extent=[first,second].flatMap(s=>s.points.map(p=>p.position)),span=worldBounds3(extent);
  const weld=Math.max(Number.MIN_VALUE,WELD*Math.max(1e-12,...[0,1,2].map(k=>span[k+3]-span[k]).filter(Number.isFinite)));
  const cell=(p:Vec3,dx:number,dy:number,dz:number)=>`${Math.floor(p[0]/weld)+dx},${Math.floor(p[1]/weld)+dy},${Math.floor(p[2]/weld)+dz}`;
  let minted=0;
  const vertex=(position:Vec3,id:()=>string,attrs:()=>Attributes3):number=>{
    for(let dx=-1;dx<2;dx++)for(let dy=-1;dy<2;dy++)for(let dz=-1;dz<2;dz++)
      for(const i of pool.get(cell(position,dx,dy,dz))??[])if(Math.hypot(...sub3(positions[i],position))<=weld)return i;
    const index=positions.length;positions.push(Object.freeze([...position]) as unknown as Vec3);ids.push(id());attributes.push(attrs());
    const key=cell(position,0,0,0),list=pool.get(key);if(list)list.push(index);else pool.set(key,[index]);
    return index;
  };
  const sides:Side[]=bindings.map((binding,s)=>{
    const surface=binding.source;
    const vertices=surface.points.map(p=>vertex(p.position,()=>s===0?p.id:mint('b',p.id),()=>({...p.attributes})));
    const corners=surface.triangles.map(t=>t.vertices.map(v=>vertices[v]));
    const normals=surface.triangles.map(t=>{
      const [a,b,c]=t.vertices.map(v=>positions[vertices[v]]),n=cross3(sub3(b,a),sub3(c,a)),length=Math.hypot(...n);
      return (length>0?mul3(n,1/length):[0,0,0]) as Vec3;
    });
    return {surface,binding,prepared:contacts.sources[s],vertices,corners,normals,interior:new Map(),cuts:new Map(),overlaps:new Map()};
  });

  // A seam point goes on the edge of a triangle it reached, or inside it. The
  // question is asked of the WELDED point at the welding distance, not of the
  // exact one: a seam that means to run along an edge and misses it by an ulp
  // must still be an edge point for both triangles that own the edge, or the
  // two disagree and the cut mesh grows a T-junction.
  const edgePoints=new Map<string,Set<number>>();
  const place=(side:Side,triangle:number,index:number):void=>{
    const corners=side.corners[triangle];
    if(corners.includes(index))return; // a corner of the triangle: already a vertex
    const p=positions[index];
    let nearest=-1,least=Infinity;
    for(let k=0;k<3;k++){const d=toSegment(p,positions[corners[k]],positions[corners[(k+1)%3]]);if(d<least){least=d;nearest=k;}}
    if(least<=weld){
      const key=ekey(corners[nearest],corners[(nearest+1)%3]);
      let set=edgePoints.get(key);if(!set){set=new Set();edgePoints.set(key,set);}
      set.add(index);
      return;
    }
    let set=side.interior.get(triangle);if(!set){set=new Set();side.interior.set(triangle,set);}
    set.add(index);
  };
  const addCut=(side:Side,triangle:number,a:number,b:number):void=>{
    if(a===b)return;
    let list=side.cuts.get(triangle);if(!list){list=[];side.cuts.set(triangle,list);}
    if(!list.some(([u,v])=>ekey(u,v)===ekey(a,b)))list.push([a,b]);
  };
  // A pair that lies in one plane to within the weld overlaps over an area,
  // whatever the exact kernel says about the ulp of tilt between them: its
  // exact contact is replaced by that overlap, cut in the first triangle's own
  // plane. A pair the kernel already found exactly coplanar keeps its answer.
  const coplanar=coplanarOverlaps(sides,weld);
  const exactArea=new Set(contacts.contacts.filter(row=>row.contact.kind==='area').map(row=>pairKey(row.a,row.b)));
  const rows:ContactRow[]=[
    ...contacts.contacts.filter(row=>row.contact.kind==='area'||!coplanar.has(pairKey(row.a,row.b))),
    ...[...coplanar].flatMap(([key,row])=>row.contact&&!exactArea.has(key)?[row as ContactRow]:[]),
  ];
  for(const row of rows){
    const triangles=[row.a,row.b] as const;
    const indices=row.contact.points.map(p=>{
      const position=pointNumber(p);
      return vertex(position,()=>mint('cut',minted++),()=>seamAttributes(sides[0],row.a,p));
    });
    for(let s=0;s<2;s++){
      for(const index of indices)place(sides[s],triangles[s],index);
      if(row.contact.kind==='segment')addCut(sides[s],triangles[s],indices[0],indices[1]);
      if(row.contact.kind==='area'){
        for(let k=0;k<indices.length;k++)addCut(sides[s],triangles[s],indices[k],indices[(k+1)%indices.length]);
        const other=sides[1-s].normals[triangles[1-s]];
        let list=sides[s].overlaps.get(triangles[s]);if(!list){list=[];sides[s].overlaps.set(triangles[s],list);}
        list.push({polygon:indices,normal:other});
      }
    }
  }

  const scale=Math.max(1e-300,...bothBounds(sides).map(b=>b[3]-b[0]+b[4]-b[1]+b[5]-b[2]));
  const solids=sides.map((_,s)=>solid3(sides[1-s],positions));

  // Cut every touched triangle, then keep the patches this operation wants.
  const faces:SurfaceFace3[]=[],triangles:SurfaceTriangle3[]=[];
  const emit=(face:SurfaceFace3,parts:readonly (readonly number[])[]):void=>{
    const index=faces.length;faces.push(face);
    for(const vertices of parts)triangles.push({face:index,vertices:vertices as readonly [number,number,number]});
  };
  for(let s=0;s<2;s++){
    const side=sides[s],keep=new Set<Placement>(KEEP[operation][s]),flip=operation==='subtract'&&s===1;
    const byFace=side.surface.faces.map(()=>[] as number[]);
    side.surface.triangles.forEach((t,i)=>byFace[t.face].push(i));
    for(let f=0;f<side.surface.faces.length;f++){
      const source=side.surface.faces[f],own=byFace[f];
      // `cut` accumulates: a face that came out of an earlier operation's seam
      // is still on a seam, so a chain of operations answers every one of them.
      const was=source.attributes.cut===true;
      const cuts=own.map(i=>cutTriangle(side,i,positions,edgePoints,operation));
      if(cuts.every(c=>c.whole)){
        // Nothing reached this face: it stays one face, with its identity.
        if(!keep.has(place3(side,own[0],centroid(side.corners[own[0]].map(v=>positions[v])),positions,solids[s],scale)))continue;
        emit({
          id:faceId(s,source.id,mint),vertices:oriented(source.vertices.map(v=>side.vertices[v]),flip),
          attributes:{...clone(source.attributes),cut:was},...(s===0?{}:{provenance:{operation,parents:[source.id]}}),
        },own.map(i=>oriented(side.corners[i],flip)));
        continue;
      }
      // A cut face is replaced by its pieces: one triangular face each, so the
      // result keeps one fixed triangle per polygon and no Steiner points.
      let n=0;
      for(let k=0;k<own.length;k++)for(const piece of cuts[k].parts){
        if(!keep.has(place3(side,own[k],centroid(piece.vertices.map(v=>positions[v])),positions,solids[s],scale)))continue;
        const vertices=oriented(piece.vertices,flip);
        emit({id:mint('piece',faceId(s,source.id,mint),n++),vertices,attributes:{...clone(source.attributes),cut:piece.cut||was},provenance:{operation,parents:[source.id]}},[vertices]);
      }
    }
  }

  // Only the vertices the kept faces use, in first-seen order.
  const used=new Map<number,number>(),points:SurfacePoint3[]=[];
  const remap=(v:number):number=>{
    let index=used.get(v);
    if(index===undefined){index=points.length;used.set(v,index);points.push({id:ids[v],position:positions[v],attributes:attributes[v]});}
    return index;
  };
  const outFaces=faces.map(f=>({...f,vertices:f.vertices.map(remap)}));
  const outTriangles=triangles.map(t=>({face:t.face,vertices:t.vertices.map(v=>used.get(v)!) as unknown as readonly [number,number,number]}));
  let result:Surface3;
  try{result=assembleSurface3(points,outFaces,outTriangles);}
  catch(error){throw new Error(`${operation}: the result is not a manifold surface (${(error as Error).message})`);}
  const open=openEdgeCount(result);
  if(open)throw new Error(`${operation}: the result is not a closed surface (${open} boundary edges)`);
  return result;
}

type ContactRow={readonly a:number;readonly b:number;readonly contact:TriangleContact3};
type CoplanarRow={readonly a:number;readonly b:number;readonly contact:TriangleContact3|null};
const pairKey=(a:number,b:number)=>`${a}:${b}`;

/** Pairs of triangles, first solid then second, that lie in one plane to
 * within the weld: every corner of one of them is within the weld of the
 * other's plane. A cone set on a sphere's facet by its sampled normal is such
 * a pair — the rotation that stands it on the facet leaves its base an ulp
 * off the facet's plane, and the exact kernel then reports a seam at an ulp of
 * tilt that no classification can read. By the rule the weld already states
 * (what the solids mean to share, they share), the two lie in one plane, and
 * each pair answers its overlap, `coplanarContact3` in the first's own exact
 * plane. The answer is null for a pair that lies side by side without
 * overlapping. */
function coplanarOverlaps(sides:readonly Side[],weld:number):Map<string,CoplanarRow> {
  const [left,right]=[sides[0].prepared,sides[1].prepared],out=new Map<string,CoplanarRow>();
  for(let i=0;i<left.bounds.length;i++){
    const b=left.bounds[i],grown=[b[0]-weld,b[1]-weld,b[2]-weld,b[3]+weld,b[4]+weld,b[5]+weld] as unknown as WorldBounds3;
    for(const j of right.index.query(grown)){
      // Two triangles with planes, one within the weld of the other's.
      if(!hasPlane(left.corners,9*i)||!hasPlane(right.corners,9*j))continue;
      if(!withinPlane(right.corners,9*j,left.corners,9*i,weld)&&!withinPlane(left.corners,9*i,right.corners,9*j,weld))continue;
      out.set(pairKey(i,j),{a:i,b:j,contact:coplanarContact3(bindingTriangle3(sides[0].binding,i),bindingTriangle3(sides[1].binding,j),left.planes[i])});
    }
  }
  return out;
}
/** Whether a triangle, read from a nine-double corner row, has a plane. */
function hasPlane(corners:Float64Array,q:number):boolean {
  const a:Vec3=[corners[q],corners[q+1],corners[q+2]],b:Vec3=[corners[q+3],corners[q+4],corners[q+5]],c:Vec3=[corners[q+6],corners[q+7],corners[q+8]];
  return Math.hypot(...cross3(sub3(b,a),sub3(c,a)))>0;
}
/** Whether all three corners of one triangle lie within `weld` of the plane of
 * another, both read from nine-double corner rows. */
function withinPlane(points:Float64Array,p:number,plane:Float64Array,q:number,weld:number):boolean {
  const a:Vec3=[plane[q],plane[q+1],plane[q+2]],b:Vec3=[plane[q+3],plane[q+4],plane[q+5]],c:Vec3=[plane[q+6],plane[q+7],plane[q+8]];
  const n=cross3(sub3(b,a),sub3(c,a)),length=Math.hypot(...n);
  if(!(length>0))return false;
  for(let k=0;k<3;k++)if(Math.abs(dot3(n,sub3([points[p+3*k],points[p+3*k+1],points[p+3*k+2]],a)))>weld*length)return false;
  return true;
}
const clone=(attrs:Attributes3):Attributes3=>Object.fromEntries(Object.entries(attrs).map(([k,v])=>[k,Array.isArray(v)?[...v]:v]));
const faceId=(side:number,id:string,mint:(...parts:(string|number)[])=>string)=>side===0?id:mint('b',id);
const oriented=(vertices:readonly number[],flip:boolean):readonly number[]=>flip?[...vertices].reverse():vertices;
const centroid=(points:readonly Vec3[]):Vec3=>mul3(points.reduce((a,b)=>add3(a,b),[0,0,0] as Vec3),1/points.length);
function bothBounds(sides:readonly Side[]):WorldBounds3[]{return sides.map(s=>worldBounds3(s.surface.points.map(p=>p.position)));}

/** A new seam vertex takes its columns from the first solid's triangle, by the
 * exact barycentric weights of the point on it: a numeric column is blended,
 * anything else comes from the nearest corner. */
function seamAttributes(side:Side,triangle:number,exact:H):Attributes3 {
  const weights=triangleWeights(bindingTriangle3(side.binding,triangle),exact);
  const corners=side.surface.triangles[triangle]?.vertices;
  if(!weights||!corners)return {};
  const total=Number(weights[0]+weights[1]+weights[2]);
  if(!(total>0))return {};
  const w=weights.map(n=>Number(n)/total),rows=corners.map(v=>side.surface.points[v].attributes);
  let nearest=0;for(let k=1;k<3;k++)if(w[k]>w[nearest])nearest=k;
  const out:Attributes3={};
  for(const name of new Set(rows.flatMap(r=>Object.keys(r)))){
    const values=rows.map(r=>r[name]);
    if(values.every(v=>typeof v==='number'))out[name]=(values as number[]).reduce((sum,v,k)=>sum+v*w[k],0);
    else if(values.every(v=>Array.isArray(v)&&v.length===(values[0] as readonly number[]).length))out[name]=(values[0] as readonly number[]).map((_,i)=>(values as unknown as readonly (readonly number[])[]).reduce((sum,v,k)=>sum+v[i]*w[k],0));
    else if(values[nearest]!==undefined)out[name]=Array.isArray(values[nearest])?[...values[nearest] as readonly number[]]:values[nearest] as Attribute3;
  }
  return out;
}

/** The parts one source triangle becomes. `whole` means nothing touched it. */
interface CutTriangle {readonly whole:boolean;readonly parts:readonly {vertices:readonly number[];cut:boolean}[]}

function cutTriangle(side:Side,triangle:number,positions:readonly Vec3[],edgePoints:ReadonlyMap<string,Set<number>>,operation:string):CutTriangle {
  const corners=side.corners[triangle],interior=side.interior.get(triangle),cuts=side.cuts.get(triangle)??[];
  const rims=[0,1,2].map(k=>[...edgePoints.get(ekey(corners[k],corners[(k+1)%3]))??[]]);
  const extra=rims.some(r=>r.length)||(interior?.size??0)>0;
  // A triangle nothing reached is still a piece of a face its neighbours cut.
  const untouched={whole:true,parts:[{vertices:corners,cut:false}]};
  if(!extra&&!cuts.length)return untouched;
  const normal=side.normals[triangle];
  if(!Math.hypot(...normal))return untouched;
  // Project along the dominant axis, swapping the kept axes when that flips
  // the sheet, so a counterclockwise loop in the plane winds like the triangle.
  let drop=0;for(let k=1;k<3;k++)if(Math.abs(normal[k])>Math.abs(normal[drop]))drop=k;
  const axes=normal[drop]>0?[(drop+1)%3,(drop+2)%3]:[(drop+2)%3,(drop+1)%3];
  const local:number[]=[],index=new Map<number,number>();
  const at=(v:number):number=>{let i=index.get(v);if(i===undefined){i=local.length;local.push(v);index.set(v,i);}return i;};
  const boundary:number[]=[];
  for(let k=0;k<3;k++){
    boundary.push(at(corners[k]));
    const from=positions[corners[k]],along=sub3(positions[corners[(k+1)%3]],from);
    for(const p of rims[k].slice().sort((a,b)=>dot3(sub3(positions[a],from),along)-dot3(sub3(positions[b],from),along)))boundary.push(at(p));
  }
  for(const p of interior??[])at(p);
  const constraints=cuts.map(([a,b])=>[at(a),at(b)] as const);
  const inner=local.map((_,i)=>i).slice(boundary.length);
  const xy=local.map(v=>[positions[v][axes[0]],positions[v][axes[1]]] as Vec2);
  let mesh;
  try{mesh=planarMesh(xy,boundary,inner,constraints);}
  catch(error){throw new Error(`${operation}: a cut triangle could not be retriangulated along the seam — ${(error as Error).message} (${boundary.length} points on the rim, ${inner.length} inside, ${constraints.length} cut segments)`);}
  return {whole:false,parts:mesh.triangles.map(t=>({
    vertices:t.map(i=>local[i]),
    cut:[0,1,2].some(k=>mesh.seam.has(ekey(t[k],t[(k+1)%3]))),
  }))};
}

/** A constrained triangulation of one source triangle in its own plane: the
 * boundary loop (its corners plus whatever the neighbouring triangles placed on
 * the shared edges), the points inside it, and the seam segments that must come
 * out as edges. Counts are tiny — a handful of points per triangle — so every
 * step is the plain quadratic one, with a cap instead of a convergence proof. */
function planarMesh(xy:readonly Vec2[],boundary:readonly number[],interior:readonly number[],constraints:readonly (readonly [number,number])[]):{triangles:[number,number,number][];seam:Set<string>} {
  const extent=Math.max(1e-300,...xy.map(p=>Math.abs(p[0])),...xy.map(p=>Math.abs(p[1])));
  const span=(a:Vec2,b:Vec2)=>Math.max(1e-300,Math.hypot(b[0]-a[0],b[1]-a[1]));
  /** Left, on, or right of the directed line, judged by distance, not by area. */
  const side=(a:number,b:number,c:number):number=>{
    const d=turn2(xy[a],xy[b],xy[c]);
    return Math.abs(d)<=1e-9*extent*span(xy[a],xy[b])?0:Math.sign(d);
  };
  let triangles:[number,number,number][]=[];
  // The boundary loop first: it is the triangle with collinear points added, so
  // clipping only strictly convex ears empties it.
  const loop=[...boundary];
  let guard=0;
  while(loop.length>3){
    if(++guard>4*boundary.length*boundary.length)throw new Error('rim clipping did not finish');
    let clipped=false;
    for(let i=0;i<loop.length;i++){
      const a=loop[(i+loop.length-1)%loop.length],b=loop[i],c=loop[(i+1)%loop.length];
      if(side(a,b,c)<=0)continue;
      if(loop.some(p=>p!==a&&p!==b&&p!==c&&side(a,b,p)>=0&&side(b,c,p)>=0&&side(c,a,p)>=0))continue;
      triangles.push([a,b,c]);loop.splice(i,1);clipped=true;break;
    }
    if(!clipped)throw new Error('no rim ear');
  }
  if(loop.length<3)throw new Error('rim collapsed');
  if(side(loop[0],loop[1],loop[2])<=0)throw new Error('rim is not wound the right way');
  triangles.push([loop[0],loop[1],loop[2]]);

  const edges=():Map<string,number[]>=>{
    const map=new Map<string,number[]>();
    triangles.forEach((t,i)=>{for(let k=0;k<3;k++){const key=ekey(t[k],t[(k+1)%3]),list=map.get(key);if(list)list.push(i);else map.set(key,[i]);}});
    return map;
  };
  for(const p of interior){
    let best=-1,edge=-1,score=-Infinity;
    for(let i=0;i<triangles.length;i++){
      const t=triangles[i],s=[side(t[0],t[1],p),side(t[1],t[2],p),side(t[2],t[0],p)];
      const worst=Math.min(...s);
      if(worst>score){score=worst;best=i;edge=s.indexOf(0);}
    }
    if(best<0||score<0)throw new Error(`inner point ${p} is outside the rim (${score})`);
    const t=triangles[best];
    if(edge<0||score>0){
      triangles.splice(best,1);
      triangles.push([t[0],t[1],p],[t[1],t[2],p],[t[2],t[0],p]);
    }else{
      const u=t[edge],v=t[(edge+1)%3],w=t[(edge+2)%3],neighbours=(edges().get(ekey(u,v))??[]).filter(i=>i!==best);
      const other=neighbours.length?triangles[neighbours[0]]:undefined;
      const k=other?other.findIndex((x,i)=>x===v&&other[(i+1)%3]===u):-1;
      if(other&&k<0)throw new Error('inner point on an edge with mismatched winding');
      const remove=new Set([best,...neighbours]);
      triangles=triangles.filter((_,i)=>!remove.has(i));
      triangles.push([u,p,w],[p,v,w]);
      if(other)triangles.push([v,p,other[(k+2)%3]],[p,u,other[(k+2)%3]]);
    }
  }
  legalize(triangles,xy,edges,side);

  // Recover every seam segment as a chain of edges. A point that lies on the
  // segment splits it; a segment across the triangulation flips its way in.
  const seam=new Set<string>();
  const has=(a:number,b:number)=>triangles.some(t=>[0,1,2].some(k=>ekey(t[k],t[(k+1)%3])===ekey(a,b)));
  const between=(a:number,b:number):number=>{
    for(let p=0;p<xy.length;p++){
      if(p===a||p===b||side(a,b,p)!==0)continue;
      const dx=xy[b][0]-xy[a][0],dy=xy[b][1]-xy[a][1];
      const along=((xy[p][0]-xy[a][0])*dx+(xy[p][1]-xy[a][1])*dy)/(dx*dx+dy*dy);
      if(along>1e-9&&along<1-1e-9)return p;
    }
    return -1;
  };
  const pending=constraints.map(([a,b])=>[a,b] as [number,number]);
  let work=0;
  while(pending.length){
    if(++work>64+64*xy.length*xy.length)throw new Error('seam recovery did not finish');
    const [a,b]=pending.pop()!;
    if(a===b)continue;
    const middle=between(a,b);
    if(middle>=0){pending.push([a,middle],[middle,b]);continue;}
    if(has(a,b)){seam.add(ekey(a,b));continue;}
    if(!recover(a,b,triangles,xy,edges,side))throw new Error(`seam segment ${a}-${b} could not be recovered`);
    seam.add(ekey(a,b));
  }
  return {triangles,seam};
}

/** A flip of the two triangles across one interior edge, when the quadrilateral
 * they make is strictly convex. Returns false when it is not. */
function flipEdge(triangles:[number,number,number][],pair:readonly number[],key:string,side:(a:number,b:number,c:number)=>number):boolean {
  const [i,j]=pair,t=triangles[i],o=triangles[j];
  const k=[0,1,2].find(k=>ekey(t[k],t[(k+1)%3])===key)!,u=t[k],v=t[(k+1)%3],p=t[(k+2)%3];
  const q=o.find(x=>x!==u&&x!==v);
  if(q===undefined)return false;
  if(side(u,q,p)<=0||side(q,v,p)<=0)return false;
  triangles[i]=[u,q,p];triangles[j]=[q,v,p];
  return true;
}

/** Flip toward a Delaunay triangulation, for patches that are not slivers.
 * Quality only: a capped number of passes, and a wrong flip cannot break the
 * topology because only strictly convex quadrilaterals flip. */
function legalize(triangles:[number,number,number][],xy:readonly Vec2[],edges:()=>Map<string,number[]>,side:(a:number,b:number,c:number)=>number):void {
  for(let pass=0;pass<8*triangles.length+8;pass++){
    let changed=false;
    for(const [key,pair] of edges()){
      if(pair.length!==2)continue;
      const t=triangles[pair[0]],k=[0,1,2].find(k=>ekey(t[k],t[(k+1)%3])===key)!;
      const u=t[k],v=t[(k+1)%3],p=t[(k+2)%3],q=triangles[pair[1]].find(x=>x!==u&&x!==v);
      if(q===undefined)continue;
      if(inCircle(xy[u],xy[v],xy[p],xy[q])<=0)continue;
      if(flipEdge(triangles,pair,key,side)){changed=true;break;}
    }
    if(!changed)return;
  }
}
/** Positive when d lies inside the circle through the counterclockwise a, b, c. */
function inCircle(a:Vec2,b:Vec2,c:Vec2,d:Vec2):number {
  const ax=a[0]-d[0],ay=a[1]-d[1],bx=b[0]-d[0],by=b[1]-d[1],cx=c[0]-d[0],cy=c[1]-d[1];
  const sign=turn2(a,b,c)>0?1:-1;
  return sign*((ax*ax+ay*ay)*(bx*cy-by*cx)-(bx*bx+by*by)*(ax*cy-ay*cx)+(cx*cx+cy*cy)*(ax*by-ay*bx));
}

/** Flip the edges that cross a seam segment until the segment itself is one. */
function recover(a:number,b:number,triangles:[number,number,number][],xy:readonly Vec2[],edges:()=>Map<string,number[]>,side:(a:number,b:number,c:number)=>number):boolean {
  for(let guard=0;guard<32+8*triangles.length*triangles.length;guard++){
    let crossed=false;
    for(const [key,pair] of edges()){
      if(pair.length!==2)continue;
      const [u,v]=key.split(':').map(Number);
      if(u===a||u===b||v===a||v===b)continue;
      if(!(side(a,b,u)*side(a,b,v)<0&&side(u,v,a)*side(u,v,b)<0))continue;
      crossed=true;
      if(flipEdge(triangles,pair,key,side))break;
    }
    if(!crossed)return triangles.some(t=>[0,1,2].some(k=>ekey(t[k],t[(k+1)%3])===ekey(a,b)));
  }
  return false;
}

/** The other solid, ready to answer "is this point inside you". */
interface Solid {readonly triangles:readonly (readonly Vec3[])[];readonly prepared:PreparedIntersectionSource3}
function solid3(other:Side,positions:readonly Vec3[]):Solid {
  return {triangles:other.corners.map(c=>c.map(v=>positions[v])),prepared:other.prepared};
}
/** Deterministic ray directions: the first that meets no triangle edge or
 * vertex decides. Every sketch with the same input asks in the same order. */
const DIRECTIONS:readonly Vec3[]=Object.freeze([[0.5257311121191336,0.8506508083520399,0.13],[0.3,-0.61,0.7331],[-0.77,0.19,0.6083],[0.13,0.6,-0.7889],[-0.41,-0.73,-0.5449],[0.91,-0.23,0.3441]].map(v=>{const l=Math.hypot(...v as [number,number,number]);return Object.freeze(v.map(n=>n/l)) as unknown as Vec3;}));

function place3(side:Side,triangle:number,centre:Vec3,positions:readonly Vec3[],solid:Solid,scale:number):Placement {
  const overlaps=side.overlaps.get(triangle);
  if(overlaps){
    const normal=side.normals[triangle];
    let drop=0;for(let k=1;k<3;k++)if(Math.abs(normal[k])>Math.abs(normal[drop]))drop=k;
    const axes=[(drop+1)%3,(drop+2)%3];
    for(const overlap of overlaps){
      const loop=overlap.polygon.map(v=>[positions[v][axes[0]],positions[v][axes[1]]] as Vec2);
      if(inPolygon([centre[axes[0]],centre[axes[1]]],loop))return dot3(normal,overlap.normal)>=0?ON_SAME:ON_OPPOSITE;
    }
  }
  return insideSolid(centre,solid,scale)?INSIDE:OUTSIDE;
}
function inPolygon(p:Vec2,loop:readonly Vec2[]):boolean {
  let inside=false;
  for(let i=0,j=loop.length-1;i<loop.length;j=i++){
    const a=loop[i],b=loop[j];
    if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
  }
  return inside;
}
/** Ray parity through the other solid. A ray that grazes an edge or a vertex
 * answers nothing, so the next direction is tried; when every direction grazes,
 * the winding number answers instead. */
function insideSolid(point:Vec3,solid:Solid,scale:number):boolean {
  if(!solid.triangles.length)return false;
  for(const direction of DIRECTIONS){
    const far=add3(point,mul3(direction,4*scale+1));
    const bounds=worldBounds3([point,far]);
    let crossings=0,certain=true;
    for(const i of solid.prepared.index.query(bounds)){
      const hit=rayTriangle(point,direction,solid.triangles[i],scale);
      if(hit===null){certain=false;break;}
      crossings+=hit;
    }
    if(certain)return (crossings&1)===1;
  }
  return Math.abs(windingNumber(point,solid.triangles))>0.5;
}
/** 1, 0, or null when the ray passes too close to an edge to be believed. */
function rayTriangle(origin:Vec3,direction:Vec3,triangle:readonly Vec3[],scale:number):number|null {
  const [a,b,c]=triangle,e1=sub3(b,a),e2=sub3(c,a),pv=cross3(direction,e2),det=dot3(e1,pv);
  const size=Math.hypot(...e1)*Math.hypot(...e2);
  if(!(size>0))return 0;
  if(Math.abs(det)<=1e-12*size)return null;
  const inverse=1/det,tv=sub3(origin,a),u=dot3(tv,pv)*inverse,qv=cross3(tv,e1),v=dot3(direction,qv)*inverse,t=dot3(e2,qv)*inverse;
  const edge=Math.min(u,v,1-u-v);
  if(edge<-1e-9)return 0;
  if(edge<1e-9)return null;
  if(Math.abs(t)<=1e-9*scale)return null;
  return t>0?1:0;
}
/** Solid angle sum over the closed surface: about 1 inside, about 0 outside. */
function windingNumber(point:Vec3,triangles:readonly (readonly Vec3[])[]):number {
  let total=0;
  for(const [a,b,c] of triangles){
    const va=sub3(a,point),vb=sub3(b,point),vc=sub3(c,point);
    const la=Math.hypot(...va),lb=Math.hypot(...vb),lc=Math.hypot(...vc);
    const numerator=dot3(va,cross3(vb,vc));
    const denominator=la*lb*lc+dot3(va,vb)*lc+dot3(vb,vc)*la+dot3(vc,va)*lb;
    if(la===0||lb===0||lc===0)return 1;
    total+=2*Math.atan2(numerator,denominator);
  }
  return total/(4*Math.PI);
}
