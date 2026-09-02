/**
 * The Fills page: the fill library as cards (built-ins read-only with
 * Clone, custom fills with Edit/Clone/Delete), each with a thumbnail
 * rendered through the real engine, and an editor panel — Monaco with the
 * occlude types, a live preview of two sample shapes, Save through the
 * warn-on-edit gate. Like the Assets page, a page of its own, not a rail
 * panel. The main thread emits TypeScript; the render worker runs it.
 */

import './style.css';
import {
  BUILTIN_FILL_NAMES, FILL_NAME_RE, drawFragments, evalPrim, isBuiltinFill,
  type PenDef, type RenderResult,
} from 'occlude';
import { createEditor, type Editor } from './editor.js';
import { RenderClient } from './workerClient.js';
import { deleteFill, fillUses, listFills, loadFill, saveFill } from './fillApi.js';
import { BUILTIN_FILL_SOURCES, cloneSource } from './builtinFills.js';
import { canonicalFillSource, freshFillName } from './fillEmbed.js';
import { NEW_FILL, loadPens, loadSettings } from './store.js';
import { warnOnEdit } from './fillWarn.js';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const grid = $('fills-grid');
const editorSection = $('fill-editor');
const nameInput = $('fill-name') as HTMLInputElement;
const note = $('fill-note');
const previewCanvas = $('fill-preview') as HTMLCanvasElement;
const status = $('fill-status');

/** The preview every fill renders into: two shapes, one rotated, so
 * shape-aligned textures show their anchoring. Plain CJS: this thread
 * emits, it never runs. */
const previewJs = (name: string): string => `
const { sketch, circle, rect, fill } = require('occlude');
module.exports.default = sketch({ aspect: [2, 1], margin: 4, seed: 7 }, (t) => {
  const b = t.bounds();
  return [
    circle(b.w * 0.27, b.cy, b.h * 0.38, { fill: fill(${JSON.stringify(name)}) }),
    rect(b.w * 0.72 - b.h * 0.3, b.cy - b.h * 0.3, b.h * 0.6, b.h * 0.6, {
      fill: fill(${JSON.stringify(name)}), rotate: 25,
    }),
  ];
});
`;

/** Draw a result cropped to its ink, at the canvas's on-screen width. */
function paint(canvas: HTMLCanvasElement, result: RenderResult, cssW: number): void {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of result.frags) {
    for (const s of [0, 0.5, 1]) {
      const [fx, fy] = evalPrim(f.geom, s);
      x0 = Math.min(x0, fx); y0 = Math.min(y0, fy);
      x1 = Math.max(x1, fx); y1 = Math.max(y1, fy);
    }
  }
  if (!Number.isFinite(x0)) {
    x0 = 0; y0 = 0; x1 = result.paper.w; y1 = result.paper.h;
  }
  const pad = 3;
  const w = Math.max(10, x1 - x0 + pad * 2);
  const h = Math.max(10, y1 - y0 + pad * 2);
  const dpr = window.devicePixelRatio || 1;
  const px = Math.min(12, (cssW * dpr) / w);
  canvas.width = Math.round(w * px);
  canvas.height = Math.round(h * px);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${Math.round((cssW * h) / w)}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f6f2ea';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(px, px);
  ctx.translate(pad - x0, pad - y0);
  drawFragments(ctx, result.frags, result.pens);
}

