import type {Tree} from '../../api.js';
import type {L} from '../../units.js';
import type {Attributes3} from '../geometry/surface.js';
import {cameraFrame3,type Camera3,type PaperFrame3} from '../camera.js';
import {sub3,type Vec3} from '../math.js';
import {lineArt3} from '../scene.js';
import {drawing3,type Drawing3} from '../drawing.js';
import {hatch3} from '../curves/hatch.js';
import {section3} from '../curves/section.js';
import {Mesh,CurveGeometry,evaluate,type Field,type FaceRow,type PointRow,type EdgeAttributes} from './mesh.js';
import {Instances,instanceSurfaceBinding3} from './instances.js';
import {SurfaceCurves} from './supported.js';
import type {SurfaceCurveObject3} from '../curves/network.js';
import type {SurfaceObject3} from '../features/snapshot.js';
import {projectedLines,projectedStrokes,captureValue,type ProjectedLines} from './projected.js';
export interface CameraOptions {readonly eye:Vec3;readonly target?:Vec3;readonly up?:Vec3;readonly near?:number;readonly far?:number}
export function orthographic(options:CameraOptions&{readonly span?:number}):Extract<Camera3,{kind:'orthographic'}>{
  const target=options.target??[0,0,0],span=options.span??6;
  return cameraFrame3({...options,kind:'orthographic',target,span,near:options.near??.1,far:options.far??Math.max(100,4*Math.hypot(...sub3(options.eye,target))+2*span)},{x:0,y:0,width:1,height:1}).camera as Extract<Camera3,{kind:'orthographic'}>;
}
export function perspective(options:CameraOptions&{readonly fovDegrees?:number}):Extract<Camera3,{kind:'perspective'}>{
  const target=options.target??[0,0,0];
  return cameraFrame3({...options,kind:'perspective',target,fovDegrees:options.fovDegrees??45,near:options.near??.1,far:options.far??Math.max(100,4*Math.hypot(...sub3(options.eye,target)))},{x:0,y:0,width:1,height:1}).camera as Extract<Camera3,{kind:'perspective'}>;
}
export interface ViewHatch<F extends Attributes3=Attributes3> {
  readonly key?:string;
  readonly spacing:Field<FaceRow<F>,L>;readonly angle?:Field<FaceRow<F>,number>;readonly offset?:Field<FaceRow<F>,L>;
  readonly stroke?:string;readonly select?:(face:FaceRow<F>)=>boolean;
}
/** Planes are in the mesh/prototype's model coordinates; instances transform
 * the resulting section with their geometry. They are not world cutting planes. */
