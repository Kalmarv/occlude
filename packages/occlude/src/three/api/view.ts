import type {Tree} from '../../api.js';
import type {L} from '../../units.js';
import type {Attributes3} from '../geometry/surface.js';
import {cameraFrame3,type Camera3,type PaperFrame3} from '../camera.js';
import {sub3,type Vec3} from '../math.js';
import {clampSetting} from '../degenerate.js';
import {lineArt3} from '../scene.js';
import {drawing3,type Drawing3} from '../drawing.js';
import {hatch3} from '../curves/hatch.js';
import {section3} from '../curves/section.js';
import {Mesh,CurveGeometry,evaluate,type Field,type FaceRow,type PointRow,type EdgeAttributes,type SuggestiveInput} from './mesh.js';
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
/** A perspective camera whose frame is moved off the optical axis. `shift` is
 * a fraction of the frame, right and up: `[0, 0.4]` raises the frame by four
 * tenths of its height, so what is drawn moves down the page by the same
 * amount. The eye and the direction of view do not move, so a level camera
 * keeps world verticals parallel while the frame covers what a tilt would
 * otherwise have to reach — the architect's two-point view. `shift: [0, 0]`
 * is `perspective`. */
export function oblique(options:CameraOptions&{readonly shift:readonly [number,number];readonly fovDegrees?:number}):Extract<Camera3,{kind:'oblique'}>{
  const target=options.target??[0,0,0];
  return cameraFrame3({...options,kind:'oblique',target,shift:options.shift,fovDegrees:options.fovDegrees??45,near:options.near??.1,far:options.far??Math.max(100,4*Math.hypot(...sub3(options.eye,target)))},{x:0,y:0,width:1,height:1}).camera as Extract<Camera3,{kind:'oblique'}>;
}
export interface ViewHatch<F extends Attributes3=Attributes3> {
  readonly key?:string;
  readonly spacing:Field<FaceRow<F>,L>;readonly angle?:Field<FaceRow<F>,number>;readonly offset?:Field<FaceRow<F>,L>;
  /** The pen for this recipe's lines: a name, or a field over the face row
   * (`f => f.ring ? 'red' : 'fine'`). Unset: the object's pen, then the view's. */
  readonly stroke?:Field<FaceRow<F>,string>;readonly select?:(face:FaceRow<F>)=>boolean;
}
/** Planes are in the mesh/prototype's model coordinates; instances transform
 * the resulting section with their geometry. They are not world cutting planes. */
export interface ViewSection {
  readonly key?:string;readonly origin:Vec3;readonly normal:Vec3;
  readonly stroke?:string;readonly attributes?:Attributes3;
}
export interface ViewOptions<F extends Attributes3=Attributes3> {
  readonly camera:Camera3;readonly stroke?:string;readonly key?:string;readonly viewport?:PaperFrame3;
  /** Default crease threshold in degrees (30) for objects without their own.
   * A fold flatter than it is not a line of the view, in the default ink and
   * in the callback's `lines` alike. Silhouettes remain visible. */
  readonly creaseAngle?:number;
  /** Suggestive contours for objects without their own reading: `false` (the
   * default) draws none, `{}` or `{ threshold }` draws them. */
  readonly suggestive?:SuggestiveInput;
  readonly hatch?:ViewHatch<F>|readonly ViewHatch<F>[];
  readonly sections?:readonly ViewSection[];
  /** A view is ink, not an occluder: unset, it hides nothing drawn before it.
   * `true` makes the paper its solids cover opaque in paint order, the same
   * word as `polygon`'s — what was drawn before the view is hidden there, and
   * the view's own ink is not. */
  readonly opaque?:boolean;
}
// Heterogeneous meshes intentionally expose an attribute map at this boundary;
// a single mesh overload preserves its precise face-column types.
type AnyMesh=Mesh<any,any,any,any>;
type ViewGeometry=SurfaceCurves<any>|AnyMesh|CurveGeometry<any,any>|Instances<any,any,any,any,any,any,any>;
/** Lists nest to any depth: a view takes what the sketch already holds
 * (`[boxes, style(intersections(boxes), ...)]`) without flattening by hand. */
