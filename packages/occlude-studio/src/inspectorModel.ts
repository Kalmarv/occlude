/**
 * The material inspector's state, with no DOM: which execution and name
 * are shown, the loaded payload in paper coordinates, the colouring
 * domain and column, the selection, and the picking and range rules. The
 * DOM module renders this; tests exercise it directly.
 */

import type { InspectionEntry, InspectionPayload } from 'occlude';

/** A column's displayed range, from its finite values only. */
export type ColumnRange =
  | { kind: 'range'; min: number; max: number; finite: number; missing: number }
  | { kind: 'constant'; value: number; finite: number; missing: number }
  | { kind: 'empty'; finite: 0; missing: number };

export function columnRange(values: ArrayLike<number>): ColumnRange {
  let min = Infinity;
  let max = -Infinity;
  let finite = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    finite++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const missing = values.length - finite;
  if (finite === 0) return { kind: 'empty', finite: 0, missing };
  if (min === max) return { kind: 'constant', value: min, finite, missing };
  return { kind: 'range', min, max, finite, missing };
}

/** Neutral for the other domain, unavailable values and no column. */
export const NEUTRAL = '#9a9ca3';

const STOPS: [number, number, number][] = [
  [59, 111, 214],  // low: toolpath blue
  [232, 197, 71],  // mid: yellow
  [217, 79, 59],   // high: red
];

