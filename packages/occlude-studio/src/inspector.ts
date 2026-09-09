/**
 * The Inspect tab: everything the last run captured, as a filterable list
 * with one capture's detail below it — its rows, its heatmap, its native
 * geometry — and the same capture painted over the ink in the preview.
 *
 * Opening the tab turns capture on and reruns the sketch (the registry is
 * made by the run, in the worker); leaving it turns capture off. A click
 * on a geometry icon in the editor lands here too, selecting that value.
 * State and rules for the material rows live in inspectorModel.ts; the
 * worker builds previews on demand; this module renders and asks.
 */

import { userUnitsToPaper, type InspectionEntry, type RenderResult } from 'occlude';
import { InspectorModel, NEUTRAL, colorFor, incidentEdges, otherEnd, prepare, type ColumnRange, type Selection } from './inspectorModel.js';
import { GeometryPreviewPanel, cssVar } from './geometryPreviewPanel.js';
import type { PreviewOptions } from './geometryPreview.js';
import { GEOMETRY_TYPES, type GeometryInspectionRequest, type GeometryKind } from './geometryTypes.js';
import { HINT_MODES, forceHints, getHintMode, setHintMode } from './geometryHints.js';
import { VirtualTable } from './virtualTable.js';
import type { Preview } from './preview.js';
import type { RenderClient, RenderReply } from './workerClient.js';

const fmt = (v: number): string => (Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v));

const el = (tag: string, cls?: string, text?: string): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** The filter chips: kinds grouped the way the sketch author thinks of them. */
type Group = 'materials' | 'shapes' | 'stations' | 'selections' | 'faces' | 'fields';
const GROUPS: { key: Group; label: string; kinds: GeometryKind[] }[] = [
  { key: 'materials', label: 'Materials', kinds: ['material', 'vertex', 'edge', 'contour'] },
  { key: 'shapes', label: 'Shapes', kinds: ['shape', 'path', 'drawing'] },
  { key: 'stations', label: 'Stations', kinds: ['stations', 'station'] },
  { key: 'selections', label: 'Selections', kinds: ['points', 'edges'] },
  { key: 'faces', label: 'Faces', kinds: ['faces', 'face'] },
  { key: 'fields', label: 'Fields', kinds: ['scalar', 'vector'] },
];
const groupOf = (kind: GeometryKind | undefined): Group | null =>
  GROUPS.find((g) => kind !== undefined && g.kinds.includes(kind))?.key ?? null;

/** What a capture is called in the list: its variable, expression or label. */
const labelOf = (e: InspectionEntry): string => e.source?.label ?? e.name;
/** A key that survives edits: the same variable on the same line, same kind. */
const keyOf = (e: InspectionEntry): string => (e.source ? `${e.source.label}@${e.source.line}:${e.kind ?? ''}` : e.name);

export class Inspector {
  readonly model = new InspectorModel();
  private frame: RenderResult['frame'] | null = null;
  /** The tab is open: capture is on and the overlay paints. */
  private active = false;
  private status = '';
  /** Set while the list describes an older run than the editor's source. */
  private stale = '';
  private dropped = 0;
  private serial = 0;
  private loading: { executionId: number; name: string } | null = null;
  /** A code-icon click waiting for a run that has its capture. */
  private request: GeometryInspectionRequest | null = null;
  private lastKey: string | null = null;
  private group: Group | null = null;
  private query = '';
  private hover: Selection | null = null;
  private flashAt = 0;
  private flashRaf = 0;
  private graphSourceRows: { capture?: string; points?: number[]; edges?: number[]; pointEdges?: number[]; occurrences?: number[]; edgeOccurrences?: number[] } | null = null;
  /** The capture the shown one was taken from (selection, faces, stations). */
  private sourceCapture: string | null = null;
  /** A row to select once the capture drilled into has loaded. */
  private pendingSelect: Selection | null = null;
  /** Measured, for the report: the last payload's size and prep time. */
  lastLoad: { name: string; bytes: number; prepMs: number; roundTripMs: number } | null = null;

