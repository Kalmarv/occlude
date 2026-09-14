import {runGeometryJob3,runGeometryJobAsync3} from '../geometry/job.js';
import {surfaceCurveNetworkJob3,type SurfaceBinding3,type SurfaceCurveBudget3} from './network.js';
import {intersectionContactsJob3,type IntersectionContactBudget3} from './intersectionContacts.js';
import {intersectionAtomsJob3,type IntersectionAtomBudget3} from './intersectionAtoms.js';
import {intersectionGraphInputJob3} from './intersectionGraph.js';

/** Internal phase budgets. The ordinary API supplies sensible defaults; these
 * controls are for explicit capacity tuning, not required surface plumbing. */
export interface IntersectionBudget3 {
 readonly contacts?:IntersectionContactBudget3;
 readonly arrangement?:IntersectionAtomBudget3;
 readonly graph?:SurfaceCurveBudget3;
}
export function* intersectionsJob3(a:SurfaceBinding3,b:SurfaceBinding3,budget:IntersectionBudget3={}) {
 const contacts=yield*intersectionContactsJob3(a,b,budget.contacts);
 const atoms=yield*intersectionAtomsJob3(contacts,budget.arrangement);
 const draft=yield*intersectionGraphInputJob3([a,b],atoms.segments,atoms.points,budget.graph);
 const network=yield*surfaceCurveNetworkJob3(draft,budget.graph);
 return Object.freeze({network,stats:Object.freeze({...contacts.stats,...atoms.stats,outputNodes:network.nodes.length,outputSegments:network.segments.length})});
}
export function intersections3(a:SurfaceBinding3,b:SurfaceBinding3,budget:IntersectionBudget3={}) {
 return runGeometryJob3(intersectionsJob3(a,b,budget));
}
export function intersectionsAsync3(a:SurfaceBinding3,b:SurfaceBinding3,budget:IntersectionBudget3={},signal?:AbortSignal) {
 return runGeometryJobAsync3(intersectionsJob3(a,b,structuredClone(budget)),signal);
}
