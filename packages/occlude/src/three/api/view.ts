import type {Tree} from '../../api.js';
import type {L} from '../../units.js';
import type {Attributes3,Surface3} from '../geometry/surface.js';
import {cameraFrame3,type Camera3,type PaperFrame3} from '../camera.js';
import {sub3,type Vec3} from '../math.js';
import {clampSetting} from '../degenerate.js';
import {lineArt3} from '../scene.js';
import {drawing3,type Drawing3} from '../drawing.js';
import {hatch3} from '../curves/hatch.js';
import {section3} from '../curves/section.js';
import {mesh,type EdgeAttributes} from './mesh.js';
import {evaluate} from './columns.js';
import {hasFaces,surfaceOf,rowName} from '../geometry/value.js';
import {viewKind} from '../../views.js';
import {prototypeOf,placedOf} from './instances.js';
import {SurfaceCurves} from './supported.js';
import type {SurfaceCurveObject3} from '../curves/network.js';
import type {SurfaceObject3} from '../features/snapshot.js';
import {projectedLines,projectedStrokes,captureValue,type ProjectedLines} from './projected.js';
import {refuseStroke,hatchRecipes,type HatchRecipe,type ViewHatchInput} from './recipes.js';
import {Material,type Vertex} from '../../material.js';
export type {ViewHatch,ViewHatchInput} from './recipes.js';
export interface CameraOptions {readonly eye:Vec3;readonly target?:Vec3;readonly up?:Vec3;readonly near?:number;readonly far?:number}
export function orthographic(options:CameraOptions&{readonly span?:number}):Extract<Camera3,{kind:'orthographic'}>{
  const target=options.target??[0,0,0],span=options.span??6;
  return cameraFrame3({...options,kind:'orthographic',target,span,near:options.near??.1,far:options.far??Math.max(100,4*Math.hypot(...sub3(options.eye,target))+2*span)},{x:0,y:0,width:1,height:1}).camera as Extract<Camera3,{kind:'orthographic'}>;
}
/** A perspective camera. `shift` moves its frame off the optical axis, as a
 * fraction of the frame, right and up: `[0, 0.4]` raises the frame by four
 * tenths of its height, so what is drawn moves down the page by the same
 * amount. The eye and the direction of view do not move, so a level camera
 * keeps world verticals parallel while the frame covers what a tilt would
 * otherwise have to reach — the architect's two-point view. No shift, or
 * `[0, 0]`, is the centred frame. */
export function perspective(options:CameraOptions&{readonly fovDegrees?:number;readonly shift?:readonly [number,number]}):Camera3{
  const target=options.target??[0,0,0],{shift,...rest}=options;
  const common={...rest,target,fovDegrees:options.fovDegrees??45,near:options.near??.1,far:options.far??Math.max(100,4*Math.hypot(...sub3(options.eye,target)))};
  // A shifted frame is the camera kind the renderer calls oblique; a zero
  // shift is the centred frame, the same camera as no shift at all.
  const camera=shift!==undefined&&(shift[0]!==0||shift[1]!==0)?{...common,kind:'oblique' as const,shift}:{...common,kind:'perspective' as const};
  return cameraFrame3(camera,{x:0,y:0,width:1,height:1}).camera;
}
/** Planes are in the mesh/prototype's model coordinates; instances transform
 * the resulting section with their geometry. They are not world cutting planes. */
export interface ViewSection {
  readonly key?:string;readonly origin:Vec3;readonly normal:Vec3;
  /** The pen for this plane's lines; unset, the view's. */
  readonly pen?:string;
  /** Columns of this plane's lines, read as properties on each. */
  readonly columns?:Attributes3;
}
/** Off, or on with the reading's own threshold. */
export type SuggestiveInput={readonly threshold?:number}|false;
/** How the view draws one object, written beside it in the view's list as
 * `[value, { … }]`: its pen, the pen of its hatch, its crease threshold, its
 * suggestive contours and its hatch. A field it names wins over the view's
 * for that object; a list in the pair gives every object in it the same
 * options, and an inner pair's fields win over an outer one's. Curves take
 * only `pen`. */