  private readonly panel = new GeometryPreviewPanel();
  private readonly table = new VirtualTable();
  private readonly search = document.createElement('input');
  private readonly hintSel = document.createElement('select');
  private readonly chips = el('div', 'inspect-chips');
  private readonly note = el('div', 'inspect-note');
  private readonly list = el('div', 'inspect-list');
  private readonly detail = el('div', 'inspect-detail');
  private readonly summary = el('div', 'inspect-summary');
  private readonly tools = el('div', 'inspect-tools');
  private readonly pointsBox = document.createElement('input');
  private readonly edgesBox = document.createElement('input');
  private readonly domainSel = document.createElement('select');
  private readonly attrSel = document.createElement('select');
  private readonly legend = el('div', 'inspect-legend');
  private readonly selected = el('div', 'inspect-selected');

  constructor(
    private readonly preview: Preview,
    private readonly client: RenderClient,
    /** Capture switched on: the host reruns the sketch with instrumentation. */
    private readonly onEnable: () => void,
    host: HTMLElement,
  ) {
    this.build(host);
    this.panel.onChange = () => this.repaint();
    this.panel.onDrill = (capture, sel) => this.drillTo(capture, sel);
    this.preview.onClick = (x, y, pxPerMm) => {
      if (!this.active) return;
      // Eight screen pixels, whatever the zoom.
      if (this.model.material) this.choose(this.model.pick(x, y, 8 / pxPerMm));
      else this.panel.pick(x, y, 8 / pxPerMm);
    };
  }

  private build(host: HTMLElement): void {
    const bar = el('div', 'inspect-bar');
    this.search.type = 'search';
    this.search.placeholder = 'Filter by name';
    this.search.setAttribute('aria-label', 'Filter captures by name');
    this.search.oninput = () => { this.query = this.search.value.trim().toLowerCase(); this.renderList(); };
    this.hintSel.title = 'Type hints in the editor: geometry icons and tints. Icons show while this tab is open.';
    this.hintSel.setAttribute('aria-label', 'Editor type hints');
    for (const m of HINT_MODES) this.hintSel.add(new Option(m.label, m.key));
    this.hintSel.value = getHintMode();
    this.hintSel.onchange = () => setHintMode(this.hintSel.value as ReturnType<typeof getHintMode>);
    const hintLabel = el('label', 'inspect-hints', 'Hints');
    hintLabel.append(this.hintSel);
    bar.append(this.search, hintLabel);

    const all = el('button', 'chip active', 'All') as HTMLButtonElement;
    all.onclick = () => { this.group = null; this.renderList(); };
    this.chips.append(all);
    for (const g of GROUPS) {
      const b = el('button', 'chip', g.label) as HTMLButtonElement;
      b.dataset.group = g.key;
      b.onclick = () => { this.group = this.group === g.key ? null : g.key; this.renderList(); };
      this.chips.append(b);
    }

    const check = (box: HTMLInputElement, text: string, on: () => void): HTMLLabelElement => {
      box.type = 'checkbox';
      box.checked = true;
      box.onchange = on;
      const l = document.createElement('label');
      l.append(box, ` ${text}`);
      return l;
    };
    this.domainSel.add(new Option('point columns', 'points'));
    this.domainSel.add(new Option('edge columns', 'edges'));
    this.domainSel.title = 'Which rows the colour reads';
    this.domainSel.onchange = () => { this.model.setDomain(this.domainSel.value as 'points' | 'edges'); this.sync(); };
    this.attrSel.title = 'The column to colour by';
    this.attrSel.onchange = () => { this.model.attr = this.attrSel.value || null; this.sync(); };
    const row = el('div', 'inspect-tools-row');
    row.append(
      check(this.pointsBox, 'points', () => { this.model.showPoints = this.pointsBox.checked; this.repaint(); }),
      check(this.edgesBox, 'edges', () => { this.model.showEdges = this.edgesBox.checked; this.repaint(); }),
    );
    const colour = el('div', 'inspect-tools-row');
    colour.append(this.domainSel, this.attrSel);
    this.tools.append(row, colour, this.legend);

    this.detail.append(this.summary, this.tools, this.panel.host, this.selected, this.table.root);
    host.append(bar, this.chips, this.note, this.list, this.detail);
  }

  /** The host reads this for the run config: instrument only while open. */
  get enabled(): boolean {
    return this.active;
  }

