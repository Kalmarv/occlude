/**
 * The primitive rows of the scene protocol: stride-9 f64 `[kind,
 * ...params]` (scene.rs documents both directions), the growable sink the
 * encoder writes them into, and the codec either way. Shared by the scene
 * encoder, the fill jobs and the decoder; depends on nothing but `Prim`.
 */

import type { Prim } from './prims.js';

export const PRIM_STRIDE = 9;
export const FRAG_STRIDE = 9;

/** A growable Float64Array the encoder writes one primitive at a time
 * straight into. A dense sketch encodes hundreds of thousands of primitives —
 * six million numbers — and a `number[]` pays twice: once for the variadic
 * push, again for the copy into the typed array the engine reads. */
export class PrimSink {
  private a = new Float64Array(1024);
  /** Numbers written — `n / PRIM_STRIDE` primitives. */
  n = 0;

  /** One primitive: exactly PRIM_STRIDE numbers, in stride order. */
  row(k: number, a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number): void {
    if (this.n + PRIM_STRIDE > this.a.length) {
      let cap = this.a.length * 2;
      while (cap < this.n + PRIM_STRIDE) cap *= 2;
      const grown = new Float64Array(cap);
      grown.set(this.a.subarray(0, this.n));
      this.a = grown;
    }
    const t = this.a;
    const o = this.n;
    t[o] = k; t[o + 1] = a; t[o + 2] = b; t[o + 3] = c; t[o + 4] = d;
    t[o + 5] = e; t[o + 6] = f; t[o + 7] = g; t[o + 8] = h;
    this.n = o + PRIM_STRIDE;
  }

  /** The written prefix, as the engine reads it — a view, not a copy. */
  view(): Float64Array {
    return this.a.subarray(0, this.n);
  }
}

export function encodePrim(p: Prim, out: PrimSink): void {
  switch (p.t) {
    case 'line':
      out.row(0, p.x0, p.y0, p.x1, p.y1, 0, 0, 0, 0);
      break;
    case 'arc':
      out.row(1, p.cx, p.cy, p.r, p.start, p.sweep, 0, 0, 0);
      break;
    case 'cubic':
      out.row(2, p.x0, p.y0, p.c0x, p.c0y, p.c1x, p.c1y, p.x1, p.y1);
      break;
  }
}

export function decodePrim(row: Float64Array | number[], off: number): Prim {
  const k = row[off];
  if (k === 0) {
    return { t: 'line', x0: row[off + 1], y0: row[off + 2], x1: row[off + 3], y1: row[off + 4] };
  }
  if (k === 1) {
    return {
      t: 'arc',
      cx: row[off + 1], cy: row[off + 2], r: row[off + 3],
      start: row[off + 4], sweep: row[off + 5],
    };
  }
  return {
    t: 'cubic',
    x0: row[off + 1], y0: row[off + 2],
    c0x: row[off + 3], c0y: row[off + 4],
    c1x: row[off + 5], c1y: row[off + 6],
    x1: row[off + 7], y1: row[off + 8],
  };
}
