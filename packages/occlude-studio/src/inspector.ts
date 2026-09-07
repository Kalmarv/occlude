/**
 * The material inspector's DOM and overlay: the Material section of the
 * debug menu, the details pane, and the geometry painted over the ink.
 * State and rules live in inspectorModel.ts; the worker holds the
 * registry; this module only asks for one material at a time and paints
 * what it was given. Nothing here reruns the sketch except the enable
 * switch, which the host wires like the occlusion ghost.
 */

import { userUnitsToPaper, type RenderResult } from 'occlude';
import { InspectorModel, NEUTRAL, colorFor, incidentEdges, otherEnd, prepare, type ColumnRange, type Selection } from './inspectorModel.js';
import type { Preview } from './preview.js';
import type { RenderClient, RenderReply } from './workerClient.js';

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
};

const fmt = (v: number): string => (Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v));

export class Inspector {
  readonly model = new InspectorModel();
  private frame: RenderResult['frame'] | null = null;
  /** The request in flight, so a late answer for another one is dropped. */
  private loading: { executionId: number; name: string } | null = null;
  private status = '';
  /** A row under the pointer in the details pane, ringed in the sketch. */
  private hover: Selection | null = null;
  /** When the current selection was made: drives the flash. */
  private flashAt = 0;
  private flashRaf = 0;
  /** Measured, for the report: the last payload's size and prep time. */
  lastLoad: { name: string; bytes: number; prepMs: number; roundTripMs: number } | null = null;

  private readonly enable = $('dbg-inspect') as HTMLInputElement;
  private readonly body = $('dbg-material-body');
  private readonly hint = $('dbg-material-hint');
  private readonly nameSel = $('dbg-material-name') as HTMLSelectElement;
  private readonly counts = $('dbg-material-counts');
  private readonly pointsBox = $('dbg-material-points') as HTMLInputElement;
  private readonly edgesBox = $('dbg-material-edges') as HTMLInputElement;
  private readonly domainSel = $('dbg-material-domain') as HTMLSelectElement;
  private readonly attrSel = $('dbg-material-attr') as HTMLSelectElement;
  private readonly legend = $('dbg-material-legend');
  private readonly menu = $('debug-menu') as HTMLDetailsElement;
  private readonly pane = $('inspector-pane');
  private readonly head = $('inspector-head');
  private readonly selected = $('inspector-selected');
  private readonly table = $('inspector-table') as HTMLTableElement;
  private readonly pager = $('inspector-pager');

  constructor(
    private readonly preview: Preview,
    private readonly client: RenderClient,
    /** Called when the enable switch flips: the host reruns the sketch with
     * inspection on or off (the registry lives in the worker's run). */
    private readonly onEnable: (on: boolean) => void,
  ) {
    this.enable.onchange = () => {
      this.model.enabled = this.enable.checked;
      if (!this.model.enabled) {
        this.model.reset();
        this.loading = null;
      }
      this.sync();
      this.onEnable(this.model.enabled);
    };
    this.nameSel.onchange = () => {
      this.model.choose(this.nameSel.value || null);
      this.fetch();
      this.sync();
    };
    this.pointsBox.onchange = () => { this.model.showPoints = this.pointsBox.checked; this.repaint(); };
    this.edgesBox.onchange = () => { this.model.showEdges = this.edgesBox.checked; this.repaint(); };
    this.domainSel.onchange = () => {
      this.model.setDomain(this.domainSel.value as 'points' | 'edges');
      this.sync();
    };
    this.attrSel.onchange = () => {
      this.model.attr = this.attrSel.value || null;
      this.sync();
    };
    // The pane lives with the debug menu: closed menu, no pane, no picking.
    this.menu.addEventListener('toggle', () => this.sync());
    this.bindDrag();
    this.preview.onClick = (x, y, pxPerMm) => {
      if (!this.model.enabled || !this.model.material || !this.menu.open) return;
      // Eight screen pixels, whatever the zoom.
      this.choose(this.model.pick(x, y, 8 / pxPerMm));
    };
  }

  get enabled(): boolean {
    return this.model.enabled;
  }

