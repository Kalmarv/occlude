/**
 * Minimal SVG import for plotting externally-generated line art (splotter
 * et al). Deliberately not a general SVG engine: it reads polylines,
 * lines, and straight-segment paths from top-level groups, in document
 * units, ignoring styling. Transforms are NOT applied — files carrying
 * transform attributes are rejected loudly rather than plotted wrong.
 * Regex-based so it runs identically in the browser and in node tests.
 */

export interface SvgLayer {
  name: string;
  /** Flat [x0,y0,x1,y1,…] per chain, document units. */
  chains: number[][];
  /** The group's stroke-width in document units, if declared. Cosmetic in
   * SVG terms — a plotted line is always nib-wide — but it records the
   * relative weight the author designed for, so the importer can report
   * how the physical pen compares at the chosen scale. */
  strokeWidth?: number;
}

export interface ParsedSvg {
  layers: SvgLayer[];
  /** Document size in its own units (viewBox preferred, else width/height). */
  width: number;
  height: number;
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
function parsePath(d: string): number[][] {
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
      // Curves and arcs are out of scope: fail the whole path loudly.
      throw new Error(`SVG import: unsupported path command '${cmd}' — only straight segments (M/L/H/V/Z)`);
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
    chains.push(...parsePath(m[1]));
  }
  return chains;
}

export function parseSvg(text: string): ParsedSvg {
  if (/\btransform="/.test(text)) {
    throw new Error('SVG import: transform attributes are not supported — flatten transforms before export');
  }
  const svgTag = /<svg\b[^>]*>/.exec(text)?.[0] ?? '';
  const viewBox = /\bviewBox="([^"]*)"/.exec(svgTag)?.[1].trim().split(/[\s,]+/).map(Number);
  const attr = (name: string): number =>
    parseFloat(new RegExp(`\\b${name}="([^"]*)"`).exec(svgTag)?.[1] ?? 'NaN');
  const width = viewBox && viewBox.length === 4 ? viewBox[2] : attr('width');
  const height = viewBox && viewBox.length === 4 ? viewBox[3] : attr('height');
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('SVG import: no usable viewBox or width/height');
  }

  // Top-level groups become layers; loose elements become an implicit one.
  const layers: SvgLayer[] = [];
  const groupRe = /<g\b([^>]*)>([\s\S]*?)<\/g>/g;
  let consumed = text;
  let gi = 0;
  for (const m of text.matchAll(groupRe)) {
    const name = /\bid="([^"]*)"/.exec(m[1])?.[1] ?? `layer-${gi}`;
    const sw = parseFloat(/\bstroke-width="([^"]*)"/.exec(m[1])?.[1] ?? 'NaN');
    const chains = elementChains(m[2]);
    if (chains.length > 0) {
      layers.push({ name, chains, ...(Number.isFinite(sw) ? { strokeWidth: sw } : {}) });
    }
    consumed = consumed.replace(m[0], '');
    gi += 1;
  }
  const loose = elementChains(consumed);
  if (loose.length > 0) layers.push({ name: 'ungrouped', chains: loose });
  if (layers.length === 0) throw new Error('SVG import: no polylines, lines, or straight paths found');
  return { layers, width, height };
}

/**
 * Build an ebb.plot()/wasm_optimize_plan plan from parsed layers.
 * `penOf[i]` maps layer i → pen index; `scale` = mm per document unit.
 */
export function buildPlan(svg: ParsedSvg, penOf: number[], scale: number): Float64Array {
  const out: number[] = [];
  svg.layers.forEach((layer, li) => {
    for (const chain of layer.chains) {
      out.push(penOf[li], 0, chain.length / 2);
      for (const c of chain) out.push(c * scale);
    }
  });
  return new Float64Array(out);
}
