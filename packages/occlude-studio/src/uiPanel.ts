/**
 * ui() control panel: sliders over the preview for every `ui(<literal>)`
 * call in the sketch source. Dragging a slider EDITS THE LITERAL in the
 * editor (the code is the single source of truth — a tuned sketch saves
 * and replots exactly as seen); the edited span is highlighted while you
 * drag, and the normal change→re-run pipeline picks the new value up.
 */

import { scanUiControls, shaper, type ProbeSummary, type UiControl } from 'occlude';
import type { Editor } from './editor.js';

interface Row {
  control: UiControl;
  slider: HTMLInputElement | null; // range or checkbox; null for a curve
  num: HTMLInputElement | null;
  /** Curve editor for a shaper's knots. */
  curve?: CurveEditor;
}

type Pt = [number, number];

/**
 * The tone-curve editor. The box is the area the knots span AS WRITTEN IN
 * THE CODE: x from the first knot to the last, y from the lowest to the
 * highest. It stays that size while you drag — knots move inside it and
 * their numbers change, the box does not. To change the area, edit the
 * numbers in the code; the corners are labelled so they are never hidden.
 * The shaper's own curve is drawn through the knots, so what you see is
 * exactly what the sketch computes. Drag a knot; double-click empty space
 * to add one; double-click a knot to remove it (never below two). End
 * knots keep their x. Every change hands the knot list back to be written
 * into the code, formatted to three decimals.
 */
class CurveEditor {
  readonly canvas: HTMLCanvasElement;
  private pts: Pt[];
  private drag: number | null = null;
  private readonly size = 132;
  private readonly pad = 6;
  /** The area, fixed from the knots as they came from the code. */
  private area: { x0: number; x1: number; y0: number; y1: number };
  private box(): { x0: number; x1: number; y0: number; y1: number } {
    return this.area;
  }
  private static spanOf(pts: Pt[]): { x0: number; x1: number; y0: number; y1: number } {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    let x0 = Math.min(...xs);
    let x1 = Math.max(...xs);
    let y0 = Math.min(...ys);
    let y1 = Math.max(...ys);
    if (x1 - x0 < 1e-9) { x0 -= 0.5; x1 += 0.5; }
    if (y1 - y0 < 1e-9) { y0 -= 0.5; y1 += 0.5; }
    return { x0, x1, y0, y1 };
  }
  constructor(
    points: Pt[],
    private onChange: (pts: Pt[], final: boolean) => void,
    private onStart: () => void,
  ) {
    this.pts = CurveEditor.tidy(points);
    this.area = CurveEditor.spanOf(this.pts);
    const c = document.createElement('canvas');
    c.className = 'ui-curve';
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(this.size * dpr);
    c.height = Math.round(this.size * dpr);
    c.style.width = `${this.size}px`;
    c.style.height = `${this.size}px`;
    c.title = 'drag a knot · double-click empty space to add · double-click a knot to remove · the box is the numbers in the code';
    this.canvas = c;
    this.bind();
    this.draw();
  }

  /** The code changed under us (an edit, not our own drag): the knots and
   * the area follow the code. */
  setPoints(points: Pt[]): void {
    if (this.drag !== null) return;
    this.pts = CurveEditor.tidy(points);
    this.area = CurveEditor.spanOf(this.pts);
    this.draw();
  }

  /** Sorted by x, as the shaper itself sorts. */
  private static tidy(points: Pt[]): Pt[] {
    return points.map((p) => [p[0], p[1]] as Pt).sort((a, b) => a[0] - b[0]);
  }

  /** Pointer → knot coordinates, clamped to the area. */
  private toKnot(e: PointerEvent | MouseEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    const { x0, x1, y0, y1 } = this.box();
    const u = Math.min(1, Math.max(0, (e.clientX - r.left - this.pad) / (r.width - 2 * this.pad)));
    const v = Math.min(1, Math.max(0, 1 - (e.clientY - r.top - this.pad) / (r.height - 2 * this.pad)));
    return [x0 + u * (x1 - x0), y0 + v * (y1 - y0)];
  }

