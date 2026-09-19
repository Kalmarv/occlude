import { groupRows } from '../../groupRows.js';
import { finite3, sub3, type Vec3 } from '../math.js';
import { snapshotSurface3, cloneSurface3 } from './model.js';
import type { Attributes3, Surface3 } from './surface.js';

export interface PointMeasure3 {
  readonly index: number;
  readonly id: string;
  readonly position: Vec3;
  readonly attributes: Readonly<Attributes3>;
  readonly neighbors: readonly number[];
  readonly boundary: boolean;
}
export interface EdgeMeasure3 {
  readonly index: number;
  readonly id: string;
  readonly vertices: readonly [number, number];
  readonly a: Vec3;
  readonly b: Vec3;
  readonly center: Vec3;
  readonly length: number;
  readonly faces: readonly number[];
  readonly attributes: Readonly<Attributes3>;
  readonly boundary: boolean;
}
interface Capture3 { readonly surface: Surface3; readonly points: readonly PointMeasure3[]; readonly edges: readonly EdgeMeasure3[] }
function capture(source: Surface3): Capture3 {
  const surface = snapshotSurface3(source);
  const neighbors = surface.points.map(() => new Set<number>()), boundary = new Set<number>();
  for (const edge of surface.edges) {
    const [a,b] = edge.vertices; neighbors[a].add(b); neighbors[b].add(a);
    if (edge.faces.length === 1) { boundary.add(a); boundary.add(b); }
  }
  const points = Object.freeze(surface.points.map((p,index) => Object.freeze({ ...p, index, neighbors: Object.freeze([...neighbors[index]].sort((a,b) => a-b)), boundary: boundary.has(index) })));
  const edges = Object.freeze(surface.edges.map((edge,index) => {
    const [a,b] = edge.vertices.map(i => surface.points[i].position);
    return Object.freeze({ ...edge, index, a, b, center: Object.freeze(a.map((v,k) => v / 2 + b[k] / 2)) as Vec3, length: Math.hypot(...sub3(b,a)), boundary: edge.faces.length === 1 });
  }));
  return Object.freeze({ surface, points, edges });
}
function indicesOf(indices: readonly number[] | undefined, length: number): readonly number[] {
  const result = indices ?? Array.from({ length }, (_,i) => i);
  if (result.some(i => !Number.isSafeInteger(i) || i < 0 || i >= length)) throw new Error('selection contains an invalid row index');
  return Object.freeze([...new Set(result)].sort((a,b) => a-b));
}
/** Captured immutable point rows; derived selections share that capture. */
export class PointSelection3 implements Iterable<PointMeasure3> {
  readonly indices: readonly number[];
  private readonly captured: Capture3;
  constructor(readonly source: Surface3, indices?: readonly number[], captured?: Capture3) {
    this.captured = captured ?? capture(source); this.indices = indicesOf(indices, this.captured.points.length); Object.freeze(this);
  }
  get length() { return this.indices.length; }
  *[Symbol.iterator]() { for (const i of this.indices) yield this.captured.points[i]; }
  map<T>(fn: (point: PointMeasure3, index: number) => T): T[] { return this.indices.map((row,i) => fn(this.captured.points[row],i)); }
  filter(fn: (point: PointMeasure3, index: number) => boolean): PointSelection3 { return new PointSelection3(this.source, this.indices.filter((row,i) => fn(this.captured.points[row],i)), this.captured); }
  groupBy<K>(fn: (point: PointMeasure3, index: number) => K): { key: K; selection: PointSelection3 }[] {
    return groupRows(this.indices,i => i,(row,i) => fn(this.captured.points[row],i)).map(g => ({ key: g.key, selection: new PointSelection3(this.source,g.rows,this.captured) }));
  }
  /** Neighbouring points, MEMBERS EXCLUDED: one hop out. */
  adjacent(): PointSelection3 {
    const held = new Set(this.indices);
    return new PointSelection3(this.source, this.indices.flatMap(i => this.captured.points[i].neighbors).filter(i => !held.has(i)), this.captured);
  }
  union(other: PointSelection3): PointSelection3 {
    if (other.source !== this.source || other.captured !== this.captured) throw new Error('point selections belong to different captures; derive them from one selection');
    return new PointSelection3(this.source,[...this.indices,...other.indices],this.captured);
  }
}
/** Original polygon edges, never derived triangulation diagonals. */
export class EdgeSelection3 implements Iterable<EdgeMeasure3> {
  readonly indices: readonly number[];
  private readonly captured: Capture3;
  constructor(readonly source: Surface3, indices?: readonly number[], captured?: Capture3) {
    this.captured = captured ?? capture(source); this.indices = indicesOf(indices, this.captured.edges.length); Object.freeze(this);
  }
  get length() { return this.indices.length; }
  *[Symbol.iterator]() { for (const i of this.indices) yield this.captured.edges[i]; }
  map<T>(fn: (edge: EdgeMeasure3, index: number) => T): T[] { return this.indices.map((row,i) => fn(this.captured.edges[row],i)); }
  filter(fn: (edge: EdgeMeasure3, index: number) => boolean): EdgeSelection3 { return new EdgeSelection3(this.source,this.indices.filter((row,i) => fn(this.captured.edges[row],i)),this.captured); }
  groupBy<K>(fn: (edge: EdgeMeasure3, index: number) => K): { key: K; selection: EdgeSelection3 }[] {
    return groupRows(this.indices,i => i,(row,i) => fn(this.captured.edges[row],i)).map(g => ({ key: g.key, selection: new EdgeSelection3(this.source,g.rows,this.captured) }));
  }
  get points(): PointSelection3 { return new PointSelection3(this.source,this.indices.flatMap(i => [...this.captured.edges[i].vertices]),this.captured); }
  union(other: EdgeSelection3): EdgeSelection3 {
    if (other.source !== this.source || other.captured !== this.captured) throw new Error('edge selections belong to different captures; derive them from one selection');
    return new EdgeSelection3(this.source,[...this.indices,...other.indices],this.captured);
  }
}
export interface PointEdit3 { readonly position?: Vec3; readonly attributes?: Attributes3 }
/** All callbacks read one frozen input; commits occur only after they finish.
 * Selection membership is captured, while callback rows reflect this edit's input. */
export function editPoints3(source: Surface3, selection: PointSelection3, edit: (point: PointMeasure3) => PointEdit3 | void): Surface3 {
  if (selection.source !== source) throw new Error('point selection belongs to another surface state');
  const input = capture(source), patches = selection.map(p => {
    if (input.points[p.index]?.id !== p.id) throw new Error('point selection identity changed');
    const patch = edit(input.points[p.index]);
    if (patch?.position) finite3(patch.position);
    return { index: p.index, patch: structuredClone(patch) };
  });
  const result = cloneSurface3(input.surface);
  for (const { index, patch } of patches) {
    if (patch?.position) result.points[index].position = patch.position;
    if (patch?.attributes) result.points[index].attributes = patch.attributes;
  }
  return result;
}
/** Edit authored edge attributes; move shared endpoints with editPoints3. */
export function editEdges3(source: Surface3, selection: EdgeSelection3, edit: (edge: EdgeMeasure3) => Attributes3): Surface3 {
  if (selection.source !== source) throw new Error('edge selection belongs to another surface state');
  const input = capture(source), patches = selection.map(e => {
    if (input.edges[e.index]?.id !== e.id) throw new Error('edge selection identity changed');
    return { index: e.index, attributes: structuredClone(edit(input.edges[e.index])) };
  });
  const result = cloneSurface3(input.surface);
  for (const patch of patches) result.edges[patch.index].attributes = patch.attributes;
  return result;
}