export type ViewInput=ViewGeometry|readonly ViewInput[];
const flattenGeometry=(value:ViewInput):ViewGeometry[]=>Array.isArray(value)?(value as readonly ViewInput[]).flatMap(flattenGeometry):[value as ViewGeometry];
export function view<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(geometry:Mesh<P,E,F,C>,options:ViewOptions<F>,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,A extends Attributes3,S extends Attributes3,R extends PointRow<{}>,C extends Attributes3>(geometry:Instances<P,E,F,A,S,R,C>,options:ViewOptions<F>,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view(geometry:SurfaceCurves<any>|CurveGeometry<any,any>,options:ViewOptions,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view(geometry:readonly ViewInput[],options:ViewOptions,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view(geometry:ViewInput,options:ViewOptions<any>,draw?:(lines:ProjectedLines)=>Tree):Drawing3 {
  const settings=captureValue(options),crease=clampSetting(settings.creaseAngle,0,180,30,'view creaseAngle');
  const recipes:readonly ViewHatch<any>[]=settings.hatch?(Array.isArray(settings.hatch)?settings.hatch:[settings.hatch]):[];
  const hatchKeys=recipes.map((r,i)=>r.key??(Array.isArray(settings.hatch)?`hatch:${i}`:'hatch'));
  const planes=settings.sections??[],sectionKeys=planes.map((p,i)=>p.key??`section:${i}`);
  for(const [kind,keys] of [['hatch',hatchKeys],['section',sectionKeys]] as const){
    if(keys.some(k=>typeof k!=='string'||!k)||new Set(keys).size!==keys.length)throw new Error(`view ${kind} keys must be nonempty and unique`);
  }
  const meshes=flattenGeometry(geometry);
  // An object's own suggestive reading wins over the view's; `false` in either
  // place, which is the default, draws none.
  const suggestiveOf=(mesh:{readonly suggestive?:SuggestiveInput}):{suggestive:{readonly threshold?:number}}|undefined=>{
    const value=mesh.suggestive??settings.suggestive;return value?{suggestive:value}:undefined;
  };
  const objects:SurfaceObject3[]=[],supported:SurfaceCurveObject3[]=[];
  const geometryKeys=new Set<string>(),seen=new Set<ViewGeometry>();
  meshes.forEach((value:ViewGeometry,index:number)=>{
    // The same value listed twice (a nested list of the same meshes, say) is
    // one drawing of it, not two: a view draws each value once. Copies are
    // placed with instances.
    if(seen.has(value))return;seen.add(value);
    if(!(value instanceof Mesh)&&!(value instanceof Instances)&&!(value instanceof CurveGeometry)&&!(value instanceof SurfaceCurves))throw new Error('view requires mesh, curve or instance geometry');
    const id=value.key??`object:${index}`;
    if(geometryKeys.has(id))throw new Error('view geometry keys must be unique');geometryKeys.add(id);
    if(value instanceof SurfaceCurves){
      // Described curves stay a description here: the drawing resolves them
      // among the objects it keeps, so seams of culled objects are never made.
      const attributes=value.stroke?{attributes:{stroke:value.stroke}}:{};
      supported.push(value.recipe?{id,recipe:value.recipe,...attributes}:{id,network:value.network,...attributes});return;
    }
    // A curve's own pen is its own, the same way a mesh's is.
    if(value instanceof CurveGeometry){objects.push({id,surface:value.surface,occluder:false,...(value.stroke!==undefined?{stroke:value.stroke}:{})});return;}
    const mesh=value instanceof Instances?value.prototype:value;
    const faces=mesh.faces;
    // Eligibility belongs to the prototype; the hatch lattice is resolved on
    // each transformed surface in the existing renderer.
    const hatch=recipes.length?hatch3(mesh.surface,face=>{
      const row=faces.at(face.index)!;
      return recipes.flatMap((recipe,i)=>{
        if(recipe.select&&!recipe.select(row))return [];
        const stroke=recipe.stroke===undefined?undefined:evaluate(recipe.stroke,row);
        if(stroke!==undefined&&(typeof stroke!=='string'||!stroke))throw new Error('hatch stroke must be a nonempty pen name');
        return [{id:hatchKeys[i],spacing:evaluate(recipe.spacing,row),angle:evaluate(recipe.angle??45,row),offset:recipe.offset===undefined?undefined:evaluate(recipe.offset,row),...(stroke===undefined?{}:{attributes:{stroke}})}];
      });
    }):undefined;
    const curves=planes.length?section3(mesh.surface,planes.map((p,i)=>({id:sectionKeys[i],origin:p.origin,normal:p.normal,attributes:p.attributes}))):undefined;
    if(value instanceof Instances){
      for(const row of value.rows)objects.push({id:JSON.stringify([id,row.id]),surface:mesh.surface,...(mesh.radialCentre?{radialCentre:mesh.radialCentre}:{}),...(mesh.creaseAngle!==undefined?{creaseThreshold:mesh.creaseAngle}:{}),...(mesh.stroke!==undefined?{stroke:mesh.stroke}:{}),...(mesh.fillPen!==undefined?{fillPen:mesh.fillPen}:{}),...suggestiveOf(mesh),binding:instanceSurfaceBinding3(value,row),hatch,curves,transform:row.transform,attributes:row.attributes,instance:{id:row.id,pointId:row.source.id,pointIndex:row.source.index,prototypeKey:mesh.key}});
    }else objects.push({id,surface:mesh.surface,hatch,curves,...(mesh.radialCentre?{radialCentre:mesh.radialCentre}:{}),...(mesh.creaseAngle!==undefined?{creaseThreshold:mesh.creaseAngle}:{}),...(mesh.stroke!==undefined?{stroke:mesh.stroke}:{}),...(mesh.fillPen!==undefined?{fillPen:mesh.fillPen}:{}),...suggestiveOf(mesh)});
  });
  if(new Set(objects.map(o=>o.id)).size!==objects.length)throw new Error('view geometry keys must be unique');
  const scene=lineArt3({id:settings.key,objects,curves:supported,camera:settings.camera,viewport:settings.viewport,lineSets:[]});
  // A fold flatter than its object's crease angle (the view's when the object
  // has none) is not a line of this view, visible or hidden, so the callback
  // sees the folds the default ink draws. A row that is also something else
  // (a boundary, a marked edge) stays, and answers to that kind.
  const line=(c:{kinds:ReadonlySet<string>;feature:{creaseAngle:number;creaseThreshold?:number}})=>!c.kinds.has('crease')||c.feature.creaseAngle>=(c.feature.creaseThreshold??crease)||c.kinds.size>1;
  return drawing3(scene,(classified,paper)=>{
    const all=projectedLines(classified),lines:ProjectedLines=Object.freeze({visible:all.visible.filter(line),hidden:all.hidden.filter(line)});
    const ink=draw?draw(lines):defaultInk(lines);
    return settings.opaque?[paper.mask3(classified),ink]:ink;
  });
  function defaultInk(lines:ProjectedLines):Tree{
    // Generated marks may name their own pen through a `stroke` attribute (hatch
    // families); everything else follows the view's stroke.
    const generated=(c:{kinds:ReadonlySet<string>})=>c.kinds.has('mapped')||c.kinds.has('trace')||c.kinds.has('isoline')||c.kinds.has('intersection');
    // The pen of an ordinary line: the curve value's own (generated marks), else
    // the object's own, else the view's.
    const penOf=(c:{kinds:ReadonlySet<string>;attributes:Attributes3;feature:{stroke?:string}})=>typeof c.attributes.stroke==='string'&&generated(c)?c.attributes.stroke:c.feature.stroke??settings.stroke;
    const ordinary=lines.visible.filter(c=>c.kinds.has('boundary')||c.kinds.has('silhouette')||c.kinds.has('wire')||c.kinds.has('intersection')||c.kinds.has('mapped')||c.kinds.has('trace')||c.kinds.has('isoline')||c.kinds.has('suggestive')||(c.kinds.has('crease')&&c.feature.creaseAngle>=(c.feature.creaseThreshold??crease)));
    // The view's pen leads, then the others by name: the order strokes are emitted is the order they are planned.
    const pens=[settings.stroke,...[...new Set([...ordinary].map(penOf))].filter(p=>p!==settings.stroke).sort()];
    return [
      ...pens.map(pen=>projectedStrokes(ordinary.filter(c=>penOf(c)===pen),{stroke:pen})),
      ...recipes.flatMap((recipe,i)=>{const family=lines.visible.filter(c=>c.kinds.has('hatch')&&c.attributes.hatchFamily===hatchKeys[i]);const hatchPen=(c:{attributes:Attributes3;feature:{stroke?:string;fillPen?:string}})=>typeof c.attributes.stroke==='string'?c.attributes.stroke:c.feature.fillPen??c.feature.stroke??settings.stroke;return [...new Set([...family].map(hatchPen))].sort().map(pen=>projectedStrokes(family.filter(c=>hatchPen(c)===pen),{stroke:pen}));}),
      ...planes.map((plane,i)=>projectedStrokes(lines.visible.filter(c=>c.kinds.has('section')&&c.attributes.sectionPlane===sectionKeys[i]),{stroke:plane.stroke??settings.stroke})),
    ];
  }
}
