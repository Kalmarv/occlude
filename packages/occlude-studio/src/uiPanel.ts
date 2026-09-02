/**
 * ui() control panel: sliders over the preview for every `ui(<literal>)`
 * call in the sketch source. Dragging a slider EDITS THE LITERAL in the
 * editor (the code is the single source of truth — a tuned sketch saves
 * and replots exactly as seen); the edited span is highlighted while you
 * drag, and the normal change→re-run pipeline picks the new value up.
 */

import { scanUiControls, type ProbeSummary, type UiControl } from 'occlude';
import type { Editor } from './editor.js';

interface Row {
  control: UiControl;
  slider: HTMLInputElement; // range or checkbox
  num: HTMLInputElement | null;
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
      row.append(name, nums, hist);
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
      .map((c) => `${c.label}|${typeof c.value}|${c.opts.min}|${c.opts.max}|${c.opts.step}`)
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
      if (typeof c.value === 'boolean') {
        row.slider.checked = c.value;
      } else if (document.activeElement !== row.slider && document.activeElement !== row.num) {
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

    const { min, max, step } = sliderSpec(control.value, control.opts);
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
  private write(row: Row, value: number | boolean): void {
    const c = row.control;
    const text = String(value);
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
    c.value = value;
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
