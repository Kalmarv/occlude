/**
 * Web docs: the repo's markdown docs rendered in the browser, same deck
 * chrome as the studio. Source of truth stays in docs/*.md.
 */

import './style.css';
import { marked } from 'marked';
import {
  DEFAULT_PENS, drawFragments, evalPrim, liveExampleToJs, setPenLibrary,
} from 'occlude';
import { preloadAssets } from './assetLoader.js';
import { runSketch } from './runner.js';
import { RenderClient } from './workerClient.js';
import architectureMd from '../../../docs/architecture.md?raw';
import referenceMd from '../../../docs/reference.md?raw';
import readmeMd from '../../../README.md?raw';

const PAGES: { slug: string; title: string; md: string }[] = [
  { slug: 'reference', title: 'Reference', md: referenceMd },
  { slug: 'architecture', title: 'Architecture', md: architectureMd },
  { slug: 'readme', title: 'README', md: readmeMd },
];

// ---- live examples: `ts live` fences render through the real engine ----

const liveSources: string[] = [];
marked.use({
  renderer: {
    code({ text, lang }) {
      if (lang === 'ts live') {
        const i = liveSources.push(text) - 1;
        const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        return (
          `<div class="live-example">` +
          `<pre><code>${escaped}</code></pre>` +
          `<div class="live-output" data-live="${i}"></div>` +
          `</div>`
        );
      }
      return false; // default rendering
    },
  },
});

let client: RenderClient | null = null;

async function hydrateLiveExamples(): Promise<void> {
  const outputs = [...content.querySelectorAll<HTMLElement>('[data-live]')];
  if (outputs.length === 0) return;
  client ??= new RenderClient();
  setPenLibrary(structuredClone(DEFAULT_PENS));
  for (const el of outputs) {
    const src = liveSources[Number(el.dataset.live)];
    try {
      const js = liveExampleToJs(src);
      await preloadAssets(js);
      const outcome = runSketch(js, {
        pens: structuredClone(DEFAULT_PENS),
        paper: 'Square20',
        landscape: false,
        defaultMarginPct: 5,
        coarsen: 1,
      });
      if (outcome.error || !outcome.scene) throw outcome.error ?? new Error('no scene');
      const result = await client.render(outcome.scene);
      if (!result) continue;
      // Crop to the drawn content (examples vary in aspect; the render
      // paper does not) with a small margin.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const f of result.frags) {
        for (const s of [0, 0.5, 1]) {
          const [fx, fy] = evalPrim(f.geom, s);
          x0 = Math.min(x0, fx); y0 = Math.min(y0, fy);
          x1 = Math.max(x1, fx); y1 = Math.max(y1, fy);
        }
      }
      const pad = 5;
      const w = Math.max(10, x1 - x0 + pad * 2);
      const h = Math.max(10, y1 - y0 + pad * 2);
      const canvas = document.createElement('canvas');
      // Render at the element's on-screen width × devicePixelRatio so
      // hiDPI screens get true-resolution strokes (bounded for huge crops).
      const dpr = window.devicePixelRatio || 1;
      const cssW = Math.min(760, el.clientWidth || 760);
      const px = Math.min(12, (cssW * dpr) / w);
      canvas.width = Math.round(w * px);
      canvas.height = Math.round(h * px);
      canvas.className = 'live-canvas';
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#f6f2ea';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(px, px);
      ctx.translate(pad - x0, pad - y0);
      drawFragments(ctx, result.frags, result.pens);
      const open = document.createElement('button');
      open.textContent = 'open in studio';
      open.className = 'live-open';
      open.onclick = () => {
        localStorage.setItem('occlude.sketch', src);
        localStorage.setItem('occlude.sketchName', '');
        location.href = '/';
      };
      el.replaceChildren(canvas, open);
    } catch (e) {
      el.textContent = `example failed: ${e instanceof Error ? e.message : String(e)}`;
      el.classList.add('live-error');
    }
  }
}