export interface ViewObjectOptions<F extends Attributes3=Attributes3> {
  /** The pen for this object's lines. A hatch recipe's own `pen` still wins. */
  readonly pen?:string;
  /** The pen for this object's hatch where the recipe names none (2D `fillPen`). */
  readonly fillPen?:string;
  /** This object's crease threshold in degrees: a fold is drawn when its
   * angle reaches it. 180 draws no creases, 0 draws every fold. */
  readonly creaseAngle?:number;
  /** This object's suggestive contours: `{}` or `{ threshold }` draws them,
   * `false` draws none. */
  readonly suggestive?:SuggestiveInput;
  /** This object's hatch, in place of the view's: a recipe,
   * `fill('hatch', …)`, `fill('crosshatch', …)`, or a list. */
  readonly hatch?:ViewHatchInput<F>;
}
export interface ViewOptions<F extends Attributes3=Attributes3> {
  /** The pen for everything that names none of its own. */
  readonly camera:Camera3;readonly pen?:string;readonly key?:string;readonly viewport?:PaperFrame3;
  /** Default crease threshold in degrees (30) for objects without their own.
   * A fold flatter than it is not a line of the view, in the default ink and
   * in the callback's `lines` alike. Silhouettes remain visible. */
  readonly creaseAngle?:number;
  /** Suggestive contours for objects without their own reading: `false` (the
   * default) draws none, `{}` or `{ threshold }` draws them. */
  readonly suggestive?:SuggestiveInput;
  /** Hatch for every object without its own (`[value, { hatch }]`): a
   * recipe, `fill('hatch', …)`, `fill('crosshatch', …)`, or a list. */
  readonly hatch?:ViewHatchInput<F>;
  readonly sections?:readonly ViewSection[];
  /** A view is ink, not an occluder: unset, it hides nothing drawn before it.
   * `true` makes the paper its solids cover opaque in paint order, the same
   * word as `polygon`'s — what was drawn before the view is hidden there, and
   * the view's own ink is not. */
  readonly opaque?:boolean;
}
// Heterogeneous meshes intentionally expose an attribute map at this boundary;
// a single mesh overload preserves its precise face-column types.
type AnyMesh=Material;
type ViewGeometry=SurfaceCurves<any>|AnyMesh|Material|Surface3;
/** Lists nest to any depth: a view takes what the sketch already holds
 * (`[boxes, intersections(boxes)]`) without flattening by hand. A pair
 * `[value, { pen, … }]` says how the view draws that value, or every value
 * in a list. */
export type ViewInput=ViewGeometry|readonly ViewInput[]|readonly [ViewInput,ViewObjectOptions<any>];
// A surface from the advanced stage (`box3`, `surface3`) is a mesh here.
const surfaces=new WeakMap<Surface3,AnyMesh>();
const isSurface3=(value:unknown):value is Surface3=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Array.isArray((value as Surface3).points)&&Array.isArray((value as Surface3).faces);
const asMesh=(value:ViewGeometry):Exclude<ViewGeometry,Surface3>=>{
  if(!isSurface3(value))return value as Exclude<ViewGeometry,Surface3>;
  let m=surfaces.get(value);if(!m){m=mesh(value);surfaces.set(value,m);}
  return m;
};
/** A record of drawing options, not geometry: the second half of a pair. */
const isObjectOptions=(value:unknown):boolean=>{
  if(!value||typeof value!=='object'||Array.isArray(value)||isSurface3(value))return false;
  const proto=Object.getPrototypeOf(value);
  return proto===Object.prototype||proto===null;
};
const OBJECT_WORDS=new Set(['pen','fillPen','creaseAngle','suggestive','hatch']);
const MESH_WORDS=['fillPen','creaseAngle','suggestive','hatch'] as const;
function checkedSuggestive(value:SuggestiveInput|undefined,who:string):SuggestiveInput|undefined {
  if(value===undefined||value===false)return value;
  if(typeof value!=='object'||Array.isArray(value))throw new Error(`${who}: suggestive must be false or { threshold }`);
  return Object.freeze({...value});
}
function checkedPen(value:unknown,name:string,who:string):string|undefined {
  if(value!==undefined&&(typeof value!=='string'||!value))throw new Error(`${who}: ${name} must be a nonempty pen name`);
  return value as string|undefined;
}
/** One pair's options, checked once: every word the view knows, and each
 * refused by name if it is not one. */
