/**
 * Preload the assets a sketch references (string literals in `asset('…')` /
 * `t.image('…')`) into the run's asset table BEFORE the synchronous sketch
 * executes. Images decode once and cache; upload/delete invalidates.
 * Decode is capped at 1536px on the long side — plot features never need
 * more, and summed-area tables stay small.
 */

import { assetTable, scanAssetNames, type AssetTable } from 'occlude';

const MAX_DIM = 1536;

interface Cached {
  kind: 'text' | 'image';
  text?: string;
  pixels?: { width: number; height: number; data: Uint8ClampedArray };
}

const cache = new Map<string, Promise<Cached>>();

export function invalidateAsset(name?: string): void {
  if (name) cache.delete(name);
  else cache.clear();
}

async function fetchAsset(name: string): Promise<Cached> {
  const res = await fetch(`/api/assets/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`asset '${name}' not found — upload it in the Assets panel`);
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('svg') || type.startsWith('text/') || type.includes('json')) {
    return { kind: 'text', text: await res.text() };
  }
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const data = ctx.getImageData(0, 0, w, h);
  return { kind: 'image', pixels: { width: w, height: h, data: data.data } };
}

/** Fetch/decode every asset the source references, as the run's captured
 * table. Decodes are cached across runs (application state); the table a
 * run gets is its own. */
export async function preloadAssets(source: string): Promise<AssetTable> {
  const names = scanAssetNames(source);
  const entries: [string, { text: string } | { pixels: NonNullable<Cached['pixels']> }][] = [];
  for (const name of names) {
    let p = cache.get(name);
    if (!p) {
      p = fetchAsset(name);
      cache.set(name, p);
      p.catch(() => cache.delete(name));
    }
    const c = await p;
    entries.push([name, c.kind === 'text' ? { text: c.text! } : { pixels: c.pixels! }]);
  }
  return assetTable(entries);
}
