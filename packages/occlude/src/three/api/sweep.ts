import type {Curve as Curve2} from '../../curves.js';
import {arcParameters3,profileCoordinates3} from '../geometry/coordinates.js';
import {triangulate} from '../geometry/surface.js';
import {add3,sub3,mul3,dot3,cross3,unit3,finite3,type Vec3} from '../math.js';
import {madeGeometry3,facesMade3,charted3,kernelRows3,emptyMesh,derived,type GeometryOptions} from './mesh.js';
import {mesh3} from '../geometry/mesh3.js';
import {evaluate,type Field} from './columns.js';
import {sampleValue} from '../degenerate.js';
import {curvePath,constructionBudget,constructionCapBudget,type ConstructionBudget} from './curveTopology.js';
import {profileCurve} from './curves.js';
import type {Material,Vertex} from '../../material.js';
export interface SweepOptions extends GeometryOptions,ConstructionBudget {
  /** World direction for the profile's initial +X, projected off the tangent. */
  readonly normal?:Vec3;
  readonly scale?:Field<Vertex,number>;
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
/** A half turn names no rotation axis, so the frame carries straight through:
 * the arriving normal is already perpendicular to a reversed tangent, and every
 * choice is as arbitrary as the next. */
function transport(normal:Vec3,from:Vec3,to:Vec3):Vec3 {
  const axis=cross3(from,to),s=Math.hypot(...axis),c=dot3(from,to);
  if(s===0)return perpendicular(normal,to);
  return perpendicular(rotate(normal,mul3(axis,1/s),Math.atan2(s,c)),to);
}
/** Carry an XY profile along an unbranched 3D path using transported frames.
 * The profile (and the path) may be a 2D chain, read in XY at z = 0.
 * Closed paths distribute frame-closure twist by arc length. */
export function sweep(input:Material|{readonly curves:unknown}|Curve2,along:Material|{readonly curves:unknown}|Curve2,options:SweepOptions={}):Material {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('sweep options must be an object');
  const profile=profileCurve(input,'xy','sweep') as Material,path=profileCurve(along,'xy','sweep path') as Material;
  const section=curvePath(profile),route=curvePath(path),shape=mesh3(profile),source=mesh3(path);
  // Nothing to carry, or nowhere to carry it: an empty sweep, not a failure.
  if(!section.edges.length||!route.edges.length)return emptyMesh(options);
  const count=route.points.length,width=section.points.length,caps=options.caps===true&&!route.closed;
  if(options.caps!==undefined&&typeof options.caps!=='boolean')throw new Error('sweep caps must be boolean');
  if(caps&&!section.closed)throw new Error('sweep end caps require a closed profile');
  const twist=options.twist??0;
  if(!Number.isFinite(twist)||(route.closed&&twist%360!==0))throw new Error('sweep twist must be finite; closed paths require whole turns');
  let extent=0;for(let i=0;i<shape.n;i++)extent=Math.max(extent,Math.hypot(shape.x[i],shape.y[i]));
  for(let i=0;i<shape.n;i++)if(Math.abs(shape.z[i])>extent*1e-10)throw new Error('sweep profile must lie in XY');
  constructionBudget(width*count,section.edges.length*route.edges.length+(caps?2:0),options);
  if(caps)constructionCapBudget(width,options);
  const centers=route.points.map(i=>source.position(i)),directions:Vec3[]=[],lengths:number[]=[],distances=[0];
  for(let i=0;i<route.edges.length;i++){
    const delta=sub3(centers[(i+1)%count],centers[i]);directions.push(unit3(delta));lengths.push(Math.hypot(...delta));
    distances.push(distances[i]+lengths[i]);
  }
  const length=distances.at(-1)!;if(!Number.isFinite(length))throw new Error('sweep path length is not representable');
  const tangents=centers.map((_,i)=>{
    if(!route.closed&&i===0)return directions[0];if(!route.closed&&i===count-1)return directions.at(-1)!;
    // A path that doubles back has no mean tangent: follow the outgoing leg.
    const tangent=add3(directions[(i+directions.length-1)%directions.length],directions[i]);
    return Math.hypot(...tangent)===0?directions[i]:unit3(tangent);
  });
  let start:Vec3;
  // A normal lying along the tangent names no direction in the section plane;
  // the automatic choice below is as good as any other.
  const automatic=()=>{const axis=[0,1,2].sort((a,b)=>Math.abs(tangents[0][a])-Math.abs(tangents[0][b]))[0];return perpendicular([axis===0?1:0,axis===1?1:0,axis===2?1:0],tangents[0]);};
  if(options.normal){finite3(options.normal,'sweep normal');start=Math.hypot(...cross3(options.normal,tangents[0]))===0?automatic():perpendicular(options.normal,tangents[0]);}
  else start=automatic();
  const normals:Vec3[]=[start];for(let i=1;i<count;i++)normals.push(transport(normals[i-1],tangents[i-1],tangents[i]));
  let closure=0;
  if(route.closed){const end=transport(normals.at(-1)!,tangents.at(-1)!,tangents[0]);closure=Math.atan2(dot3(tangents[0],cross3(end,start)),dot3(end,start));}
  // A section the scale field collapses (zero, or a value it could not answer)
  // contributes no width at that point; the sweep still runs and the triangles
  // that collapse there are dropped below.
  const rows=path.points.map(p=>p as Vertex),scales=route.points.map(i=>Math.max(0,sampleValue(evaluate(options.scale??1,rows[i]),0)));
  // Each point: a profile point carried to a path point, whose columns it
  // takes (the profile's over the path's).
  const names=shape.names,pathNames=source.names;
  const positions:Vec3[]=[],pointNames:string[]=[],profileRows:number[]=[],pathRows:number[]=[];
  for(let ring=0;ring<count;ring++){
    const normal=rotate(normals[ring],tangents[ring],(closure+twist*Math.PI/180)*distances[ring]/length),binormal=unit3(cross3(tangents[ring],normal)),pathPoint=route.points[ring];
    for(const index of section.points){
      const [x,y,z]=shape.position(index);
      const position=add3(centers[ring],add3(add3(mul3(normal,x*scales[ring]),mul3(binormal,y*scales[ring])),mul3(tangents[ring],z*scales[ring])));finite3(position,'sweep');
      positions.push(position);pointNames.push(JSON.stringify(['sweep',names.points[index],pathNames.points[pathPoint]]));profileRows.push(index);pathRows.push(pathPoint);
    }
  }
  const index=(ring:number,vertex:number)=>(ring%count)*width+vertex%width;
  // Each side face: a profile edge carried along a path edge, whose columns
  // it takes (the profile's over the path's); the caps take none (-1).
  const loops:number[][]=[],faceNames:string[]=[],profileEdges:number[]=[],pathEdges:number[]=[],triangles:number[][]=[];
  const lineage={points:positions.map((_,i)=>({operation:'sweep',parents:[names.points[profileRows[i]],pathNames.points[pathRows[i]]],inputs:[0,1]})),faces:[] as {operation:string;parents:string[];inputs:number[]}[]};
  for(let ring=0;ring<route.edges.length;ring++)for(let edge=0;edge<section.edges.length;edge++){
    const a=index(ring,edge),b=index(ring,edge+1),c=index(ring+1,edge+1),d=index(ring+1,edge),profileEdge=section.edges[edge],pathEdge=route.edges[ring];
    loops.push([a,b,c,d]);faceNames.push(JSON.stringify(['sweep',names.edges[profileEdge],pathNames.edges[pathEdge]]));profileEdges.push(profileEdge);pathEdges.push(pathEdge);
    lineage.faces.push({operation:'sweep',parents:[names.edges[profileEdge],pathNames.edges[pathEdge]],inputs:[0,1]});
    triangles.push(drawable(positions,[[a,b,c],[a,c,d]],[0,1,2,0,2,3]));
  }
  if(caps)for(const ring of [0,count-1]){
    const boundary=Array.from({length:width},(_,i)=>index(ring,i));if(ring===0)boundary.reverse();
    const at=boundary.map(i=>positions[i]);at.forEach(p=>finite3(p,'mesh'));
    const cap=triangulate(at,boundary.map((_,i)=>i));
    loops.push(boundary);faceNames.push(JSON.stringify(['sweep','cap',ring===0?'start':'end']));profileEdges.push(-1);pathEdges.push(-1);
    lineage.faces.push({operation:'sweep',parents:section.edges.map(i=>names.edges[i]),inputs:section.edges.map(()=>0)});
    triangles.push(drawable(positions,cap.map(t=>t.map(i=>boundary[i])),cap.flat()));
  }
  const profilePoints=section.points.map(i=>shape.position(i)),u=arcParameters3(profilePoints,section.closed),v=arcParameters3(centers,route.closed);
  const capUV=caps?profileCoordinates3(profilePoints,[0,1]):undefined,sideCount=section.edges.length*route.edges.length;
  const made=facesMade3(positions,pointNames,loops,faceNames,triangles,{
    points:{...kernelRows3(source.cols.points,pathRows),...kernelRows3(shape.cols.points,profileRows)},
    faces:{...kernelRows3(source.cols.edges,pathEdges),...kernelRows3(shape.cols.edges,profileEdges)},
  },lineage);
  return madeGeometry3(charted3(made,(f,c,vertex)=>{
    if(f>=sideCount)return {uv:capUV![vertex%width],chart:f===sideCount?'start':'end'};
    const ring=Math.floor(f/section.edges.length),edge=f%section.edges.length;
    const uv:readonly (readonly [number,number])[]=[[u[edge],v[ring]],[u[edge+1],v[ring]],[u[edge+1],v[ring+1]],[u[edge],v[ring+1]]];
    return {uv:uv[c],chart:'side'};
  }),{...options,derived:derived('sweep',input as object,along as object)});
}
/** The triangles of one face that have area, as positions round its loop
 * (`local`, three a triangle): a triangle with none draws nothing and is
 * dropped, the rest of the skin kept. Its polygon stays, so charts and
 * edges still line up. */
function drawable(positions:readonly Vec3[],triangles:readonly (readonly number[])[],local:readonly number[]):number[] {
  const out:number[]=[];
  triangles.forEach((triangle,t)=>{
    const [a,b,c]=triangle.map(i=>positions[i]),ab=sub3(b,a),ac=sub3(c,a),scale=Math.max(Math.hypot(...ab),Math.hypot(...ac));
    if(scale>0&&Number.isFinite(scale)&&Math.hypot(...cross3(mul3(ab,1/scale),mul3(ac,1/scale)))!==0)out.push(local[3*t],local[3*t+1],local[3*t+2]);
  });
  return out;
}
