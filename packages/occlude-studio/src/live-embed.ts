/**
 * Live examples for the docs site. The site is static Markdown rendered by
 * Blume; this script is the one piece of the studio it loads (from the same
 * origin, so the render worker and the wasm are the studio's own build).
 *
 * A live example is a ` ```ts live … ` fence. Blume keeps the code but
 * drops the fence's meta, so the sources are read from the page's raw
 * Markdown mirror (`index.md` next to every page), where the fences are
 * verbatim, and paired in order with the highlighted blocks on the page.
 * Each block gets a canvas above it, rendered when it comes near the
 * viewport, on the sheet the fence names (Square20 at 5 % by default).
 */

import { DEFAULT_PENS, docsPaper, drawFragments, liveExampleToJs, parseLiveMeta, type LiveMeta } from 'occlude';
import { RenderClient } from './workerClient.js';

interface LiveSource { src: string; meta: LiveMeta }

const FENCE = /```ts live([^\n]*)\n([\s\S]*?)```/g;

export function liveSourcesOf(markdown: string): LiveSource[] {
  const out: LiveSource[] = [];
  for (const m of markdown.matchAll(FENCE)) out.push({ src: m[2], meta: parseLiveMeta(m[1]) });
  return out;
}

let client: RenderClient | null = null;
const queue: (() => Promise<void>)[] = [];
let running = false;
function enqueue(job: () => Promise<void>): void {
  queue.push(job);
  if (running) return;
  running = true;
  void (async () => {
    while (queue.length) await queue.shift()!();
    running = false;
  })();
}

/** Render one example into `el`: a canvas showing the whole drawable, and a
 * button that opens the source in the studio on the same sheet. */
export async function mountLive(el: HTMLElement, live: LiveSource): Promise<void> {
  client ??= new RenderClient();
  const sheet = docsPaper(live.meta);
  try {
    const req = {
      js: liveExampleToJs(live.src),
      cfg: { pens: structuredClone(DEFAULT_PENS), paper: sheet.paper, landscape: sheet.landscape ?? false, defaultMarginPct: live.meta.margin ?? 5, coarsen: 1 },
    };
    // The client answers null when a request was superseded; ask once more.
    const reply = (await client.render(req)) ?? (await client.render(req));
    if (!reply) { el.textContent = 'example did not render — reload the page'; return; }
    const result = reply.result;
    const f = result.frame;
    const w = f.inner.innerW;
    const h = f.inner.innerH;
    // The drawing takes the content width, under its code.
    const cssW = el.clientWidth || 720;
    const cssScale = cssW / w;
    const dpr = window.devicePixelRatio || 1;
    const px = Math.min(16, cssScale * dpr);
    // The same drawing at any size: the whole drawable, paper-coloured.
    const paint = (pixelsPerUnit: number): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = Math.round(w * pixelsPerUnit);
      c.height = Math.round(h * pixelsPerUnit);
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#f6f2ea';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.scale(pixelsPerUnit, pixelsPerUnit);
      ctx.translate(-f.offsetX, -f.offsetY);
      drawFragments(ctx, result.frags, result.pens);
      return c;
    };
    const canvas = paint(px);
    canvas.style.width = `${Math.round(w * cssScale)}px`;
    canvas.style.maxWidth = '100%';
    canvas.style.display = 'block';
    canvas.style.borderRadius = '6px';
    // A bigger look: the drawing as large as the window allows, over the page.
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.textContent = 'preview';
    preview.title = 'Show this drawing as large as the window allows';
    preview.onclick = () => {
      const vw = window.innerWidth * 0.92;
      const vh = window.innerHeight * 0.92;
      const fit = Math.min(vw / w, vh / h);
      const big = paint(Math.min(24, fit * dpr));
      big.style.width = `${Math.round(w * fit)}px`;
      big.style.height = `${Math.round(h * fit)}px`;
      big.style.borderRadius = '8px';
      big.style.boxShadow = '0 24px 80px rgba(0,0,0,.45)';
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);cursor:zoom-out';
      overlay.append(big);
      const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
      const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
      overlay.onclick = close;
      document.addEventListener('keydown', onKey);
      document.body.append(overlay);
    };
    // Open this source in the studio on the same sheet, with the docs pens for the session.
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'open in studio';
    open.style.cssText = 'font:12px inherit;padding:3px 10px;border:1px solid currentColor;border-radius:999px;background:transparent;color:inherit;opacity:.8;cursor:pointer';
    preview.style.cssText = open.style.cssText;
    open.onclick = () => {
      localStorage.setItem('occlude.sketch', live.src);
      localStorage.setItem('occlude.sketchName', '');
      localStorage.setItem('occlude.openSettings', JSON.stringify({
        paper: typeof sheet.paper === 'string' ? sheet.paper : 'Custom',
        customPaper: typeof sheet.paper === 'string' ? undefined : sheet.paper,
        landscape: sheet.landscape ?? false,
        defaultMarginPct: live.meta.margin ?? 5,
        pens: DEFAULT_PENS,
      }));
      location.href = '/';
    };
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin:6px 0 20px';
    bar.append(preview, open);
    el.replaceChildren(canvas, bar);
  } catch (e) {
    el.textContent = `example failed: ${e instanceof Error ? e.message : String(e)}`;
    el.style.cssText = 'color:#b3261e;font:13px ui-monospace,monospace;padding:8px 0';
  }
}

/** Find the page's live blocks, read their sources from the Markdown mirror, and render lazily. */
export async function mountPage(root: ParentNode = document): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('pre[data-title="live"]'));
  if (blocks.length === 0) return;
  // Blume writes a page's raw Markdown beside its folder: /docs/reference/faces/
  // mirrors at /docs/reference/faces.md, and the site root at /docs/index.md.
  const path = location.pathname.replace(/\/$/, '');
  let res = await fetch(path + '.md', { cache: 'no-store' });
  if (!res.ok) res = await fetch(path + '/index.md', { cache: 'no-store' });
  if (!res.ok) return;
  const sources = liveSourcesOf(await res.text());
  const observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      observer.unobserve(en.target);
      const i = Number((en.target as HTMLElement).dataset.liveIndex);
      const live = sources[i];
      if (live) enqueue(() => mountLive(en.target as HTMLElement, live));
    }
  }, { rootMargin: '600px 0px' });
  blocks.forEach((pre, i) => {
    if (pre.dataset.liveIndex !== undefined) return;
    pre.dataset.liveIndex = String(i);
    const out = document.createElement('div');
    out.className = 'occlude-live';
    out.dataset.liveIndex = String(i);
    out.style.cssText = 'min-height:120px;margin:12px 0 4px';
    out.textContent = 'rendering…';
    // Blume wraps the <pre> in a figure with a header; the drawing goes right after it, code first.
    const host = pre.closest('figure') ?? pre;
    host.parentElement?.insertBefore(out, host.nextSibling);
    observer.observe(out);
  });
}

// Blume pages are static and navigate with view transitions; mount now and after every swap.
if (typeof document !== 'undefined') {
  const go = () => { void mountPage(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
  else go();
  document.addEventListener('astro:page-load', go);
}
