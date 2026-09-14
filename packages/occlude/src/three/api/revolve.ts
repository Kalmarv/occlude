import {chartSurface3,arcParameters3,profileCoordinates3,type SurfaceUV} from '../geometry/coordinates.js';
import {surface3,assembleSurface3,type Attributes3,type SurfacePoint3,type SurfaceFace3} from '../geometry/surface.js';
import {Mesh,CurveGeometry,type EdgeAttributes,type GeometryOptions} from './mesh.js';
import {curvePath,constructionBudget,constructionCapBudget,type ConstructionBudget} from './curveTopology.js';
import type {Vec3} from '../math.js';
export interface RevolveOptions extends GeometryOptions,ConstructionBudget {
  readonly segments?:number;
  /** Signed sweep in degrees, nonzero and at most a full turn. */
  readonly angle?:number;
  /** Close angular cuts for a partial turn of a closed profile. Default false. */
  readonly caps?:boolean;
}
/** Revolve an XZ meridian in x>=0 around Z. Point columns follow the profile;
 * side faces inherit profile edge columns, while angular caps have no columns. */
export function revolve<P extends Attributes3,E extends EdgeAttributes>(profile:CurveGeometry<P,E>,options:RevolveOptions={}):Mesh<P,{},Partial<E>&Attributes3,SurfaceUV> {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('revolve options must be an object');
  const path=curvePath(profile),angle=options.angle??360,n=options.segments??32,full=Math.abs(angle)===360;
  if(!Number.isFinite(angle)||angle===0||Math.abs(angle)>360)throw new Error('revolve angle must be nonzero and within -360 to 360 degrees');
  if(!Number.isSafeInteger(n)||n<1||Math.abs(angle)/n>=180)throw new Error('revolve needs integer segments with each angular step smaller than 180 degrees');
  if(options.caps!==undefined&&typeof options.caps!=='boolean')throw new Error('revolve caps must be boolean');
  const caps=options.caps===true&&!full;
  if(caps&&!path.closed)throw new Error('revolve angular caps require a closed profile');
  const source=profile.surface,anchorZ=source.points[0].position[2],extent=source.points.reduce((m,p)=>Math.max(m,Math.abs(p.position[0]),Math.abs(p.position[2]-anchorZ)),0);
  if(source.points.some(p=>p.position[0]<0||Math.abs(p.position[1])>extent*1e-10))throw new Error('revolve profile must lie in the XZ meridian with x >= 0');
  const axis=(i:number)=>source.points[i].position[0]===0&&source.points[i].position[1]===0;
  const usedEdges=path.edges.filter(i=>!source.edges[i].vertices.every(axis)),edgeSet=new Set(usedEdges);
  if(!usedEdges.length)throw new Error('revolve profile lies entirely on the axis');
  const used=new Set(usedEdges.flatMap(i=>source.edges[i].vertices));
  for(let i=0;i<path.points.length;i++){
    const p=path.points[i];if(!axis(p))continue;
    const before=path.points[(i+path.points.length-1)%path.points.length],after=path.points[(i+1)%path.points.length];
    if((path.closed||(i>0&&i+1<path.points.length))&&!axis(before)&&!axis(after))throw new Error('revolve axis contact would create a pinched non-manifold vertex');
  }
  const rings=full?n:n+1,pointsCount=[...used].reduce((sum,i)=>sum+(axis(i)?1:rings),0);
  constructionBudget(pointsCount,usedEdges.length*n+(caps?2:0),options);
  if(caps)constructionCapBudget(used.size,options);
  const points:SurfacePoint3[]=[],vertices=new Map<number,number[]>();
  for(const i of path.points){
    if(!used.has(i))continue;
    const p=source.points[i],indices:number[]=[];
    for(let ring=0;ring<(axis(i)?1:rings);ring++){
      const a=angle*Math.PI/180*ring/n,c=Math.cos(a),s=Math.sin(a),[x,y,z]=p.position;
      indices.push(points.length);points.push({id:JSON.stringify(['revolve',p.id,axis(i)?'axis':ring]),position:[x*c-y*s,x*s+y*c,z],attributes:p.attributes,provenance:{operation:'revolve',parents:[p.id]}});
    }
    vertices.set(i,indices);
  }
  const index=(p:number,ring:number)=>vertices.get(p)![axis(p)?0:ring%rings];
  const faces:SurfaceFace3[]=[],charts:{uv:readonly (readonly [number,number])[];chart:string}[]=[];
  const profilePoints=path.points.map(i=>source.points[i].position),parameters=arcParameters3(profilePoints,path.closed);
  const capCoordinates=caps?profileCoordinates3(profilePoints,[0,2]):undefined;
  const capByPoint=capCoordinates?new Map(path.points.map((p,i)=>[p,capCoordinates[i]])):undefined;
  const add=(id:string,indices:number[],attributes:Attributes3,parents:readonly string[],coordinates:readonly (readonly [number,number])[],chart:string)=>{
    const vertices=indices.filter((v,i)=>v!==indices[(i+indices.length-1)%indices.length]);
    // An axis point occupies one geometric vertex, with a distinct chart value
    // in each angular sector. Average its two collapsed parameter corners.
    const uv=vertices.map(vertex=>{
      const at=indices.flatMap((v,i)=>v===vertex?[coordinates[i]]:[]);
      return [at.reduce((sum,p)=>sum+p[0],0)/at.length,at.reduce((sum,p)=>sum+p[1],0)/at.length] as const;
    });
    if(angle<0){vertices.reverse();uv.reverse();}
    charts.push({uv,chart});
    faces.push({id,vertices,attributes,provenance:{operation:'revolve',parents}});
  };
  for(let j=0;j<path.edges.length;j++){
    const edge=path.edges[j];if(!edgeSet.has(edge))continue;
    const a=path.points[j],b=path.points[(j+1)%path.points.length],e=source.edges[edge];
    for(let ring=0;ring<n;ring++)add(JSON.stringify(['revolve',e.id,ring]),[index(a,ring),index(a,ring+1),index(b,ring+1),index(b,ring)],e.attributes,[e.id],[[ring/n,parameters[j]],[(ring+1)/n,parameters[j]],[(ring+1)/n,parameters[j+1]],[ring/n,parameters[j+1]]],'side');
  }
  if(caps){
    // Collinear axis-only profile samples do not participate in the skin.
    const boundary=path.points.filter(i=>used.has(i));
    add(JSON.stringify(['revolve','start']),boundary.map(i=>index(i,0)),{},path.edges.map(i=>source.edges[i].id),boundary.map(i=>capByPoint!.get(i)!), 'start');
    add(JSON.stringify(['revolve','end']),boundary.map(i=>index(i,n)).reverse(),{},path.edges.map(i=>source.edges[i].id),boundary.map(i=>capByPoint!.get(i)!).reverse(), 'end');
  }
  const topology=surface3(points.map(p=>p.position as Vec3),faces.map(f=>f.vertices));
  return new Mesh<P,{},Partial<E>&Attributes3,SurfaceUV>(chartSurface3(assembleSurface3(points,faces,topology.triangles),(f,c)=>({uv:charts[f].uv[c],chart:charts[f].chart})),{...options,key:options.key??profile.key});
}
