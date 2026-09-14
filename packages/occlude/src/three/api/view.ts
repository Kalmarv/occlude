import type {Tree} from '../../api.js';
import type {L} from '../../units.js';
import type {Attributes3} from '../geometry/surface.js';
import {cameraFrame3,type Camera3,type PaperFrame3} from '../camera.js';
import {sub3,type Vec3} from '../math.js';
import {lineArt3} from '../scene.js';
import {drawing3,type Drawing3} from '../drawing.js';
import {hatch3} from '../curves/hatch.js';
import {Mesh,type FaceRow,type EdgeAttributes} from './mesh.js';
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
export interface ViewOptions<F extends Attributes3=Attributes3> {
  readonly camera:Camera3;readonly stroke?:string;readonly key?:string;readonly viewport?:PaperFrame3;
  /** Artistic threshold in degrees; default 30. Silhouettes remain visible. */
  readonly creaseAngle?:number;
  readonly hatch?:{readonly spacing:L;readonly angle?:number;readonly offset?:L;readonly stroke?:string;readonly select?:(face:FaceRow<F>)=>boolean};
}
// Heterogeneous meshes intentionally expose an attribute map at this boundary;
// a single mesh overload preserves its precise face-column types.
type AnyMesh=Mesh<any,any,any>;
export function view<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3>(geometry:Mesh<P,E,F>,options:ViewOptions<F>,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view(geometry:readonly AnyMesh[],options:ViewOptions,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view(geometry:AnyMesh|readonly AnyMesh[],options:ViewOptions<any>,draw?:(lines:ProjectedLines)=>Tree):Drawing3 {
  const settings=captureValue(options),crease=settings.creaseAngle??30;
  if(!Number.isFinite(crease)||crease<0||crease>180)throw new Error('view creaseAngle must be between 0 and 180 degrees');
  const meshes=Array.isArray(geometry)?geometry:[geometry];
  const objects=meshes.map((value:AnyMesh,index:number)=>{
    if(!(value instanceof Mesh))throw new Error('view requires mesh geometry');
    const faces=value.faces(),recipe=settings.hatch;
    const hatch=recipe?hatch3(value.surface,face=>!recipe.select||recipe.select(faces.at(face.index)!)?[{id:'hatch',spacing:recipe.spacing,angle:recipe.angle??45,offset:recipe.offset}]:[]):undefined;
    return {id:value.key??`object:${index}`,surface:value.surface,hatch};
  });
  if(new Set(objects.map(o=>o.id)).size!==objects.length)throw new Error('view geometry keys must be unique');
  const scene=lineArt3({id:settings.key,objects,camera:settings.camera,viewport:settings.viewport,lineSets:[]});
  return drawing3(scene,classified=>{
    const lines=projectedLines(classified);
    if(draw)return draw(lines);
    return [
      projectedStrokes(lines.visible.filter(c=>c.kinds.has('boundary')||c.kinds.has('silhouette')||c.kinds.has('wire')||(c.kinds.has('crease')&&c.feature.creaseAngle>=crease)),{stroke:settings.stroke}),
      ...(settings.hatch?[projectedStrokes(lines.visible.filter(c=>c.kinds.has('hatch')),{stroke:settings.hatch.stroke??settings.stroke})]:[]),
    ];
  });
}