  /** Nearest knot within ~7% of the box, in box-normalised distance. */
  private nearest(p: Pt): number | null {
    const { x0, x1, y0, y1 } = this.box();
    let best = -1;
    let bestD = Infinity;
    this.pts.forEach((q, i) => {
      const d = Math.hypot((q[0] - p[0]) / (x1 - x0), (q[1] - p[1]) / (y1 - y0));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return bestD < 0.07 ? best : null;
  }

  private bind(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      const p = this.toKnot(e);
      const i = this.nearest(p);
      if (i === null) return;
      this.drag = i;
      c.setPointerCapture(e.pointerId);
      this.onStart();
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.drag === null) return;
      const p = this.toKnot(e);
      const i = this.drag;
      const first = i === 0;
      const last = i === this.pts.length - 1;
      // End knots keep their x (the domain); inner knots keep their order.
      const { x0, x1 } = this.box();
      const gap = (x1 - x0) * 0.005;
      const x = first
        ? this.pts[0][0]
        : last
          ? this.pts[i][0]
          : Math.min(this.pts[i + 1][0] - gap, Math.max(this.pts[i - 1][0] + gap, p[0]));
      this.pts[i] = [x, p[1]];
      this.draw();
      this.onChange(this.pts, false);
    });
    const end = (): void => {
      if (this.drag === null) return;
      this.drag = null;
      this.draw();
      this.onChange(this.pts, true);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', (e) => {
      const p = this.toKnot(e);
      const i = this.nearest(p);
      this.onStart();
      if (i !== null) {
        if (i === 0 || i === this.pts.length - 1 || this.pts.length <= 2) return;
        this.pts.splice(i, 1);
      } else {
        this.pts.push(p);
        this.pts.sort((a, b) => a[0] - b[0]);
      }
      this.draw();
      this.onChange(this.pts, true);
    });
  }

  private draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const S = this.size;
    const pad = this.pad;
    const w = S - 2 * pad;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    const css = getComputedStyle(this.canvas);
    const ink = css.getPropertyValue('--ink').trim() || '#c9cdd1';
    const dim = css.getPropertyValue('--ink-faint').trim() || '#4d5257';
    const edge = css.getPropertyValue('--panel-edge').trim() || '#2e3237';
    const accent = css.getPropertyValue('--toolpath').trim() || '#5b8bd9';
    const { x0, x1, y0, y1 } = this.box();
    const X = (x: number): number => pad + ((x - x0) / (x1 - x0)) * w;
    const Y = (y: number): number => pad + (1 - (y - y0) / (y1 - y0)) * w;
    // Grid: quarters of the box, and its diagonal as the reference.
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      ctx.beginPath();
      ctx.moveTo(X(x0 + t * (x1 - x0)), Y(y0));
      ctx.lineTo(X(x0 + t * (x1 - x0)), Y(y1));
      ctx.moveTo(X(x0), Y(y0 + t * (y1 - y0)));
      ctx.lineTo(X(x1), Y(y0 + t * (y1 - y0)));
      ctx.stroke();
    }
    ctx.strokeStyle = dim;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(X(x0), Y(y0));
    ctx.lineTo(X(x1), Y(y1));
    ctx.stroke();
    ctx.setLineDash([]);
    // The curve, through the sketch's own shaper.
    let fn: (v: number) => number;
    try {
      fn = shaper(this.pts);
    } catch {
      fn = (v) => v;
    }
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let k = 0; k <= 100; k++) {
      const x = x0 + (k / 100) * (x1 - x0);
      const y = fn(x);
      if (k === 0) ctx.moveTo(X(x), Y(y));
      else ctx.lineTo(X(x), Y(y));
    }
    ctx.stroke();
    // Corner values: the area is the knots' own numbers, never hidden.
    ctx.fillStyle = dim;
    ctx.font = '9px ui-monospace, monospace';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(`${fmt3(x0)}, ${fmt3(y0)}`, pad + 2, S - pad - 1);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    ctx.fillText(`${fmt3(x1)}, ${fmt3(y1)}`, S - pad - 2, pad + 1);
    // Knots.
    for (const [i, p] of this.pts.entries()) {
      ctx.beginPath();
      ctx.arc(X(p[0]), Y(p[1]), i === this.drag ? 4.5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = i === this.drag ? accent : ink;
      ctx.fill();
    }
  }
}

