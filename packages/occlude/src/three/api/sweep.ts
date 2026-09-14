import {chartSurface3,arcParameters3,profileCoordinates3,type SurfaceUV} from '../geometry/coordinates.js';
import {surface3,assembleSurface3,type Attributes3,type SurfacePoint3,type SurfaceFace3,type SurfaceTriangle3} from '../geometry/surface.js';
import {add3,sub3,mul3,dot3,cross3,unit3,finite3,type Vec3} from '../math.js';
import {Mesh,CurveGeometry,evaluate,type PointRow,type Field,type EdgeAttributes,type GeometryOptions} from './mesh.js';
import {curvePath,constructionBudget,constructionCapBudget,type ConstructionBudget} from './curveTopology.js';
type Combined<A,B>=Omit<A,keyof B>&B;
export interface SweepOptions<A extends Attributes3={}> extends GeometryOptions,ConstructionBudget {
  /** World direction for the profile's initial +X, projected off the tangent. */
  readonly normal?:Vec3;
  readonly scale?:Field<PointRow<A>,number>;
  /** Total twist in degrees; closed paths require whole turns. */
  readonly twist?:number;
  /** Close a closed profile at the two ends of an open path. Default false. */
  readonly caps?:boolean;
}
function rotate(v:Vec3,axis:Vec3,angle:number):Vec3 {
  const c=Math.cos(angle),s=Math.sin(angle);
  return add3(add3(mul3(v,c),mul3(cross3(axis,v),s)),mul3(axis,dot3(axis,v)*(1-c)));
}
function perpendicular(v:Vec3,tangent:Vec3):Vec3{return unit3(sub3(v,mul3(tangent,dot3(v,tangent))));}
function transport(normal:Vec3,from:Vec3,to:Vec3):Vec3 {
  const axis=cross3(from,to),s=Math.hypot(...axis),c=dot3(from,to);
  if(s===0){if(c<0)throw new Error('sweep has an ambiguous 180-degree frame turn');return perpendicular(normal,to);}
  return perpendicular(rotate(normal,mul3(axis,1/s),Math.atan2(s,c)),to);
}
/** Carry an XY profile along an unbranched 3D path using transported frames.
 * Closed paths distribute frame-closure twist by arc length. */