const nav = document.getElementById('docs-nav')!;
const toc = document.getElementById('docs-toc')!;
const content = document.getElementById('docs-content')!;

function currentSlug(): string {
  const slug = location.hash.replace(/^#\/?/, '').split('#')[0];
  return PAGES.some((p) => p.slug === slug) ? slug : PAGES[0].slug;
}

function currentAnchor(): string | undefined {
  return location.hash.replace(/^#\/?/, '').split('#')[1];
}

// ---- jump-to sidebar: h2/h3 outline of the current page, scroll-spied ----

function slugifyHeading(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function buildToc(slug: string): void {
  const heads = [...content.querySelectorAll<HTMLElement>('h2, h3')];
  toc.replaceChildren();
  toc.hidden = heads.length < 3;
  for (const h of heads) {
    if (!h.id) h.id = slugifyHeading(h.textContent ?? '');
    const a = document.createElement('a');
    a.textContent = h.textContent;
    a.className = h.tagName === 'H2' ? 'toc-h2' : 'toc-h3';
    a.dataset.target = h.id;
    a.href = `#/${slug}#${h.id}`;
    a.onclick = (e) => {
      e.preventDefault();
      h.scrollIntoView();
      history.replaceState(null, '', `#/${slug}#${h.id}`);
      updateTocActive();
    };
    toc.append(a);
  }
  updateTocActive();
}

function updateTocActive(): void {
  let active: string | null = null;
  for (const h of content.querySelectorAll<HTMLElement>('h2, h3')) {
    if (h.getBoundingClientRect().top <= 80) active = h.id;
    else break;
  }
  let current: HTMLAnchorElement | null = null;
  for (const a of toc.querySelectorAll<HTMLAnchorElement>('a')) {
    a.classList.toggle('active', a.dataset.target === active);
    if (a.dataset.target === active) current = a;
  }
  // Keep the active link in view when the outline itself scrolls.
  if (current) {
    const t = toc.getBoundingClientRect();
    const c = current.getBoundingClientRect();
    if (c.top < t.top || c.bottom > t.bottom) current.scrollIntoView({ block: 'center' });
  }
}

window.addEventListener('scroll', updateTocActive, { passive: true });

let shownSlug = '';

async function show(slug: string): Promise<void> {
  // Back/forward between anchors on the same page: just scroll, don't
  // re-render (hydrating every live example again is expensive).
  if (slug === shownSlug) {
    document.getElementById(currentAnchor() ?? '')?.scrollIntoView();
    return;
  }
  shownSlug = slug;
  const page = PAGES.find((p) => p.slug === slug) ?? PAGES[0];
  content.innerHTML = await marked.parse(page.md);
  document.title = `occlude docs — ${page.title}`;
  for (const a of nav.querySelectorAll('a')) {
    a.classList.toggle('active', a.dataset.slug === page.slug);
  }
  // Cross-doc relative links (e.g. ../plan.md) aren't served — neutralise
  // them; same-page anchors keep working.
  for (const a of content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (href.endsWith('.md') || href.startsWith('..')) {
      const target = PAGES.find((p) => href.includes(`${p.slug}.md`));
      if (target) {
        a.href = `#/${target.slug}`;
      } else {
        a.replaceWith(...a.childNodes);
      }
    } else if (href.startsWith('#') && !href.startsWith('#/')) {
      // In-page anchor: route through the page slug so the hash router
      // doesn't mistake it for a page name and bounce to the default.
      a.href = `#/${page.slug}${href}`;
    }
  }
  buildToc(page.slug);
  const anchor = document.getElementById(currentAnchor() ?? '');
  if (anchor) anchor.scrollIntoView();
  else window.scrollTo(0, 0);
  void hydrateLiveExamples();
}

for (const page of PAGES) {
  const a = document.createElement('a');
  a.textContent = page.title;
  a.href = `#/${page.slug}`;
  a.dataset.slug = page.slug;
  nav.append(a);
}

window.addEventListener('hashchange', () => void show(currentSlug()));
void show(currentSlug());
