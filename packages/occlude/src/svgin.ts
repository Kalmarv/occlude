/**
 * SVG as a shape source: `svg(text, opts)` turns machine-generated line art
 * (splotter et al) into ordinary open-path shapes — placed in sketch units,
 * drawn with library pens, occluded, modifiable (wrap with `modify([...])`
 * for wobble and friends), exported and plotted like anything else.
 *
 * Deliberately not a general SVG engine: polylines, lines, and
 * straight-segment paths (M/L/H/V/Z, absolute + relative), one layer per
 * top-level `<g>`. Transforms and curves are rejected loudly rather than
 * drawn wrong. Regex-based so it parses identically in browser and node.
 */

import { group, path, type GroupValue, type ShapeOpts } from './api.js';

export interface SvgShapesOptions extends ShapeOpts {
  /** Position of the artwork's top-left, sketch units (default 0,0). */
  x?: number;
  y?: number;
  /** Target width in sketch units (bare = percent of the drawable's short
   * side, like every coordinate). Height follows the aspect. Default 100.
   * Measured on the artwork BEFORE rotation — rotate 90 makes `width` the
   * vertical extent on paper. */
  width?: number;
  /** Rotate the artwork clockwise about its own top-left corner, degrees.
   * x/y always place that corner. */
  rotate?: number;
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

function elementChains(fragment: string): number[][] {
  const chains: number[][] = [];
  for (const m of fragment.matchAll(/<polyline\b[^>]*\bpoints="([^"]*)"/g)) {
    const pts = parsePoints(m[1]);
    if (pts.length > 0) chains.push(pts);
  }
  for (const m of fragment.matchAll(/<line\b[^>]*>/g)) {
    const attr = (name: string): number =>
      Number(new RegExp(`\\b${name}="([^"]*)"`).exec(m[0])?.[1] ?? NaN);
    const [x1, y1, x2, y2] = [attr('x1'), attr('y1'), attr('x2'), attr('y2')];
    if ([x1, y1, x2, y2].every(Number.isFinite)) chains.push([x1, y1, x2, y2]);
  }
  for (const m of fragment.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)) {
    chains.push(...parsePathData(m[1]));
  }
  return chains;
}

function parseSvgText(text: string): { layers: SvgLayer[]; width: number; height: number } {
  if (/\btransform="/.test(text)) {
    throw new Error('svg(): transform attributes are not supported — flatten transforms before export');
  }
  const svgTag = /<svg\b[^>]*>/.exec(text)?.[0] ?? '';
  const viewBox = /\bviewBox="([^"]*)"/.exec(svgTag)?.[1].trim().split(/[\s,]+/).map(Number);
  const attr = (name: string): number =>
    parseFloat(new RegExp(`\\b${name}="([^"]*)"`).exec(svgTag)?.[1] ?? 'NaN');
  const width = viewBox && viewBox.length === 4 ? viewBox[2] : attr('width');
  const height = viewBox && viewBox.length === 4 ? viewBox[3] : attr('height');
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('svg(): no usable viewBox or width/height');
  }
  const layers: SvgLayer[] = [];
  let consumed = text;
  let gi = 0;
  for (const m of text.matchAll(/<g\b([^>]*)>([\s\S]*?)<\/g>/g)) {
    const name = /\bid="([^"]*)"/.exec(m[1])?.[1] ?? `layer-${gi}`;
    const chains = elementChains(m[2]);
    if (chains.length > 0) layers.push({ name, chains });
    consumed = consumed.replace(m[0], '');
    gi += 1;
  }
  const loose = elementChains(consumed);
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
  const { x = 0, y = 0, width = 100, rotate = 0, layers: only, ...shapeOpts } = opts;
  const parsed = parseSvgText(text);
  const s = width / parsed.width;
  const a = (rotate * Math.PI) / 180;
  const [cos, sin] = [Math.cos(a), Math.sin(a)];
  const map = (px: number, py: number): [number, number] => {
    const sx = px * s;
    const sy = py * s;
    return [x + sx * cos - sy * sin, y + sx * sin + sy * cos];
  };
  const shapes = parsed.layers
    .filter((l) => !only || only.includes(l.name))
    .flatMap((l) =>
      l.chains.map((chain) => {
        const p = path();
        p.moveTo(...map(chain[0], chain[1]));
        for (let k = 2; k < chain.length; k += 2) {
          p.lineTo(...map(chain[k], chain[k + 1]));
        }
        return p.build(shapeOpts);
      }),
    );
  if (shapes.length === 0) {
    throw new Error(`svg(): layer filter matched nothing (layers: ${parsed.layers.map((l) => l.name).join(', ')})`);
  }
  return group({}, ...shapes);
}