  /** The tab opened or closed. Opening reruns with capture on; closing
   * drops the registry and the overlay without a run. */
  setActive(on: boolean, rerun = true): void {
    if (this.active === on) return;
    this.active = on;
    this.model.enabled = on;
    forceHints(on);
    if (on) {
      this.status = 'capturing…';
      if (rerun) this.onEnable();
    } else {
      this.request = null;
      this.serial++;
      this.loading = null;
      this.panel.clear();
      this.model.reset();
      this.client.releaseInspections();
    }
    this.sync();
  }

  /** A geometry icon was clicked in the editor. The host has switched the
   * rail to this tab first; the capture is selected as soon as a run has it. */
  openGeometry(request: GeometryInspectionRequest): void {
    this.request = request;
    if (request.annotation.sourceStart === undefined) {
      this.status = `'${request.label}' has no capture site here — inspect its declaration or a complete expression`;
      this.request = null;
      this.sync();
      return;
    }
    const entry = this.entryFor(request);
    if (entry) {
      this.request = null;
      this.choose(null);
      this.chooseEntry(entry.name);
    } else {
      this.status = `waiting for a run that captures '${request.label}'…`;
      this.sync();
    }
  }

  private entryFor(r: GeometryInspectionRequest): InspectionEntry | undefined {
    const exact = this.model.names.find((e) => e.source
      && e.source.document === r.document && e.source.revision === r.revision
      && e.source.start === r.annotation.sourceStart && e.source.end === r.annotation.sourceEnd);
    // The source moved on since the run: the same name and kind will do.
    return exact ?? this.model.names.find((e) => e.source?.label === r.label && e.kind === r.annotation.kind);
  }

  /** The editor changed or a run started: the material and previews belong
   * to an older run. The list stays, dimmed, until the next run lands. */
  invalidate(reason = 'source changed — rerunning'): void {
    if (!this.active) return;
    this.serial++;
    this.loading = null;
    this.stale = reason;
    this.model.material = null;
    this.model.selection = null;
    this.graphSourceRows = null;
    this.panel.clear();
    this.frame = null;
    this.sync();
  }

  /** Nothing to inspect at all: a frozen result, a replaced worker. */
  clear(reason: string): void {
    this.serial++;
    this.loading = null;
    this.model.reset();
    this.panel.clear();
    this.graphSourceRows = null;
    this.frame = null;
    this.status = reason;
    this.stale = '';
    this.sync();
  }

  onRender(reply: RenderReply): void {
    if (!this.active) return;
    this.frame = reply.result.frame;
    this.stale = '';
    this.status = '';
    this.dropped = reply.inspectionsDropped ?? 0;
    const before = this.lastKey;
    this.model.onRender(reply.executionId, reply.inspections);
    if (this.request) {
      const entry = this.entryFor(this.request);
      if (entry) { this.request = null; this.model.choose(entry.name); }
      else this.status = `'${this.request.label}' was not captured by this run`;
    } else if (before && !this.model.names.some((e) => e.name === this.model.chosen && keyOf(e) === before)) {
      // Keep following the same variable across edits.
      const same = this.model.names.find((e) => keyOf(e) === before);
      if (same) this.model.choose(same.name);
    }
    this.lastKey = this.chosenEntry() ? keyOf(this.chosenEntry()!) : null;
    if (this.model.chosen !== null) this.fetch();
    this.sync();
  }

  private chosenEntry(): InspectionEntry | undefined {
    return this.model.names.find((e) => e.name === this.model.chosen);
  }

  /** Open another capture and select one of its rows: a station's edge,
   * a face's wall, a selection's source point. */
  private drillTo(capture: string, sel: Selection): void {
    if (!this.model.names.some((e) => e.name === capture)) return;
    if (this.model.chosen === capture && this.model.material) { this.choose(sel); return; }
    this.pendingSelect = sel;
    this.chooseEntry(capture);
  }

  private chooseEntry(name: string | null): void {
    this.model.choose(name);
    this.lastKey = this.chosenEntry() ? keyOf(this.chosenEntry()!) : null;
    this.graphSourceRows = null;
    this.fetch();
    this.sync();
  }