  /** Drag the pane by its header; the corner handle resizes it (CSS). Once
   * moved it is anchored top-left so a resize grows from where it sits. */
  private bindDrag(): void {
    const pane = this.pane;
    const head = pane; // any press on the pane that is not on a control or the table drags it
    head.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button, a, input, .inspector-table-wrap, .inspector-pager')) return;
      // The resize handle lives in the bottom-right corner: leave it to the browser.
      const rr = pane.getBoundingClientRect();
      if (e.clientX > rr.right - 18 && e.clientY > rr.bottom - 18) return;
      const bench = pane.parentElement!;
      const b = bench.getBoundingClientRect();
      const r = pane.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      pane.style.left = `${r.left - b.left}px`;
      pane.style.top = `${r.top - b.top}px`;
      pane.style.bottom = 'auto';
      head.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const x = Math.max(0, Math.min(b.width - 60, ev.clientX - b.left - dx));
        const y = Math.max(0, Math.min(b.height - 30, ev.clientY - b.top - dy));
        pane.style.left = `${x}px`;
        pane.style.top = `${y}px`;
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      e.preventDefault();
    });
  }

  /** A render landed: adopt its registry and fetch the chosen material for
   * this execution. Only meaningful for replies of the newest run. */
  onRender(reply: RenderReply): void {
    this.frame = reply.result.frame;
    const name = this.model.onRender(reply.executionId, reply.inspections);
    if (name !== null) this.fetch();
    else this.loading = null;
    this.sync();
  }

  /** The drawing is a saved plan or the worker was replaced: nothing to inspect. */
  clear(reason: string): void {
    this.model.reset();
    this.loading = null;
    this.status = reason;
    this.sync();
  }

  private fetch(): void {
    const { executionId, chosen } = this.model;
    if (!this.model.enabled || chosen === null || executionId < 0 || !this.frame) return;
    const want = { executionId, name: chosen };
    this.loading = want;
    this.status = `loading ${chosen}…`;
    const toPaper = userUnitsToPaper(this.frame);
    const t0 = performance.now();
    this.client.inspectMaterial(executionId, chosen).then(
      (raw) => {
        if (this.loading?.executionId !== want.executionId || this.loading.name !== want.name) return;
        this.loading = null;
        const t1 = performance.now();
        const m = prepare(raw, executionId, toPaper);
        const prepMs = performance.now() - t1;
        let bytes = raw.x.byteLength + raw.y.byteLength + raw.edges.byteLength;
        for (const a of Object.values(raw.attrs)) bytes += a.byteLength;
        for (const a of Object.values(raw.edgeAttrs)) bytes += a.byteLength;
        this.lastLoad = { name: chosen, bytes, prepMs, roundTripMs: t1 - t0 };
        this.status = this.model.acceptMaterial(m) ? '' : 'superseded';
        this.sync();
      },
      (err: unknown) => {
        if (this.loading?.executionId !== want.executionId || this.loading.name !== want.name) return;
        this.loading = null;
        this.status = err instanceof Error ? err.message : String(err);
        this.sync();
      },
    );
  }

  private repaint(): void {
    this.preview.overlay = this.model.enabled && this.model.material ? (ctx, pxPerMm) => this.paint(ctx, pxPerMm) : null;
    this.preview.draw();
  }

  /** Reflect the model in every control and the pane, then repaint. */
  sync(): void {
    const m = this.model;
    this.enable.checked = m.enabled;
    this.body.hidden = !m.enabled;
    // The pane appears only while something is selected; the overlay alone
    // is the resting state.
    this.pane.hidden = !(m.enabled && m.material && m.selection && this.menu.open);
    if (!m.enabled) {
      this.hint.hidden = true;
      this.repaint();
      return;
    }
    // Names.
    const names = m.names.map((e) => e.name);
    if (names.join('\n') !== [...this.nameSel.options].map((o) => o.value).join('\n')) {
      this.nameSel.replaceChildren(...names.map((n) => new Option(n, n)));
    }
    this.nameSel.value = m.chosen ?? '';
    this.nameSel.disabled = names.length === 0;
    const noRegistry = names.length === 0;
    this.hint.hidden = !noRegistry;
    if (noRegistry) this.hint.textContent = this.status || 'no material in this run — every variable holding a material is listed by name; t.inspect(label, material) names one explicitly';
    const entry = m.names.find((e) => e.name === m.chosen);
    this.counts.textContent = entry ? `${entry.points} points · ${entry.edges} edges` : '';
    this.pointsBox.checked = m.showPoints;
    this.edgesBox.checked = m.showEdges;
    this.domainSel.value = m.domain;
    // Columns.
    const cols = m.columns();
    const wanted = ['', ...cols];
    if (wanted.join('\n') !== [...this.attrSel.options].map((o) => o.value).join('\n')) {
      this.attrSel.replaceChildren(new Option('none', ''), ...cols.map((c) => new Option(c, c)));
    }
    this.attrSel.value = m.attr ?? '';
    this.attrSel.disabled = cols.length === 0;
    this.renderLegend(m.range());
    this.renderPane();
    this.repaint();
  }

  private renderLegend(r: ColumnRange | null): void {
    const m = this.model;
    if (!r || m.attr === null) {
      this.legend.replaceChildren();
      return;
    }
    const bar = document.createElement('div');
    bar.className = 'bar' + (r.kind === 'constant' ? ' constant' : '');
    const ends = document.createElement('div');
    ends.className = 'ends';
    const note = r.missing > 0 ? ` · ${r.missing} unavailable (grey)` : '';
    if (r.kind === 'range') ends.innerHTML = `<span>${fmt(r.min)}</span><span>${m.attr}${note}</span><span>${fmt(r.max)}</span>`;
    else if (r.kind === 'constant') ends.innerHTML = `<span></span><span>${m.attr} = ${fmt(r.value)} (constant)${note}</span><span></span>`;
    else ends.innerHTML = `<span></span><span>${m.attr}: no finite values${note}</span><span></span>`;
    this.legend.replaceChildren(r.kind === 'empty' ? ends : bar, ...(r.kind === 'empty' ? [] : [ends]));
  }

  private renderPane(): void {
    const m = this.model;
    const mat = m.material;
    if (!mat) {
      this.head.textContent = this.status || (m.chosen ? `${m.chosen}: not loaded` : 'no material chosen');
      this.selected.replaceChildren();
      this.table.replaceChildren();
      this.pager.replaceChildren();
      return;
    }
    this.head.innerHTML = `<b>${mat.name}</b> · ${mat.n} points · ${mat.edges.length / 2} edges · iteration ${mat.iteration}` +
      `<button class="inspector-close" title="Clear the selection and hide this pane">×</button>` +
      `<div class="sub">rows are indices in this state, in material coordinates before drawing transforms${this.status ? ' · ' + this.status : ''}</div>`;
    (this.head.querySelector('.inspector-close') as HTMLButtonElement).onclick = () => this.choose(null);
    this.renderSelected();
    this.renderTable();
  }

  /** Select, flash, and refresh. */
  private choose(sel: Selection | null): void {
    this.model.select(sel);
    this.hover = null;
    this.flashAt = sel ? performance.now() : 0;
    this.sync();
    if (sel) this.animateFlash();
  }

  private static readonly FLASH_MS = 650;

  private animateFlash(): void {
    if (this.flashRaf) cancelAnimationFrame(this.flashRaf);
    const tick = () => {
      this.flashRaf = 0;
      if (performance.now() - this.flashAt >= Inspector.FLASH_MS) return;
      this.preview.draw();
      this.flashRaf = requestAnimationFrame(tick);
    };
    this.flashRaf = requestAnimationFrame(tick);
  }

  private link(sel: Selection, text: string): HTMLAnchorElement {
    const a = document.createElement('a');
    a.textContent = text;
    a.onclick = () => this.choose(sel);
    a.onmouseenter = () => { this.hover = sel; this.preview.draw(); };
    a.onmouseleave = () => { this.hover = null; this.preview.draw(); };
    return a;
  }

  private renderSelected(): void {
    const m = this.model;
    const mat = m.material!;
    const sel = m.selection;
    const box = this.selected;
    box.replaceChildren();
    if (!sel) {
      box.textContent = 'click a point or edge in the preview, or a row below';
      return;
    }
    const line = (html: string): HTMLDivElement => {
      const d = document.createElement('div');
      d.innerHTML = html;
      box.append(d);
      return d;
    };
    if (sel.kind === 'point') {
      const i = sel.index;
      line(`<b>point ${i}</b> at (${fmt(mat.x[i])}, ${fmt(mat.y[i])})`);
      const attrs = Object.keys(mat.attrs).map((k) => `${k} = ${fmt(mat.attrs[k][i])}`).join(' · ');
      line(attrs || 'no declared point columns');
      const edges = incidentEdges(mat, i);
      const d = line(`edges (${edges.length}): `);
      for (const e of edges) d.append(this.link({ kind: 'edge', index: e }, `#${e}`));
      const c = line('connected points: ');
      if (edges.length === 0) c.append('none');
      for (const e of edges) c.append(this.link({ kind: 'point', index: otherEnd(mat, e, i) }, `#${otherEnd(mat, e, i)}`));
    } else {
      const e = sel.index;
      const a = mat.edges[2 * e];
      const b = mat.edges[2 * e + 1];
      const len = Math.hypot(mat.x[b] - mat.x[a], mat.y[b] - mat.y[a]);
      line(`<b>edge ${e}</b> · length ${fmt(len)}`);
      const attrs = Object.keys(mat.edgeAttrs).map((k) => `${k} = ${fmt(mat.edgeAttrs[k][e])}`).join(' · ');
      line(attrs || 'no declared edge columns');
      const d = line('endpoints: ');
      d.append(this.link({ kind: 'point', index: a }, `#${a} (${fmt(mat.x[a])}, ${fmt(mat.y[a])})`));
      d.append(this.link({ kind: 'point', index: b }, `#${b} (${fmt(mat.x[b])}, ${fmt(mat.y[b])})`));
    }
  }

  /** One page of rows for the current domain; the DOM never exceeds a page. */
  private renderTable(): void {
    const m = this.model;
    const mat = m.material!;
    const points = m.domain === 'points';
    const cols = points ? Object.keys(mat.attrs) : Object.keys(mat.edgeAttrs);
    const range = m.range();
    const values = m.values();
    const total = m.rowCount();
    const start = m.page * m.pageSize;
    const end = Math.min(total, start + m.pageSize);
    const head = document.createElement('tr');
    for (const h of m.sortKeys()) {
      const th = document.createElement('th');
      const active = m.sort?.key === h;
      th.textContent = h + (active ? (m.sort!.dir === 1 ? ' ▲' : ' ▼') : '');
      th.title = 'Sort by this column (again: descending, again: stored order)';
      th.onclick = () => { m.toggleSort(h); this.sync(); };
      head.append(th);
    }
    const rows: HTMLTableRowElement[] = [head];
    const order = m.order();
    for (let pos = start; pos < end; pos++) {
      const r = order ? order[pos] : pos;
      const tr = document.createElement('tr');
      const sel = m.selection;
      if (sel && sel.index === r && (sel.kind === 'point') === points) tr.className = 'selected';
      const cells: string[] = [];
      if (points) cells.push(fmt(mat.x[r]), fmt(mat.y[r]));
      else {
        const a = mat.edges[2 * r];
        const b = mat.edges[2 * r + 1];
        cells.push(String(a), String(b), fmt(Math.hypot(mat.x[b] - mat.x[a], mat.y[b] - mat.y[a])));
      }
      for (const c of cols) cells.push(fmt((points ? mat.attrs : mat.edgeAttrs)[c][r]));
      const first = document.createElement('td');
      if (values && range) {
        const sw = document.createElement('span');
        sw.className = 'swatch';
        sw.style.background = colorFor(values[r], range) ?? NEUTRAL;
        first.append(sw);
      }
      first.append(String(r));
      tr.append(first);
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.append(td);
      }
      tr.onclick = () => this.choose({ kind: points ? 'point' : 'edge', index: r });
      tr.onmouseenter = () => { this.hover = { kind: points ? 'point' : 'edge', index: r }; this.preview.draw(); };
      tr.onmouseleave = () => { this.hover = null; this.preview.draw(); };
      rows.push(tr);
    }
    this.table.replaceChildren(...rows);
    this.table.querySelector('tr.selected')?.scrollIntoView({ block: 'nearest' });
    // Pager.
    const pages = m.pageCount();
    const prev = document.createElement('button');
    prev.textContent = '‹';
    prev.disabled = m.page === 0;
    prev.onclick = () => { m.page--; this.sync(); };
    const next = document.createElement('button');
    next.textContent = '›';
    next.disabled = m.page >= pages - 1;
    next.onclick = () => { m.page++; this.sync(); };
    const label = document.createElement('span');
    label.textContent = total === 0 ? `no ${m.domain}` : `rows ${start}–${end - 1} of ${total} · page ${m.page + 1}/${pages}`;
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const go = document.createElement('input');
    go.type = 'number';
    go.placeholder = 'row';
    go.title = 'Go to a row (select it)';
    go.onchange = () => {
      const r = Number(go.value);
      if (Number.isInteger(r) && r >= 0 && r < total) this.choose({ kind: points ? 'point' : 'edge', index: r });
    };
    this.pager.replaceChildren(prev, next, label, spacer, go);
  }

  /** The overlay: edges then points, the colour domain coloured, the other
   * neutral, the selection ringed. Marker sizes are screen-constant. */
  private paint(ctx: CanvasRenderingContext2D, pxPerMm: number): void {
    const m = this.model;
    const mat = m.material;
    if (!mat) return;
    const range = m.range();
    const values = m.values();
    const colourEdges = m.domain === 'edges' && values && range;
    const colourPoints = m.domain === 'points' && values && range;
    const e = mat.edges.length / 2;
    const sel = m.selection;
    if (m.showEdges) {
      ctx.lineWidth = Math.max(0.1, 1.4 / pxPerMm);
      ctx.lineCap = 'round';
      if (colourEdges) {
        for (let k = 0; k < e; k++) {
          const c = colorFor(values![k], range!);
          ctx.strokeStyle = c ?? NEUTRAL;
          if (c === null) ctx.setLineDash([2 / pxPerMm, 2 / pxPerMm]);
          ctx.beginPath();
          ctx.moveTo(mat.px[mat.edges[2 * k]], mat.py[mat.edges[2 * k]]);
          ctx.lineTo(mat.px[mat.edges[2 * k + 1]], mat.py[mat.edges[2 * k + 1]]);
          ctx.stroke();
          if (c === null) ctx.setLineDash([]);
        }
      } else {
        ctx.strokeStyle = 'rgba(91, 139, 217, 0.8)';
        ctx.beginPath();
        for (let k = 0; k < e; k++) {
          ctx.moveTo(mat.px[mat.edges[2 * k]], mat.py[mat.edges[2 * k]]);
          ctx.lineTo(mat.px[mat.edges[2 * k + 1]], mat.py[mat.edges[2 * k + 1]]);
        }
        ctx.stroke();
      }
    }
    if (m.showPoints) {
      const r = 2.6 / pxPerMm;
      if (colourPoints) {
        for (let i = 0; i < mat.n; i++) {
          const c = colorFor(values![i], range!);
          ctx.fillStyle = c ?? NEUTRAL;
          ctx.beginPath();
          ctx.arc(mat.px[i], mat.py[i], r, 0, Math.PI * 2);
          ctx.fill();
          if (c === null) {
            ctx.strokeStyle = '#3a3c40';
            ctx.lineWidth = 0.8 / pxPerMm;
            ctx.stroke();
          }
        }
      } else {
        ctx.fillStyle = 'rgba(91, 139, 217, 0.95)';
        ctx.beginPath();
        for (let i = 0; i < mat.n; i++) {
          ctx.moveTo(mat.px[i] + r, mat.py[i]);
          ctx.arc(mat.px[i], mat.py[i], r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
    const mark = (which: Selection, radius: number, width: number, colour: string, halo: boolean): void => {
      ctx.setLineDash([]);
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (which.kind === 'point') {
        ctx.arc(mat.px[which.index], mat.py[which.index], radius / pxPerMm, 0, Math.PI * 2);
      } else {
        ctx.moveTo(mat.px[mat.edges[2 * which.index]], mat.py[mat.edges[2 * which.index]]);
        ctx.lineTo(mat.px[mat.edges[2 * which.index + 1]], mat.py[mat.edges[2 * which.index + 1]]);
      }
      if (halo) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.lineWidth = (width + 3) / pxPerMm;
        ctx.stroke();
      }
      ctx.strokeStyle = colour;
      ctx.lineWidth = width / pxPerMm;
      ctx.stroke();
    };
    if (this.hover && !(sel && this.hover.kind === sel.kind && this.hover.index === sel.index)) {
      mark(this.hover, 8, 2.5, '#3ad0ff', true);
    }
    if (sel) {
      // A quiet persistent ring, and on selection a glow that expands and fades.
      mark(sel, 7, 2, '#ff6a1a', true);
      const t = (performance.now() - this.flashAt) / Inspector.FLASH_MS;
      if (t >= 0 && t < 1) {
        const ease = 1 - t * t;
        ctx.save();
        ctx.globalAlpha = ease * 0.9;
        ctx.shadowColor = '#ff6a1a';
        ctx.shadowBlur = 10 * ease;
        mark(sel, 8 + 18 * t, sel.kind === 'point' ? 3 + 3 * ease : 4 + 10 * ease, '#ff8a3a', false);
        ctx.restore();
      }
    }
  }
}
