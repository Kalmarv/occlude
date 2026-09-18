/**
 * SVG as a shape source: `svg(text, opts)` turns machine-generated line art
 * (splotter et al) into ordinary open-path shapes — placed in sketch units,
 * drawn with library pens, occluded, modifiable (wrap with `modify([...])`
 * for wobble and friends), exported and plotted like anything else.
 *
 * Deliberately not a general SVG engine: polylines, lines, and paths made
 * of straight segments and Bézier curves (M/L/H/V/Z, C/S/Q/T, absolute +
 * relative), one layer per top-level `<g>`. Affine `transform` attributes
 * (translate, scale, rotate, skew, matrix, nested through groups) are
 * applied exactly — lines stay lines and a Bézier's transformed control
 * points describe the transformed curve — and cubics and quadratics enter
 * the shape model as the curves they are. Elliptical arcs (A) have no exact
 * form here and are rejected loudly rather than approximated. Regex-based
 * so it parses identically in browser and node.
 */

import { group, path, type GroupValue, type ShapeOpts } from './api.js';

export interface SvgShapesOptions extends ShapeOpts {
  /** Position of the artwork's top-left, sketch units (default 0,0). */
  x?: number;
  y?: number;
  /** Target width in sketch units (bare = percent of the drawable's short
   * side, like every coordinate). Height follows the aspect. Default 100.
   * To rotate/scale the artwork, use the ordinary transform opts every
   * shape has: `{ translate: [X, Y], rotate: deg }` pivots at [X, Y]. */
  width?: number;
  /** Only these layers (top-level group ids); default all. */
  layers?: string[];
}

/** One drawn piece of a chain, document units: a line to a point, or a
 * Bézier with its control points. A chain is a start point plus segments. */
type Seg =
  | { op: 'line'; x: number; y: number }
  | { op: 'quad'; cx: number; cy: number; x: number; y: number }
  | { op: 'cubic'; c0x: number; c0y: number; c1x: number; c1y: number; x: number; y: number };
interface Chain { x: number; y: number; segs: Seg[] }
interface SvgLayer {
  name: string;
  chains: Chain[];
}

const polylineChain = (nums: number[]): Chain => {
  const segs: Seg[] = [];
  for (let k = 2; k < nums.length; k += 2) segs.push({ op: 'line', x: nums[k], y: nums[k + 1] });
  return { x: nums[0], y: nums[1], segs };
};

function parsePoints(points: string): number[] {
  const nums = points
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  return nums.length >= 4 && nums.length % 2 === 0 ? nums : [];
}

/** Path data: M/L/H/V/Z lines, C/S cubics, Q/T quadratics, absolute and
 * relative; Z closes with a line. Elliptical arcs (A) are rejected. */
function parsePathData(d: string): Chain[] {
  const chains: Chain[] = [];
  let cur: Chain | null = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // The control point a following S/T reflects, when the previous command
  // was the matching Bézier kind; the current point otherwise.
  let lastCubicCtrl: [number, number] | null = null;
  let lastQuadCtrl: [number, number] | null = null;
  // Tokenize ALL letters so unsupported commands reach the rejection branch
  // instead of being silently skipped.
  const tokens = d.match(/[A-Za-z]|-?[\d.]+(?:e-?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  const flush = (): void => {
    if (cur && cur.segs.length > 0) chains.push(cur);
    cur = null;
  };
  const num = (): number => {
    const v = Number(tokens[i++]);
    if (!Number.isFinite(v)) throw new Error(`svg(): malformed path data near '${tokens.slice(Math.max(0, i - 3), i + 1).join(' ')}'`);
    return v;
  };
  const push = (seg: Seg): void => { if (!cur) cur = { x, y, segs: [] }; cur.segs.push(seg); };
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === 'Z' || cmd === 'z') {
        if (cur && cur.segs.length > 0) {
          if (x !== startX || y !== startY) cur.segs.push({ op: 'line', x: startX, y: startY });
          x = startX; y = startY;
          flush();
        } else {
          cur = null;
        }
        lastCubicCtrl = null; lastQuadCtrl = null;
        continue;
      }
    }
    if (cmd === '' || i >= tokens.length) break;
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();
    const ax = (v: number): number => (rel ? x + v : v);
    const ay = (v: number): number => (rel ? y + v : v);
    if (c === 'M' || c === 'L') {
      const nx = ax(num()), ny = ay(num());
      if (c === 'M') {
        flush();
        x = nx; y = ny; startX = x; startY = y;
        cur = { x, y, segs: [] };
        cmd = rel ? 'l' : 'L'; // subsequent pairs are implicit LineTo
      } else {
        x = nx; y = ny;
        push({ op: 'line', x, y });
      }
      lastCubicCtrl = null; lastQuadCtrl = null;
    } else if (c === 'H' || c === 'V') {
      const nv = num();
      if (c === 'H') x = ax(nv); else y = ay(nv);
      push({ op: 'line', x, y });
      lastCubicCtrl = null; lastQuadCtrl = null;
    } else if (c === 'C' || c === 'S') {
      let c0x: number, c0y: number;
      if (c === 'C') { c0x = ax(num()); c0y = ay(num()); }
      else { c0x = lastCubicCtrl ? 2 * x - lastCubicCtrl[0] : x; c0y = lastCubicCtrl ? 2 * y - lastCubicCtrl[1] : y; }
      const c1x = ax(num()), c1y = ay(num()), nx = ax(num()), ny = ay(num());
      push({ op: 'cubic', c0x, c0y, c1x, c1y, x: nx, y: ny });
      x = nx; y = ny; lastCubicCtrl = [c1x, c1y]; lastQuadCtrl = null;
    } else if (c === 'Q' || c === 'T') {
      let cx: number, cy: number;
      if (c === 'Q') { cx = ax(num()); cy = ay(num()); }
      else { cx = lastQuadCtrl ? 2 * x - lastQuadCtrl[0] : x; cy = lastQuadCtrl ? 2 * y - lastQuadCtrl[1] : y; }
      const nx = ax(num()), ny = ay(num());
      push({ op: 'quad', cx, cy, x: nx, y: ny });
      x = nx; y = ny; lastQuadCtrl = [cx, cy]; lastCubicCtrl = null;
    } else if (c === 'A') {
      throw new Error("svg(): elliptical arcs (A) have no exact form here — convert them to Béziers before export");
    } else {
      throw new Error(`svg(): unsupported path command '${cmd}'`);
    }
  }
  flush();
  return chains;
}

