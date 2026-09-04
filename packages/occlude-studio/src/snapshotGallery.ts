/**
 * The snapshot lightbox: one frozen render at a time, filling the screen,
 * arrow keys to flip. Snapshotting is cheap and the Sketches page draws
 * them as 110x76 pictures hung off a lineage graph — good for seeing where
 * a render came from, useless for deciding which one to print. This is the
 * deciding view: the image as large as the window allows, the seed and date
 * under it, and the actions that matter next to them.
 *
 * Snapshots are annotated git tags carrying { seed, label, at }, and each
 * has a committed thumbnail — but those are 360px, made for the lineage
 * graph, so filling a window with one is an upscale. The thumbnail is
 * therefore only the FIRST paint: the snapshot's frozen source is re-run in
 * a render worker and the real render replaces it, at the size the window
 * actually is.
 *
 * Caveat worth knowing: a re-render uses TODAY's pens and paper, not
 * whatever was set when the snapshot was frozen (the tag stores only seed,
 * label and time). The seed is honoured, so the geometry is the frozen
 * geometry; the stock and nibs are current.
 */

import {
  forkSnapshot, listSketchInfo, loadSnapshot, openInStudio, sketchHistory, snapshotJs, thumbUrl,
  type Snapshot,
} from './sketchApi.js';
import { liveExampleToJs } from 'occlude';
import { loadPens, loadSettings } from './store.js';
import { RenderClient } from './workerClient.js';

export interface GalleryOpts {
  /** Snapshots to show, newest first. */
  shots: Snapshot[];
  /** Which one to open on. */
  index?: number;
  /** What this set is ("contours", "beach-house family", …). */
  scope: string;
}

/** Newest first. Snapshot ids are `20260902T191019Z`, so lexicographic
 * ordering IS chronological — no date parsing needed. */
const newestFirst = (a: Snapshot, b: Snapshot): number => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

let close: (() => void) | null = null;

/** Every snapshot in the library, for the all-sketches toggle. */
async function everySnapshot(): Promise<Snapshot[]> {
  const all = await listSketchInfo();
  const hist = await Promise.all(
    all.map((i) => sketchHistory(i.name).catch(() => ({ commits: [], snapshots: [] }))),
  );
  return hist.flatMap((h) => h.snapshots).sort(newestFirst);
}

