/**
 * Preload the assets a sketch references (string literals in `asset('…')` /
 * `image('…')`) into the occlude registry BEFORE the synchronous sketch
 * executes. Images decode once and cache; upload/delete invalidates.
 * Decode is capped at 1536px on the long side — plot features never need
 * more, and summed-area tables stay small.
 */

import {
  clearAssets, registerImageAsset, registerTextAsset, scanAssetNames,
} from 'occlude';

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

/** Fetch/decode every referenced asset and (re)fill the registry. */
export async function preloadAssets(source: string): Promise<void> {
  const names = scanAssetNames(source);
  const loaded = await Promise.all(
    names.map(async (name) => {
      let p = cache.get(name);
      if (!p) {
        p = fetchAsset(name);
        cache.set(name, p);
        p.catch(() => cache.delete(name)); // failed fetches retry next run
      }
      return [name, await p] as const;
    }),
  );
  clearAssets();
  for (const [name, a] of loaded) {
    if (a.kind === 'text') registerTextAsset(name, a.text!);
    else registerImageAsset(name, a.pixels!);
  }
}
