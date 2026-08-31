/** Client for the server-side asset store (uploaded SVGs/images). */

export interface AssetInfo {
  name: string;
  size: number;
  mtime: number;
}

export async function listAssets(): Promise<AssetInfo[]> {
  const res = await fetch('/api/assets');
  if (!res.ok) throw new Error('asset store unavailable');
  return (await res.json()) as AssetInfo[];
}

/** Replace characters the store rejects; keeps the extension readable. */
export function sanitizeAssetName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9 ._()[\]&+'@-]/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
}

/** Uploads under a sanitized name; returns the name actually stored. */
export async function uploadAsset(file: File, name = file.name): Promise<string> {
  const stored = sanitizeAssetName(name);
  const res = await fetch(`/api/assets/${encodeURIComponent(stored)}`, {
    method: 'PUT',
    body: file,
  });
  if (!res.ok) throw new Error(`upload failed: ${await res.text()}`);
  return stored;
}

export async function deleteAsset(name: string): Promise<void> {
  await fetch(`/api/assets/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/** Rename = copy bytes to the new name, then delete the old (no server
 * endpoint needed). Returns the sanitized new name. */
export async function renameAsset(from: string, to: string): Promise<string> {
  const stored = sanitizeAssetName(to);
  if (stored === from) return stored;
  const res = await fetch(`/api/assets/${encodeURIComponent(from)}`);
  if (!res.ok) throw new Error(`rename failed: '${from}' not found`);
  const put = await fetch(`/api/assets/${encodeURIComponent(stored)}`, {
    method: 'PUT',
    body: await res.blob(),
  });
  if (!put.ok) throw new Error(`rename failed: ${await put.text()}`);
  await deleteAsset(from);
  return stored;
}