/** An affine map [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (the SVG matrix order). */
type Affine = readonly [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
/** m ∘ n: apply n first, then m. */
const compose = (m: Affine, n: Affine): Affine => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const translation = (tx: number, ty: number): Affine => [1, 0, 0, 1, tx, ty];

/** A `transform` attribute: functions listed left to right compose so the
 * rightmost applies first, as the SVG spec has it. */
function parseTransform(value: string | undefined): Affine {
  if (!value || !value.trim()) return IDENTITY;
  let m = IDENTITY;
  let matched = 0;
  for (const [, fn, args] of value.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    matched += 1;
    const a = args.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (a.some((n) => !Number.isFinite(n))) throw new Error(`svg(): malformed transform '${fn}(${args})'`);
    const rad = (deg: number): number => (deg * Math.PI) / 180;
    let t: Affine;
    switch (fn) {
      case 'matrix':
        if (a.length !== 6) throw new Error(`svg(): matrix() needs six numbers, got ${a.length}`);
        t = [a[0], a[1], a[2], a[3], a[4], a[5]];
        break;
      case 'translate':
        t = translation(a[0] ?? 0, a[1] ?? 0);
        break;
      case 'scale':
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const cos = Math.cos(rad(a[0] ?? 0)), sin = Math.sin(rad(a[0] ?? 0));
        const rot: Affine = [cos, sin, -sin, cos, 0, 0];
        t = a.length >= 3 ? compose(translation(a[1], a[2]), compose(rot, translation(-a[1], -a[2]))) : rot;
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(rad(a[0] ?? 0)), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(rad(a[0] ?? 0)), 0, 1, 0, 0];
        break;
      default:
        throw new Error(`svg(): unsupported transform '${fn}'`);
    }
    m = compose(m, t);
  }
  if (matched === 0) throw new Error(`svg(): malformed transform '${value}'`);
  return m;
}

/** Map every point of a chain, control points included: an affine map of
 * a Bézier's control points is the map of the curve. */
const mapChain = (m: Affine, chain: Chain): Chain => {
  if (m === IDENTITY) return chain;
  const px = (x: number, y: number): number => m[0] * x + m[2] * y + m[4];
  const py = (x: number, y: number): number => m[1] * x + m[3] * y + m[5];
  return {
    x: px(chain.x, chain.y), y: py(chain.x, chain.y),
    segs: chain.segs.map((s): Seg => {
      switch (s.op) {
        case 'line': return { op: 'line', x: px(s.x, s.y), y: py(s.x, s.y) };
        case 'quad': return { op: 'quad', cx: px(s.cx, s.cy), cy: py(s.cx, s.cy), x: px(s.x, s.y), y: py(s.x, s.y) };
        case 'cubic': return { op: 'cubic', c0x: px(s.c0x, s.c0y), c0y: py(s.c0x, s.c0y), c1x: px(s.c1x, s.c1y), c1y: py(s.c1x, s.c1y), x: px(s.x, s.y), y: py(s.x, s.y) };
      }
    }),
  };
};

