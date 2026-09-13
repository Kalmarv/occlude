import { orient2d, orient3d } from 'robust-predicates';
import { cross3, dot3, mul3, sub3, type Triangle3, type Vec3 } from '../math.js';
export type Interval3 = readonly [number, number];
/** Interior is n·p + w >= 0. The last plane is strictly behind the surface. */
export type Plane3 = readonly [number, number, number, number];
export interface OcclusionVolume3 { readonly planes: readonly Plane3[]; readonly triangle?: Triangle3; readonly perspective?: boolean }

/** Camera-space shadow cone/prism, independent of winding. Degenerate or edge-on
 * triangles have zero occluding area and yield no volume. */
export function occlusionVolume3(triangle: Triangle3, perspective: boolean): OcclusionVolume3 | null {
  const [a, b, c] = triangle;
  let normal = cross3(sub3(b, a), sub3(c, a));
  const length = Math.hypot(...normal);
  if (!(length > 0)) return null;
  normal = mul3(normal, 1 / length);
  const towardCamera = perspective ? dot3(normal, mul3(a, -1)) : normal[2];
  if (towardCamera === 0) return null;
  if (towardCamera > 0) normal = mul3(normal, -1);
  const planes: Plane3[] = [];
  for (let i = 0; i < 3; i++) {
    const p = triangle[i], q = triangle[(i + 1) % 3], other = triangle[(i + 2) % 3];
    let n = perspective ? cross3(p, q) : cross3(sub3(q, p), [0, 0, -1]);
    const size = Math.hypot(...n);
    if (!(size > 0)) return null;
    n = mul3(n, 1 / size);
    let w = perspective ? 0 : -dot3(n, p);
    if (dot3(n, other) + w < 0) { n = mul3(n, -1); w = -w; }
    planes.push([...n, w]);
  }
  planes.push([...normal, -dot3(normal, a)]);
  return Object.freeze({ planes: Object.freeze(planes.map(p => Object.freeze(p))), triangle: Object.freeze(triangle.map(p => Object.freeze([...p]))) as unknown as Triangle3, perspective });
}

/** f64 reference. Exact support is excluded by provenance before this call;
 * coplanar distinct geometry does not obscure ink on the same plane. */
export function hiddenInterval3(a: Vec3, b: Vec3, volume: OcclusionVolume3): Interval3 | null {
  let lo = 0, hi = 1;
  for (let i = 0; i < volume.planes.length; i++) {
    const p = volume.planes[i];
    const value = (point: Vec3): number => {
      const tri = volume.triangle;
      if (!tri) return p[0] * point[0] + p[1] * point[1] + p[2] * point[2] + p[3];
      const determinant = (a: Vec3, b: Vec3, c: Vec3, d: Vec3) => orient3d(...a, ...b, ...c, ...d);
      if (i === 3) {
        const cameraSide = volume.perspective ? determinant(tri[0], tri[1], tri[2], [0,0,0]) : orient2d(tri[0][0],tri[0][1],tri[1][0],tri[1][1],tri[2][0],tri[2][1]);
        return -Math.sign(cameraSide) * determinant(tri[0],tri[1],tri[2],point);
      }
      const u=tri[i], v=tri[(i+1)%3], other=tri[(i+2)%3];
      const side = (q: Vec3) => volume.perspective ? determinant([0,0,0],u,v,q) : orient2d(u[0],u[1],v[0],v[1],q[0],q[1]);
      return Math.sign(side(other)) * side(point);
    };
    const va = value(a), vb = value(b);
    if (i === 3 && va <= 0 && vb <= 0) return null;
    if (va < 0 && vb < 0) return null;
    if (va < 0) lo = Math.max(lo, va / (va - vb));
    if (vb < 0) hi = Math.min(hi, va / (va - vb));
    if (lo >= hi) return null;
  }
  return [lo, hi];
}

export function unionIntervals3(intervals: readonly Interval3[]): Interval3[] {
  const sorted = intervals.map(([a, b]): Interval3 => [Math.max(0, a), Math.min(1, b)]).filter(([a, b]) => a < b).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const previous = out.at(-1);
    if (previous && lo <= previous[1]) previous[1] = Math.max(previous[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}
export function visibleIntervals3(hidden: readonly Interval3[]): Interval3[] {
  const result: Interval3[] = []; let cursor = 0;
  for (const [lo, hi] of unionIntervals3(hidden)) {
    if (lo > cursor) result.push([cursor, lo]);
    cursor = hi;
  }
  if (cursor < 1) result.push([cursor, 1]);
  return result;
}
