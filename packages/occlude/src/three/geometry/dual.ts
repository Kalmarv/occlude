import {add3,centroid3,dot3,mul3,type Vec3} from '../math.js';
import {triangulate} from './surface.js';
import {cornerNames3,checkMade3,faceEdges3,kernelColumn,pairKey,type Made3,type Mesh3} from './mesh3.js';
import {kindOf,type AnyColumn} from '../../column.js';
import {emptySize} from '../degenerate.js';

export interface DualOptions {
  /** Push every dual point out to this radius from the origin. A geodesic
   * projected this way is the Goldberg polyhedron. */
  readonly project?:number;
}
/** Newell's normal: the area vector of a polygon, planar or not. */
function areaVector(positions:readonly Vec3[]):Vec3 {
  let normal:Vec3=[0,0,0];
  for(let i=0;i<positions.length;i++){
    const a=positions[i],b=positions[(i+1)%positions.length];
    normal=add3(normal,[ (a[1]-b[1])*(a[2]+b[2]), (a[2]-b[2])*(a[0]+b[0]), (a[0]-b[0])*(a[1]+b[1]) ]);
  }
  return normal;
}
/** Nothing: the dual of a value with no ring to walk. */
const NOTHING:Made3=Object.freeze({x:[],y:[],z:[],names:{points:[],edges:[],faces:[],corners:[]},loops:[],triangles:[],edges:[]});
/** Each column of `cols` that `keep` accepts, on the rows `rows`. */
const columnsOn=(cols:Readonly<Record<string,AnyColumn>>,rows:readonly number[],keep:(column:AnyColumn)=>boolean):Record<string,AnyColumn>=>
  Object.fromEntries(Object.entries(cols).filter(([,column])=>keep(column)).map(([name,column])=>[name,column.keep(rows)]));
/** A column of numbers or of numeric vectors: what a face column may become
 * as a point column. */
const numeric=(column:AnyColumn):boolean=>{const kind=kindOf(column).name;return kind==='number'||kind==='vector';};
/** The dual: one point per face, one face per vertex.
 *
 * A vertex's dual face walks the faces around it, so a closed surface duals to
 * a closed surface — a cube to an octahedron, a geodesic polyhedron to its
 * Goldberg. A vertex on a boundary has no ring to walk and gets no face, so an
 * open mesh loses its rim rather than failing. Numeric face columns become
 * point columns, and point columns face columns. */
export function dualMesh3(mesh:Mesh3,options:DualOptions={}):Made3 {
  if(!mesh.faceCount)return NOTHING;
  if(options.project!==undefined&&emptySize(options.project))return NOTHING;
  const positions=mesh.positions,loops=mesh.loops;
  const faceCentre=loops.map(loop=>centroid3(loop.map(v=>positions[v])));
  const faceNormal=loops.map(loop=>areaVector(loop.map(v=>positions[v])));
  const radius=options.project;
  const placed=faceCentre.map(p=>{
    if(radius===undefined)return p;
    const length=Math.hypot(...p);
    // A face centred on the origin has no direction to be pushed along; it
    // stays where it is rather than becoming a non-finite point.
    return length>0?mul3(p,radius/length):p;
  });
  const edgeAt=new Map<number,number>();
  for(let e=0;e<mesh.edgeCount;e++)edgeAt.set(pairKey(mesh.edges[2*e],mesh.edges[2*e+1]),e);
  const edgeFaces=mesh.edgeFaces,around=mesh.pointFaces;
  const polygons:number[][]=[],owners:number[]=[];
  for(let v=0;v<mesh.n;v++){
    const incident=around[v];
    if(incident.length<3)continue;
    const ring:number[]=[];
    let face=incident[0],closed=false;
    for(let step=0;step<=incident.length;step++){
      ring.push(face);
      const vertices=loops[face],at=vertices.indexOf(v);
      const e=edgeAt.get(pairKey(v,vertices[(at+1)%vertices.length])),faces=e===undefined?undefined:edgeFaces[e];
      // A rim edge has one face: the walk cannot close, so this vertex has no
      // dual face and the rest of the mesh still duals.
      if(!faces||faces.length!==2)break;
      face=faces[0]===face?faces[1]:faces[0];
      if(face===ring[0]){closed=true;break;}
    }
    if(!closed||ring.length!==incident.length)continue;
    // Wind the dual face with the vertex it belongs to, so a consistently
    // wound source duals to a consistently wound result.
    const outward=incident.reduce((sum,f)=>add3(sum,faceNormal[f]),[0,0,0] as Vec3);
    const loop=dot3(areaVector(ring.map(f=>placed[f])),outward)<0?[...ring].reverse():ring;
    polygons.push(loop);owners.push(v);
  }
  if(!polygons.length)return NOTHING;
  // A face nobody's ring reached contributes no point: an open mesh keeps only
  // the dual it actually has.
  const used=[...new Set(polygons.flat())].sort((a,b)=>a-b);
  const at=new Map(used.map((f,i)=>[f,i]));
  const names=mesh.names;
  const points=used.map(f=>placed[f]);
  const dualLoops=polygons.map(loop=>loop.map(f=>at.get(f)!));
  const pointNames=used.map(f=>`dual:${names.faces[f]}`),faceNames=owners.map(v=>`dual:${names.points[v]}`);
  const edges=faceEdges3(dualLoops,pointNames);
  const made:Made3={
    x:points.map(p=>p[0]),y:points.map(p=>p[1]),z:points.map(p=>p[2]),
    names:{points:pointNames,edges:edges.names,faces:faceNames,corners:cornerNames3(dualLoops,faceNames,pointNames)},
    loops:dualLoops,
    // The ordinary ear clipping decides the triangles, in each face's own
    // average plane: a projected Goldberg's hexagons are not exactly planar,
    // and they are drawn as the triangles that plane gives.
    triangles:dualLoops.map(loop=>triangulate(points,loop).flatMap(t=>t.map(v=>loop.indexOf(v)))),
    edges:edges.edges,
    cols:{points:columnsOn(mesh.cols.faces,used,numeric),faces:columnsOn(mesh.cols.points,owners,kernelColumn)},
    lineage:{
      points:used.map(f=>({operation:'dual',parents:[names.faces[f]]})),
      faces:owners.map(v=>({operation:'dual',parents:[names.points[v]]})),
    },
  };
  checkMade3(made);
  return made;
}