export interface ViewSection {
  readonly key?:string;readonly origin:Vec3;readonly normal:Vec3;
  readonly stroke?:string;readonly attributes?:Attributes3;
}
export interface ViewOptions<F extends Attributes3=Attributes3> {
  readonly camera:Camera3;readonly stroke?:string;readonly key?:string;readonly viewport?:PaperFrame3;
  /** Artistic threshold in degrees; default 30. Silhouettes remain visible. */
  /** Default crease threshold in degrees (30) for objects without their own. */
  readonly creaseAngle?:number;
  readonly hatch?:ViewHatch<F>|readonly ViewHatch<F>[];
  readonly sections?:readonly ViewSection[];
}
// Heterogeneous meshes intentionally expose an attribute map at this boundary;
// a single mesh overload preserves its precise face-column types.
type AnyMesh=Mesh<any,any,any,any>;
type ViewGeometry=SurfaceCurves<any>|AnyMesh|CurveGeometry<any,any>|Instances<any,any,any,any,any,any,any>;
export function view<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(geometry:Mesh<P,E,F,C>,options:ViewOptions<F>,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,A extends Attributes3,S extends Attributes3,R extends PointRow<{}>,C extends Attributes3>(geometry:Instances<P,E,F,A,S,R,C>,options:ViewOptions<F>,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view(geometry:SurfaceCurves<any>|CurveGeometry<any,any>,options:ViewOptions,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view(geometry:readonly ViewGeometry[],options:ViewOptions,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view(geometry:ViewGeometry|readonly ViewGeometry[],options:ViewOptions<any>,draw?:(lines:ProjectedLines)=>Tree):Drawing3 {
  const settings=captureValue(options),crease=settings.creaseAngle??30;
  if(!Number.isFinite(crease)||crease<0||crease>180)throw new Error('view creaseAngle must be between 0 and 180 degrees');
  const recipes:readonly ViewHatch<any>[]=settings.hatch?(Array.isArray(settings.hatch)?settings.hatch:[settings.hatch]):[];
  const hatchKeys=recipes.map((r,i)=>r.key??(Array.isArray(settings.hatch)?`hatch:${i}`:'hatch'));
  const planes=settings.sections??[],sectionKeys=planes.map((p,i)=>p.key??`section:${i}`);
  for(const [kind,keys] of [['hatch',hatchKeys],['section',sectionKeys]] as const){
    if(keys.some(k=>typeof k!=='string'||!k)||new Set(keys).size!==keys.length)throw new Error(`view ${kind} keys must be nonempty and unique`);
  }
  const meshes=Array.isArray(geometry)?geometry:[geometry];
  const objects:SurfaceObject3[]=[],supported:SurfaceCurveObject3[]=[];
  const geometryKeys=new Set<string>();
  meshes.forEach((value:ViewGeometry,index:number)=>{
    if(!(value instanceof Mesh)&&!(value instanceof Instances)&&!(value instanceof CurveGeometry)&&!(value instanceof SurfaceCurves))throw new Error('view requires mesh, curve or instance geometry');
    const id=value.key??`object:${index}`;
    if(geometryKeys.has(id))throw new Error('view geometry keys must be unique');geometryKeys.add(id);
    if(value instanceof SurfaceCurves){supported.push({id,network:value.network,...(value.stroke?{attributes:{stroke:value.stroke}}:{})});return;}
    if(value instanceof CurveGeometry){objects.push({id,surface:value.surface,occluder:false});return;}
    const mesh=value instanceof Instances?value.prototype:value;
    const faces=mesh.faces;
    // Eligibility belongs to the prototype; the hatch lattice is resolved on
    // each transformed surface in the existing renderer.
    const hatch=recipes.length?hatch3(mesh.surface,face=>{
      const row=faces.at(face.index)!;
      return recipes.flatMap((recipe,i)=>!recipe.select||recipe.select(row)?[{id:hatchKeys[i],spacing:evaluate(recipe.spacing,row),angle:evaluate(recipe.angle??45,row),offset:recipe.offset===undefined?undefined:evaluate(recipe.offset,row)}]:[]);
    }):undefined;
    const curves=planes.length?section3(mesh.surface,planes.map((p,i)=>({id:sectionKeys[i],origin:p.origin,normal:p.normal,attributes:p.attributes}))):undefined;
    if(value instanceof Instances){
      for(const row of value.rows)objects.push({id:JSON.stringify([id,row.id]),surface:mesh.surface,...(mesh.creaseAngle!==undefined?{creaseThreshold:mesh.creaseAngle}:{}),binding:instanceSurfaceBinding3(value,row),hatch,curves,transform:row.transform,attributes:row.attributes,instance:{id:row.id,pointId:row.source.id,pointIndex:row.source.index,prototypeKey:mesh.key}});
    }else objects.push({id,surface:mesh.surface,hatch,curves,...(mesh.creaseAngle!==undefined?{creaseThreshold:mesh.creaseAngle}:{})});
  });
  if(new Set(objects.map(o=>o.id)).size!==objects.length)throw new Error('view geometry keys must be unique');
  const scene=lineArt3({id:settings.key,objects,curves:supported,camera:settings.camera,viewport:settings.viewport,lineSets:[]});
  return drawing3(scene,classified=>{
    const lines=projectedLines(classified);
    if(draw)return draw(lines);
    // Generated marks may name their own pen through a `stroke` attribute (hatch
    // families); everything else follows the view's stroke.
    const generated=(c:{kinds:ReadonlySet<string>})=>c.kinds.has('mapped')||c.kinds.has('trace')||c.kinds.has('isoline')||c.kinds.has('intersection');
    const named=lines.visible.filter(c=>typeof c.attributes.stroke==='string'&&generated(c));
    const pens=[...new Set(named.map(c=>c.attributes.stroke as string))].sort();
    return [
      projectedStrokes(lines.visible.filter(c=>!(typeof c.attributes.stroke==='string'&&generated(c))&&(c.kinds.has('boundary')||c.kinds.has('silhouette')||c.kinds.has('wire')||c.kinds.has('intersection')||c.kinds.has('mapped')||c.kinds.has('trace')||c.kinds.has('isoline')||(c.kinds.has('crease')&&c.feature.creaseAngle>=(c.feature.creaseThreshold??crease)))),{stroke:settings.stroke}),
      ...pens.map(pen=>projectedStrokes(named.filter(c=>c.attributes.stroke===pen),{stroke:pen})),
      ...recipes.map((recipe,i)=>projectedStrokes(lines.visible.filter(c=>c.kinds.has('hatch')&&c.attributes.hatchFamily===hatchKeys[i]),{stroke:recipe.stroke??settings.stroke})),
      ...planes.map((plane,i)=>projectedStrokes(lines.visible.filter(c=>c.kinds.has('section')&&c.attributes.sectionPlane===sectionKeys[i]),{stroke:plane.stroke??settings.stroke})),
    ];
  });
}
