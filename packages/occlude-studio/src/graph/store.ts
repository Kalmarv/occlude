/**
 * Client for the server-side graph and group stores (see graph-store.mjs,
 * wired in vite.config.ts and server.mjs). Graphs are JSON documents beside
 * the sketches, not in them: the sketch library is the git history, a graph
 * is one document you overwrite. A group is the same document shape with a
 * boundary, in its own library, so it can be wired into any graph. */

export interface GraphInfo {
  name: string;
  mtime: number;
}

/** Rejects with the server's own message, as the sketch client does. */
const check = async (res: Response, what: string): Promise<Response> => {
  if (res.ok) return res;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? `${what} failed (${res.status})`);
};

/** One library of documents: `graphs` or `groups`. */
const list = async (kind: 'graphs' | 'groups'): Promise<GraphInfo[]> => {
  const res = await check(await fetch(`/api/${kind}`), `${kind} list`);
  return (await res.json()) as GraphInfo[];
};

export async function listGraphs(): Promise<GraphInfo[]> {
  return list('graphs');
}

export async function listGroups(): Promise<GraphInfo[]> {
  return list('groups');
}

export async function loadGroupText(name: string): Promise<string> {
  const res = await check(await fetch(`/api/groups/${encodeURIComponent(name)}`), `group '${name}'`);
  return res.text();
}

export async function saveGroupText(name: string, json: string): Promise<void> {
  await check(
    await fetch(`/api/groups/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: json,
    }),
    'save group',
  );
}

export async function deleteGroup(name: string): Promise<void> {
  await check(await fetch(`/api/groups/${encodeURIComponent(name)}`, { method: 'DELETE' }), 'delete group');
}

export async function loadGraphText(name: string): Promise<string> {
  const res = await check(await fetch(`/api/graphs/${encodeURIComponent(name)}`), `graph '${name}'`);
  return res.text();
}

export async function saveGraphText(name: string, json: string): Promise<void> {
  await check(
    await fetch(`/api/graphs/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: json,
    }),
    'save',
  );
}

export async function deleteGraph(name: string): Promise<void> {
  await check(await fetch(`/api/graphs/${encodeURIComponent(name)}`, { method: 'DELETE' }), 'delete');
}

/** The graph page on one graph: what the shell links to and what a save
 * leaves in the address bar. */
export function graphHref(name: string): string {
  return `/graph.html?${new URLSearchParams({ graph: name }).toString()}`;
}