import type {L} from '../../units.js';
import type {FillSpec} from '../../fills.js';
import type {Attributes3} from '../geometry/surface.js';
import type {Field} from './mesh.js';
import {Selection} from '../../selection.js';
import type {Face} from '../../faces.js';

/** The 2D words for a pen, said once for every 3D option record: a record
 * that names a pen names it `pen`. `stroke` is the 2D outline switch; in
 * these records it only ever named a pen, so it is refused by name. */
export function refuseStroke(options:unknown,who:string):void {
  if(!options||typeof options!=='object'||!('stroke' in options))return;
  const value=(options as {stroke?:unknown}).stroke;
  if(value===undefined)return;
  const hint=typeof value==='string'?`{ pen: '${value}' }`:'{ pen }';
  throw new Error(`${who}: \`stroke\` is the 2D outline switch — name the pen with \`pen\`: ${hint}`);
}

/** How an object is drawn is the view's to say, never the value's: a
 * display word in a geometry's options is refused by name, with the one
 * spelling that says it. */
const DISPLAY_WORDS=['pen','fillPen','creaseAngle','suggestive','hatch'] as const;
/** @internal Refuse a display word in the options of a 3D value. */
export function refuseDisplay(options:unknown,who:string):void {
  if(!options||typeof options!=='object')return;
  for(const word of DISPLAY_WORDS)if((options as Record<string,unknown>)[word]!==undefined)
    throw new Error(`${who}: \`${word}\` is how the view draws an object, not part of the geometry — give it in the view: view([[value, { ${word}: … }], …], options)`);
}
/** The face row a hatch recipe reads: the mesh's own row, so a selection's
 * `has(f)` answers for it. */
export type HatchRow<F extends Attributes3>=Face&Face;
/** One view hatch recipe: parallel lines on the faces it selects. Per-face
 * fields read the mesh's own face row. */
export interface ViewHatch<F extends Attributes3=Attributes3> {
  readonly key?:string;
  readonly spacing:Field<HatchRow<F>,L>;readonly angle?:Field<HatchRow<F>,number>;readonly offset?:Field<HatchRow<F>,L>;
  /** The pen for this recipe's lines: a name, or a field over the face row
   * (`f => f.ring ? 'red' : 'fine'`). Unset: the object's `fillPen`, then its
   * `pen`, then the view's. */
  readonly pen?:Field<HatchRow<F>,string>;
  /** The faces the recipe hatches: a face selection of the mesh, or a test on
   * its face rows. Unset: every face. */
  readonly select?:Selection<any>|((face:HatchRow<F>)=>unknown);
}
/** What a `hatch` option takes: a recipe, the 2D `fill('hatch', …)` or
 * `fill('crosshatch', …)`, or a list of them. */
export type ViewHatchInput<F extends Attributes3=Attributes3>=ViewHatch<F>|FillSpec|readonly (ViewHatch<F>|FillSpec)[];

/** A recipe as the view reads it: one pattern, its key and its face test. */
export interface HatchRecipe {
  readonly key:string;
  readonly spacing:Field<any,L>;readonly angle:Field<any,number>;readonly offset?:Field<any,L>;
  readonly pen?:Field<any,string>;readonly select?:(face:Face)=>boolean;
}

const isFillSpec=(value:unknown):value is FillSpec=>!!value&&typeof value==='object'&&typeof (value as {type?:unknown}).type==='string'&&['use','asset','custom','mask'].includes((value as {type:string}).type);

/** A 2D hatch fill read as view recipes: `fill('hatch')` is one, and
 * `fill('crosshatch')` one per angle. The view lays lines on each face in
 * its own chart, so a spacing field of the paper, `align` and `step` have no
 * reading here and are refused by name, as is any other fill. */
function fillRecipes(spec:FillSpec,who:string):Omit<HatchRecipe,'key'>[] {
  if(spec.type!=='use'||(spec.name!=='hatch'&&spec.name!=='crosshatch'))throw new Error(`${who}: a view hatch draws parallel lines — it takes fill('hatch', …) or fill('crosshatch', …), not ${spec.type==='use'?`fill('${spec.name}')`:`a ${spec.type} fill`}`);
  const {spacing,angle,angles,offset,...rest}=spec.params as {spacing?:unknown;angle?:unknown;angles?:unknown;offset?:unknown};
  const other=Object.keys(rest);
  if(other.length)throw new Error(`${who}: fill('${spec.name}') here takes spacing, ${spec.name==='hatch'?'angle':'angles'} and offset; '${other[0]}' has no reading on a surface`);
  if(spacing===undefined)throw new Error(`${who}: fill('${spec.name}') needs a spacing here — fill('${spec.name}', { spacing: mm(1.5) })`);
  if(typeof spacing==='function')throw new Error(`${who}: a spacing field of the paper has no reading on a surface — give a length, or a recipe { spacing: f => … } that reads the face`);
  const one=(a:number)=>({spacing:spacing as L,angle:a,...(offset!==undefined?{offset:offset as L}:{})});
  if(spec.name==='hatch')return [one((angle as number|undefined)??0)];
  return ((angles as number[]|undefined)??[0,90]).map(one);
}

function recipeOf(value:ViewHatch<any>,who:string):Omit<HatchRecipe,'key'>&{key?:string} {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(`${who}: a hatch recipe is a record or fill('hatch', …)`);
  refuseStroke(value,`${who} recipe`);
  const select=value.select;
  let test:HatchRecipe['select'];
  if(select instanceof Selection){
    if(select.domain.kind.name!=='face')throw new Error(`${who}: select takes a face selection, got a ${select.domain.kind.name} selection`);
    test=face=>select.has(face);
  }else if(select!==undefined){
    if(typeof select!=='function')throw new Error(`${who}: select takes a face selection or a test on the face rows`);
    test=face=>!!(select as (f:unknown)=>unknown)(face);
  }
  return {...(value.key!==undefined?{key:value.key}:{}),spacing:value.spacing,angle:value.angle??45,...(value.offset!==undefined?{offset:value.offset}:{}),...(value.pen!==undefined?{pen:value.pen}:{}),...(test?{select:test}:{})};
}

/** Every recipe a `hatch` option names, keyed as the view has always keyed
 * them: a lone recipe is `hatch` (or `${prefix}`), a list's are
 * `hatch:0`, `hatch:1`, … unless a recipe names its own key. */
export function hatchRecipes(input:ViewHatchInput<any>|undefined,who:string,prefix='hatch'):readonly HatchRecipe[] {
  if(input===undefined)return [];
  const listed=Array.isArray(input);
  const entries=(listed?input as readonly (ViewHatch<any>|FillSpec)[]:[input as ViewHatch<any>|FillSpec]).flatMap(value=>isFillSpec(value)?fillRecipes(value,who):[recipeOf(value as ViewHatch<any>,who)]);
  const several=listed||entries.length>1;
  const recipes=entries.map((r,i)=>Object.freeze({...r,key:(r as {key?:string}).key??(several?`${prefix}:${i}`:prefix)}) as HatchRecipe);
  const keys=recipes.map(r=>r.key);
  if(keys.some(k=>typeof k!=='string'||!k)||new Set(keys).size!==keys.length)throw new Error(`${who}: hatch keys must be nonempty and unique`);
  return Object.freeze(recipes);
}