export class UiPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private rows: Row[] = [];
  private signature = '';
  private selfEdit = false;
  private decorations: string[] = [];
  private probes: HTMLElement;
  private controlCount = 0;
  private probeCount = 0;

  constructor(host: HTMLElement, private ed: Editor) {
    this.root = document.createElement('div');
    this.root.id = 'ui-panel';
    this.root.hidden = true;
    this.root.classList.add('collapsed'); // closed until asked; the sketch is the point
    const head = document.createElement('div');
    head.className = 'ui-panel-head';
    head.title = 'ui() values — dragging edits the literal in the code';
    const setHead = (): void => {
      head.textContent = `${this.root.classList.contains('collapsed') ? '▸' : '▾'} controls`;
    };
    head.onclick = () => {
      this.root.classList.toggle('collapsed');
      setHead();
    };
    setHead();
    this.body = document.createElement('div');
    this.body.className = 'ui-panel-body';
    this.probes = document.createElement('div');
    this.probes.className = 'ui-probes';
    this.probes.title = 't.probe(label, value) readouts from the last render';
    this.root.append(head, this.body, this.probes);
    host.append(this.root);
  }

  /** The variable inspector: after each render, what every `t.probe()`
   * label ran through — count, min, mean, max, and a 16-bin histogram. */
  setProbes(stats: Record<string, ProbeSummary>): void {
    this.probes.replaceChildren();
    const labels = Object.keys(stats);
    this.probeCount = labels.length;
    this.root.hidden = this.controlCount === 0 && this.probeCount === 0;
    for (const label of labels) {
      const p = stats[label];
      const row = document.createElement('div');
      row.className = 'ui-probe';
      const name = document.createElement('span');
      name.className = 'ui-label';
      name.textContent = label;
      const nums = document.createElement('span');
      nums.className = 'ui-probe-nums';
      const finite = p.count - p.nonFinite;
      nums.textContent =
        finite > 0
          ? `n=${p.count}  min ${fmt(p.min)}  mean ${fmt(p.mean)}  max ${fmt(p.max)}` +
            (p.nonFinite ? `  (${p.nonFinite} non-finite)` : '')
          : `n=${p.count}  no finite values`;
      const hist = document.createElement('span');
      hist.className = 'ui-probe-hist';
      hist.textContent = sparkline(p);
      hist.title = 'histogram, min → max';
      row.append(name, hist, nums);
      this.probes.append(row);
    }
  }

  /** Rescan the source; rebuild rows on structural change, else refresh. */
  sync(): void {
    if (this.selfEdit) return; // our own literal edit — offsets kept manually
    const controls = scanUiControls(this.ed.getValue());
    this.controlCount = controls.length;
    this.root.hidden = controls.length === 0 && this.probeCount === 0;
    const signature = controls
      .map((c) => `${c.label}|${c.kind}|${c.opts.min}|${c.opts.max}|${c.opts.step}`)
      .join(';');
    if (signature !== this.signature) {
      this.signature = signature;
      this.rebuild(controls);
      return;
    }
    // Same controls — refresh values/offsets (an outside edit moved them).
    controls.forEach((c, k) => {
      const row = this.rows[k];
      row.control = c;
      if (c.kind === 'points') {
        row.curve?.setPoints(c.value as Pt[]);
      } else if (typeof c.value === 'boolean') {
        if (row.slider) row.slider.checked = c.value;
      } else if (row.slider && document.activeElement !== row.slider && document.activeElement !== row.num) {
        row.slider.value = String(c.value);
        if (row.num) row.num.value = String(c.value);
      }
    });
  }

  private rebuild(controls: UiControl[]): void {
    this.body.replaceChildren();
    this.rows = controls.map((c) => this.buildRow(c));
  }

  private buildRow(control: UiControl): Row {
    const row = document.createElement('label');
    row.className = 'ui-row';
    const name = document.createElement('span');
    name.className = 'ui-label';
    name.textContent = control.label;
    row.append(name);

    if (control.kind === 'points') {
      const entry: Row = { control, slider: null, num: null };
      const curve = new CurveEditor(
        control.value as Pt[],
        (pts, final) => {
          this.write(entry, pts);
          if (final) {
            this.ed.editor.pushUndoStop();
            this.clearHighlight();
          } else {
            this.highlight(entry.control);
          }
        },
        () => {
          this.ed.editor.pushUndoStop();
          this.highlight(entry.control);
        },
      );
      entry.curve = curve;
      row.classList.add('ui-row-curve');
      row.append(curve.canvas);
      this.body.append(row);
      return entry;
    }

    if (typeof control.value === 'boolean') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = control.value;
      const entry: Row = { control, slider: box, num: null };
      box.onchange = () => this.write(entry, box.checked);
      row.append(box);
      this.body.append(row);
      return entry;
    }

    const { min, max, step } = sliderSpec(control.value as number, control.opts);
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(control.value);
    const num = document.createElement('input');
    num.type = 'number';
    num.className = 'ui-num';
    num.step = String(step);
    num.value = String(control.value);

    const entry: Row = { control, slider, num };
    // One undo stop per drag, not one per pixel of thumb travel.
    slider.onpointerdown = () => {
      this.ed.editor.pushUndoStop();
      this.highlight(entry.control);
    };
    slider.oninput = () => {
      num.value = slider.value;
      this.write(entry, Number(slider.value));
      this.highlight(entry.control);
    };
    slider.onpointerup = () => {
      this.ed.editor.pushUndoStop();
      this.clearHighlight();
    };
    num.onchange = () => {
      const v = Number(num.value);
      if (!Number.isFinite(v)) return;
      slider.value = num.value;
      this.write(entry, v);
      this.clearHighlight();
    };
    row.append(slider, num);
    this.body.append(row);
    return entry;
  }

  /** Replace the control's literal in the editor and shift later offsets. */
  private write(row: Row, value: number | boolean | Pt[]): void {
    const c = row.control;
    const text = Array.isArray(value)
      ? `[${value.map(([x, y]) => `[${fmt3(x)}, ${fmt3(y)}]`).join(', ')}]`
      : String(value);
    const model = this.ed.model;
    const s = model.getPositionAt(c.valueStart);
    const e = model.getPositionAt(c.valueEnd);
    this.selfEdit = true;
    try {
      this.ed.editor.executeEdits('ui-panel', [
        {
          range: {
            startLineNumber: s.lineNumber,
            startColumn: s.column,
            endLineNumber: e.lineNumber,
            endColumn: e.column,
          },
          text,
        },
      ]);
    } finally {
      this.selfEdit = false;
    }
    const delta = text.length - (c.valueEnd - c.valueStart);
    c.valueEnd += delta;
    c.value = Array.isArray(value) ? value.map((p) => [p[0], p[1]] as Pt) : value;
    for (const other of this.rows) {
      if (other.control.valueStart > c.valueStart) {
        other.control.valueStart += delta;
        other.control.valueEnd += delta;
      }
    }
  }

  /** Mark the literal being edited so the change is visible in the code. */
  private highlight(c: UiControl): void {
    const model = this.ed.model;
    const s = model.getPositionAt(c.valueStart);
    const e = model.getPositionAt(c.valueEnd);
    const range = {
      startLineNumber: s.lineNumber,
      startColumn: s.column,
      endLineNumber: e.lineNumber,
      endColumn: e.column,
    };
    this.decorations = model.deltaDecorations(this.decorations, [
      { range, options: { inlineClassName: 'ui-edit-highlight' } },
    ]);
    this.ed.editor.revealRangeInCenterIfOutsideViewport(range);
  }

  private clearHighlight(): void {
    this.decorations = this.ed.model.deltaDecorations(this.decorations, []);
  }
}

