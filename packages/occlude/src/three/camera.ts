import { cross3, dot3, finite3, lerp3, sub3, unit3, type Triangle3, type Vec3 } from './math.js';

interface CameraBase {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly up?: Vec3;
  readonly near: number;
  readonly far: number;
}
export type Camera3 = CameraBase & (
  | { readonly kind: 'orthographic'; readonly span: number }
  | { readonly kind: 'perspective'; readonly fovDegrees: number }
  /** A perspective camera whose frame is moved off the optical axis. `shift`
   * is a fraction of the frame, right and up: `[0, 0.4]` raises the frame by
   * four tenths of its height, so what is drawn moves down the page by the
   * same amount. The eye and the direction of view do not move, so world
   * verticals stay parallel where a tilted camera would make them converge. */
  | { readonly kind: 'oblique'; readonly fovDegrees: number; readonly shift: readonly [number, number] }
);
/** The NDC offset a projection adds for this camera: the image moves against
 * the frame, and twice the paper-frame fraction because NDC runs -1 to 1.
 * Zero for a camera whose frame sits on the optical axis. */
export function cameraShift3(camera: Camera3): readonly [number, number] {
  return camera.kind === 'oblique' ? [-2 * camera.shift[0], -2 * camera.shift[1]] : [0, 0];
}
export interface PaperFrame3 { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface CameraFrame3 {
  readonly camera: Camera3;
  readonly right: Vec3;
  readonly up: Vec3;
  readonly back: Vec3;
  readonly paper: PaperFrame3;
}

/** Capture and validate an explicit camera and paper frame. Right-handed, Z up. */
export function cameraFrame3(camera: Camera3, paper: PaperFrame3): CameraFrame3 {
  finite3(camera.eye); finite3(camera.target); finite3(camera.up ?? [0, 0, 1]);
  if (![camera.near, camera.far].every(Number.isFinite) || !(camera.near > 0 && camera.far > camera.near)) throw new Error('camera requires 0 < near < far');
  if (camera.kind === 'orthographic') {
    if (!(camera.span > 0) || !Number.isFinite(camera.span)) throw new Error('orthographic span must be positive and finite');
  } else if (camera.kind === 'perspective' || camera.kind === 'oblique') {
    if (!(camera.fovDegrees > 0 && camera.fovDegrees < 180)) throw new Error('perspective FOV must be between 0 and 180 degrees');
    if (camera.kind === 'oblique' && (camera.shift.length !== 2 || !camera.shift.every(Number.isFinite))) throw new Error('oblique shift must be two finite fractions of the frame');
  } else throw new Error('unknown camera projection');
  if (![paper.x, paper.y, paper.width, paper.height].every(Number.isFinite) || !(paper.width > 0 && paper.height > 0)) throw new Error('camera paper frame must be finite with positive size');
  const back = unit3(sub3(camera.eye, camera.target));
  const right = unit3(cross3(unit3(camera.up ?? [0, 0, 1]), back));
  const up = cross3(back, right);
  const copy = (p: Vec3): Vec3 => Object.freeze([...p]) as Vec3;
  const held: Camera3 = camera.kind === 'oblique' ? { ...camera, shift: Object.freeze([...camera.shift]) as readonly [number, number] } : camera;
  return Object.freeze({ camera: Object.freeze({ ...held, eye: copy(camera.eye), target: copy(camera.target), up: copy(camera.up ?? [0, 0, 1]) }), right: copy(right), up: copy(up), back: copy(back), paper: Object.freeze({ ...paper }) });
}

export function toCamera3(frame: CameraFrame3, point: Vec3): Vec3 {
  finite3(point);
  const p = sub3(point, frame.camera.eye);
  return [dot3(p, frame.right), dot3(p, frame.up), dot3(p, frame.back)];
}

/** NDC xy and WebGPU depth [0,1] for a near/far-clipped camera point. */
export function projectCamera3(frame: CameraFrame3, p: Vec3): Vec3 {
  finite3(p);
  const c = frame.camera, d = -p[2];
  if (!(d > 0)) throw new Error('clip points behind the eye before projection');
  const aspect = frame.paper.width / frame.paper.height;
  if (c.kind === 'orthographic') return [2 * p[0] / (c.span * aspect), 2 * p[1] / c.span, (d - c.near) / (c.far - c.near)];
  const scale = 1 / Math.tan(c.fovDegrees * Math.PI / 360), offset = cameraShift3(c);
  return [scale * p[0] / (d * aspect) + offset[0], scale * p[1] / d + offset[1], c.far / (c.far - c.near) * (1 - c.near / d)];
}
export function toPaper3(frame: CameraFrame3, p: Vec3): readonly [number, number] {
  const q = projectCamera3(frame, p), r = frame.paper;
  return [r.x + (q[0] + 1) * r.width / 2, r.y + (1 - q[1]) * r.height / 2];
}

/** Original segment parameters. Side planes deliberately do not crop style overscan. */
export function clipSegment3(a: Vec3, b: Vec3, near: number, far: number): readonly [number, number] | null {
  let lo = 0, hi = 1;
  for (const [va, vb] of [[-a[2] - near, -b[2] - near], [far + a[2], far + b[2]]]) {
    if (va < 0 && vb < 0) return null;
    if (va < 0) lo = Math.max(lo, va / (va - vb));
    if (vb < 0) hi = Math.min(hi, va / (va - vb));
  }
  return lo < hi ? [lo, hi] : null;
}

/** Clip a triangle before division. Callers retain its source/support ID. */
export function clipTriangle3(triangle: Triangle3, near: number, far: number): Triangle3[] {
  let polygon: Vec3[] = [...triangle];
  for (const distance of [(p: Vec3) => -p[2] - near, (p: Vec3) => far + p[2]]) {
    const next: Vec3[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length], da = distance(a), db = distance(b);
      if (da >= 0) next.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) next.push(lerp3(a, b, da / (da - db)));
    }
    polygon = next;
  }
  const result: Triangle3[] = [];
  for (let i = 1; i + 1 < polygon.length; i++) result.push([polygon[0], polygon[i], polygon[i + 1]]);
  return result;
}

