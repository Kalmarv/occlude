export type Bounds3 = readonly [number, number, number, number];
interface Node { bounds: Bounds3; nearest: number; left?: Node; right?: Node; indices?: readonly number[] }
const intersects = (a: Bounds3, b: Bounds3) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
/** Projected bounds with an outward f64 arithmetic envelope. Nonfinite
 * projection must be diagnosed before building an index, never silently culled. */
export function projectedBounds3(points: readonly (readonly [number, number])[]): Bounds3 {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('nonfinite projection cannot be indexed');
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const e = Math.max(1, Math.abs(x0), Math.abs(y0), Math.abs(x1), Math.abs(y1)) * Number.EPSILON * 64;
  return [x0 - e, y0 - e, x1 + e, y1 + e];
}
/** Camera depth is negative in front of the eye and decreases with distance.
 * An occluder entirely farther than a feature's farthest point cannot hide
 * any of it under either projection: every point of the eye ray to a feature
 * point is nearer than that point. The outward envelope keeps exact-incidence
 * cases (a curve on its own surface) inside the candidate set. */
export function depthCutoff3(nearestDepth: number): number {
  return nearestDepth - Math.max(1, Math.abs(nearestDepth)) * Number.EPSILON * 64;
}
/** Deterministic median BVH over projected bounds, O(n log² n) build, no
 * segment×triangle storage. Optional per-item nearest depth (max camera z)
 * lets a query skip everything farther than its own farthest point. */
export class ProjectedIndex3 {
  private root: Node | null;
  constructor(private bounds: readonly Bounds3[], private nearest: readonly number[] = bounds.map(() => Infinity)) {
    if (nearest.length !== bounds.length) throw new Error('projected index depth needs one value per item');
    const build = (indices: number[]): Node => {
      const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity]; let near = -Infinity;
      for (const i of indices) { const b = bounds[i]; box[0] = Math.min(box[0], b[0]); box[1] = Math.min(box[1], b[1]); box[2] = Math.max(box[2], b[2]); box[3] = Math.max(box[3], b[3]); near = Math.max(near, nearest[i]); }
      if (indices.length <= 8) return { bounds: box, nearest: near, indices };
      const axis = box[2] - box[0] >= box[3] - box[1] ? 0 : 1;
      indices.sort((a, b) => (bounds[a][axis] / 2 + bounds[a][axis + 2] / 2) - (bounds[b][axis] / 2 + bounds[b][axis + 2] / 2) || a - b);
      const split = Math.floor(indices.length / 2);
      return { bounds: box, nearest: near, left: build(indices.slice(0, split)), right: build(indices.slice(split)) };
    };
    this.root = bounds.length ? build(bounds.map((_, i) => i)) : null;
  }
  /** Items overlapping `bounds` whose nearest depth is not beyond `cutoff`. */
  *query(bounds: Bounds3, cutoff = -Infinity): Generator<number> {
    const stack = this.root ? [this.root] : [];
    while (stack.length) {
      const node = stack.pop()!; if (node.nearest < cutoff || !intersects(bounds, node.bounds)) continue;
      if (node.indices) { for (const i of node.indices) if (this.nearest[i] >= cutoff && intersects(bounds, this.bounds[i])) yield i; }
      else { stack.push(node.right!, node.left!); }
    }
  }
}
