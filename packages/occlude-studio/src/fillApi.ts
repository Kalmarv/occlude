/** Client for the server-side fill library (fill-store.mjs). */

export interface FillMeta {
  name: string;
  mtime: number;
}

export const FILL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export async function listFills(): Promise<FillMeta[]> {
  const res = await fetch('/api/fills');
  if (!res.ok) throw new Error(`fill list failed (${res.status})`);
  return (await res.json()) as FillMeta[];
}

/** Source text, or null when the library has no such fill. */
export async function loadFill(name: string): Promise<string | null> {
  const res = await fetch(`/api/fills/${encodeURIComponent(name)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fill '${name}' load failed (${res.status})`);
  return res.text();
}

export async function saveFill(name: string, source: string): Promise<void> {
  const res = await fetch(`/api/fills/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: source,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `save failed (${res.status})`);
  }
}

export async function deleteFill(name: string): Promise<void> {
  const res = await fetch(`/api/fills/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`delete failed (${res.status})`);
}

/** Saved sketches that reference fill('name') — scanned by the server at
 * call time (warn-on-edit reads the truth, never an index). */
export async function fillUses(name: string): Promise<string[]> {
  const res = await fetch(`/api/fills/${encodeURIComponent(name)}/uses`);
  if (!res.ok) throw new Error(`fill uses scan failed (${res.status})`);
  return (await res.json()) as string[];
}