  private fetch(options?: PreviewOptions): void {
    const { executionId, chosen } = this.model;
    if (!this.active || chosen === null || executionId < 0 || !this.frame) return;
    const entry = this.chosenEntry();
    if (!entry) return;
    const serial = ++this.serial;
    if (!options) {
      this.panel.clear();
      this.model.material = null;
      this.graphSourceRows = null;
    }
    if (entry.limited && !entry.retainedOccurrences) {
      this.status = entry.limited;
      this.sync();
      return;
    }
    const field = entry.kind === 'scalar' || entry.kind === 'vector';
    if (field && !options) {
      // The controls first, then the default grid; edits re-sample.
      this.panel.fieldControls(entry, this.frame, (opts) => { this.fetch(opts); this.sync(); });
      this.fetch({ sample: true, resolution: 32 });
      return;
    }
    const want = { executionId, name: chosen };
    this.loading = want;
    this.status = `loading ${labelOf(entry)}…`;
    const toPaper = userUnitsToPaper(this.frame);
    const t0 = performance.now();
    this.client.inspectGeometry(executionId, chosen, options).then(
      (raw) => {
        if (serial !== this.serial || this.model.executionId !== executionId || this.model.chosen !== chosen) return;
        this.loading = null;
        if (raw.kind === 'graph') {
          const t1 = performance.now();
          const m = prepare(raw.material, executionId, toPaper);
          this.graphSourceRows = { capture: raw.sourceCapture, points: raw.sourcePoints, edges: raw.sourceEdges, pointEdges: raw.sourcePointEdges, occurrences: raw.occurrences, edgeOccurrences: raw.edgeOccurrences };
          this.sourceCapture = raw.sourceCapture ?? null;
          const arrays = [raw.material.x, raw.material.y, raw.material.edges, ...Object.values(raw.material.attrs), ...Object.values(raw.material.edgeAttrs)];
          this.lastLoad = { name: chosen, bytes: arrays.reduce((n, a) => n + a.byteLength, 0), prepMs: performance.now() - t1, roundTripMs: t1 - t0 };
          this.model.acceptMaterial(m);
          // Colour by the first declared column: values are the point.
          const cols = this.model.columns();
          if (this.model.attr === null && cols.length) this.model.attr = cols[0];
          if (this.pendingSelect) {
            const sel = this.pendingSelect;
            this.pendingSelect = null;
            if (sel.kind === 'point' ? sel.index < m.n : sel.index < m.edges.length / 2) {
              if ((sel.kind === 'point') !== (this.model.domain === 'points')) this.model.setDomain(sel.kind === 'point' ? 'points' : 'edges');
              this.model.select(sel);
              this.flashAt = performance.now();
              this.animateFlash();
            }
          }
        } else {
          this.graphSourceRows = null;
          this.sourceCapture = raw.kind === 'faces' ? raw.sourceCapture ?? null : null;
          this.pendingSelect = null;
        }
        this.panel.show(raw);
        this.status = '';
        this.sync();
      },
      (err: unknown) => {
        if (serial !== this.serial || this.model.executionId !== executionId || this.model.chosen !== chosen) return;
        this.loading = null;
        this.status = err instanceof Error ? err.message : String(err);
        this.sync();
      },
    );
  }

  // ---- rendering ----------------------------------------------------------

  private sync(): void {
    this.renderList();
    this.renderDetail();
    this.repaint();
  }

  private visibleEntries(): InspectionEntry[] {
    return this.model.names.filter((e) =>
      (this.group === null || groupOf(e.kind) === this.group)
      && (this.query === '' || labelOf(e).toLowerCase().includes(this.query)));
  }