const attrOf = (attrs: string, name: string): string | undefined =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

/** The chains of one element (polyline, line or path) in its own coordinates. */
function elementChains(tag: string, attrs: string): Chain[] {
  if (tag === 'polyline') {
    const pts = parsePoints(attrOf(attrs, 'points') ?? '');
    return pts.length > 0 ? [polylineChain(pts)] : [];
  }
  if (tag === 'line') {
    const n = (name: string): number => Number(attrOf(attrs, name) ?? NaN);
    const [x1, y1, x2, y2] = [n('x1'), n('y1'), n('x2'), n('y2')];
    return [x1, y1, x2, y2].every(Number.isFinite) ? [polylineChain([x1, y1, x2, y2])] : [];
  }
  const d = attrOf(attrs, 'd');
  return d ? parsePathData(d) : [];
}

function parseSvgText(text: string): { layers: SvgLayer[]; width: number; height: number } {
  const svgTag = /<svg\b[^>]*>/.exec(text)?.[0] ?? '';
  const viewBox = /\bviewBox="([^"]*)"/.exec(svgTag)?.[1].trim().split(/[\s,]+/).map(Number);
  const attr = (name: string): number =>
    parseFloat(new RegExp(`\\b${name}="([^"]*)"`).exec(svgTag)?.[1] ?? 'NaN');
  const width = viewBox && viewBox.length === 4 ? viewBox[2] : attr('width');
  const height = viewBox && viewBox.length === 4 ? viewBox[3] : attr('height');
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('svg(): no usable viewBox or width/height');
  }
  // One pass over the tags in document order, carrying the current
  // transform: each <g> composes its transform onto its parent's, each
  // element composes its own on top, and the chains are mapped as they are
  // read. Top-level groups are the layers; elements outside any group make
  // the 'ungrouped' layer, last.
  const layers: SvgLayer[] = [];
  const loose: Chain[] = [];
  const stack: Affine[] = [IDENTITY];
  let current: SvgLayer | null = null;
  let gi = 0;
  for (const m of text.matchAll(/<(\/?)(g|polyline|line|path)\b([^>]*?)(\/?)>/g)) {
    const [, closing, tag, attrs, selfClosing] = m;
    if (tag === 'g') {
      if (closing) {
        if (stack.length > 1) stack.pop();
        if (stack.length === 1 && current) { if (current.chains.length > 0) layers.push(current); current = null; }
        continue;
      }
      if (selfClosing) continue;
      stack.push(compose(stack[stack.length - 1], parseTransform(attrOf(attrs, 'transform'))));
      if (stack.length === 2) { current = { name: attrOf(attrs, 'id') ?? `layer-${gi}`, chains: [] }; gi += 1; }
      continue;
    }
    if (closing) continue;
    const ctm = compose(stack[stack.length - 1], parseTransform(attrOf(attrs, 'transform')));
    const into = current ? current.chains : loose;
    for (const chain of elementChains(tag, attrs)) into.push(mapChain(ctm, chain));
  }
  if (current && current.chains.length > 0) layers.push(current);
  if (loose.length > 0) layers.push({ name: 'ungrouped', chains: loose });
  // Nothing drawable in the file: no layers, and the shapes that would have
  // come from them are simply not there.
  return { layers, width, height };
}

/**
 * Parse SVG text into a group of open-path shapes. `opts` beyond
 * placement/size are ordinary ShapeOpts (pen, z, …) applied to every path;
 * wrap the result with `modify([...])` for modifiers, or `mask`/`clip` it —
 * it is a normal subtree.
 */
export function svg(text: string, opts: SvgShapesOptions = {}): GroupValue {
  const { x = 0, y = 0, width = 100, layers: only, ...shapeOpts } = opts;
  const parsed = parseSvgText(text);
  const s = width / parsed.width;
  const shapes = parsed.layers
    .filter((l) => !only || only.includes(l.name))
    .flatMap((l) =>
      l.chains.map((chain) => {
        const X = (v: number): number => x + v * s, Y = (v: number): number => y + v * s;
        const p = path();
        p.moveTo(X(chain.x), Y(chain.y));
        for (const seg of chain.segs) {
          if (seg.op === 'line') p.lineTo(X(seg.x), Y(seg.y));
          else if (seg.op === 'quad') p.quadTo(X(seg.cx), Y(seg.cy), X(seg.x), Y(seg.y));
          else p.bezierTo(X(seg.c0x), Y(seg.c0y), X(seg.c1x), Y(seg.c1y), X(seg.x), Y(seg.y));
        }
        return p.build(shapeOpts);
      }),
    );
  // A filter that matches no layer draws no shapes — an empty group, which
  // composes like any other.
  return group({}, ...shapes);
}
