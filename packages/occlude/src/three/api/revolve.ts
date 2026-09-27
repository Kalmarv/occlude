import type {Curve as Curve2} from '../../curves.js';
import {arcParameters3,profileCoordinates3} from '../geometry/coordinates.js';
import {finite3,type Vec3} from '../math.js';
import {geometry3,facesMade3,earClip3,charted3,kernelRows3,emptyMesh,derived,type GeometryOptions} from './mesh.js';
import {mesh3,type Lineage3} from '../geometry/mesh3.js';
import {emptyCount,emptySize} from '../degenerate.js';
import {curvePath,constructionBudget,constructionCapBudget,type ConstructionBudget} from './curveTopology.js';
import {profileCurve} from './curves.js';
import type {Material} from '../../material.js';
export interface RevolveOptions extends GeometryOptions,ConstructionBudget {
  readonly segments?:number;
  /** Signed sweep in degrees, nonzero and at most a full turn. */
  readonly angle?:number;
  /** Close angular cuts for a partial turn of a closed profile. Default false. */
  readonly caps?:boolean;
}
/** Revolve an XZ meridian in x>=0 around Z. A 2D chain is that meridian:
 * its x is the radius and its y the height. Point columns follow the profile;
 * side faces inherit profile edge columns, while angular caps have no columns. */