  private renderList(): void {
    for (const b of this.chips.querySelectorAll<HTMLButtonElement>('button')) {
      b.classList.toggle('active', (b.dataset.group ?? null) === this.group);
    }
    const names = this.model.names;
    const shown = this.visibleEntries();
    this.list.classList.toggle('stale', this.stale !== '');
    const items = shown.map((e) => {
      const info = e.kind ? GEOMETRY_TYPES[e.kind] : null;
      const item = el('button', 'inspect-item') as HTMLButtonElement;
      item.setAttribute('aria-selected', String(e.name === this.model.chosen));
      const ic = el('span', `inspect-item-icon kind-${info?.color ?? 'graph'}`, info?.icon ?? '·');
      const body = el('span', 'inspect-item-body');
      body.append(el('span', 'inspect-item-name', labelOf(e)));
      const where = e.source ? `${info?.label ?? e.kind} · line ${e.source.line}` : `${info?.label ?? e.kind} · t.inspect`;
      body.append(el('span', 'inspect-item-sub', where));
      const count = e.occurrences > 1 ? `×${e.occurrences}` : e.points ? `${e.points}` : '';
      item.append(ic, body, el('span', 'inspect-item-count', count));
      if (e.limited) item.title = e.limited;
      item.onclick = () => this.chooseEntry(e.name);
      return item;
    });
    this.list.replaceChildren(...items);
    let note = '';
    if (!this.active) note = 'Open this tab to capture the sketch’s geometry on its next run.';
    else if (this.stale) note = this.stale;
    else if (this.status && names.length === 0) note = this.status;
    else if (names.length === 0) note = 'Nothing captured: initialise a variable with geometry, or call t.inspect(label, value).';
    else if (shown.length === 0) note = 'No captures match the filter.';
    else if (this.status) note = this.status;
    if (this.dropped) note += `${note ? ' · ' : ''}${this.dropped} more captures beyond the limit`;
    this.note.textContent = note;
    this.note.hidden = note === '';
  }

  private renderDetail(): void {
    const m = this.model;
    const entry = this.chosenEntry();
    this.detail.hidden = !this.active || !entry;
    if (!entry) return;
    const info = entry.kind ? GEOMETRY_TYPES[entry.kind] : null;
    this.summary.replaceChildren();
    const title = el('div', 'inspect-summary-title');
    title.append(el('span', `inspect-item-icon kind-${info?.color ?? 'graph'}`, info?.icon ?? '·'), el('b', undefined, labelOf(entry)));
    if (info) title.append(el('span', 'inspect-summary-kind', info.label));
    this.summary.append(title);
    const facts: string[] = [];
    if (entry.summary) facts.push(entry.summary);
    if (entry.source) facts.push(`line ${entry.source.line}`);
    if (entry.occurrences > 1 && entry.retainedOccurrences < entry.occurrences) facts.push(`${entry.retainedOccurrences} of ${entry.occurrences} retained`);
    this.summary.append(el('div', 'inspect-summary-facts', facts.join(' · ')));
    const mat = m.material;
    if (mat) {
      const cols = [...Object.keys(mat.attrs), ...Object.keys(mat.edgeAttrs).map((k) => `${k} (edge)`)];
      if (cols.length) this.summary.append(el('div', 'inspect-summary-facts', `columns: ${cols.join(', ')}`));
    }
    const from = this.sourceCapture && this.model.names.find((e) => e.name === this.sourceCapture);
    if (from) {
      const line = el('div', 'inspect-summary-facts', 'from ');
      const a = document.createElement('a');
      a.textContent = labelOf(from);
      a.title = 'The material this was taken from';
      a.onclick = () => this.chooseEntry(from.name);
      line.append(a);
      this.summary.append(line);
    }
    if (info) this.summary.append(el('div', 'inspect-summary-desc', info.description));

    const graph = !!m.material;
    this.tools.hidden = !graph;
    if (graph) {
      this.pointsBox.checked = m.showPoints;
      this.edgesBox.checked = m.showEdges;
      this.domainSel.value = m.domain;
      const cols = m.columns();
      const wanted = ['', ...cols];
      if (wanted.join('\n') !== [...this.attrSel.options].map((o) => o.value).join('\n')) {
        this.attrSel.replaceChildren(new Option('no colour', ''), ...cols.map((c) => new Option(c, c)));
      }
      this.attrSel.value = m.attr ?? '';
      this.attrSel.disabled = cols.length === 0;
      this.renderLegend(m.range());
    }
    this.selected.hidden = !graph;
    this.table.root.hidden = !graph;
    if (graph) {
      this.renderSelected();
      this.renderTable();
    }
  }

