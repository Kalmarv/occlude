/**
 * Web docs: the repo's topic pages rendered in the browser, same deck
 * chrome as the studio. Source of truth stays in docs/*.md; the page list
 * is DOC_PAGES (shared with the checker). Live examples render through
 * the real engine as they come near the viewport, on the sheet the fence
 * names (default Square20 at a 5 % margin), and the whole drawable is
 * shown — never a crop to the surviving ink — so framing is honest. Each
 * example's source sits in an editor: edits re-render in place and are
 * not saved anywhere (reload restores the page).
 */

import './style.css';
import { marked } from 'marked';
import { createEditor, type Editor } from './editor.js';
import { UiPanel } from './uiPanel.js';
import {
  DEFAULT_PENS, DOC_PAGES, decodePlanBuffer, docsPaper, drawFragments, evalPrim, liveExampleToJs, paperSize, parseLiveMeta, planValue, resolveDraw, tracePrim,
  type LiveMeta,
} from 'occlude';
import { RenderClient, type RenderReply } from './workerClient.js';

// Every page's markdown, by file, at build time.
const RAW = import.meta.glob('../../../docs/**/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const mdOf = (file: string): string => {
  const key = Object.keys(RAW).find((k) => k.endsWith(`/docs/${file}`));
  return key ? RAW[key] : `# ${file}\n\nmissing`;
};

// ---- live examples: `ts live` fences render through the real engine ----

interface Live {
  src: string;
  meta: LiveMeta;
}
const liveSources: Live[] = [];
marked.use({
  renderer: {
    code({ text, lang }) {
      if (lang && lang.startsWith('ts live')) {
        let meta: LiveMeta = {};
        try {
          meta = parseLiveMeta(lang.slice('ts live'.length));
        } catch (e) {
          return `<div class="live-error">${e instanceof Error ? e.message : String(e)}</div>`;
        }
        const i = liveSources.push({ src: text, meta }) - 1;
        const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        // Reserve the preview's space from the drawable's aspect (the sketch's
        // own when it states one, else the sheet's): no layout jump when it lands.
        const size = drawableAspect(text, meta);
        return (
          `<div class="live-example">` +
          `<div class="live-code-cell"><div class="live-code" data-code="${i}"><pre><code>${escaped}</code></pre></div></div>` +
          `<div class="live-output" data-live="${i}" style="aspect-ratio: ${size.w} / ${size.h}"><span class="live-pending">rendering when in view…</span></div>` +
          `</div>`
        );
      }
      return false; // default rendering
    },
  },
});

/** The shown drawable's proportions before the sketch has run: a fixed
 * `aspect` in the source, else the sheet inside its margin. */
function drawableAspect(src: string, meta: LiveMeta): { w: number; h: number } {
  const m = src.match(/aspect:\s*\[\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*\]/);
  if (m) return { w: Number(m[1]), h: Number(m[2]) };
  if (/aspect:\s*'square'/.test(src)) return { w: 1, h: 1 };
  const size = paperSize(docsPaper(meta));
  const inset = ((meta.margin ?? 5) / 100) * Math.min(size.w, size.h);
  return { w: size.w - 2 * inset, h: size.h - 2 * inset };
}

let client: RenderClient | null = null;
/** Bumped on every page change: results for an older page are dropped. */
let pageToken = 0;
let observer: IntersectionObserver | null = null;
/** Editors on the current page, disposed when it changes. */
const editors: Editor[] = [];

/** Renders go through one worker in the order they were asked for. */
let chain: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>): void {
  chain = chain.then(task).catch(() => undefined);
}

/** Each example's current state: its editor once mounted, and the version
 * of its source that the slot shows (stale edits are dropped). */
interface Slot {
  live: Live;
  out: HTMLElement;
  code: HTMLElement;
  editor: Editor | null;
  version: number;
  bar: HTMLElement | null;
}
const slots = new Map<number, Slot>();