/** Sane slider range/step from the initial value when opts don't pin them. */
export function sliderSpec(
  v: number,
  o: { min?: number; max?: number; step?: number },
): { min: number; max: number; step: number } {
  let min = o.min;
  let max = o.max;
  if (min === undefined && max === undefined) {
    if (v === 0) {
      min = 0;
      max = 10;
    } else if (v > 0 && v <= 1) {
      min = 0;
      max = 1;
    } else if (v > 0) {
      min = 0;
      max = niceCeil(v * 2.5);
    } else {
      min = -niceCeil(-v * 2.5);
      max = niceCeil(-v * 2.5);
    }
  } else {
    min ??= Math.min(0, v);
    max ??= niceCeil(Math.max(v, (min as number) + 1) * 2.5);
  }
  let step = o.step;
  if (step === undefined) {
    step =
      Number.isInteger(v) && max - min >= 10 && Number.isInteger(min)
        ? 1
        : niceStep((max - min) / 200);
  }
  return { min, max, step };
}

/** Round up to a tidy 1/2/5 × 10^k value. */
function niceCeil(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

function niceStep(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 5]) if (m * p >= x) return m * p;
  return 10 * p;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000 || a < 0.001) return v.toExponential(2);
  return v.toPrecision(3).replace(/\.?0+$/, '');
}

/** 16 bins between min and max, drawn with block characters. */
function sparkline(p: ProbeSummary): string {
  if (p.samples.length === 0 || !(p.max > p.min)) return '';
  const bins = new Array<number>(16).fill(0);
  for (const v of p.samples) {
    const k = Math.min(15, Math.floor(((v - p.min) / (p.max - p.min)) * 16));
    bins[k]++;
  }
  const peak = Math.max(...bins);
  const blocks = ' ▁▂▃▄▅▆▇█';
  return bins.map((b) => blocks[b === 0 ? 0 : 1 + Math.floor((b / peak) * 7.999)]).join('');
}

/** Three decimals, no trailing zeros: 0.3 stays 0.3, 0.125 stays 0.125. */
function fmt3(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}