  private renderLegend(r: ColumnRange | null): void {
    const m = this.model;
    if (!r || m.attr === null) { this.legend.replaceChildren(); return; }
    const bar = el('div', 'bar' + (r.kind === 'constant' ? ' constant' : ''));
    const ends = el('div', 'ends');
    const note = r.missing > 0 ? ` · ${r.missing} unavailable (grey)` : '';
    if (r.kind === 'range') ends.append(el('span', undefined, fmt(r.min)), el('span', undefined, `${m.attr}${note}`), el('span', undefined, fmt(r.max)));
    else if (r.kind === 'constant') ends.append(el('span'), el('span', undefined, `${m.attr} = ${fmt(r.value)} (constant)${note}`), el('span'));
    else ends.append(el('span'), el('span', undefined, `${m.attr}: no finite values${note}`), el('span'));
    this.legend.replaceChildren(...(r.kind === 'empty' ? [ends] : [bar, ends]));
  }

  /** Select, flash, and refresh. */
  private choose(sel: Selection | null): void {
    this.model.select(sel);
    this.hover = null;
    this.flashAt = sel ? performance.now() : 0;
    this.renderDetail();
    this.repaint();
    if (sel) {
      this.animateFlash();
      if ((sel.kind === 'point') === (this.model.domain === 'points')) this.table.scrollToRow(this.model.positionOf(sel.index));
    }
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
    const mat = this.model.material!;
    const sel = this.model.selection;
    const box = this.selected;
    box.replaceChildren();
    if (!sel) {
      box.append(el('span', 'inspect-hint', 'Click a point or edge in the preview, or a row below.'));
      return;
    }
    const line = (...parts: (string | Node)[]): HTMLElement => {
      const d = el('div');
      d.append(...parts);
      box.append(d);
      return d;
    };
    const src = this.graphSourceRows;
    const drill = (kind: 'point' | 'edge', index: number | undefined, what: string): void => {
      if (index === undefined || index < 0 || !src?.capture) return;
      const cap = this.model.names.find((e) => e.name === src.capture);
      if (!cap) return;
      const a = document.createElement('a');
      a.textContent = `${what} ${index} in ${labelOf(cap)}`;
      a.onclick = () => this.drillTo(src.capture!, { kind, index });
      line('source: ', a);
    };
    if (sel.kind === 'point') {
      const i = sel.index;
      line(el('b', undefined, `point ${i}`), ` at (${fmt(mat.x[i])}, ${fmt(mat.y[i])})`);
      drill('point', src?.points?.[i], 'point');
      drill('edge', src?.pointEdges?.[i], 'on edge');
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
      line(el('b', undefined, `edge ${e}`), ` · length ${fmt(len)}`);
      drill('edge', src?.edges?.[e], 'edge');
      const attrs = Object.keys(mat.edgeAttrs).map((k) => `${k} = ${fmt(mat.edgeAttrs[k][e])}`).join(' · ');
      line(attrs || 'no declared edge columns');
      const d = line('endpoints: ');
      d.append(this.link({ kind: 'point', index: a }, `#${a} (${fmt(mat.x[a])}, ${fmt(mat.y[a])})`));
      d.append(this.link({ kind: 'point', index: b }, `#${b} (${fmt(mat.x[b])}, ${fmt(mat.y[b])})`));
    }
  }