async function boot(): Promise<void> {
  const pens: PenDef[] = await loadPens();
  const settings = loadSettings();
  const client = new RenderClient();
  const cfg = {
    pens,
    paper: settings.paper === 'Custom' ? settings.customPaper : settings.paper,
    landscape: settings.landscape,
    defaultMarginPct: settings.defaultMarginPct,
    coarsen: 1,
  };
  /** Render one fill's preview. Requests coalesce in the client, so
   * callers await one at a time. Null = superseded. */
  const renderFill = async (
    name: string,
    draft?: { name: string; js: string },
  ): Promise<RenderResult | null> => {
    const reply = await client.render({ js: previewJs(name), cfg: { ...cfg, draftFill: draft } });
    return reply?.result ?? null;
  };

  // ---- editor panel ----
  let editor: Editor | null = null;
  let open: { name: string; baseline: string; readOnly: boolean } | null = null;
  let pending: number | null = null;
  const taken = async (): Promise<Set<string>> =>
    new Set([...BUILTIN_FILL_NAMES, ...(await listFills()).map((f) => f.name)]);

  async function preview(): Promise<void> {
    if (!editor || !open) return;
    const emitted = await editor.emit();
    if (!emitted.js) {
      status.className = 'fill-status err';
      status.textContent = emitted.errors[0] ?? 'syntax error';
      return;
    }
    const name = nameInput.value.trim() || 'draft';
    status.className = 'fill-status';
    status.textContent = 'rendering…';
    try {
      const result = await renderFill(name, open.readOnly ? undefined : { name, js: emitted.js });
      if (!result) return; // superseded
      paint(previewCanvas, result, previewCanvas.parentElement!.clientWidth - 2);
      status.textContent = `${result.stats.fragments} frags · ${result.stats.fillPrims} fill prims · ${result.stats.renderMs.toFixed(1)}ms`;
    } catch (e) {
      status.className = 'fill-status err';
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  }
  function schedulePreview(): void {
    if (pending !== null) clearTimeout(pending);
    pending = window.setTimeout(() => {
      pending = null;
      void preview();
    }, 200);
  }

  function dirty(): boolean {
    return !!editor && !!open && !open.readOnly && editor.getValue() !== open.baseline;
  }

  function openEditor(name: string, source: string, readOnly: boolean): void {
    if (dirty() && !confirm(`Discard unsaved changes to fill '${open!.name}'?`)) return;
    editorSection.hidden = false;
    if (!editor) {
      editor = createEditor($('editor'), source);
      editor.onChange(schedulePreview);
    } else {
      editor.setValue(source);
    }
    open = { name, baseline: source, readOnly };
    editor.setReadOnly(readOnly);
    nameInput.value = name;
    nameInput.disabled = readOnly;
    note.textContent = readOnly ? 'built-in · read-only — Clone to make it yours' : '';
    ($('btn-save') as HTMLButtonElement).disabled = readOnly;
    editorSection.scrollIntoView({ block: 'start' });
    schedulePreview();
  }

  function closeEditor(): void {
    if (dirty() && !confirm(`Discard unsaved changes to fill '${open!.name}'?`)) return;
    open = null;
    editorSection.hidden = true;
  }

  async function save(): Promise<void> {
    if (!editor || !open || open.readOnly) return;
    let name = nameInput.value.trim();
    if (!name) {
      alert('Name the fill first.');
      return;
    }
    if (!FILL_NAME_RE.test(name)) {
      alert("Fill names: letters, digits, - and _ (max 64) — they are fill('name') literals.");
      return;
    }
    if (isBuiltinFill(name)) {
      alert(`'${name}' is a built-in fill — built-ins never change; pick another name.`);
      return;
    }
    await editor.format();
    const src = editor.getValue();
    const stored = await loadFill(name);
    // Warn-on-edit (spec rule 8): scan the sketch directory NOW; a draft
    // (unsaved, unchanged, or unreferenced) saves silently.
    if (stored !== null && canonicalFillSource(stored) !== canonicalFillSource(src)) {
      const uses = await fillUses(name);
      if (uses.length > 0) {
        const names = await taken();
        const choice = await warnOnEdit(name, uses, freshFillName(name, names), names);
        if (choice.action === 'cancel') return;
        if (choice.action === 'clone') {
          name = choice.name;
          nameInput.value = name;
        }
      }
    }
    await saveFill(name, src);
    open = { name, baseline: src, readOnly: false };
    note.textContent = `saved '${name}'`;
    await refresh();
  }

  // ---- cards ----
  async function refresh(): Promise<void> {
    let custom;
    try {
      custom = await listFills();
    } catch {
      grid.textContent = 'fill library unavailable';
      return;
    }
    grid.innerHTML = '';
    const thumbs: { name: string; canvas: HTMLCanvasElement }[] = [];
    const card = (
      name: string,
      tag: string,
      source: () => Promise<string | null>,
      builtin: boolean,
    ): void => {
      const el = document.createElement('div');
      el.className = 'asset-card fill-card';
      const thumb = document.createElement('div');
      thumb.className = 'asset-thumb fill-thumb';
      const canvas = document.createElement('canvas');
      thumb.append(canvas);
      thumbs.push({ name, canvas });
      const meta = document.createElement('div');
      meta.className = 'asset-meta';
      const nm = document.createElement('div');
      nm.className = 'asset-name';
      nm.textContent = name;
      const t = document.createElement('div');
      t.className = 'asset-size';
      t.textContent = tag;
      meta.append(nm, t);
      const actions = document.createElement('div');
      actions.className = 'asset-actions';
      const b = (label: string, fn: () => void | Promise<void>): HTMLButtonElement => {
        const x = document.createElement('button');
        x.textContent = label;
        x.onclick = () => void Promise.resolve(fn()).catch((e) => alert(e instanceof Error ? e.message : String(e)));
        return x;
      };
      actions.append(
        b(builtin ? 'view' : 'edit', async () => {
          const s = await source();
          if (s !== null) openEditor(name, s, builtin);
        }),
        b('clone', async () => {
          const s = await source();
          if (s !== null) openEditor(freshFillName(name, await taken()), cloneSource(name, s), false);
        }),
      );
      if (!builtin) {
        actions.append(
          b('delete', async () => {
            const uses = await fillUses(name);
            const warn = uses.length > 0 ? ` Saved sketches use it: ${uses.join(', ')}.` : '';
            if (!confirm(`Delete fill '${name}' from the library?${warn}`)) return;
            await deleteFill(name);
            if (open?.name === name) closeEditor();
            await refresh();
          }),
        );
      }
      el.append(thumb, meta, actions);
      grid.append(el);
    };
    for (const name of BUILTIN_FILL_NAMES) {
      card(name, 'built-in', async () => BUILTIN_FILL_SOURCES[name] ?? null, true);
    }
    for (const f of custom) {
      card(f.name, ago(f.mtime), () => loadFill(f.name), false);
    }
    // Thumbnails one at a time: the client coalesces concurrent renders.
    for (const { name, canvas } of thumbs) {
      try {
        const result = await renderFill(name);
        if (result) paint(canvas, result, canvas.parentElement!.clientWidth - 2);
      } catch {
        canvas.replaceWith(Object.assign(document.createElement('span'), { textContent: 'render failed' }));
      }
    }
  }

  $('btn-new').onclick = () => openEditor('', NEW_FILL, false);
  $('btn-save').onclick = () => void save().catch((e) => alert(e instanceof Error ? e.message : String(e)));
  $('btn-close').onclick = closeEditor;
  nameInput.onchange = schedulePreview;
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        if (open) void save().catch((err) => alert(err instanceof Error ? err.message : String(err)));
      }
    },
    true,
  );
  // Automation handle.
  (window as unknown as Record<string, unknown>).__fills = { refresh, openEditor, save, get editor() { return editor; } };
  await refresh();
}

function ago(mtime: number): string {
  const s = (Date.now() - mtime) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

void boot();
