import { stroke, type ShapeValue } from '../../api.js';
import type { ModifierValue } from '../../shapes.js';
import { mm, type L } from '../../units.js';
import type { Stroke3 } from './construct.js';
import { unionSourceRanges3 } from './ranges.js';
/** One complete reference polyline per pen. Visibility is a source selection,
 * so modifier distances and samples survive cuts. The frame is supplied by
 * the interpretation boundary, never inferred from captured geometry. */
export function sourceStrokeShapes3(runs:readonly Stroke3[], point:(p:readonly [number,number])=>[L,L],options:{modifiers?:readonly ModifierValue[]}={}):ShapeValue[] {
  const groups=new Map<Stroke3['reference'],Map<string,{run:Stroke3;ranges:[number,number][]}>>();
  for(const run of runs) {
    const pens=groups.get(run.reference)??new Map();
    const entry=pens.get(run.stroke)??{run,ranges:[]};
    entry.ranges.push(...run.sourceRanges.map(r=>[...r] as [number,number]));
    pens.set(run.stroke,entry);groups.set(run.reference,pens);
  }
  return [...groups.values()].flatMap(pens=>[...pens.values()].map(({run,ranges})=>stroke(run.reference.points.map(point),{stroke:run.stroke,preserveStroke:true,strokeRanges:unionSourceRanges3(ranges),modifiers:options.modifiers&&[...options.modifiers]})));
}
/** Explicit paper-mm adapter for hosts without an execution frame. */
export function paperStrokes3(strokes: readonly Stroke3[]): ShapeValue[] {
  return sourceStrokeShapes3(strokes,p=>[mm(p[0]),mm(p[1])]);
}