  /** Every row of the current domain, windowed: the DOM holds a screenful. */
  private renderTable(): void {
    const m = this.model;
    const mat = m.material!;
    const points = m.domain === 'points';
    const cols = points ? Object.keys(mat.attrs) : Object.keys(mat.edgeAttrs);
    const range = m.range();
    const values = m.values();
    const order = m.order();
    const keys = m.sortKeys();
    const src = this.graphSourceRows;
    const capture = src?.capture && this.model.names.some((e) => e.name === src.capture) ? src.capture : undefined;
    const rowLabel = (r: number): string | Node => {
      const sourceRow = points ? (src?.points?.[r] ?? src?.pointEdges?.[r]) : src?.edges?.[r];
      const sourceKind: 'point' | 'edge' = points && src?.points ? 'point' : 'edge';
      const occurrence = src?.[points ? 'occurrences' : 'edgeOccurrences']?.[r];
      if (sourceRow === undefined || sourceRow < 0) return String(r);
      const span = document.createElement('span');
      span.append(`${r} `);
      const ref = document.createElement(capture ? 'a' : 'span');
      ref.className = 'vtable-src';
      ref.textContent = `${sourceKind === 'edge' && points ? 'on edge' : 'src'} ${sourceRow}${occurrence ? ` · #${occurrence}` : ''}`;
      if (capture) {
        ref.title = 'This row in the source material';
        (ref as HTMLAnchorElement).onclick = (ev) => { ev.stopPropagation(); this.drillTo(capture, { kind: sourceKind, index: sourceRow }); };
      }
      span.append(ref);
      return span;
    };
    this.table.set({
      columns: keys.map((k, i) => ({ key: k, label: k, align: i === 0 ? 'left' : 'right' })),
      rowCount: m.rowCount(),
      headerMark: (k) => (m.sort?.key === k ? (m.sort.dir === 1 ? ' ▲' : ' ▼') : ''),
      rowClass: (pos) => {
        const r = order ? order[pos] : pos;
        const sel = m.selection;
        return sel && sel.index === r && (sel.kind === 'point') === points ? 'selected' : '';
      },
      cell: (pos, col) => {
        const r = order ? order[pos] : pos;
        if (col === 0) {
          const first = document.createElement('span');
          if (values && range) {
            const sw = el('span', 'swatch');
            sw.style.background = colorFor(values[r], range) ?? NEUTRAL;
            first.append(sw);
          }
          first.append(rowLabel(r));
          return first;
        }
        if (points) {
          if (col === 1) return fmt(mat.x[r]);
          if (col === 2) return fmt(mat.y[r]);
          return fmt(mat.attrs[cols[col - 3]][r]);
        }
        const a = mat.edges[2 * r];
        const b = mat.edges[2 * r + 1];
        if (col === 1) return String(a);
        if (col === 2) return String(b);
        if (col === 3) return fmt(Math.hypot(mat.x[b] - mat.x[a], mat.y[b] - mat.y[a]));
        return fmt(mat.edgeAttrs[cols[col - 4]][r]);
      },
      onHeaderClick: (k) => { m.toggleSort(k); this.sync(); },
      onRowClick: (pos) => { const r = order ? order[pos] : pos; this.choose({ kind: points ? 'point' : 'edge', index: r }); },
      onRowHover: (pos) => {
        const r = pos === null ? null : order ? order[pos] : pos;
        this.hover = r === null ? null : { kind: points ? 'point' : 'edge', index: r };
        this.preview.draw();
      },
    });
  }

  private repaint(): void {
    this.preview.overlay = this.active
      ? (ctx, pxPerMm) => { if (this.model.material) this.paint(ctx, pxPerMm); this.panel.paint(ctx, pxPerMm); }
      : null;
    this.preview.draw();
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
    const plain = cssVar('--toolpath');
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
        ctx.strokeStyle = plain;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        for (let k = 0; k < e; k++) {
          ctx.moveTo(mat.px[mat.edges[2 * k]], mat.py[mat.edges[2 * k]]);
          ctx.lineTo(mat.px[mat.edges[2 * k + 1]], mat.py[mat.edges[2 * k + 1]]);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
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
            ctx.strokeStyle = cssVar('--bg');
            ctx.lineWidth = 0.8 / pxPerMm;
            ctx.stroke();
          }
        }
      } else {
        ctx.fillStyle = plain;
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
        ctx.strokeStyle = cssVar('--bg');
        ctx.lineWidth = (width + 3) / pxPerMm;
        ctx.stroke();
      }
      ctx.strokeStyle = colour;
      ctx.lineWidth = width / pxPerMm;
      ctx.stroke();
    };
    if (this.hover && !(sel && this.hover.kind === sel.kind && this.hover.index === sel.index)) {
      mark(this.hover, 8, 2.5, cssVar('--ink'), true);
    }
    if (sel) {
      // A quiet persistent ring, and on selection a glow that expands and fades.
      const accent = cssVar('--accent');
      mark(sel, 7, 2, accent, true);
      const t = (performance.now() - this.flashAt) / Inspector.FLASH_MS;
      if (t >= 0 && t < 1) {
        const ease = 1 - t * t;
        ctx.save();
        ctx.globalAlpha = ease * 0.9;
        ctx.shadowColor = accent;
        ctx.shadowBlur = 10 * ease;
        mark(sel, 8 + 18 * t, sel.kind === 'point' ? 3 + 3 * ease : 4 + 10 * ease, accent, false);
        ctx.restore();
      }
    }
  }
}
