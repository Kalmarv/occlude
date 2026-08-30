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

export async function uploadAsset(file: File): Promise<void> {
  const res = await fetch(`/api/assets/${encodeURIComponent(file.name)}`, {
    method: 'PUT',
    body: file,
  });
  if (!res.ok) throw new Error(`upload failed: ${await res.text()}`);
}

export async function deleteAsset(name: string): Promise<void> {
  await fetch(`/api/assets/${encodeURIComponent(name)}`, { method: 'DELETE' });
}
