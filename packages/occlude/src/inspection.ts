/**
 * The inspection registry: what a run captured for the studio's Inspect
 * tab. It lives outside the sketch state on purpose — module-scope
 * declarations are captured before `sketch()` resets the state, and the
 * registry must survive that reset within one host execution. The host
 * clears it explicitly at the start of every run (`setInspectHint`), and
 * with the hint off nothing is retained, so a sketch that is not being
 * inspected costs nothing on this account.
 *
 * Two kinds of registration share the registry:
 *  - explicit `t.inspect(label, value)`: a label names one value; a reused
 *    label replaces its value;
 *  - automatic capture sites the studio's emit inserts, keyed by source
 *    identity and carrying an `InspectionSource`: every execution of the
 *    site is an occurrence, retained up to the limits.
 *
 * Retention is bounded by handles and rows, not bytes: the captured values
 * are the sketch's own objects, never copied here.
 */

import { describeInspectionValue, type InspectionKind } from './inspectionValues.js';
import { Material, stationsMaterial, type Station } from './material.js';
import type { TransformOp } from './state.js';

/** The name the studio's emitted code calls for every capture site. */
export const INSPECT_HOOK = '__occlude_inspect';

export const INSPECTION_LIMITS = {
  /** Distinct captures per run. */
  captures: 256,
  /** Point + edge rows retained across all captures. */
  rows: 1_000_000,
  /** Rows one capture may retain; beyond it the capture keeps a summary only. */
  previewRows: 250_000,
  /** Executions of one automatic site retained as separate values. */
  occurrences: 10_000,
} as const;

export interface InspectionSource {
  document: string;
  revision: string;
  start: number;
  end: number;
  label: string;
  line: number;
  kind?: string;
  expression?: boolean;
}

/** What the current run registered, in first-seen order. */
export interface InspectionEntry {
  /** The registry key: a label, or a source identity for automatic sites. */
  name: string;
  kind?: InspectionKind;
  points: number;
  /** Absent for values without connections (stations derive theirs on preview). */
  edges?: number;
  summary?: string;
  source?: InspectionSource;
  /** Executions of the site this run, and how many are retained. */
  occurrences: number;
  retainedOccurrences: number;
  /** Set when a limit stopped retention; the message says which. */
  limited?: string;
}

interface Capture {
  kind: InspectionKind;
  source?: InspectionSource;
  /** Retained values, one per retained occurrence. */
  values: unknown[];
  occurrences: number;
  points: number;
  edges: number | undefined;
  rows: number;
  summary: string;
  limited?: string;
}

/** Where a value landed in the returned drawing: shape indices and the
 * transform chain in force when it was emitted. */
export interface InspectionPlacement { start: number; end: number; transforms: TransformOp[] }

let inspectHint = false;
let captures = new Map<string, Capture>();
let placements = new WeakMap<object, InspectionPlacement[]>();
let rowsRetained = 0;
let dropped = 0;

/** Host switch: off (the default) registers nothing. Turning it either way
 * clears the registry, so every inspected run starts empty. */
export function setInspectHint(on: boolean): void {
  inspectHint = on;
  clearInspections();
}

export function getInspectHint(): boolean {
  return inspectHint;
}

export function clearInspections(): void {
  captures = new Map();
  placements = new WeakMap();
  rowsRetained = 0;
  dropped = 0;
}

export function recordInspectionPlacement(value: object, placement: InspectionPlacement): void {
  const list = placements.get(value);
  if (list) list.push(placement);
  else placements.set(value, [placement]);
}

export function getInspectionPlacements(value: unknown): readonly InspectionPlacement[] {
  return value && typeof value === 'object' ? placements.get(value) ?? [] : [];
}

/** Register `value` under `label`. With a `source` this is an automatic
 * site and every call is one more occurrence of it; without one it is an
 * explicit `t.inspect` and the last value wins. A value that is not
 * inspectable geometry is ignored at an automatic site (the site keeps
 * the occurrences it already has) and forgets the label at an explicit one. */