export function sweep<P extends Attributes3,E extends EdgeAttributes,A extends Attributes3,B extends EdgeAttributes>(profile:CurveGeometry<P,E>,path:CurveGeometry<A,B>,options:SweepOptions<A>={}):Mesh<Combined<A,P>,{},Partial<Combined<B,E>>&Attributes3,SurfaceUV> {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('sweep options must be an object');
  const section=curvePath(profile),route=curvePath(path),shape=profile.surface,source=path.surface;
  const count=route.points.length,width=section.points.length,caps=options.caps===true&&!route.closed;
  if(options.caps!==undefined&&typeof options.caps!=='boolean')throw new Error('sweep caps must be boolean');
  if(caps&&!section.closed)throw new Error('sweep end caps require a closed profile');
  const twist=options.twist??0;
  if(!Number.isFinite(twist)||(route.closed&&twist%360!==0))throw new Error('sweep twist must be finite; closed paths require whole turns');
  const extent=shape.points.reduce((m,p)=>Math.max(m,Math.hypot(p.position[0],p.position[1])),0);
  if(shape.points.some(p=>Math.abs(p.position[2])>extent*1e-10))throw new Error('sweep profile must lie in XY');
  constructionBudget(width*count,section.edges.length*route.edges.length+(caps?2:0),options);
  if(caps)constructionCapBudget(width,options);
  const centers=route.points.map(i=>source.points[i].position),directions:Vec3[]=[],lengths:number[]=[],distances=[0];
  for(let i=0;i<route.edges.length;i++){
    const delta=sub3(centers[(i+1)%count],centers[i]);directions.push(unit3(delta));lengths.push(Math.hypot(...delta));
    distances.push(distances[i]+lengths[i]);
  }
  const length=distances.at(-1)!;if(!Number.isFinite(length))throw new Error('sweep path length is not representable');
  const tangents=centers.map((_,i)=>{
    if(!route.closed&&i===0)return directions[0];if(!route.closed&&i===count-1)return directions.at(-1)!;
    const tangent=add3(directions[(i+directions.length-1)%directions.length],directions[i]);
    if(Math.hypot(...tangent)===0)throw new Error('sweep path has an ambiguous 180-degree reversal');
    return unit3(tangent);
  });
  let start:Vec3;
  if(options.normal){finite3(options.normal);if(Math.hypot(...cross3(options.normal,tangents[0]))===0)throw new Error('sweep normal must not be parallel to the initial tangent');start=perpendicular(options.normal,tangents[0]);}
  else{const axis=[0,1,2].sort((a,b)=>Math.abs(tangents[0][a])-Math.abs(tangents[0][b]))[0];start=perpendicular([axis===0?1:0,axis===1?1:0,axis===2?1:0],tangents[0]);}
  const normals:Vec3[]=[start];for(let i=1;i<count;i++)normals.push(transport(normals[i-1],tangents[i-1],tangents[i]));
  let closure=0;
  if(route.closed){const end=transport(normals.at(-1)!,tangents.at(-1)!,tangents[0]);closure=Math.atan2(dot3(tangents[0],cross3(end,start)),dot3(end,start));}
  const rows=path.points.map(p=>p),scales=route.points.map(i=>evaluate(options.scale??1,rows[i]));
  if(scales.some(s=>!Number.isFinite(s)||s<=0))throw new Error('sweep scale must be positive and finite at every path point');
  const points:SurfacePoint3[]=[],faces:SurfaceFace3[]=[],triangles:SurfaceTriangle3[]=[];
  for(let ring=0;ring<count;ring++){
    const normal=rotate(normals[ring],tangents[ring],(closure+twist*Math.PI/180)*distances[ring]/length),binormal=unit3(cross3(tangents[ring],normal)),pathPoint=source.points[route.points[ring]];
    for(const index of section.points){
      const p=shape.points[index],[x,y,z]=p.position;
      const position=add3(centers[ring],add3(add3(mul3(normal,x*scales[ring]),mul3(binormal,y*scales[ring])),mul3(tangents[ring],z*scales[ring])));finite3(position);
      points.push({id:JSON.stringify(['sweep',p.id,pathPoint.id]),position,attributes:{...pathPoint.attributes,...p.attributes},provenance:{operation:'sweep',parents:[p.id,pathPoint.id]}});
    }
  }
  const index=(ring:number,vertex:number)=>(ring%count)*width+vertex%width;
  for(let ring=0;ring<route.edges.length;ring++)for(let edge=0;edge<section.edges.length;edge++){
    const a=index(ring,edge),b=index(ring,edge+1),c=index(ring+1,edge+1),d=index(ring+1,edge),profileEdge=shape.edges[section.edges[edge]],pathEdge=source.edges[route.edges[ring]],face=faces.length;
    faces.push({id:JSON.stringify(['sweep',profileEdge.id,pathEdge.id]),vertices:[a,b,c,d],attributes:{...pathEdge.attributes,...profileEdge.attributes},provenance:{operation:'sweep',parents:[profileEdge.id,pathEdge.id]}});
    triangles.push({face,vertices:[a,b,c]},{face,vertices:[a,c,d]});
  }
  if(caps)for(const ring of [0,count-1]){
    const boundary=Array.from({length:width},(_,i)=>index(ring,i));if(ring===0)boundary.reverse();
    const cap=surface3(boundary.map(i=>points[i].position),[boundary.map((_,i)=>i)]),face=faces.length;
    faces.push({id:JSON.stringify(['sweep','cap',ring===0?'start':'end']),vertices:boundary,attributes:{},provenance:{operation:'sweep',parents:section.edges.map(i=>shape.edges[i].id)}});
    for(const t of cap.triangles)triangles.push({face,vertices:t.vertices.map(i=>boundary[i]) as [number,number,number]});
  }
  for(const triangle of triangles){
    const [a,b,c]=triangle.vertices.map(i=>points[i].position),ab=sub3(b,a),ac=sub3(c,a),scale=Math.max(Math.hypot(...ab),Math.hypot(...ac));
    if(!(scale>0)||!Number.isFinite(scale)||Math.hypot(...cross3(mul3(ab,1/scale),mul3(ac,1/scale)))===0)throw new Error('sweep creates a degenerate triangle; adjust the profile or path');
  }
  const profilePoints=section.points.map(i=>shape.points[i].position),u=arcParameters3(profilePoints,section.closed),v=arcParameters3(centers,route.closed);
  const capUV=caps?profileCoordinates3(profilePoints,[0,1]):undefined,sideCount=section.edges.length*route.edges.length;
  const surface=chartSurface3(assembleSurface3(points,faces,triangles),(f,c,vertex)=>{
    if(f>=sideCount)return {uv:capUV![vertex%width],chart:f===sideCount?'start':'end'};
    const ring=Math.floor(f/section.edges.length),edge=f%section.edges.length;
    const uv:readonly (readonly [number,number])[]=[[u[edge],v[ring]],[u[edge+1],v[ring]],[u[edge+1],v[ring+1]],[u[edge],v[ring+1]]];
    return {uv:uv[c],chart:'side'};
  });
  return new Mesh<Combined<A,P>,{},Partial<Combined<B,E>>&Attributes3,SurfaceUV>(surface,options);
}