function slotOf(i: number): Slot {
  let slot = slots.get(i);
  if (!slot) {
    slot = {
      live: liveSources[i],
      out: content.querySelector<HTMLElement>(`[data-live="${i}"]`)!,
      code: content.querySelector<HTMLElement>(`[data-code="${i}"]`)!,
      editor: null,
      version: 0,
      bar: null,
    };
    slots.set(i, slot);
  }
  return slot;
}

/** The source as it stands: the editor's text once mounted, else the fence. */
const currentSource = (slot: Slot): string => slot.editor?.getValue() ?? slot.live.src;

/** Replace the static listing with an editor sized to its text. Edits
 * transpile through the TS worker and re-render; nothing is saved. */
function mountEditor(i: number, token: number): void {
  const slot = slotOf(i);
  if (slot.editor || token !== pageToken) return;
  const host = document.createElement('div');
  host.className = 'live-editor';
  const bar = document.createElement('div');
  bar.className = 'live-code-bar';
  const err = document.createElement('span');
  err.className = 'live-err';
  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  const reset = document.createElement('button');
  reset.className = 'live-btn';
  reset.textContent = 'reset';
  reset.title = 'Restore the example as written';
  reset.hidden = true;
  bar.append(err, spacer, reset);
  slot.code.replaceChildren(host, bar);
  slot.bar = bar;
  const foldable = /^\s*\/\/ ?#region/m.test(slot.live.src);
  const editor = createEditor(host, slot.live.src, { uri: `file:///docs/example-${token}-${i}.ts`, inline: true, folding: foldable });
  editors.push(editor);
  slot.editor = editor;
  // The lines this example is about (`focus=` in the fence) stay tinted;
  // a `// #region` block (setup carried from an earlier stage) starts folded.
  const focus = slot.live.meta.focus;
  if (focus) {
    editor.editor.createDecorationsCollection(focus.map(([a, b]) => ({
      range: { startLineNumber: a, startColumn: 1, endLineNumber: b, endColumn: 1 },
      options: { isWholeLine: true, className: 'live-focus', linesDecorationsClassName: 'live-focus-gutter' },
    })));
  }
  // ui() literals in the example become sliders under the code, editing the
  // literal like the studio's panel does; the change re-renders as any edit.
  const controlsHost = document.createElement('div');
  controlsHost.className = 'live-controls';
  slot.code.append(controlsHost);
  const panel = new UiPanel(controlsHost, editor, { inline: true });
  panel.sync();
  editor.onChange(() => panel.sync());
  const foldSetup = () => { if (foldable) void editor.editor.getAction('editor.foldAllMarkerRegions')?.run(); };
  foldSetup();
  reset.onclick = () => { editor.setValue(slot.live.src); foldSetup(); };
  let timer: ReturnType<typeof setTimeout> | null = null;
  editor.onChange(() => {
    reset.hidden = editor.getValue() === slot.live.src;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const version = ++slot.version;
      enqueue(async () => {
        if (version !== slot.version || token !== pageToken) return;
        const emitted = await editor.emit();
        if (!emitted.js) {
          err.textContent = emitted.errors[0] ?? 'syntax error';
          return;
        }
        err.textContent = '';
        slot.out.classList.add('stale');
        await renderInto(slot, emitted.js, version, token);
      });
    }, 350);
  });
}