export function revolve(input:Material|{readonly curves:unknown}|Curve2,options:RevolveOptions={}):Material {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new Error('revolve options must be an object');
  const profile=profileCurve(input,'xz','revolve') as Material;
  const path=curvePath(profile),angle=options.angle??360,n=options.segments??32,full=Math.abs(angle)===360;
  if(!Number.isFinite(angle)||Math.abs(angle)>360)throw new Error('revolve angle must be within -360 to 360 degrees');
  // No profile, no turn and no segments each revolve nothing. The angular step
  // is a construction constraint, not a magnitude, and still throws.
  if(!path.edges.length||emptySize(Math.abs(angle))||emptyCount(n,1,'revolve segments'))return emptyMesh(options);
  if(Math.abs(angle)/n>=180)throw new Error('revolve needs an angular step smaller than 180 degrees');
  if(options.caps!==undefined&&typeof options.caps!=='boolean')throw new Error('revolve caps must be boolean');
  const caps=options.caps===true&&!full;
  if(caps&&!path.closed)throw new Error('revolve angular caps require a closed profile');
  const source=mesh3(profile),{x:X,y:Y,z:Z}=source,names=source.names,list=source.edges;
  const anchorZ=Z[0];
  let extent=0;for(let i=0;i<source.n;i++)extent=Math.max(extent,Math.abs(X[i]),Math.abs(Z[i]-anchorZ));
  for(let i=0;i<source.n;i++)if(X[i]<0||Math.abs(Y[i])>extent*1e-10)throw new Error('revolve profile must lie in the XZ meridian with x >= 0');
  const axis=(i:number)=>X[i]===0&&Y[i]===0;
  const usedEdges=path.edges.filter(i=>!(axis(list[2*i])&&axis(list[2*i+1]))),edgeSet=new Set(usedEdges);
  // A profile lying on the axis sweeps no surface: an empty mesh, not a fault.
  if(!usedEdges.length)return emptyMesh(options);
  const used=new Set(usedEdges.flatMap(i=>[list[2*i],list[2*i+1]]));
  for(let i=0;i<path.points.length;i++){
    const p=path.points[i];if(!axis(p))continue;
    const before=path.points[(i+path.points.length-1)%path.points.length],after=path.points[(i+1)%path.points.length];
    if((path.closed||(i>0&&i+1<path.points.length))&&!axis(before)&&!axis(after))throw new Error('revolve axis contact would create a pinched non-manifold vertex');
  }
  const rings=full?n:n+1,pointsCount=[...used].reduce((sum,i)=>sum+(axis(i)?1:rings),0);
  constructionBudget(pointsCount,usedEdges.length*n+(caps?2:0),options);
  if(caps)constructionCapBudget(used.size,options);
  // Each point of the skin: where it is, its name, and the profile point it
  // turns (its columns and its lineage).
  const positions:Vec3[]=[],pointNames:string[]=[],pointRows:number[]=[],vertices=new Map<number,number[]>();
  for(const i of path.points){
    if(!used.has(i))continue;
    const indices:number[]=[],x=X[i],y=Y[i],z=Z[i];
    for(let ring=0;ring<(axis(i)?1:rings);ring++){
      const a=angle*Math.PI/180*ring/n,c=Math.cos(a),s=Math.sin(a);
      indices.push(positions.length);positions.push([x*c-y*s,x*s+y*c,z]);pointNames.push(JSON.stringify(['revolve',names.points[i],axis(i)?'axis':ring]));pointRows.push(i);
    }
    vertices.set(i,indices);
  }
  const index=(p:number,ring:number)=>vertices.get(p)![axis(p)?0:ring%rings];
  // Each face: its loop, its name, the profile edge whose columns it takes
  // (-1: none), what it came from and its chart.
  const loops:number[][]=[],faceNames:string[]=[],faceRows:number[]=[],faceParents:(readonly string[])[]=[],charts:{uv:readonly (readonly [number,number])[];chart:string}[]=[];
  const profilePoints=path.points.map(i=>source.position(i)),parameters=arcParameters3(profilePoints,path.closed);
  const capCoordinates=caps?profileCoordinates3(profilePoints,[0,2]):undefined;
  const capByPoint=capCoordinates?new Map(path.points.map((p,i)=>[p,capCoordinates[i]])):undefined;
  const add=(id:string,indices:number[],row:number,parents:readonly string[],coordinates:readonly (readonly [number,number])[],chart:string)=>{
    const loop=indices.filter((v,i)=>v!==indices[(i+indices.length-1)%indices.length]);
    // An axis point occupies one geometric vertex, with a distinct chart value
    // in each angular sector. Average its two collapsed parameter corners.
    const uv=loop.map(vertex=>{
      const at=indices.flatMap((v,i)=>v===vertex?[coordinates[i]]:[]);
      return [at.reduce((sum,p)=>sum+p[0],0)/at.length,at.reduce((sum,p)=>sum+p[1],0)/at.length] as const;
    });
    if(angle<0){loop.reverse();uv.reverse();}
    charts.push({uv,chart});
    loops.push(loop);faceNames.push(id);faceRows.push(row);faceParents.push(parents);
  };
  for(let j=0;j<path.edges.length;j++){
    const edge=path.edges[j];if(!edgeSet.has(edge))continue;
    const a=path.points[j],b=path.points[(j+1)%path.points.length],e=names.edges[edge];
    for(let ring=0;ring<n;ring++)add(JSON.stringify(['revolve',e,ring]),[index(a,ring),index(a,ring+1),index(b,ring+1),index(b,ring)],edge,[e],[[ring/n,parameters[j]],[(ring+1)/n,parameters[j]],[(ring+1)/n,parameters[j+1]],[ring/n,parameters[j+1]]],'side');
  }
  if(caps){
    // Collinear axis-only profile samples do not participate in the skin.
    const boundary=path.points.filter(i=>used.has(i)),all=path.edges.map(i=>names.edges[i]);
    add(JSON.stringify(['revolve','start']),boundary.map(i=>index(i,0)),-1,all,boundary.map(i=>capByPoint!.get(i)!), 'start');
    add(JSON.stringify(['revolve','end']),boundary.map(i=>index(i,n)).reverse(),-1,all,boundary.map(i=>capByPoint!.get(i)!).reverse(), 'end');
  }
  positions.forEach(p=>finite3(p,'mesh'));
  const lineage:Lineage3={
    points:pointRows.map(i=>({operation:'revolve',parents:[names.points[i]]})),
    faces:faceParents.map(parents=>({operation:'revolve',parents})),
  };
  const made=facesMade3(positions,pointNames,loops,faceNames,earClip3(positions,loops),{points:kernelRows3(source.cols.points,pointRows),faces:kernelRows3(source.cols.edges,faceRows)},lineage);
  return geometry3(charted3(made,(f,c)=>({uv:charts[f].uv[c],chart:charts[f].chart})),{...options,key:options.key??profile.key,derived:derived('revolve',input as object)});
}
