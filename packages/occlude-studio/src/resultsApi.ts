/** Client for the saved-result store (result-store.mjs). */

import type { PlanSettings, PlanSelection } from 'occlude';

export interface ResultMeta {
  schemaVersion: number;
  /** Identity of the SAVED plan (the selected chains as a plan of their own). */
  planHash: string;
  /** The full plan the selection was made from. */
  sourcePlanHash: string;
  selection: { from: number; to: number; count: number; selectionHash: string };
  request: unknown;
  settings: PlanSettings;
  pens: { name: string; width: number; color: string; feed: number; penDown: number; penUp: number; penDelay: number }[];
  paper: { w: number; h: number };
  profile: { name: string; timing: unknown; tolerance: number } | null;
  eta: { standaloneMs: number; fullMs: number };
  build: string;
  provenance: { sketch: string | null; sourceHash: string | null; seed: string | null };
  /** The whole plan is NOT saved: reopening cannot expand beyond the selection. */
  fullPlanSaved: false;
}

export interface SavedResult extends ResultMeta {
  id: string;
  savedAt: string;
  planBytes: number;
  svgBytes: number;
}

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export async function saveResult(meta: ResultMeta, svg: string, plan: Float64Array): Promise<string> {
  const bytes = new Uint8Array(plan.buffer, plan.byteOffset, plan.byteLength);
  const res = await fetch('/api/results', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ meta, svg, plan: b64(bytes) }),
  });
  if (!res.ok) throw new Error(`save failed: ${(await res.json().catch(() => ({ error: res.statusText }))).error}`);
  return ((await res.json()) as { id: string }).id;
}

export async function listResults(): Promise<SavedResult[]> {
  const res = await fetch('/api/results');
  if (!res.ok) throw new Error('results: server unavailable');
  return (await res.json()) as SavedResult[];
}

export async function loadResult(id: string): Promise<{ meta: SavedResult; plan: Float64Array; svg: string }> {
  const [metaRes, planRes, svgRes] = await Promise.all([fetch(`/api/results/${id}`), fetch(`/api/results/${id}/plan`), fetch(`/api/results/${id}/svg`)]);
  if (!metaRes.ok || !planRes.ok || !svgRes.ok) throw new Error(`result ${id}: not found or incomplete`);
  const meta = (await metaRes.json()) as SavedResult;
  const bytes = new Uint8Array(await planRes.arrayBuffer());
  if (bytes.byteLength % 8 !== 0) throw new Error(`result ${id}: plan bytes are not float64`);
  return { meta, plan: new Float64Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 8), svg: await svgRes.text() };
}

export async function deleteResult(id: string): Promise<void> {
  const res = await fetch(`/api/results/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('delete failed');
}

export const resultSvgUrl = (id: string): string => `/api/results/${id}/svg`;

export function selectionOf(sel: PlanSelection): ResultMeta['selection'] {
  return { from: sel.fromChain, to: sel.toChain, count: sel.count, selectionHash: sel.selectionHash };
}
