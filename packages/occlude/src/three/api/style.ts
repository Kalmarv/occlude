import {Mesh,type Style3} from './mesh.js';
import {Instances} from './instances.js';
import {SurfaceCurves} from './supported.js';

export type Styleable=Mesh<any,any,any,any>|Instances<any,any,any,any,any,any,any>|SurfaceCurves<any>;
type Leaf<T>=T extends readonly (infer U)[]?Leaf<U>:T;
/** A list in, a flat list out (nested lists flatten); a value in, that value out. */
type Styled<T>=T extends readonly (infer U)[]?Leaf<U>[]:T;

/** One place to say how things are drawn: `style(geometry, { stroke, fillPen,
 * creaseAngle })` returns the same shape it was given, a value or a list of
 * them (nested lists flatten as `view` does), with the fields named set and
 * the rest kept. Curves take only `stroke`. Factory options are the same
 * style at birth; the view's `stroke` is the default for anything unstyled. */
export function style<T extends Styleable|readonly (Styleable|readonly Styleable[])[]>(geometry:T,style:Style3):Styled<T> {
  if(Array.isArray(geometry))return (geometry as readonly unknown[]).flat(Infinity).map(g=>styleOne(g,style)) as Styled<T>;
  return styleOne(geometry,style) as Styled<T>;
}
function styleOne(value:unknown,s:Style3):Styleable {
  if(value instanceof Mesh||value instanceof Instances)return value.style(s);
  if(value instanceof SurfaceCurves){
    if(s.fillPen!==undefined||s.creaseAngle!==undefined||s.suggestive!==undefined)throw new Error('curves take only a stroke: fillPen, creaseAngle and suggestive belong to meshes');
    return value.style(s);
  }
  throw new Error('style takes meshes, instances, supported curves, or a list of them');
}
