/**
 * Thumbnails that self-heal. A thumbnail is a file beside the git store,
 * not history: a deleted-and-restored sketch, a snapshot made before
 * thumbnails existed, or a cleared thumbs folder leaves lineage boxes
 * empty. After the Sketches page has drawn, this walks every sketch and
 * snapshot whose thumbnail the server does not have, renders it in one
 * background worker at the studio's settings, saves the PNG back, and
 * repaints the box — one at a time, lowest priority, never blocking.
 */
import { liveExampleToJs } from 'occlude';

import { RenderClient } from './workerClient.js';
import { loadPens, loadSettings } from './store.js';
import { loadSketchJs, putThumb, snapshotSeed, thumbUrl, type SnapshotMeta } from './sketchApi.js';

export interface ThumbTarget {
  name: string;
  /** A snapshot's id; absent for the sketch's own (head) thumbnail. */
  snap?: string;
  meta?: SnapshotMeta;
}

/** Width of a stored thumbnail, px — the lineage graph's size. */
const THUMB_PX = 360;

let running: Promise<void> | null = null;

/** Does the server have this thumbnail? A HEAD is one round trip, no bytes. */
async function hasThumb(t: ThumbTarget): Promise<boolean> {
  try {
    const res = await fetch(thumbUrl(t.name, t.snap), { method: 'HEAD', cache: 'no-store' });
    return res.ok;
  } catch {
    return true; // unreachable server: nothing to mend now
  }
}

/** Repaint every lineage box showing this thumbnail (a cache-busting href). */
function repaint(t: ThumbTarget): void {
  const base = thumbUrl(t.name, t.snap);
  for (const img of document.querySelectorAll<SVGImageElement>('image')) {
    const href = img.getAttribute('href') ?? '';
    if (href === base || href.startsWith(`${base}?`)) img.setAttribute('href', `${base}?t=${Date.now()}`);
  }
}

/**
 * Mend what is missing among `targets`. Returns when the pass is over; a
 * second call while one runs is folded into it (the page refreshes often).
 */
export function mendThumbs(targets: ThumbTarget[], onMended?: (t: ThumbTarget) => void): Promise<void> {
  if (running) return running;
  running = (async () => {
    let client: RenderClient | null = null;
    try {
      const pens = await loadPens();
      const settings = loadSettings();
      for (const t of targets) {
        if (await hasThumb(t)) continue;
        try {
          client ??= new RenderClient();
          const js = liveExampleToJs(await loadSketchJs({ name: t.name, snap: t.snap }));
          const reply = await client.render({
            js,
            cfg: {
              pens,
              paper: settings.paper === 'Custom' ? settings.customPaper : settings.paper,
              landscape: settings.landscape,
              defaultMarginPct: settings.defaultMarginPct,
              coarsen: 1,
              seed: t.meta ? snapshotSeed(t.meta) : null,
            },
          });
          if (!reply) continue;
          const { w, h } = reply.result.paper;
          const bytes = await client.exportPng(w, h, THUMB_PX / Math.max(1, w), settings.paperColor);
          await putThumb(t.name, new Blob([bytes as BlobPart], { type: 'image/png' }), t.snap);
          repaint(t);
          onMended?.(t);
        } catch (e) {
          // A source that no longer runs has no thumbnail to give; say so once.
          console.warn('thumbnail not regenerated', t.name, t.snap ?? '(head)', e);
        }
      }
    } finally {
      running = null;
    }
  })();
  return running;
}