async function renderInto(slot: Slot, js: string, version: number, token: number): Promise<void> {
  const { live, out: el } = slot;
  client ??= new RenderClient();
  try {
    const sheet = docsPaper(live.meta);
    const reply: RenderReply | null = await client.render({
      js,
      cfg: {
        pens: structuredClone(DEFAULT_PENS),
        paper: sheet.paper,
        landscape: sheet.landscape ?? false,
        defaultMarginPct: live.meta.margin ?? 5,
        coarsen: 1,
      },
    });
    if (!reply || token !== pageToken || version !== slot.version) return;
    const result = reply.result;
    // The whole drawable, with a hairline for the sheet's edge.
    const f = result.frame;
    const x0 = f.offsetX;
    const y0 = f.offsetY;
    const w = f.inner.innerW;
    const h = f.inner.innerH;
    const canvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    const cssW = el.clientWidth || 760;
    const px = Math.min(16, (cssW * dpr) / w);
    canvas.width = Math.round(w * px);
    canvas.height = Math.round(h * px);
    canvas.className = 'live-canvas';
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#f6f2ea';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(px, px);
    ctx.translate(-x0, -y0);
    // A sketch that says t.draw({...}) is shown as it asks: the chosen
    // range of its ordered plan at nib width, the rest ghosted. Ranges by
    // minutes or a budget need a machine; the label says so.
    let shown = false;
    let note = '';
    if (reply.draw) {
      if ((reply.draw.chains || reply.draw.progress) && reply.draw.budget === undefined) {
        try {
          const plan = planValue(reply.plan.buffer, reply.plan.settings, reply.plan.planHash);
          const sel = resolveDraw(plan, reply.draw).final;
          const chains = decodePlanBuffer(reply.plan.buffer);
          ctx.save();
          ctx.strokeStyle = 'rgba(91, 139, 217, 0.45)';
          ctx.lineWidth = 0.12;
          ctx.setLineDash([0.8, 0.8]);
          ctx.beginPath();
          chains.forEach((c, i) => { if (i < sel.fromChain || i >= sel.toChain) for (const q of c.prims) tracePrim(ctx, q); });
          ctx.stroke();
          ctx.restore();
          ctx.save();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          for (let i = sel.fromChain; i < sel.toChain; i++) {
            const c = chains[i];
            const pen = result.pens[c.pen];
            ctx.strokeStyle = pen?.color ?? '#111';
            ctx.fillStyle = ctx.strokeStyle;
            ctx.lineWidth = pen?.width ?? 0.3;
            ctx.beginPath();
            if (c.dot) {
              const [qx, qy] = evalPrim(c.prims[0], 0);
              ctx.arc(qx, qy, ctx.lineWidth / 2, 0, Math.PI * 2);
              ctx.fill();
              continue;
            }
            for (const q of c.prims) tracePrim(ctx, q);
            ctx.stroke();
          }
          ctx.restore();
          shown = true;
          note = `t.draw: chains ${sel.fromChain}–${sel.toChain} of ${chains.length}, the rest ghosted`;
        } catch {
          shown = false;
        }
      } else {
        note = 't.draw by minutes or a budget needs a machine profile — the whole plan is shown here; the studio applies it';
      }
    }
    if (!shown) drawFragments(ctx, result.frags, result.pens);
    const label = document.createElement('div');
    label.className = 'live-label';
    const paperName = typeof sheet.paper === 'string' ? sheet.paper : `${sheet.paper.w}×${sheet.paper.h} mm`;
    label.textContent = `drawable ${w.toFixed(0)} × ${h.toFixed(0)} mm on ${paperName}${sheet.landscape ? ' landscape' : ''}` + (note ? ` · ${note}` : '');
    const open = document.createElement('button');
    open.textContent = 'open in studio';
    open.className = 'live-open';
    open.title = 'Open this source (as edited here) in the studio on the same sheet, with the docs pens available for the session';
    open.onclick = () => {
      localStorage.setItem('occlude.sketch', currentSource(slot));
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
    const dl = document.createElement('button');
    dl.textContent = 'download .ts';
    dl.className = 'live-open';
    dl.onclick = () => {
      const url = URL.createObjectURL(new Blob([currentSource(slot)], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'example.ts';
      a.click();
      URL.revokeObjectURL(url);
    };
    const actions = document.createElement('div');
    actions.className = 'live-actions';
    actions.append(open, dl);
    el.style.aspectRatio = '';
    el.classList.remove('stale', 'live-error');
    el.replaceChildren(canvas, label, actions);
  } catch (e) {
    el.classList.remove('stale');
    el.textContent = `example failed: ${e instanceof Error ? e.message : String(e)}`;
    el.classList.add('live-error');
  }
}

/** Render what is on screen or about to be; the rest waits for the scroll. */
function watchLiveExamples(): void {
  observer?.disconnect();
  const token = pageToken;
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      observer?.unobserve(en.target);
      const i = Number((en.target as HTMLElement).dataset.live);
      const slot = slotOf(i);
      const version = ++slot.version;
      enqueue(() => renderInto(slot, liveExampleToJs(slot.live.src), version, token));
      mountEditor(i, token);
    }
  }, { rootMargin: '600px 0px' });
  for (const el of content.querySelectorAll<HTMLElement>('[data-live]')) observer.observe(el);
}