function objectOptions(value:ViewObjectOptions<any>):ViewObjectOptions<any> {
  const who='view object options';
  refuseStroke(value,who);
  for(const name of Object.keys(value))if(!OBJECT_WORDS.has(name))throw new Error(`${who}: '${name}' is not a way to draw an object — [value, { pen, fillPen, creaseAngle, suggestive, hatch }]`);
  checkedPen(value.pen,'pen',who);checkedPen(value.fillPen,'fillPen',who);
  const creaseAngle=value.creaseAngle===undefined?undefined:clampSetting(value.creaseAngle,0,180,30,'creaseAngle');
  if(value.hatch!==undefined)hatchRecipes(value.hatch,'object hatch');
  const suggestive=checkedSuggestive(value.suggestive,who);
  return Object.freeze({...value,...(creaseAngle!==undefined?{creaseAngle}:{}),...(suggestive!==undefined?{suggestive}:{})});
}
interface Drawn {readonly value:Exclude<ViewGeometry,Surface3>;readonly options:ViewObjectOptions<any>}
const NONE:ViewObjectOptions<any>=Object.freeze({});
const isCurves=(value:unknown):boolean=>((value instanceof Material)&&prototypeOf(value)===undefined&&!hasFaces(value))||value instanceof SurfaceCurves;
/** Every value a view draws, in list order, each with the options the pairs
 * around it give it (the inner pair's fields win). */
function flattenGeometry(value:ViewInput,options:ViewObjectOptions<any>=NONE,out:Drawn[]=[]):Drawn[] {
  if(!Array.isArray(value)){out.push({value:asMesh(value as ViewGeometry),options});return out;}
  const list=value as readonly unknown[];
  if(list.length===2&&isObjectOptions(list[1])){
    const own=objectOptions(list[1] as ViewObjectOptions<any>),from=out.length;
    flattenGeometry(list[0] as ViewInput,options===NONE?own:Object.freeze({...options,...own}),out);
    // A pair of curves alone that names what only a surface has is a
    // mistake; in a mixed list, those words are for the surfaces in it.
    const drawn=out.slice(from);
    const word=MESH_WORDS.find(w=>own[w]!==undefined);
    if(word&&drawn.length&&drawn.every(d=>isCurves(d.value)))throw new Error(`view object options: curves take only a pen — ${word} belongs to meshes`);
    return out;
  }
  for(const item of list)flattenGeometry(item as ViewInput,options,out);
  return out;
}
/** Two readings of suggestive contours say the same: both off, or both on
 * with one threshold. */
const sameSuggestive=(a:SuggestiveInput|undefined,b:SuggestiveInput|undefined):boolean=>
  a===b||(typeof a==='object'&&typeof b==='object'&&a.threshold===b.threshold);
const sameOptions=(a:ViewObjectOptions<any>,b:ViewObjectOptions<any>):boolean=>
  a.pen===b.pen&&a.fillPen===b.fillPen&&a.creaseAngle===b.creaseAngle&&sameSuggestive(a.suggestive,b.suggestive)&&a.hatch===b.hatch;
