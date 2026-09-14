import {Collection} from './collection.js';
import {Mesh,type GeometryOptions,type PointRow} from './mesh.js';
import {surfaceBinding3,rebindSurfaceCurveNetwork3,selectSurfaceCurveNetwork3,validateSurfaceCurveNetwork3,type SurfaceCurveNetwork3,type SurfaceCurveNode3,type SupportedCurveSegment3} from '../curves/network.js';
/** Multiple support contexts remain distinct at seams and intersections. */
export interface SurfaceCurvePoint extends PointRow<{}> {
 readonly exact:SurfaceCurveNode3['exact'];readonly supports:SurfaceCurveNode3['supports'];
 readonly attributes:SurfaceCurveNode3['attributes'];
}
export interface SurfaceCurveEdge extends Omit<SupportedCurveSegment3,'a'|'b'> {
 readonly index:number;readonly a:SurfaceCurvePoint;readonly b:SurfaceCurvePoint;
}
const rows=new WeakMap<SurfaceCurveNetwork3,{points:readonly SurfaceCurvePoint[];edges:readonly SurfaceCurveEdge[]}>();
/** Supported construction geometry, before camera interpretation. Generators
 * create these values; edge extraction retains attachments and full source phase. */
export class SurfaceCurves {
 readonly key?:string;
 readonly points:Collection<SurfaceCurvePoint,readonly SurfaceCurvePoint[]>;
 readonly edges:Collection<SurfaceCurveEdge,SurfaceCurves>;
 constructor(readonly network:SurfaceCurveNetwork3,options:GeometryOptions={}){
  validateSurfaceCurveNetwork3(network);
  if(options.key!==undefined&&(typeof options.key!=='string'||!options.key))throw new Error('surface curve key must be nonempty');
  this.key=options.key;
  let cached=rows.get(network);
  if(!cached){
   const points=Object.freeze(network.nodes.map((node,index)=>Object.freeze({id:node.id,index,x:node.position[0],y:node.position[1],z:node.position[2],attributes:node.attributes,exact:node.exact,supports:node.supports})));
   const edges=Object.freeze(network.segments.map((segment,index)=>Object.freeze({...segment,index,a:points[segment.a],b:points[segment.b]})));
   cached={points,edges};rows.set(network,cached);
  }
  const {points,edges}=cached;
  const active=network.reference?[...new Set(network.segments.flatMap(s=>[s.a,s.b]))]:points.map(p=>p.index);
  this.points=new Collection(network,'point',points,indices=>Object.freeze(indices.map(i=>points[i])),active);
  this.edges=new Collection(network,'edge',edges,indices=>new SurfaceCurves(selectSurfaceCurveNetwork3(network,indices),this));
  Object.freeze(this);
 }
 get sources():SurfaceCurveNetwork3['sources']{return this.network.sources;}
 rebind(target:Mesh<any,any,any,any>|readonly Mesh<any,any,any,any>[]):SurfaceCurves {
  const targets=target instanceof Mesh?[target]:target;
  if(!Array.isArray(targets)||targets.length!==this.sources.length||targets.some(t=>!(t instanceof Mesh)))throw new Error('curve rebind requires one mesh per source');
  const bindings=targets.map((t,i)=>surfaceBinding3(t.surface,this.sources[i].binding.placement));
  return new SurfaceCurves(rebindSurfaceCurveNetwork3(this.network,bindings),this);
 }
 withKey(key:string):SurfaceCurves{return new SurfaceCurves(this.network,{key});}
}
