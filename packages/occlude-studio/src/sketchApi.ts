/** Client for the server-side sketch store (see vite.config.ts). */

export interface SketchMeta {
  name: string;
  mtime: number;
}

export async function listSketches(): Promise<SketchMeta[]> {
  const res = await fetch('/api/sketches');
  if (!res.ok) throw new Error(`sketch list failed (${res.status})`);
  return (await res.json()) as SketchMeta[];
}

export async function loadSketchByName(name: string): Promise<string> {
  const res = await fetch(`/api/sketches/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`sketch '${name}' not found (${res.status})`);
  return res.text();
}

export async function saveSketchByName(name: string, source: string): Promise<void> {
  const res = await fetch(`/api/sketches/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: source,
  });
  if (!res.ok) throw new Error(`save failed (${res.status})`);
}

export async function deleteSketchByName(name: string): Promise<void> {
  const res = await fetch(`/api/sketches/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`delete failed (${res.status})`);
}

// ---- the library beyond files: forks, snapshots, thumbnails, history ----

export interface SketchInfo extends SketchMeta {
  /** Parent sketch name when this file is a fork (its first line says so). */
  parent: string | null;
  snapshots: number;
  thumb: boolean;
}

export interface SnapshotMeta {
  seed?: string | number | null;
  label?: string;
  at?: string;
}

export interface Snapshot {
  name: string;
  id: string;
  sha: string;
  meta: SnapshotMeta;
}

const j = async (res: Response, what: string): Promise<unknown> => {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${what} failed (${res.status})`);
  }
  return res.json();
};

export async function listSketchInfo(): Promise<SketchInfo[]> {
  return (await j(await fetch('/api/sketches'), 'sketch list')) as SketchInfo[];
}

export async function forkSketch(name: string, to: string): Promise<string> {
  const r = (await j(
    await fetch(`/api/sketches/${encodeURIComponent(name)}/fork`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }),
    }),
    'fork',
  )) as { name: string };
  return r.name;
}

export async function listSnapshots(name: string): Promise<Snapshot[]> {
  return (await j(await fetch(`/api/sketches/${encodeURIComponent(name)}/snapshots`), 'snapshots')) as Snapshot[];
}

export async function createSnapshot(name: string, meta: SnapshotMeta): Promise<string> {
  const r = (await j(
    await fetch(`/api/sketches/${encodeURIComponent(name)}/snapshots`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(meta),
    }),
    'snapshot',
  )) as { id: string };
  return r.id;
}

export async function loadSnapshot(name: string, id: string): Promise<{ source: string; meta: SnapshotMeta }> {
  return (await j(
    await fetch(`/api/sketches/${encodeURIComponent(name)}/snapshots/${id}`),
    'snapshot',
  )) as { source: string; meta: SnapshotMeta };
}

export async function deleteSnapshot(name: string, id: string): Promise<void> {
  await j(await fetch(`/api/sketches/${encodeURIComponent(name)}/snapshots/${id}`, { method: 'DELETE' }), 'delete snapshot');
}

export async function forkSnapshot(name: string, id: string, to: string): Promise<string> {
  const r = (await j(
    await fetch(`/api/sketches/${encodeURIComponent(name)}/snapshots/${id}/fork`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }),
    }),
    'fork snapshot',
  )) as { name: string };
  return r.name;
}

export interface Commit {
  sha: string;
  time: number;
  subject: string;
}

export async function sketchHistory(name: string): Promise<{ commits: Commit[]; snapshots: Snapshot[] }> {
  return (await j(await fetch(`/api/sketches/${encodeURIComponent(name)}/history`), 'history')) as {
    commits: Commit[]; snapshots: Snapshot[];
  };
}

export function thumbUrl(name: string, snapId?: string): string {
  const base = `/api/sketches/${encodeURIComponent(name)}`;
  return snapId ? `${base}/snapshots/${snapId}/thumb` : `${base}/thumb`;
}

export async function putThumb(name: string, png: Blob, snapId?: string): Promise<void> {
  await fetch(thumbUrl(name, snapId), { method: 'PUT', headers: { 'content-type': 'image/png' }, body: png });
}

/** The studio's finished render, scaled to a small PNG: no re-render, the
 * preview canvas is already painted. */
export function thumbFromCanvas(canvas: HTMLCanvasElement, width = 360): Promise<Blob | null> {
  const w = Math.max(1, Math.min(width, canvas.width));
  const h = Math.max(1, Math.round((canvas.height / Math.max(1, canvas.width)) * w));
  const small = document.createElement('canvas');
  small.width = w;
  small.height = h;
  small.getContext('2d')!.drawImage(canvas, 0, 0, w, h);
  return new Promise((resolve) => small.toBlob(resolve, 'image/png'));
}

/** Hand a source to the studio and go there: what the Sketches page does
 * for open, fork, and snapshot. */
export function openInStudio(name: string, source: string, seed?: string | number | null): void {
  localStorage.setItem('occlude.sketch', source);
  localStorage.setItem('occlude.sketchName', name);
  location.href = seed !== undefined && seed !== null ? `/?seed=${encodeURIComponent(String(seed))}` : '/';
}