export function openGallery(opts: GalleryOpts): void {
  close?.();
  let shots = [...opts.shots].sort(newestFirst);
  let scope = opts.scope;
  let i = Math.max(0, Math.min(opts.index ?? 0, shots.length - 1));
  let showingAll = false;
  if (shots.length === 0) return;

  const div = (cls: string, text?: string): HTMLDivElement => {
    const d = document.createElement('div');
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  };
  const button = (label: string, title: string, fn: () => void | Promise<void>): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    b.onclick = (e) => { e.stopPropagation(); void fn(); };
    return b;
  };

  const root = div('gal-root');
  const stage = div('gal-stage');
  const working = div('gal-working', 'rendering…');
  working.hidden = true;
  const img = document.createElement('img');
  img.className = 'gal-img';
  img.alt = '';
  const missing = div('gal-missing', 'no thumbnail for this snapshot');
  missing.hidden = true;
  stage.append(img, missing, working);

  // The list reads newest first, so ← / › move with the counter, not with
  // time: → always advances 1/18 -> 2/18, which is what the arrow looks like
  // it should do.
  const prev = button('‹', 'Newer (←)', () => go(i - 1));
  const next = button('›', 'Older (→)', () => go(i + 1));
  prev.className = 'gal-arrow gal-prev';
  next.className = 'gal-arrow gal-next';

  const title = div('gal-title');
  const sub = div('gal-sub');
  const count = div('gal-count');
  const actions = div('gal-actions');
  const bar = div('gal-bar');
  const meta = div('gal-meta');
  meta.append(title, sub);
  bar.append(meta, actions, count);

  const hint = div('gal-hint', '← → flip · Home/End ends · A all sketches · Esc close');
  root.append(stage, prev, next, bar, hint);

  // Preloading the neighbours is what makes flipping feel instant.
  const preload = (n: number): void => {
    const s = shots[n];
    if (!s) return;
    const p = new Image();
    p.src = thumbUrl(s.name, s.id);
  };

  // ---- the real render, in the background ----
  // One worker for the whole session of the lightbox; renders are keyed by
  // snapshot so flipping back is instant, and a render that finishes after
  // you have moved on is dropped rather than painted over the new one.
  const key = (s: Snapshot): string => `${s.name}@${s.id}`;
  const rendered = new Map<string, string>();
  let client: RenderClient | null = null;
  let renderSeq = 0;

  async function realRender(s: Snapshot): Promise<void> {
    const k = key(s);
    if (rendered.has(k)) {
      img.src = rendered.get(k)!;
      img.classList.remove('thumb');
      return;
    }
    const mine = ++renderSeq;
    working.textContent = 'rendering…';
    working.title = '';
    working.hidden = false;
    try {
      const [ts, pens] = await Promise.all([snapshotJs(s.name, s.id), loadPens()]);
      const settings = loadSettings();
      // The server strips types; the worker evaluates CommonJS. This is the
      // same ESM→CJS rewrite the docs examples and the fill loader use.
      const js = liveExampleToJs(ts);
      client ??= new RenderClient();
      const reply = await client.render({
        js,
        cfg: {
          pens,
          paper: settings.paper === 'Custom' ? settings.customPaper : settings.paper,
          landscape: settings.landscape,
          defaultMarginPct: settings.defaultMarginPct,
          coarsen: 1,
          seed: s.meta.seed ?? null,
        },
      });
      if (!reply || mine !== renderSeq) return; // superseded, or you flipped on
      // ~150 dpi: sharp on any screen, a fraction of the 300 dpi export.
      const bytes = await client.exportPng(reply.result.paper.w, reply.result.paper.h, 5.9, settings.paperColor);
      if (mine !== renderSeq) return;
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
      rendered.set(k, url);
      img.src = url;
      img.classList.remove('thumb');
    } catch (e) {
      // A snapshot whose source no longer runs still has its thumbnail. Keep
      // it, but say so — a silently blurry image looks like a bug.
      if (mine === renderSeq) {
        working.textContent = 'thumbnail only';
        working.title = e instanceof Error ? e.message : String(e);
        console.warn('snapshot re-render failed', s.name, s.id, e);
      }
      return;
    } finally {
      if (mine === renderSeq && working.textContent === 'rendering…') working.hidden = true;
    }
  }

  function paint(): void {
    const s = shots[i];
    if (!s) return;
    missing.hidden = true;
    img.hidden = false;
    const done = rendered.get(key(s));
    img.src = done ?? thumbUrl(s.name, s.id);
    img.classList.toggle('thumb', !done);
    img.onerror = () => { img.hidden = true; missing.hidden = false; };
    void realRender(s);
    const seed = s.meta.seed ?? '—';
    title.textContent = s.meta.label ? `${s.name} · ${s.meta.label}` : s.name;
    const at = s.meta.at ? new Date(s.meta.at) : null;
    sub.textContent =
      `seed ${seed}` +
      (at && !Number.isNaN(at.getTime())
        ? ` · ${at.toLocaleDateString()} ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : ` · ${s.id}`);
    count.textContent = `${i + 1} / ${shots.length}  ·  ${scope}`;
    prev.disabled = i <= 0;
    next.disabled = i >= shots.length - 1;
    preload(i - 1);
    preload(i + 1);
  }

  function go(n: number): void {
    if (n < 0 || n >= shots.length) return;
    i = n;
    paint();
  }

  async function toggleAll(): Promise<void> {
    const here = shots[i];
    if (showingAll) {
      shots = [...opts.shots].sort(newestFirst);
      scope = opts.scope;
      showingAll = false;
    } else {
      count.textContent = 'loading…';
      shots = await everySnapshot();
      scope = 'all sketches';
      showingAll = true;
    }
    // Keep the eye on the same render across the switch where possible.
    const at = shots.findIndex((s) => s.name === here.name && s.id === here.id);
    i = at >= 0 ? at : 0;
    paint();
  }

  actions.append(
    button('open in studio', 'Load this snapshot’s source and seed into the studio', async () => {
      const s = shots[i];
      const { source, meta } = await loadSnapshot(s.name, s.id);
      openInStudio(s.name, source, meta.seed);
    }),
    button('fork', 'Start a new sketch from this snapshot', async () => {
      const s = shots[i];
      const made = await forkSnapshot(s.name, s.id);
      const { source, meta } = await loadSnapshot(s.name, s.id);
      openInStudio(made, source, meta.seed);
    }),
    button('all sketches', 'Show every snapshot in the library (A)', () => toggleAll()),
  );

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { done(); return; }
    if (e.key === 'ArrowRight') { go(i + 1); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft') { go(i - 1); e.preventDefault(); return; }
    if (e.key === 'Home') { go(0); e.preventDefault(); return; }
    if (e.key === 'End') { go(shots.length - 1); e.preventDefault(); return; }
    if (e.key === 'a' || e.key === 'A') { void toggleAll(); e.preventDefault(); }
  };
  function done(): void {
    document.removeEventListener('keydown', onKey);
    renderSeq++;                       // orphan any in-flight render
    client?.dispose();
    client = null;
    for (const url of rendered.values()) URL.revokeObjectURL(url);
    rendered.clear();
    root.remove();
    close = null;
  }
  close = done;
  root.onclick = (e) => { if (e.target === root || e.target === stage) done(); };
  document.addEventListener('keydown', onKey);
  document.body.append(root);
  paint();
}
