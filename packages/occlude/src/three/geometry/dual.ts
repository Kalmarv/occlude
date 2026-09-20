import {add3,cross3,dot3,mul3,sub3,type Vec3} from '../math.js';
import {assembleSurface3,surface3,type Attributes3,type Surface3,type SurfaceFace3,type SurfacePoint3} from './surface.js';
import {emptySize} from '../degenerate.js';

export interface DualOptions {
  /** Push every dual point out to this radius from the origin. A geodesic
   * projected this way is the Goldberg polyhedron. */
  readonly project?:number;
}
const centroid=(positions:readonly Vec3[]):Vec3=>mul3(positions.reduce((sum,p)=>add3(sum,p),[0,0,0] as Vec3),1/positions.length);
/** Newell's normal: the area vector of a polygon, planar or not. */
function areaVector(positions:readonly Vec3[]):Vec3 {
  let normal:Vec3=[0,0,0];
  for(let i=0;i<positions.length;i++){
    const a=positions[i],b=positions[(i+1)%positions.length];
    normal=add3(normal,[ (a[1]-b[1])*(a[2]+b[2]), (a[2]-b[2])*(a[0]+b[0]), (a[0]-b[0])*(a[1]+b[1]) ]);
  }
  return normal;
}
/** The dual surface: one point per face, one face per vertex.
 *
 * A vertex's dual face walks the faces around it, so a closed surface duals to
 * a closed surface — a cube to an octahedron, a geodesic polyhedron to its
 * Goldberg. A vertex on a boundary has no ring to walk and gets no face, so an
 * open mesh loses its rim rather than failing. */
export function dualSurface3(surface:Surface3,options:DualOptions={}):Surface3 {
  if(!surface.faces.length)return surface3([],[]);
  if(options.project!==undefined&&emptySize(options.project))return surface3([],[]);
  const positions=surface.points.map(p=>p.position);
  const faceCentre=surface.faces.map(f=>centroid(f.vertices.map(v=>positions[v])));
  const faceNormal=surface.faces.map(f=>areaVector(f.vertices.map(v=>positions[v])));
  const radius=options.project;
  const placed=faceCentre.map(p=>{
    if(radius===undefined)return p;
    const length=Math.hypot(...p);
    // A face centred on the origin has no direction to be pushed along; it
    // stays where it is rather than becoming a non-finite point.
    return length>0?mul3(p,radius/length):p;
  });
  const edgeAt=new Map<string,number>();
  surface.edges.forEach((edge,i)=>edgeAt.set(`${edge.vertices[0]}:${edge.vertices[1]}`,i));
  const key=(a:number,b:number):string=>a<b?`${a}:${b}`:`${b}:${a}`;
  const around:number[][]=surface.points.map(()=>[]);
  surface.faces.forEach((face,f)=>{for(const v of face.vertices)around[v].push(f);});
  const polygons:number[][]=[],owners:number[]=[];
  for(let v=0;v<surface.points.length;v++){
    const incident=around[v];
    if(incident.length<3)continue;
    const ring:number[]=[];
    let face=incident[0],closed=false;
    for(let step=0;step<=incident.length;step++){
      ring.push(face);
      const vertices=surface.faces[face].vertices,at=vertices.indexOf(v);
      const next=vertices[(at+1)%vertices.length],edge=surface.edges[edgeAt.get(key(v,next))!];
      // A rim edge has one face: the walk cannot close, so this vertex has no
      // dual face and the rest of the mesh still duals.
      if(!edge||edge.faces.length!==2)break;
      face=edge.faces[0]===face?edge.faces[1]:edge.faces[0];
      if(face===ring[0]){closed=true;break;}
    }
    if(!closed||ring.length!==incident.length)continue;
    // Wind the dual face with the vertex it belongs to, so a consistently
    // wound source duals to a consistently wound result.
    const outward=incident.reduce((sum,f)=>add3(sum,faceNormal[f]),[0,0,0] as Vec3);
    const loop=dot3(areaVector(ring.map(f=>placed[f])),outward)<0?[...ring].reverse():ring;
    polygons.push(loop);owners.push(v);
  }
  if(!polygons.length)return surface3([],[]);
  // A face nobody's ring reached contributes no point: an open mesh keeps only
  // the dual it actually has.
  const used=[...new Set(polygons.flat())].sort((a,b)=>a-b);
  const at=new Map(used.map((f,i)=>[f,i]));
  const numeric=(attributes:Attributes3):Attributes3=>Object.fromEntries(Object.entries(attributes).filter(([,value])=>typeof value==='number'||Array.isArray(value)&&value.every(n=>typeof n==='number')));
  const points:SurfacePoint3[]=used.map(f=>({id:`dual:${surface.faces[f].id}`,position:placed[f],attributes:numeric(surface.faces[f].attributes)}));
  const faces:SurfaceFace3[]=polygons.map((loop,i)=>({id:`dual:${surface.points[owners[i]].id}`,vertices:loop.map(f=>at.get(f)!),attributes:{...surface.points[owners[i]].attributes}}));
  // The ordinary ear clipping decides the triangles, in each face's own average
  // plane: a projected Goldberg's hexagons are not exactly planar, and they are
  // drawn as the triangles that plane gives.
  const triangulated=surface3(points.map(p=>p.position),faces.map(f=>f.vertices));
  return assembleSurface3(points,faces,triangulated.triangles);
}