const tree = document.getElementById('docs-tree')!;
const content = document.getElementById('docs-content')!;

/** Old links: `#/reference#anchor` and `#/readme` resolve to the topic page holding the anchor. */
function resolveSlug(): { slug: string; anchor?: string } {
  const [rawSlug, anchor] = location.hash.replace(/^#\/?/, '').split('#');
  if (DOC_PAGES.some((p) => p.slug === rawSlug)) return { slug: rawSlug, anchor };
  if (rawSlug === 'reference' && anchor) {
    for (const p of DOC_PAGES) {
      if (headings(mdOf(p.file)).some((h) => h.id === anchor)) return { slug: p.slug, anchor };
    }
  }
  return { slug: DOC_PAGES[0].slug, anchor: rawSlug === 'reference' ? anchor : undefined };
}

function slugifyHeading(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** h2/h3 outline of a page from its markdown (fenced code skipped). */
function headings(md: string): { level: 2 | 3; text: string; id: string }[] {
  const out: { level: 2 | 3; text: string; id: string }[] = [];
  for (const m of md.replace(/```[\s\S]*?```/g, '').matchAll(/^(#{2,3}) (.+)$/gm)) {
    const text = m[2].replace(/`/g, '');
    out.push({ level: m[1].length as 2 | 3, text, id: slugifyHeading(text) });
  }
  return out;
}

// ---- sidebar: every page as a drop-down of its sections; the current one open and scroll-spied ----

function buildTree(): void {
  tree.replaceChildren();
  for (const group of ['topics', 'workshop', 'developer'] as const) {
    const label = document.createElement('div');
    label.className = 'tree-group';
    label.textContent = group === 'topics' ? 'topics' : group === 'workshop' ? 'workshop' : 'developer notes';
    tree.append(label);
    for (const page of DOC_PAGES.filter((p) => p.group === group)) {
      const det = document.createElement('details');
      det.className = 'tree-page';
      det.dataset.slug = page.slug;
      const sum = document.createElement('summary');
      const a = document.createElement('a');
      a.textContent = page.title;
      a.href = `#/${page.slug}`;
      const caret = document.createElement('span');
      caret.className = 'tree-caret';
      caret.textContent = '▶';
      caret.title = 'Show sections';
      sum.append(a, caret);
      // The title opens the page; the caret only peeks at its sections.
      sum.onclick = (e) => {
        if (e.target === caret) return;
        e.preventDefault();
        if (page.slug === shownSlug) det.open = !det.open;
        else location.hash = `#/${page.slug}`;
      };
      const outline = document.createElement('div');
      outline.className = 'tree-outline';
      for (const h of headings(mdOf(page.file))) {
        const link = document.createElement('a');
        link.textContent = h.text;
        link.className = h.level === 2 ? 'toc-h2' : 'toc-h3';
        link.dataset.target = h.id;
        link.href = `#/${page.slug}#${h.id}`;
        outline.append(link);
      }
      det.append(sum, outline);
      tree.append(det);
    }
  }
}

function markCurrent(slug: string): void {
  for (const det of tree.querySelectorAll<HTMLDetailsElement>('details.tree-page')) {
    const on = det.dataset.slug === slug;
    det.classList.toggle('current', on);
    det.open = on;
  }
  for (const h of content.querySelectorAll<HTMLElement>('h2, h3')) {
    if (!h.id) h.id = slugifyHeading(h.textContent ?? '');
  }
  updateTocActive();
}

function updateTocActive(): void {
  let active: string | null = null;
  for (const h of content.querySelectorAll<HTMLElement>('h2, h3')) {
    if (h.getBoundingClientRect().top <= 40) active = h.id;
    else break;
  }
  const outline = tree.querySelector<HTMLElement>('details.current .tree-outline');
  if (!outline) return;
  let current: HTMLAnchorElement | null = null;
  for (const a of outline.querySelectorAll<HTMLAnchorElement>('a')) {
    a.classList.toggle('active', a.dataset.target === active);
    if (a.dataset.target === active) current = a;
  }
  if (current) {
    const t = tree.getBoundingClientRect();
    const c = current.getBoundingClientRect();
    if (c.top < t.top || c.bottom > t.bottom) current.scrollIntoView({ block: 'center' });
  }
}

content.addEventListener('scroll', updateTocActive, { passive: true });

// ---- API index: type a name, land on its section ----

function buildIndex(): void {
  const box = document.getElementById('docs-search') as HTMLInputElement | null;
  const list = document.getElementById('docs-search-results');
  if (!box || !list) return;
  const entries: { page: string; title: string; id: string; text: string }[] = [];
  for (const p of DOC_PAGES) {
    for (const h of headings(mdOf(p.file))) entries.push({ page: p.slug, title: p.title, id: h.id, text: h.text });
  }
  box.oninput = () => {
    const q = box.value.trim().toLowerCase();
    list.replaceChildren();
    list.hidden = q.length < 2;
    if (q.length < 2) return;
    for (const e of entries.filter((e) => e.text.toLowerCase().includes(q)).slice(0, 12)) {
      const a = document.createElement('a');
      a.href = `#/${e.page}#${e.id}`;
      a.textContent = `${e.text} — ${e.title}`;
      a.onclick = () => { list.hidden = true; box.value = ''; };
      list.append(a);
    }
  };
}

let shownSlug = '';

async function show(): Promise<void> {
  const { slug, anchor } = resolveSlug();
  if (slug === shownSlug) {
    document.getElementById(anchor ?? '')?.scrollIntoView();
    return;
  }
  shownSlug = slug;
  pageToken++;
  for (const ed of editors.splice(0)) ed.dispose();
  slots.clear();
  liveSources.length = 0;
  const page = DOC_PAGES.find((p) => p.slug === slug) ?? DOC_PAGES[0];
  content.innerHTML = await marked.parse(mdOf(page.file));
  document.title = `occlude docs — ${page.title}`;
  // Links: `other-page.md#anchor` → the page's route; `#anchor` → this page's route;
  // a link to a file the site does not serve is named, not silently flattened.
  for (const a of content.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    const md = href.match(/^(?:\.\/|\.\.\/)?(?:docs\/)?([a-z0-9/-]+\.md)(#.*)?$/);
    if (md) {
      const target = DOC_PAGES.find((p) => p.file === md[1] || p.file.endsWith(`/${md[1]}`));
      if (target) a.href = `#/${target.slug}${md[2] ?? ''}`;
      else a.title = `${md[1]} is in the repository, not on this site`;
    } else if (href.startsWith('#') && !href.startsWith('#/')) {
      a.href = `#/${page.slug}${href}`;
    }
  }
  markCurrent(page.slug);
  const target = document.getElementById(anchor ?? '');
  if (target) target.scrollIntoView();
  else content.scrollTo(0, 0);
  watchLiveExamples();
}

buildTree();
buildIndex();

window.addEventListener('hashchange', () => void show());
void show();
