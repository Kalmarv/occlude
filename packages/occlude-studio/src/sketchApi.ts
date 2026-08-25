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