/** True when every point lies beyond the near or far plane, or, when the
 * physical `sheet` is given, beyond one edge of it. Nothing inside the convex
 * hull of such points can be plotted, and nothing outside the view can stand
 * between the eye and a visible point, so the object can be skipped without
 * changing a stroke. Features are not cut at the paper frame here — the
 * finished ink is clipped to it (`inFrame3` in resolve.ts), after modifiers
 * that need the whole line — so the frame itself is never a cull. A perspective
 * object with a point behind the eye is kept. */
export function outsideView3(frame: CameraFrame3, points: readonly Vec3[], sheet?: PaperFrame3): boolean {
  if (!points.length) return true;
  const c = frame.camera, r = frame.paper, aspect = r.width / r.height;
  const scale = c.kind === 'orthographic' ? 0 : 1 / Math.tan(c.fovDegrees * Math.PI / 360), offset = cameraShift3(c);
  let nearAll = true, farAll = true, left = true, right = true, below = true, above = true, behind = false;
  for (const p of points) {
    const d = -p[2];
    if (d >= c.near) nearAll = false;
    if (d <= c.far) farAll = false;
    if (!sheet) continue;
    let nx: number, ny: number;
    if (c.kind === 'orthographic') { nx = 2 * p[0] / (c.span * aspect); ny = 2 * p[1] / c.span; }
    else { if (!(d > 0)) { behind = true; continue; } nx = scale * p[0] / (d * aspect) + offset[0]; ny = scale * p[1] / d + offset[1]; }
    const x = r.x + (nx + 1) * r.width / 2, y = r.y + (1 - ny) * r.height / 2;
    if (x >= sheet.x) left = false; if (x <= sheet.x + sheet.width) right = false;
    if (y >= sheet.y) above = false; if (y <= sheet.y + sheet.height) below = false;
  }
  if (nearAll || farAll) return true;
  if (!sheet || behind) return false;
  return left || right || below || above;
}