export function recordInspection(label: string, value: unknown, source?: InspectionSource): void {
  if (!inspectHint) return;
  const described = describeInspectionValue(value, source?.kind);
  const old = captures.get(label);
  if (!described) {
    if (!source && old) forget(label, old);
    return;
  }
  const { kind, points, edges, rows, summary } = described;
  if (!old) {
    if (captures.size >= INSPECTION_LIMITS.captures) { dropped++; return; }
    const capture: Capture = { kind, source, values: [], occurrences: 0, points: 0, edges: undefined, rows: 0, summary };
    captures.set(label, capture);
    retain(capture, value, points, edges, rows);
    return;
  }
  if (source) {
    retain(old, value, points, edges, rows);
    return;
  }
  // Explicit relabel: the last value wins, in the label's first-seen
  // position; the registrations still count as occurrences.
  rowsRetained -= old.rows;
  Object.assign(old, { kind, values: [], points: 0, edges: undefined, rows: 0, summary, limited: undefined });
  retain(old, value, points, edges, rows);
}

function retain(c: Capture, value: unknown, points: number, edges: number | undefined, rows: number): void {
  c.occurrences++;
  const limit = c.rows + rows > INSPECTION_LIMITS.previewRows ? 'rows for one capture'
    : rowsRetained + rows > INSPECTION_LIMITS.rows ? 'rows across all captures'
    : c.values.length >= INSPECTION_LIMITS.occurrences ? 'occurrences'
    : null;
  if (limit) {
    c.limited = `Inspection limit reached (${limit}); retained ${c.values.length} of ${c.occurrences} occurrences`;
    return;
  }
  c.values.push(value);
  c.rows += rows;
  rowsRetained += rows;
  c.points += points;
  if (edges !== undefined) c.edges = (c.edges ?? 0) + edges;
  if (c.limited) c.limited = `Inspection limit reached; retained ${c.values.length} of ${c.occurrences} occurrences`;
}

function forget(label: string, c: Capture): void {
  rowsRetained -= c.rows;
  captures.delete(label);
}

export function getInspectionIndex(): InspectionEntry[] {
  const out: InspectionEntry[] = [];
  for (const [name, c] of captures) {
    const summary = c.occurrences > 1
      ? `${c.occurrences} occurrences · ${c.points ? `${c.points} points${c.edges === undefined ? '' : ` / ${c.edges} edges`}` : c.kind}`
      : c.summary;
    out.push({
      name, kind: c.kind, points: c.points, edges: c.edges, summary, source: c.source,
      occurrences: c.occurrences, retainedOccurrences: c.values.length, limited: c.limited,
    });
  }
  return out;
}

/** Captures that did not fit in the handle limit this run. */
export function getInspectionDropped(): number {
  return dropped;
}

/** Every retained value of a capture, oldest occurrence first. Throws when
 * a limit left nothing to show, with the limit's own message. */
export function getInspectionValues(name: string): readonly unknown[] {
  const c = captures.get(name);
  if (!c) return [];
  if (c.limited && c.values.length === 0) throw new Error(c.limited);
  return c.values;
}

/** The last retained value of a capture, or undefined. */
export function getInspectionValue(name: string): unknown {
  const c = captures.get(name);
  if (!c) return undefined;
  if (c.limited && c.values.length === 0) throw new Error(c.limited);
  return c.values[c.values.length - 1];
}

/** One registered material as plain transport: copies of its positions,
 * edge list and declared columns, nothing branded, nothing shared with the
 * material (so a transfer cannot detach what the sketch still holds). */
export interface InspectionPayload {
  name: string;
  n: number;
  x: Float64Array;
  y: Float64Array;
  edges: Uint32Array;
  attrs: Record<string, Float64Array>;
  edgeAttrs: Record<string, Float64Array>;
  iteration: number;
}

export function inspectionPayload(name: string): InspectionPayload | null {
  const c = captures.get(name);
  if (!c) return null;
  const value = getInspectionValue(name);
  const m = value instanceof Material ? value : c.kind === 'stations' ? stationsMaterial(value as readonly Station[]) : null;
  if (!m) throw new Error('This capture needs a geometry preview');
  const attrs: Record<string, Float64Array> = {};
  for (const k of Object.keys(m.attrs)) attrs[k] = m.attrs[k].slice();
  const edgeAttrs: Record<string, Float64Array> = {};
  for (const k of Object.keys(m.edgeAttrs)) edgeAttrs[k] = m.edgeAttrs[k].slice();
  return { name, n: m.n, x: m.x.slice(), y: m.y.slice(), edges: m.edgeList.slice(), attrs, edgeAttrs, iteration: m.iteration };
}
