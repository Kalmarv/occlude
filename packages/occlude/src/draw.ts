/**
 * Canvas 2D preview drawing. Draws exact geometry — Canvas renders arcs and
 * cubics natively, so preview never flattens (spec: flatten only at export).
 */

import type { PenDef } from './pens.js';
import type { Prim } from './prims.js';
import type { Fragment } from './render.js';

/** Append one primitive to the current canvas path. */
export function tracePrim(ctx: CanvasRenderingContext2D, p: Prim): void {
  switch (p.t) {
    case 'line':
      ctx.moveTo(p.x0, p.y0);
      ctx.lineTo(p.x1, p.y1);
      break;
    case 'arc':
      ctx.moveTo(p.cx + p.r * Math.cos(p.start), p.cy + p.r * Math.sin(p.start));
      ctx.arc(p.cx, p.cy, p.r, p.start, p.start + p.sweep, p.sweep < 0);
      break;
    case 'cubic':
      ctx.moveTo(p.x0, p.y0);
      ctx.bezierCurveTo(p.c0x, p.c0y, p.c1x, p.c1y, p.x1, p.y1);
      break;
  }
}

/**
 * Draw fragments with real pen widths and colours. The context should already
 * be scaled so 1 unit = 1 mm.
 */
export function drawFragments(
  ctx: CanvasRenderingContext2D,
  frags: Fragment[],
  pens: PenDef[],
): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let pi = 0; pi < pens.length; pi++) {
    const pen = pens[pi];
    ctx.strokeStyle = pen.color;
    ctx.fillStyle = pen.color;
    ctx.lineWidth = pen.width;
    ctx.beginPath();
    let dots: Fragment[] | null = null;
    for (const f of frags) {
      if (f.pen !== pi) continue;
      if (f.dot) {
        (dots ??= []).push(f);
        continue;
      }
      tracePrim(ctx, f.geom);
    }
    ctx.stroke();
    if (dots) {
      ctx.beginPath();
      for (const f of dots) {
        const p = f.geom;
        const x = p.t === 'line' ? p.x0 : 0;
        const y = p.t === 'line' ? p.y0 : 0;
        ctx.moveTo(x + pen.width / 2, y);
        ctx.arc(x, y, pen.width / 2, 0, 2 * Math.PI);
      }
      ctx.fill();
    }
  }
}
