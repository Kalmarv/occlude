import { stroke, type ShapeValue } from '../../api.js';
import { mm } from '../../units.js';
import type { Stroke3 } from './construct.js';
/** Explicit paper-mm adapter. Every constructed run keeps its authored
 * traversal and intentional breaks through the shared finishing/plan path. */
export function paperStrokes3(strokes: readonly Stroke3[]): ShapeValue[] {
  return strokes.map(s=>stroke(s.points.map(p=>[mm(p[0]),mm(p[1])]),{stroke:s.stroke,preserveStroke:true}));
}
