/**
 * SVG as a shape source: `svg(text, opts)` turns machine-generated line art
 * (splotter et al) into ordinary open-path shapes — placed in sketch units,
 * drawn with library pens, occluded, modifiable (wrap with `modify([...])`
 * for wobble and friends), exported and plotted like anything else.
 *
 * Deliberately not a general SVG engine: polylines, lines, and
 * straight-segment paths (M/L/H/V/Z, absolute + relative), one layer per
 * top-level `<g>`. Affine `transform` attributes (translate, scale, rotate,
 * skew, matrix, nested through groups) are applied exactly — a straight
 * segment stays straight under any affine map — while curves are rejected
 * loudly rather than approximated. Regex-based so it parses identically in
 * browser and node.
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

interface SvgLayer {
  name: string;
  /** Flat [x0,y0,x1,y1,…] per chain, document units. */
  chains: number[][];
}

function parsePoints(points: string): number[] {
  const nums = points
    .trim()
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  return nums.length >= 4 && nums.length % 2 === 0 ? nums : [];
}

/** Straight-segment path data (M/L/H/V, absolute and relative, Z closes). */
function parsePathData(d: string): number[][] {
  const chains: number[][] = [];
  let cur: number[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // Tokenize ALL letters so unsupported commands (curves, arcs) reach the
  // rejection branch instead of being silently skipped.
  const tokens = d.match(/[A-Za-z]|-?[\d.]+(?:e-?\d+)?/g) ?? [];
  let i = 0;
  let cmd = '';
  const flush = (): void => {
    if (cur.length >= 4) chains.push(cur);
    cur = [];
  };
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) {
      cmd = tokens[i++];
      if (cmd === 'Z' || cmd === 'z') {
        if (cur.length >= 4) {
          cur.push(startX, startY);
          flush();
        } else {
          cur = [];
        }
        continue;
      }
    }
    if (cmd === '' || i >= tokens.length) break;
    const rel = cmd === cmd.toLowerCase();
    const c = cmd.toUpperCase();
    if (c === 'M' || c === 'L') {
      const nx = Number(tokens[i++]);
      const ny = Number(tokens[i++]);
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) break;
      // Relative always adds; an initial 'm' is absolute per spec, which
      // falls out naturally since x,y start at 0.
      x = rel ? x + nx : nx;
      y = rel ? y + ny : ny;
      if (c === 'M') {
        flush();
        startX = x;
        startY = y;
        cur = [x, y];
        cmd = rel ? 'l' : 'L'; // subsequent pairs are implicit LineTo
      } else {
        cur.push(x, y);
      }
    } else if (c === 'H' || c === 'V') {
      const nv = Number(tokens[i++]);
      if (!Number.isFinite(nv)) break;
      if (c === 'H') x = rel ? x + nv : nv;
      else y = rel ? y + nv : nv;
      cur.push(x, y);
    } else {
      throw new Error(
        `svg(): unsupported path command '${cmd}' — only straight segments (M/L/H/V/Z)`,
      );
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

const mapChain = (m: Affine, chain: number[]): number[] => {
  if (m === IDENTITY) return chain;
  const out = new Array<number>(chain.length);
  for (let k = 0; k < chain.length; k += 2) {
    const x = chain[k], y = chain[k + 1];
    out[k] = m[0] * x + m[2] * y + m[4];
    out[k + 1] = m[1] * x + m[3] * y + m[5];
  }
  return out;
};

const attrOf = (attrs: string, name: string): string | undefined =>
  new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

/** The chains of one element (polyline, line or path) in its own coordinates. */
function elementChains(tag: string, attrs: string): number[][] {
  if (tag === 'polyline') {
    const pts = parsePoints(attrOf(attrs, 'points') ?? '');
    return pts.length > 0 ? [pts] : [];
  }
  if (tag === 'line') {
    const n = (name: string): number => Number(attrOf(attrs, name) ?? NaN);
    const [x1, y1, x2, y2] = [n('x1'), n('y1'), n('x2'), n('y2')];
    return [x1, y1, x2, y2].every(Number.isFinite) ? [[x1, y1, x2, y2]] : [];
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
  const loose: number[][] = [];
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
  if (layers.length === 0) {
    throw new Error('svg(): no polylines, lines, or straight paths found');
  }
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
        const p = path();
        p.moveTo(x + chain[0] * s, y + chain[1] * s);
        for (let k = 2; k < chain.length; k += 2) {
          p.lineTo(x + chain[k] * s, y + chain[k + 1] * s);
        }
        return p.build(shapeOpts);
      }),
    );
  if (shapes.length === 0) {
    throw new Error(`svg(): layer filter matched nothing (layers: ${parsed.layers.map((l) => l.name).join(', ')})`);
  }
  return group({}, ...shapes);
}