/** 0…1 → colour, through blue, yellow and red. */
export function ramp(t: number): string {
  const u = Math.min(1, Math.max(0, t)) * 2;
  const k = u < 1 ? 0 : 1;
  const f = u - k;
  const a = STOPS[k];
  const b = STOPS[k + 1];
  const c = a.map((x, i) => Math.round(x + (b[i] - x) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** The colour of one value under a range; null when it has no colour
 * (non-finite, or the column has none), so the caller draws it neutral. */
export function colorFor(v: number, r: ColumnRange): string | null {
  if (!Number.isFinite(v)) return null;
  if (r.kind === 'constant') return ramp(0.5);
  if (r.kind === 'empty') return null;
  return ramp((v - r.min) / (r.max - r.min));
}

/** A loaded material, positions already in paper mm, with the adjacency
 * the selection details read (built once per payload). */
export interface LoadedMaterial extends InspectionPayload {
  executionId: number;
  px: Float64Array;
  py: Float64Array;
  /** CSR incident-edge lists: edges of vertex i are adjEdges[adjStart[i]…adjStart[i+1]). */
  adjStart: Uint32Array;
  adjEdges: Uint32Array;
}

export function prepare(raw: InspectionPayload, executionId: number, toPaper: (x: number, y: number) => [number, number]): LoadedMaterial {
  const px = new Float64Array(raw.n);
  const py = new Float64Array(raw.n);
  for (let i = 0; i < raw.n; i++) {
    const [x, y] = toPaper(raw.x[i], raw.y[i]);
    px[i] = x;
    py[i] = y;
  }
  const e = raw.edges.length / 2;
  const adjStart = new Uint32Array(raw.n + 1);
  for (let k = 0; k < e; k++) {
    adjStart[raw.edges[2 * k] + 1]++;
    adjStart[raw.edges[2 * k + 1] + 1]++;
  }
  for (let i = 0; i < raw.n; i++) adjStart[i + 1] += adjStart[i];
  const fill = adjStart.slice(0, raw.n);
  const adjEdges = new Uint32Array(adjStart[raw.n]);
  for (let k = 0; k < e; k++) {
    adjEdges[fill[raw.edges[2 * k]]++] = k;
    adjEdges[fill[raw.edges[2 * k + 1]]++] = k;
  }
  return { ...raw, executionId, px, py, adjStart, adjEdges };
}

export function incidentEdges(m: LoadedMaterial, i: number): number[] {
  return Array.from(m.adjEdges.subarray(m.adjStart[i], m.adjStart[i + 1]));
}

/** The other end of edge `e` from vertex `i`. */
export function otherEnd(m: LoadedMaterial, e: number, i: number): number {
  const a = m.edges[2 * e];
  return a === i ? m.edges[2 * e + 1] : a;
}

/** Nearest point within `tol` (paper mm), lowest row on a tie; -1 for none. */
export function pickPoint(m: LoadedMaterial, x: number, y: number, tol: number): number {
  let best = -1;
  let bestD = tol * tol;
  for (let i = 0; i < m.n; i++) {
    const dx = m.px[i] - x;
    const dy = m.py[i] - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Nearest edge within `tol` (paper mm), lowest row on a tie; -1 for none. */
export function pickEdge(m: LoadedMaterial, x: number, y: number, tol: number): number {
  let best = -1;
  let bestD = tol * tol;
  const e = m.edges.length / 2;
  for (let k = 0; k < e; k++) {
    const a = m.edges[2 * k];
    const b = m.edges[2 * k + 1];
    const ax = m.px[a];
    const ay = m.py[a];
    const bx = m.px[b];
    const by = m.py[b];
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * vx + (y - ay) * vy) / len2));
    const dx = ax + vx * t - x;
    const dy = ay + vy * t - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

export type Domain = 'points' | 'edges';
export type Selection = { kind: 'point'; index: number } | { kind: 'edge'; index: number };

export class InspectorModel {
  enabled = false;
  /** The execution whose registry `names` describes. */
  executionId = -1;
  names: InspectionEntry[] = [];
  chosen: string | null = null;
  material: LoadedMaterial | null = null;
  domain: Domain = 'points';
  attr: string | null = null;
  showPoints = true;
  showEdges = true;
  selection: Selection | null = null;
  page = 0;
  readonly pageSize = 50;
  /** Column sort of the row table; null is stored order. */
  sort: { key: string; dir: 1 | -1 } | null = null;
  private orderCache: { material: LoadedMaterial; domain: Domain; key: string; dir: 1 | -1; order: Uint32Array } | null = null;

  /** Sortable column keys of the current domain, in table order. */
  sortKeys(): string[] {
    const m = this.material;
    if (!m) return [];
    return this.domain === 'points' ? ['row', 'x', 'y', ...Object.keys(m.attrs)] : ['row', 'a', 'b', 'length', ...Object.keys(m.edgeAttrs)];
  }

  /** Click a header: ascending, then descending, then stored order. */
  toggleSort(key: string): void {
    if (!this.sort || this.sort.key !== key) this.sort = { key, dir: 1 };
    else if (this.sort.dir === 1) this.sort = { key, dir: -1 };
    else this.sort = null;
    this.page = this.selection ? Math.floor(this.positionOf(this.selection.index) / this.pageSize) : 0;
  }

  /** The values a sort key reads, as a typed column (built per call for the
   * derived ones, cached with the order). */
  private sortColumn(key: string): ArrayLike<number> | null {
    const m = this.material!;
    if (this.domain === 'points') {
      if (key === 'x') return m.x;
      if (key === 'y') return m.y;
      return m.attrs[key] ?? null;
    }
    const e = m.edges.length / 2;
    if (key === 'a' || key === 'b') {
      const off = key === 'a' ? 0 : 1;
      const col = new Float64Array(e);
      for (let k = 0; k < e; k++) col[k] = m.edges[2 * k + off];
      return col;
    }
    if (key === 'length') {
      const col = new Float64Array(e);
      for (let k = 0; k < e; k++) {
        const a = m.edges[2 * k];
        const b = m.edges[2 * k + 1];
        col[k] = Math.hypot(m.x[b] - m.x[a], m.y[b] - m.y[a]);
      }
      return col;
    }
    return m.edgeAttrs[key] ?? null;
  }

  /** Row indices in table order: null means stored order. Non-finite
   * values sort last whichever direction; equal values keep row order. */
  order(): Uint32Array | null {
    const m = this.material;
    const sort = this.sort;
    if (!m || !sort || sort.key === 'row') return null;
    const c = this.orderCache;
    if (c && c.material === m && c.domain === this.domain && c.key === sort.key && c.dir === sort.dir) return c.order;
    const col = this.sortColumn(sort.key);
    const n = this.rowCount();
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    if (col) {
      const dir = sort.dir;
      order.sort((i, j) => {
        const a = col[i];
        const b = col[j];
        const fa = Number.isFinite(a);
        const fb = Number.isFinite(b);
        if (fa !== fb) return fa ? -1 : 1;
        if (fa && a !== b) return (a < b ? -1 : 1) * dir;
        return i - j;
      });
    }
    this.orderCache = { material: m, domain: this.domain, key: sort.key, dir: sort.dir, order };
    return order;
  }

  /** Where a row sits in table order. */
  positionOf(row: number): number {
    const o = this.order();
    return o ? o.indexOf(row) : row;
  }

  /** A render landed: adopt its registry, keep the chosen name if it is
   * still there, drop the row selection. Returns the name to fetch (null
   * when nothing is chosen or registered). The old material is released immediately;
   * rows are shown only for the current execution. */
  onRender(executionId: number, names: InspectionEntry[]): string | null {
    this.executionId = executionId;
    this.names = names;
    this.selection = null;
    if (!this.enabled) return null;
    if (this.chosen !== null && !names.some((e) => e.name === this.chosen)) this.chosen = null;
    if (this.chosen === null && names.length > 0) this.chosen = names[0].name;
    // The old rows and sort cache belong to the previous execution.
    this.orderCache = null;
    this.material = null; // old rows must never appear under a new execution
    return this.chosen;
  }

  /** Adopt a loaded material; a payload for another execution or a name no
   * longer chosen is ignored. */
  acceptMaterial(m: LoadedMaterial): boolean {
    if (!this.enabled || m.executionId !== this.executionId || m.name !== this.chosen) return false;
    this.material = m;
    this.selection = null;
    this.page = 0;
    if (this.attr !== null && !this.columns().includes(this.attr)) this.attr = null;
    if (this.sort && !this.sortKeys().includes(this.sort.key)) this.sort = null;
    return true;
  }

  choose(name: string | null): void {
    if (name === this.chosen) return;
    this.chosen = name;
    this.orderCache = null;
    this.material = null;
    this.selection = null;
    this.page = 0;
  }

  setDomain(d: Domain): void {
    if (d === this.domain) return;
    this.domain = d;
    this.attr = null;
    this.selection = null;
    this.sort = null;
    this.page = 0;
  }

  /** Declared columns of the current domain. */
  columns(): string[] {
    const m = this.material;
    if (!m) return [];
    return Object.keys(this.domain === 'points' ? m.attrs : m.edgeAttrs);
  }

  /** The chosen column's values, or null with no column. */
  values(): Float64Array | null {
    const m = this.material;
    if (!m || this.attr === null) return null;
    const col = (this.domain === 'points' ? m.attrs : m.edgeAttrs)[this.attr];
    return col ?? null;
  }

  range(): ColumnRange | null {
    const v = this.values();
    return v ? columnRange(v) : null;
  }

  rowCount(): number {
    const m = this.material;
    if (!m) return 0;
    return this.domain === 'points' ? m.n : m.edges.length / 2;
  }

  pageCount(): number {
    return Math.max(1, Math.ceil(this.rowCount() / this.pageSize));
  }

  select(sel: Selection | null): void {
    this.selection = sel;
    if (sel) {
      const domain: Domain = sel.kind === 'point' ? 'points' : 'edges';
      if (domain === this.domain) this.page = Math.floor(this.positionOf(sel.index) / this.pageSize);
    }
  }

  /** Pick at a paper position with a tolerance in mm: a point whose marker
   * is within reach wins over an edge; otherwise the nearest edge. */
  pick(x: number, y: number, tol: number): Selection | null {
    const m = this.material;
    if (!m) return null;
    if (this.showPoints) {
      const p = pickPoint(m, x, y, tol);
      if (p >= 0) return { kind: 'point', index: p };
    }
    if (this.showEdges) {
      const e = pickEdge(m, x, y, tol);
      if (e >= 0) return { kind: 'edge', index: e };
    }
    return null;
  }

  /** Everything gone: a frozen result, inspection off, a disposed worker. */
  reset(): void {
    this.executionId = -1;
    this.names = [];
    this.orderCache = null;
    this.material = null;
    this.selection = null;
    this.page = 0;
  }
}