export function view<P extends Attributes3,E extends EdgeAttributes,F extends Attributes3,C extends Attributes3>(geometry:Material,options:ViewOptions<F>,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view(geometry:SurfaceCurves<any>|Material,options:ViewOptions,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view(geometry:ViewInput,options:ViewOptions,draw?:(lines:ProjectedLines)=>Tree):Drawing3;
export function view(geometry:ViewInput,options:ViewOptions<any>,draw?:(lines:ProjectedLines)=>Tree):Drawing3 {
  refuseStroke(options,'view');
  const settings=captureValue(options),crease=clampSetting(settings.creaseAngle,0,180,30,'view creaseAngle');
  const recipes=hatchRecipes(settings.hatch,'view hatch');
  const planes=settings.sections??[],sectionKeys=planes.map((p,i)=>p.key??`section:${i}`);
  planes.forEach(p=>{refuseStroke(p,'view section');if((p as {attributes?:unknown}).attributes!==undefined)throw new Error('view section: its columns are `columns` — { origin, normal, columns: { … } }');});
  if(sectionKeys.some(k=>typeof k!=='string'||!k)||new Set(sectionKeys).size!==sectionKeys.length)throw new Error('view section keys must be nonempty and unique');
  // An object's own recipes (`[value, { hatch }]`) replace the view's for
  // that object. Their families are keyed apart from the view's, in the order
  // the objects come, so the default ink draws each family once.
  const families:string[]=recipes.map(r=>r.key);
  const ownRecipes=new Map<object,Map<unknown,readonly HatchRecipe[]>>();let ownFamilies=0;
  const recipesOf=(mesh:Material,hatch:ViewHatchInput<any>|undefined):readonly HatchRecipe[]=>{
    if(hatch===undefined)return recipes;
    let byInput=ownRecipes.get(mesh);if(!byInput){byInput=new Map();ownRecipes.set(mesh,byInput);}
    let own=byInput.get(hatch);
    if(!own){
      const prefix=`style:${ownFamilies++}`;
      own=hatchRecipes(hatch,'object hatch',prefix).map(r=>Object.freeze({...r,key:r.key.startsWith(prefix)?r.key:`${prefix}/${r.key}`}));
      byInput.set(hatch,own);families.push(...own.map(r=>r.key));
    }
    return own;
  };
  const drawn=flattenGeometry(geometry);
  // An object's own suggestive reading wins over the view's; `false` in either
  // place, which is the default, draws none.
  const suggestiveOf=(own:ViewObjectOptions<any>):{suggestive:{readonly threshold?:number}}|undefined=>{
    const value=own.suggestive??settings.suggestive;return value?{suggestive:value}:undefined;
  };
  // What an object's own options say about how it is drawn, in the words the
  // scene reads.
  const drawing=(own:ViewObjectOptions<any>)=>({...(own.creaseAngle!==undefined?{creaseThreshold:own.creaseAngle}:{}),...(own.pen!==undefined?{stroke:own.pen}:{}),...(own.fillPen!==undefined?{fillPen:own.fillPen}:{}),...suggestiveOf(own)});
  const objects:SurfaceObject3[]=[],supported:SurfaceCurveObject3[]=[];
  const geometryKeys=new Set<string>(),seen=new Map<ViewGeometry,ViewObjectOptions<any>>();
  drawn.forEach(({value,options:own},index)=>{
    // The same value listed twice (a nested list of the same meshes, say) is
    // one drawing of it, not two: a view draws each value once. Copies are
    // placed with instances, so two ways to draw one value is a mistake.
    const before=seen.get(value);
    if(before){if(!sameOptions(before,own))throw new Error('view: one value is listed twice with two ways to draw it — a view draws each value once; place copies with instanceOnPoints');return;}
    seen.set(value,own);
    if(!(value instanceof Material)&&!(value instanceof SurfaceCurves))throw new Error('view requires mesh, curve or instance geometry');
    const id=value.key??`object:${index}`;
    if(geometryKeys.has(id))throw new Error('view geometry keys must be unique');geometryKeys.add(id);
    if(value instanceof SurfaceCurves){
      // Described curves stay a description here: the drawing resolves them
      // among the objects it keeps, so seams of culled objects are never made.
      const attributes=own.pen?{attributes:{pen:own.pen}}:{};
      supported.push(value.recipe?{id,recipe:value.recipe,...attributes}:{id,network:value.network,...attributes});return;
    }
    // Instances draw their prototype at every copy.
    const prototype=prototypeOf(value);
    // A curve's own pen is its own, the same way a mesh's is.
    if(prototype===undefined&&!hasFaces(value)){objects.push({id,surface:surfaceOf(value),occluder:false,...(own.pen!==undefined?{stroke:own.pen}:{})});return;}
    const mesh=prototype??value;
    const faces=mesh.faces;
    // Eligibility belongs to the prototype; the hatch lattice is resolved on
    // each transformed surface in the existing renderer.
    const recipesHere=recipesOf(mesh,own.hatch);
    const hatch=recipesHere.length?hatch3(surfaceOf(mesh),face=>{
      const row=faces.at(face.index)!;
      return recipesHere.flatMap(recipe=>{
        if(recipe.select&&!recipe.select(row))return [];
        const pen=recipe.pen===undefined?undefined:evaluate(recipe.pen,row);
        if(pen!==undefined&&(typeof pen!=='string'||!pen))throw new Error('hatch pen must be a nonempty pen name');
        return [{id:recipe.key,spacing:evaluate(recipe.spacing,row),angle:evaluate(recipe.angle,row),offset:recipe.offset===undefined?undefined:evaluate(recipe.offset,row),...(pen===undefined?{}:{attributes:{pen}})}];
      });
    }):undefined;
    const curves=planes.length?section3(surfaceOf(mesh),planes.map((p,i)=>({id:sectionKeys[i],origin:p.origin,normal:p.normal,attributes:p.columns}))):undefined;
    if(prototype!==undefined){
      for(const copy of placedOf(value)){
        const at=copy.source as {readonly index:number};
        objects.push({id:JSON.stringify([id,copy.id]),surface:surfaceOf(mesh),...(mesh.radialCentre?{radialCentre:mesh.radialCentre}:{}),...drawing(own),binding:copy.binding,hatch,curves,transform:copy.transform,attributes:copy.attributes,instance:{id:copy.id,pointId:rowName(at,viewKind(at)==='face'?'faces':'points'),pointIndex:at.index,prototypeKey:mesh.key}});
      }
    }else objects.push({id,surface:surfaceOf(mesh),hatch,curves,...(mesh.radialCentre?{radialCentre:mesh.radialCentre}:{}),...drawing(own)});
  });
  if(new Set(objects.map(o=>o.id)).size!==objects.length)throw new Error('view geometry keys must be unique');
  const scene=lineArt3({id:settings.key,objects,curves:supported,camera:settings.camera,viewport:settings.viewport,lineSets:[]});
  // A fold flatter than its object's crease angle (the view's when the object
  // has none) is not a line of this view, visible or hidden, so the callback
  // sees the folds the default ink draws. A row that is also something else
  // (a boundary, a marked edge) stays, and answers to that kind.
  const line=(c:{kinds:ReadonlySet<string>;feature:{creaseAngle:number;creaseThreshold?:number}})=>!c.kinds.has('crease')||c.feature.creaseAngle>=(c.feature.creaseThreshold??crease)||c.kinds.size>1;
  return drawing3(scene,(classified,paper)=>{
    const all=projectedLines(classified,paper.toUser),lines:ProjectedLines=Object.freeze({visible:all.visible.filter(line),hidden:all.hidden.filter(line),stats:all.stats});
    const ink=draw?draw(lines):defaultInk(lines);
    return settings.opaque?[paper.mask3(classified),ink]:ink;
  });
  function defaultInk(lines:ProjectedLines):Tree{
    // Generated marks may name their own pen through a `pen` column (hatch
    // families); everything else follows the view's pen.
    const generated=(c:{kinds:ReadonlySet<string>})=>c.kinds.has('mapped')||c.kinds.has('trace')||c.kinds.has('isoline')||c.kinds.has('intersection');
    // The pen of an ordinary line: the curve value's own (generated marks), else
    // the object's own, else the view's.
    const penOf=(c:{kinds:ReadonlySet<string>;feature:{attributes:Attributes3;stroke?:string}})=>typeof c.feature.attributes.pen==='string'&&generated(c)?c.feature.attributes.pen:c.feature.stroke??settings.pen;
    const ordinary=lines.visible.filter(c=>c.kinds.has('boundary')||c.kinds.has('silhouette')||c.kinds.has('wire')||c.kinds.has('intersection')||c.kinds.has('mapped')||c.kinds.has('trace')||c.kinds.has('isoline')||c.kinds.has('suggestive')||(c.kinds.has('crease')&&c.feature.creaseAngle>=(c.feature.creaseThreshold??crease)));
    // The view's pen leads, then the others by name: the order strokes are emitted is the order they are planned.
    const pens=[settings.pen,...[...new Set([...ordinary].map(penOf))].filter(p=>p!==settings.pen).sort()];
    return [
      ...pens.map(pen=>projectedStrokes(ordinary.filter(c=>penOf(c)===pen),{stroke:pen})),
      ...families.flatMap(key=>{const family=lines.visible.filter(c=>c.kinds.has('hatch')&&c.feature.attributes.hatchFamily===key);const hatchPen=(c:{feature:{attributes:Attributes3;stroke?:string;fillPen?:string}})=>typeof c.feature.attributes.pen==='string'?c.feature.attributes.pen:c.feature.fillPen??c.feature.stroke??settings.pen;return [...new Set([...family].map(hatchPen))].sort().map(pen=>projectedStrokes(family.filter(c=>hatchPen(c)===pen),{stroke:pen}));}),
      ...planes.map((plane,i)=>projectedStrokes(lines.visible.filter(c=>c.kinds.has('section')&&c.feature.attributes.sectionPlane===sectionKeys[i]),{stroke:plane.pen??settings.pen})),
    ];
  }
}
