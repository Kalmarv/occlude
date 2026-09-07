/**
 * The control rail: sketch library, pen tray, paper & machine, export.
 * Pens are the one colourful thing in the chrome — each row draws a live
 * stroke sample with the pen's true ink and nib width. Exports run in the
 * render worker against the last rendered buffers, so they never block the
 * editor (or re-render).
 */

import {
  encodeToolpath, chainsBounds, type FlatChain,
  estimatePlanMs, profileToJson,
  type GcodeJob, type PenDef, type RenderResult,
} from 'occlude';
import { loadSketchByName, saveSketchByName } from './sketchApi.js';
import {
  DEFAULT_SKETCH, NEW_SKETCH, PAPER_COLORS,
  download, loadUi, savePens, saveProfiles, saveSettings, saveUi,
  type MachineProfile, type Settings,
} from './store.js';
import { serialSupported, type PlotProgress } from './ebb.js';
import { buildConnect, buildManualControls, buildProfileSelect, createSession } from './machine.js';
import { machineTiming, machineTolerance, penTimingOf, type Drawing, type SelectionRequest } from './drawing.js';
import type { RenderClient } from './workerClient.js';
import { button, checkbox, el, hint, numberInput, pairInput, row, segmented } from './widgets.js';

export interface PanelHooks {
  pens: PenDef[];
  settings: Settings;
  /** Server-shared machine profiles; settings.activeProfile picks one. */
  profiles: MachineProfile[];
  onChanged(): void;
  /** Paper colour changed: repaint the sheet, don't re-render the ink. */
  onPaperColor(hex: string): void;
  lastResult(): RenderResult | null;
  /** The seed the current render actually used (resume checks it). */
  currentSeed(): string | null;
  client: RenderClient;
  /** THE ordered plan of the current render and the selection of it that
   * preview, exports, simulation and the machine all use. */
  drawing: Drawing;
  /** Repaint the preview's selection view (a preview-only toggle moved). */
  onSelectionView(): void;
  getSource(): string;
  openSketch(name: string, source: string): void;
  currentName(): string;
  setName(name: string): void;
  importSketchFile(): void;
  downloadSketchFile(): void;
  /** A save landed: the studio uploads the finished render as the thumb. */
  afterSave(name: string): void;
  /** Live plot view: mirror the machine's progress in the preview. */
  livePlot: {
    start(plan: Float64Array, pens: PenDef[]): void;
    progress(chain: number): void;
    end(): void;
  };
}

export interface Rail {
  refreshExport(): void;
  refreshSketches(): void;
  /** Save the current sketch under its name (Ctrl+S path). Resolves with the
   * saved name, or null when there is no name yet. */
  saveCurrent(): Promise<string | null>;
}

/** Callbacks re-rendering profile-bound controls after a profile switch —
 * the single mechanism keeping the UI and the active profile in lockstep. */
const onProfileSwitch: (() => void)[] = [];

export function buildRail(rail: HTMLElement, hooks: PanelHooks): Rail {
  onProfileSwitch.length = 0;
  rail.innerHTML = '';
  // Two modes, two rhythms: composing the drawing (every minute) and running
  // the machine (every plot). Each fits one screen; the switch is remembered.
  const ui = loadUi();
  const compose = el('div', 'rail-mode compose');
  const plot = el('div', 'rail-mode plot');
  const setMode = (mode: 'compose' | 'plot'): void => {
    compose.hidden = mode !== 'compose';
    plot.hidden = mode !== 'plot';
    rail.dataset.mode = mode;
    ui.railMode = mode;
    saveUi(ui);
  };
  const modes = segmented(
    [
      { key: 'compose' as const, label: 'Compose', title: 'Sketch, paper, pens, export' },
      { key: 'plot' as const, label: 'Plot', title: 'Connect, position, plot' },
    ],
    ui.railMode,
    setMode,
  );
  rail.append(modes.root, compose, plot);

  const sketchesPanel = panel('Sketch', true);
  const paperPanel = panel('Paper', true);
  const pensPanel = panel('Pens', true);
  const drawingPanel = panel('Drawing', true);
  const exportPanel = panel('Export', false);
  compose.append(sketchesPanel.root, paperPanel.root, pensPanel.root, drawingPanel.root, exportPanel.root);

  const sketches = buildSketchesPanel(sketchesPanel.body, hooks);
  buildPensPanel(pensPanel.body, hooks);
  buildDrawingPanel(drawingPanel.body, hooks);
  buildPaperPanel(paperPanel.body, hooks);
  buildPlotPanel(plot, hooks);
  const refreshExport = buildExportPanel(exportPanel.body, hooks);
  exportPanel.root.addEventListener('toggle', () => {
    if ((exportPanel.root as HTMLDetailsElement).open) refreshExport();
  });
  setMode(ui.railMode);
  return {
    refreshExport,
    refreshSketches: sketches.refresh,
    saveCurrent: sketches.save,
  };
}

function panel(title: string, open: boolean): { root: HTMLDetailsElement; body: HTMLDivElement } {
  const root = document.createElement('details');
  root.className = 'panel';
  root.open = open;
  const summary = document.createElement('summary');
  summary.textContent = title;
  const body = document.createElement('div');
  body.className = 'panel-body';
  root.append(summary, body);
  return { root, body };
}

/** Collapsed sub-section inside a panel — the home of set-once controls. */
function sub(title: string): { root: HTMLDetailsElement; body: HTMLDivElement } {
  const root = document.createElement('details');
  root.className = 'subpanel';
  const summary = document.createElement('summary');
  summary.textContent = title;
  const body = document.createElement('div');
  body.className = 'subpanel-body';
  root.append(summary, body);
  return { root, body };
}

// ---- sketch library (server-side store, shared across devices) ----

function buildSketchesPanel(
  body: HTMLElement,
  hooks: PanelHooks,
): { refresh(): void; save(): Promise<string | null> } {
  // The sketch's name lives in the topbar title input; this panel saves,
  // lists, and moves .ts files in and out.
  const actionRow = document.createElement('div');
  actionRow.className = 'row';
  async function save(): Promise<string | null> {
    const name = hooks.currentName().trim();
    if (!name) return null;
    if (!/^[a-zA-Z0-9 _-]{1,64}$/.test(name)) {
      alert('Names: letters, digits, spaces, - and _ (max 64).');
      return null;
    }
    await saveSketchByName(name, hooks.getSource());
    hooks.setName(name);
    hooks.afterSave(name);
    return name;
  }
  const saveBtn = button('Save', async () => {
    try {
      if ((await save()) === null) {
        alert('Name the sketch first — the title field in the top bar.');
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  });
  saveBtn.className = 'primary';
  saveBtn.title = 'Save to the studio server under the title-bar name (Ctrl+S)';
  const importBtn2 = button('Import .ts', hooks.importSketchFile);
  importBtn2.title = 'Load a .ts sketch file into the editor';
  const dlBtn = button('Download .ts', hooks.downloadSketchFile);
  dlBtn.title = 'Download the current sketch as a .ts file';
  const newBtn = button('New', async () => {
    // Losing work needs a prompt; losing nothing shouldn't. Named sketches
    // are dirty when the editor drifted from the server copy; unnamed ones
    // when they aren't just a pristine starter.
    const src = hooks.getSource();
    const name = hooks.currentName().trim();
    const dirty = name
      ? await loadSketchByName(name).then((saved) => saved !== src, () => true)
      : src !== DEFAULT_SKETCH && src !== NEW_SKETCH;
    if (dirty && !confirm('Replace the editor with a fresh sketch? Unsaved changes are lost.')) {
      return;
    }
    hooks.openSketch('', NEW_SKETCH);
  });
  newBtn.title = 'Start a fresh sketch — name it in the top bar, then Save';
  actionRow.append(newBtn, saveBtn, importBtn2, dlBtn);

  const hint = document.createElement('div');
  hint.className = 'panel-hint';
  const link = document.createElement('a');
  link.href = '/sketches.html';
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Sketches page';
  hint.append('Saved on the studio server — browse, fork and snapshot on the ', link, '.');

  body.append(actionRow, hint);
  return { refresh: () => undefined, save };
}

function ago(mtime: number): string {
  const s = (Date.now() - mtime) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// ---- pens ----

function strokeSample(canvas: HTMLCanvasElement, pen: PenDef): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 200;
  const h = 14;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = pen.color;
  // Sample at 2px/mm so nib widths are visibly different.
  ctx.lineWidth = Math.max(0.5, pen.width * 4);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let x = 4; x <= w - 4; x += 2) {
    const t = (x - 4) / (w - 8);
    const y = h / 2 + Math.sin(t * Math.PI * 3) * 3.2;
    if (x === 4) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function buildPensPanel(body: HTMLElement, hooks: PanelHooks): void {
  let selected: number | null = null;

  const list = document.createElement('div');
  const editHost = document.createElement('div');
  const actions = document.createElement('div');
  actions.className = 'row';

  const addBtn = button('Add pen', () => {
    hooks.pens.push({
      name: `pen-${hooks.pens.length + 1}`,
      width: 0.3,
      color: '#3355aa',
      feed: 3000,
      penDown: 0,
      penUp: 5,
      penDelay: 100,
    });
    selected = hooks.pens.length - 1;
    persist();
    renderList();
  });
  const importBtn = button('Import', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const pens = JSON.parse(await file.text()) as PenDef[];
        if (!Array.isArray(pens)) throw new Error('expected a JSON array of pens');
        hooks.pens.splice(0, hooks.pens.length, ...pens);
        selected = null;
        persist();
        renderList();
      } catch (e) {
        alert(`Pen import failed: ${e instanceof Error ? e.message : e}`);
      }
    };
    input.click();
  });
  const exportBtn = button('Export', () => {
    download('pens.json', JSON.stringify(hooks.pens, null, 2), 'application/json');
  });
  actions.append(addBtn, importBtn, exportBtn);

  function persist(): void {
    savePens(hooks.pens);
    hooks.onChanged();
  }

  function renderEditor(): void {
    editHost.innerHTML = '';
    if (selected === null) return;
    const pen = hooks.pens[selected];
    const form = document.createElement('div');
    form.className = 'pen-edit';
    const fields: [string, keyof PenDef, string][] = [
      ['Name', 'name', 'text'],
      ['Width mm', 'width', 'number'],
      ['Color', 'color', 'color'],
      ['Feed', 'feed', 'number'],
      ['Pen down', 'penDown', 'number'],
      ['Pen up', 'penUp', 'number'],
      ['Delay ms', 'penDelay', 'number'],
      ['Re-ink mm', 'reinkMm', 'number'],
    ];
    for (const [label, key, type] of fields) {
      const l = document.createElement('label');
      l.textContent = label;
      const input = document.createElement('input');
      input.type = type;
      if (type === 'number') input.step = key === 'width' ? '0.05' : '10';
      input.value = String(pen[key] ?? (type === 'number' ? 0 : ''));
      input.onchange = () => {
        const v: string | number = type === 'number' ? parseFloat(input.value) : input.value;
        (pen as unknown as Record<string, string | number>)[key] = v;
        persist();
        renderList();
      };
      form.append(l, input);
    }
    const del = button('Delete pen', () => {
      hooks.pens.splice(selected!, 1);
      selected = null;
      persist();
      renderList();
    });
    del.style.gridColumn = '1 / -1';
    form.append(del);
    editHost.append(form);
  }

  // Calibration pens (the settle-sweep sketch's per-column pens) stay in the
  // library so sketches can name them, but out of the everyday tray.
  const isCalibrationPen = (pen: PenDef): boolean => /^(settle|cal|lift|down|traverse)-/.test(pen.name);
  let calOpen = false;
  function renderList(): void {
    list.innerHTML = '';
    const group = document.createElement('details');
    group.className = 'pen-group';
    group.open = calOpen;
    group.addEventListener('toggle', () => { calOpen = group.open; });
    const summary = document.createElement('summary');
    group.append(summary);
    let calCount = 0;
    hooks.pens.forEach((pen, i) => {
      const row = document.createElement('div');
      row.className = `pen-row${i === selected ? ' selected' : ''}`;
      row.tabIndex = 0;
      const name = document.createElement('span');
      name.className = 'pen-name';
      name.textContent = pen.name;
      const meta = document.createElement('span');
      meta.className = 'pen-meta';
      meta.textContent = `${pen.width.toFixed(2)}mm`;
      const sample = document.createElement('canvas');
      sample.className = 'pen-sample';
      row.append(name, meta, sample);
      row.onclick = () => {
        selected = selected === i ? null : i;
        renderList();
      };
      if (isCalibrationPen(pen)) {
        calCount += 1;
        group.append(row);
      } else {
        list.append(row);
      }
      requestAnimationFrame(() => strokeSample(sample, pen));
    });
    if (calCount > 0) {
      summary.textContent = `${calCount} calibration pens`;
      list.append(group);
    }
    renderEditor();
  }

  body.append(list, editHost, actions);
  renderList();
}

// ---- paper & machine ----

function buildPaperPanel(body: HTMLElement, hooks: PanelHooks): void {
  const s = hooks.settings;
  const persist = (): void => {
    saveSettings(s);
    hooks.onChanged();
  };

  const paperSel = document.createElement('select');
  for (const name of ['A3', 'A4', 'A5', 'A6', 'Letter', 'Square20', 'Custom']) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    paperSel.append(o);
  }
  paperSel.value = s.paper;

  // Custom size: inputs display in the chosen unit, storage is always mm.
  const MM_PER_IN = 25.4;
  const toUnit = (mm: number): number => (s.paperUnit === 'in' ? mm / MM_PER_IN : mm);
  const fromUnit = (v: number): number => (s.paperUnit === 'in' ? v * MM_PER_IN : v);
  const fmt = (mm: number): string =>
    s.paperUnit === 'in' ? String(+toUnit(mm).toFixed(3)) : String(+mm.toFixed(1));
  const cw = document.createElement('input');
  const ch = document.createElement('input');
  for (const el of [cw, ch]) {
    el.type = 'number';
    el.step = 'any';
    el.style.width = '4.5em';
  }
  const unitSel = document.createElement('select');
  for (const u of ['mm', 'in']) {
    const o = document.createElement('option');
    o.value = u;
    o.textContent = u;
    unitSel.append(o);
  }
  unitSel.value = s.paperUnit;
  const syncCustom = (): void => {
    cw.value = fmt(s.customPaper.w);
    ch.value = fmt(s.customPaper.h);
  };
  syncCustom();
  const readCustom = (): void => {
    const w = fromUnit(parseFloat(cw.value));
    const h = fromUnit(parseFloat(ch.value));
    if (Number.isFinite(w) && w > 10 && Number.isFinite(h) && h > 10) {
      s.customPaper = { w: Math.min(w, 5000), h: Math.min(h, 5000) };
      persist();
    }
  };
  cw.onchange = readCustom;
  ch.onchange = readCustom;
  unitSel.onchange = () => {
    s.paperUnit = unitSel.value as 'mm' | 'in';
    persist();
    syncCustom();
  };
  const customWrap = document.createElement('div');
  customWrap.className = 'row';
  const times = document.createElement('span');
  times.textContent = '\u00d7';
  customWrap.append(cw, times, ch, unitSel);
  const customRow = row('Size', customWrap);
  const syncVisible = (): void => {
    customRow.style.display = s.paper === 'Custom' ? '' : 'none';
  };
  syncVisible();
  paperSel.onchange = () => {
    s.paper = paperSel.value;
    persist();
    syncVisible();
  };

  const landscape = checkbox('Landscape', s.landscape, (v) => {
    s.landscape = v;
    persist();
  });

  // Paper colour: what the preview and both exports paint under the ink.
  // Changing it never re-renders — the ink is identical, the sheet is not.
  const colorSel = document.createElement('select');
  for (const name of [...PAPER_COLORS.map((c) => c.name), 'Custom']) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    colorSel.append(o);
  }
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.style.flex = '0 0 3.2em';
  colorInput.title = 'The sheet colour, exactly';
  const syncColor = (): void => {
    colorInput.value = s.paperColor;
    colorSel.value = PAPER_COLORS.find((c) => c.hex === s.paperColor)?.name ?? 'Custom';
  };
  syncColor();
  const applyColor = (hex: string): void => {
    s.paperColor = hex;
    saveSettings(s);
    hooks.onPaperColor(hex);
    syncColor();
  };
  colorSel.onchange = () => {
    const stock = PAPER_COLORS.find((c) => c.name === colorSel.value);
    if (stock) applyColor(stock.hex);
  };
  colorInput.oninput = () => applyColor(colorInput.value);
  const colorWrap = document.createElement('div');
  colorWrap.className = 'row';
  colorWrap.append(colorSel, colorInput);

  const marginInput = numberInput(s.defaultMarginPct, 0.5, (v) => {
    s.defaultMarginPct = v;
    persist();
  });

  body.append(
    row('Paper', paperSel),
    customRow,
    row('Color', colorWrap, 'The stock you are plotting on — preview and exports both use it'),
    landscape,
    row('Margin %', marginInput, 'Used when the sketch does not call margin()'),
  );
}

// ---- the ordered drawing: choose a prefix or interval of the plan ----

const fmtMin = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.ceil(ms / 1000)} s`);

function buildDrawingPanel(body: HTMLElement, hooks: PanelHooks): void {
  const d = hooks.drawing;
  type Mode = 'full' | 'prefix' | 'interval';
  type Unit = 'chains' | 'progress' | 'time';
  let mode: Mode = 'full';
  let unit: Unit = 'chains';
  let from = 0;
  let to = 0;
  let budgetOn = false;
  let budgetMin = 20;

  const readout = document.createElement('div');
  readout.className = 'panel-hint drawing-readout';
  const fromInput = numberInput(0, 1, (v) => { from = v; apply(); });
  const toInput = numberInput(0, 1, (v) => { to = v; apply(); });
  const fromRow = row('From', fromInput);
  const toRow = row('To', toInput);
  const unitSeg = segmented(
    [
      { key: 'chains' as const, label: 'chains', title: 'Whole chains of the plan, [from, to)' },
      { key: 'progress' as const, label: '% chains', title: 'Fraction OF CHAINS — not ink, area or time' },
      { key: 'time' as const, label: 'min', title: 'An interval of the full drawing\'s estimated timeline, quantized to whole chains' },
    ],
    unit,
    (u) => { unit = u; syncInputs(); apply(); },
  );
  const modeSeg = segmented(
    [
      { key: 'full' as const, label: 'Full', title: 'The whole plan' },
      { key: 'prefix' as const, label: 'Prefix', title: 'From the first chain up to a stopping point' },
      { key: 'interval' as const, label: 'Interval', title: 'A contiguous middle stretch of the plan' },
    ],
    mode,
    (m) => { mode = m; syncInputs(); apply(); },
  );
  const budgetInput = numberInput(budgetMin, 1, (v) => { budgetMin = v; apply(); });
  const budgetBox = checkbox('Fit an estimated budget (min)', budgetOn, (v) => { budgetOn = v; apply(); });
  const budgetRow = row('Budget', budgetInput, 'Longest prefix of the selection whose standalone estimate fits — travel in and final lift included; human waits not modelled');
  const omitted = checkbox('Ghost the omitted ink (preview only)', d.showOmitted, (v) => { d.showOmitted = v; hooks.onSelectionView(); });

  const syncInputs = (): void => {
    fromRow.style.display = mode === 'interval' ? '' : 'none';
    toRow.style.display = mode === 'full' ? 'none' : '';
    unitSeg.root.style.display = mode === 'full' ? 'none' : '';
    const step = unit === 'chains' ? 1 : unit === 'progress' ? 1 : 0.5;
    fromInput.step = String(step);
    toInput.step = String(step);
  };
  const request = (): SelectionRequest => {
    if (mode === 'full') return { kind: 'full' };
    const a = mode === 'prefix' ? 0 : from;
    if (unit === 'chains') return { kind: 'chains', from: Math.max(0, Math.round(a)), to: Math.max(0, Math.round(to)) };
    if (unit === 'progress') return { kind: 'progress', from: Math.min(1, Math.max(0, a / 100)), to: Math.min(1, Math.max(0, to / 100)) };
    return { kind: 'time', fromMs: Math.max(0, a) * 60_000, toMs: Math.max(0, to) * 60_000 };
  };
  const apply = (): void => {
    const req = request();
    if (req.kind !== 'full' && ((req.kind === 'chains' && req.from > req.to) || (req.kind === 'progress' && req.from > req.to) || (req.kind === 'time' && req.fromMs > req.toMs))) {
      readout.textContent = 'from must not exceed to';
      return;
    }
    void d.select(req, budgetOn ? budgetMin * 60_000 : null).catch((e: unknown) => {
      readout.textContent = e instanceof Error ? e.message : String(e);
    });
  };
  const refresh = (): void => {
    const plan = d.plan;
    const r = d.current;
    if (!plan || !r) {
      readout.textContent = 'render a sketch to see its plan';
      return;
    }
    const n = plan.chains.length;
    const final = r.fit?.selection ?? r.selection;
    const parts: string[] = [];
    parts.push(`chains ${final.fromChain}–${final.toChain} of ${n} (${final.count} selected)`);
    if (r.effective) parts.push(`effective ${fmtMin(r.effective.fromMs)}–${fmtMin(r.effective.toMs)} of ${fmtMin(r.fullMs)}`);
    parts.push(`standalone ETA ${fmtMin(r.estimate.totalMs)}` + (final.count < n ? ` (full plan ${fmtMin(r.fullMs)})` : ''));
    if (r.fit) parts.push(r.fit.dropped > 0 ? `budget: ${r.fit.dropped} chains dropped, ${fmtMin(r.fit.unusedMs)} unused` : `budget: fits, ${fmtMin(r.fit.unusedMs)} unused`);
    readout.textContent = parts.join(' · ');
    // The inputs' ceilings follow the plan so the controls stay meaningful.
    if (unit === 'chains') { toInput.max = String(n); fromInput.max = String(n); }
    if (unit === 'progress') { toInput.max = '100'; fromInput.max = '100'; }
    if (unit === 'time') { toInput.max = String(Math.ceil(r.fullMs / 60_000)); fromInput.max = toInput.max; }
  };
  d.onChange(refresh);
  syncInputs();
  refresh();

  body.append(
    modeSeg.root,
    unitSeg.root,
    fromRow,
    toRow,
    budgetBox,
    budgetRow,
    omitted,
    readout,
    hint('Selection reuses the plan as rendered: nothing is re-solved, reordered or re-bridged, and ink hidden by later shapes stays hidden. Exports, Simulate and Plot all use this selection.'),
  );
}

// ---- plot: EBB (AxiDraw-family) over Web Serial ----

function buildPlotPanel(body: HTMLElement, hooks: PanelHooks): void {
  if (!serialSupported()) {
    body.append(hint(window.isSecureContext
      ? 'Web Serial needs Chrome or Edge.'
      : 'Web Serial needs a secure context — open the studio over HTTPS (or localhost).'));
    return;
  }
  const status = document.createElement('div');
  status.className = 'panel-hint status-line';
  const showErr = (e: unknown): void => {
    status.textContent = e instanceof Error ? e.message : String(e);
  };
  const m = createSession(hooks.profiles, hooks.settings, () => hooks.pens, showErr);
  m.onChanged = () => {
    hooks.onChanged(); // estimates follow the machine
    for (const fn of onProfileSwitch) fn();
  };
  const { ebb } = m;
  const prof = m.prof;

  // Pen to plot. No physical pen changer: a multi-pen sketch is plotted one
  // pen per run — plot, swap the pen by hand, pick the next, plot again.
  // Options mirror the last render, rebuilt on open so they never go stale.
  const penSelect = document.createElement('select');
  const refreshPenSelect = (): void => {
    const prev = penSelect.selectedOptions[0]?.textContent ?? '';
    penSelect.innerHTML = '';
    const pens = hooks.lastResult()?.pens ?? [];
    if (pens.length > 1) {
      const all = document.createElement('option');
      all.value = '-1';
      all.textContent = 'all pens (one run)';
      all.selected = prev === all.textContent;
      penSelect.append(all);
    }
    pens.forEach((pen, i) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = pen.name;
      option.selected = pen.name === prev;
      penSelect.append(option);
    });
    tintPlot();
  };
  penSelect.addEventListener('pointerdown', refreshPenSelect);
  penSelect.addEventListener('change', () => tintPlot());

  // The Plot button wears the selected pen's ink: which pen is about to plot,
  // without a label. "All pens" is the neutral brass.
  const tintPlot = (): void => {
    const raw = parseInt(penSelect.value, 10);
    const pens = hooks.lastResult()?.pens ?? [];
    const pen = raw >= 0 ? pens[raw] : undefined;
    const color = pen ? hooks.pens.find((p) => p.name === pen.name)?.color ?? pen.color : null;
    plotBtn.style.setProperty('--pen', color ?? 'var(--brass)');
    bar.style.setProperty('--pen', color ?? 'var(--brass)');
  };

  const bar = document.createElement('progress');
  bar.className = 'plot-progress';
  bar.max = 1;
  bar.value = 0;
  const progressText = document.createElement('div');
  progressText.className = 'panel-hint progress-text';

  function onProgress(p: PlotProgress): void {
    if (p.chain !== undefined) hooks.livePlot.progress(p.chain);
    if (p.state === 'done' || p.state === 'stopped') hooks.livePlot.end();
    if (p.state === 'done' && p.wallMs && p.estimate) {
      // Calibration record: model breakdown vs measured wall time. The log
      // accumulates on the server; `plotstats --fit` learns correction
      // coefficients from it.
      void fetch('/api/plotlog', {
        method: 'POST',
        body: JSON.stringify({
          ts: new Date().toISOString(),
          sketch: hooks.currentName() || null,
          pen: p.penName || null,
          wallMs: Math.round(p.wallMs),
          modelMs: Math.round(p.totalMs),
          estimate: p.estimate,
          settings: {
            liftMap: ((mp) => (mp ? `${mp.cols}x${mp.rows}` : null))(prof().ebb.liftMap),
            liftMarginPulses: prof().ebb.liftMarginPulses,
            settleCurve: prof().ebb.settleCurve?.length ?? 0,
            travelFeed: prof().machine.travelFeed,
            acceleration: prof().ebb.acceleration,
            travelAcceleration: prof().ebb.travelAcceleration,
            lmMotion: prof().ebb.lmMotion,
          },
        }),
      }).catch(() => undefined);
    }
    bar.value = p.totalMs > 0 ? Math.min(1, p.elapsedMs / p.totalMs) : 0;
    const eta = Math.max(0, p.etaMs / 60000);
    const base =
      p.state === 'done'
        ? 'done'
        : p.state === 'stopped'
          ? 'stopped'
          : `${p.state} · ${p.penName} · ${eta.toFixed(1)} min left`;
    progressText.textContent = p.warning ? `${base} · ⚠ ${p.warning}` : base;
    pauseBtn.textContent = p.state === 'paused' ? 'Resume' : 'Pause';
    body.classList.toggle('plotting', p.state === 'plotting' || p.state === 'paused');
  }

  /** The plan for the current render at a pen selection (undefined = all),
   * with the bed-fit check. Shared by Plot and Resume. */
  const buildPlan = async (r: RenderResult, penIndex: number | undefined): Promise<Float64Array | null> => {
    const tol = machineTolerance(prof(), penIndex === undefined ? r.pens : [r.pens[penIndex] ?? r.pens[0]]);
    // The SELECTED chains of the plan, source indices kept; the driver's
    // pen filter is an execution filter over that same sequence.
    const flat = await hooks.drawing.selectedToolpath(tol);
    executed = penIndex === undefined ? flat : flat.filter((c) => c.pen === penIndex);
    const plan = encodeToolpath(flat);
    const bb = chainsBounds(executed);
    const bed = prof().machine;
    const [ox, oy] = ebb.paperOffset;
    if (ox + bb.x + bb.w > bed.bedW + 0.5 || oy + bb.y + bb.h > bed.bedH + 0.5) {
      showErr(
        `plan needs ${(ox + bb.x + bb.w).toFixed(0)}×${(oy + bb.y + bb.h).toFixed(0)}mm from the bed origin — ` +
        `exceeds the ${prof().name} bed (${bed.bedW}×${bed.bedH}mm); not plotting`,
      );
      return null;
    }
    return plan;
  };

  /** The chains the driver is executing (selection, then pen filter): the
   * driver reports indices into this list; source rows come from it. */
  let executed: FlatChain[] = [];

  // Saved progress: which plan, which selection of it, and the chain the
  // machine reached — after a stop, a crashed tab, or a power loss.
  interface SavedPlot {
    sketch: string;
    sourceHash: string;
    seed: string | null;
    penIndex: number | null;
    paperOffset: [number, number];
    /** Index into the EXECUTED list (selection, pen-filtered). */
    chain: number;
    chainTotal: number;
    /** Full-plan row of that chain, for reading. */
    sourceChain: number | null;
    /** Identity of the plan and the selected range this progress is of. */
    planHash: string | null;
    selection: { from: number; to: number } | null;
    ts: string;
  }
  const hashSource = (src: string): string => {
    let h = 5381;
    for (let i = 0; i < src.length; i++) h = ((h * 33) ^ src.charCodeAt(i)) >>> 0;
    return h.toString(16);
  };
  let saved: SavedPlot | null = null;
  let lastSavedChain = -1;
  let lastSavedAt = 0;
  const savedBox = document.createElement('div');
  savedBox.className = 'saved-plot';
  savedBox.hidden = true; // shown once the server says there is one
  const savedText = document.createElement('div');
  savedText.className = 'panel-hint';
  const showSaved = (): void => {
    savedBox.hidden = !saved;
    if (!saved) return;
    const pen = saved.penIndex === null ? 'all pens' : `pen ${saved.penIndex}`;
    const range = saved.selection ? `chains ${saved.selection.from}–${saved.selection.to} of the plan` : 'the whole plan';
    savedText.textContent =
      `Unfinished: ${saved.sketch}, ${pen}, ${range}, executed chain ${saved.chain} of ${saved.chainTotal}` +
      (saved.sourceChain !== null ? ` (plan row ${saved.sourceChain})` : '') +
      `, paper at ${saved.paperOffset[0]}, ${saved.paperOffset[1]} mm. ` +
      'After a power loss, re-park at the bed corner and Set bed origin first.';
  };
  const putProgress = (p: SavedPlot): void => {
    saved = p;
    void fetch('/api/plot-progress', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
    }).catch(() => undefined);
  };
  const clearProgress = (): void => {
    saved = null;
    lastSavedChain = -1;
    void fetch('/api/plot-progress', { method: 'DELETE' }).catch(() => undefined);
    showSaved();
  };
  void fetch('/api/plot-progress')
    .then(async (res) => (res.ok ? ((await res.json()) as SavedPlot) : null))
    .then((p) => { saved = p; showSaved(); })
    .catch(() => undefined);

  const runPlot = async (penIndex: number | undefined, startChain: number): Promise<void> => {
    const r = hooks.lastResult();
    if (!r) return;
    const plan = await buildPlan(r, penIndex);
    if (!plan) return;
    const sel = hooks.drawing.selection;
    const record = (chain: number, chainTotal: number): void => {
      putProgress({
        sketch: hooks.currentName(),
        sourceHash: hashSource(hooks.getSource()),
        seed: hooks.currentSeed(),
        penIndex: penIndex ?? null,
        paperOffset: [...ebb.paperOffset] as [number, number],
        chain, chainTotal,
        sourceChain: executed[chain]?.index ?? null,
        planHash: hooks.drawing.plan?.planHash ?? null,
        selection: sel ? { from: sel.fromChain, to: sel.toChain } : null,
        ts: new Date().toISOString(),
      });
      lastSavedChain = chain;
      lastSavedAt = Date.now();
    };
    hooks.livePlot.start(plan, r.pens);
    try {
      await ebb.plot(
        plan, r.pens, m.opts(),
        (p) => {
          onProgress(p);
          if (p.state === 'done') {
            clearProgress();
          } else if (p.state === 'plotting' || p.state === 'paused' || p.state === 'stopped') {
            const chain = p.chain ?? 0;
            if (chain !== lastSavedChain && (chain % 10 === 0 || Date.now() - lastSavedAt > 5000 || p.state === 'stopped')) {
              record(chain, p.chainTotal ?? 0);
              showSaved();
            }
          }
        },
        (name) => hooks.pens.find((p) => p.name === name),
        () => ({ penUpPulse: prof().ebb.penUpPulse, penDownPulse: prof().ebb.penDownPulse }),
        penIndex, undefined, startChain,
      );
    } finally {
      hooks.livePlot.end();
    }
  };

  const plotBtn = button('Plot', async () => {
    if (!ebb.connected || ebb.plotting) return;
    const r = hooks.lastResult();
    if (!r) return;
    try {
      refreshPenSelect();
      const raw = parseInt(penSelect.value, 10);
      const penIndex = raw === -1 ? undefined : Math.min(raw || 0, r.pens.length - 1);
      await runPlot(penIndex, 0);
    } catch (e) {
      showErr(e);
    }
  });
  plotBtn.className = 'plot-go';
  plotBtn.title = 'Plot on the connected machine — pen and paper, for real';
  const pauseBtn = button('Pause', () => {
    if (!ebb.plotting) return;
    if (pauseBtn.textContent === 'Pause') ebb.pause();
    else ebb.resume();
  });
  const stopBtn = button('Stop', () => void ebb.stop().catch(showErr));
  stopBtn.className = 'plot-stop';
  const frameBtn = button('Frame', async () => {
    if (!ebb.connected || ebb.plotting) return;
    const r = hooks.lastResult();
    if (!r) return;
    try {
      // Policy: frame the SELECTED ink — what this run will put on paper.
      const flat = await hooks.drawing.selectedToolpath(Math.max(0.0001, prof().machine.resolution));
      const bb = chainsBounds(flat);
      // Pen-up perimeter of the selection's bounding box, at the paper
      // offset: the placement check no model can do.
      const [ox, oy] = ebb.paperOffset;
      const legs: [number, number][] = [
        [ox + bb.x, oy + bb.y], [bb.w, 0], [0, bb.h], [-bb.w, 0], [0, -bb.h], [-(ox + bb.x), -(oy + bb.y)],
      ];
      for (const [dx, dy] of legs) await ebb.jog(dx, dy, m.opts());
    } catch (e) {
      showErr(e);
    }
  });
  frameBtn.title = 'Trace the plan’s bounding box pen-up from the paper origin — see where the piece lands before committing ink';

  const resumeBtn = button('Resume', async () => {
    if (!ebb.connected || ebb.plotting || !saved) return;
    const r = hooks.lastResult();
    if (!r) return;
    try {
      const sv = saved;
      // Identity, not heuristics: the current plan must BE the saved plan.
      const plan = hooks.drawing.plan;
      if (sv.planHash) {
        if (!plan) throw new Error('resume: render the saved sketch first');
        if (plan.planHash !== sv.planHash) {
          throw new Error(
            `resume: the current drawing is not the saved plan (hash ${plan.planHash.slice(0, 8)}… vs ${sv.planHash.slice(0, 8)}…) — ` +
            `open "${sv.sketch}" unchanged with seed ${sv.seed ?? '—'}, the same pens and paper`,
          );
        }
        const cur = hooks.drawing.selection;
        if (sv.selection && cur && (cur.fromChain !== sv.selection.from || cur.toChain !== sv.selection.to)) {
          throw new Error(`resume: the saved plot selected chains ${sv.selection.from}–${sv.selection.to}; set the Drawing panel to that range first`);
        }
      } else if (hooks.currentName() !== sv.sketch || hashSource(hooks.getSource()) !== sv.sourceHash || (hooks.currentSeed() ?? null) !== sv.seed) {
        throw new Error(`resume: load the saved sketch "${sv.sketch}" unchanged (seed ${sv.seed}) first — this record predates plan identities`);
      }
      ebb.paperOffset = [...sv.paperOffset] as [number, number];
      const penIndex = sv.penIndex === null ? undefined : sv.penIndex;
      await runPlot(penIndex, sv.chain);
    } catch (e) {
      showErr(e);
    }
  });
  resumeBtn.title = 'Carry on from the saved chain at the saved paper offset — only when the current render IS the saved plan (same hash) and the same range is selected.';
  const clearSavedBtn = button('Forget', clearProgress);
  savedBox.append(savedText, el('div', 'row', resumeBtn, clearSavedBtn));

  const connect = buildConnect(m);
  const transport = el('div', 'transport', plotBtn, pauseBtn, stopBtn, frameBtn);
  const manual = buildManualControls(m);

  body.append(
    el('div', 'plot-head', buildProfileSelect(m, hooks.profiles, false), connect.root),
    status,
    row('Pen', penSelect, 'Plots this pen only — for multi-pen sketches: plot, swap the pen, pick the next, plot again'),
    transport,
    bar,
    progressText,
    savedBox,
    el('h4', 'band-title', 'Manual control'),
    manual,
    hint('Profile, calibration and the serial log live on the Machine page.'),
  );
  refreshPenSelect();
}

// ---- export (runs in the render worker on the last rendered buffers) ----

function buildExportPanel(body: HTMLElement, hooks: PanelHooks): () => void {
  const s = hooks.settings;
  const prof = (): MachineProfile =>
    hooks.profiles.find((pp) => pp.name === s.activeProfile) ?? hooks.profiles[0];
  const persistProfile = (): void => {
    saveProfiles(hooks.profiles);
    hooks.onChanged();
  };
  // G-code export settings are part of the MACHINE PROFILE (they describe
  // the machine the file targets); rebuilt whenever the profile changes.
  const profile = sub('G-code profile');
  function renderGcodeProfile(): void {
    const m = prof().machine;
    profile.body.replaceChildren(
      row('Bed mm', pairInput(m.bedW, m.bedH, (a, b) => {
        m.bedW = a;
        m.bedH = b;
        persistProfile();
      })),
      row('Travel mm/min', numberInput(m.travelFeed, 100, (v) => {
        m.travelFeed = v;
        persistProfile();
      })),
      row('Resolution mm', numberInput(m.resolution, 0.005, (v) => {
        m.resolution = v;
        persistProfile();
      }), 'Flattening error ceiling for exported toolpaths'),
      checkbox('Pen via Z axis (off = M3/M5)', m.zMode, (v) => {
        m.zMode = v;
        persistProfile();
      }),
      checkbox('Emit G2/G3 arcs', m.arcSupport, (v) => {
        m.arcSupport = v;
        persistProfile();
      }),
    );
  }
  renderGcodeProfile();
  onProfileSwitch.push(renderGcodeProfile);

  const table = document.createElement('table');
  table.className = 'export-table';
  const svgAll = button('Download SVG (selection, all pens)', async () => {
    if (!hooks.lastResult()) return;
    const svg = await hooks.drawing.svg(hooks.settings.paperColor, -1);
    download('occlude.svg', svg, 'image/svg+xml');
  });
  svgAll.className = 'primary';
  const pngBtn = button('Download PNG (300 dpi)', async () => {
    const r = hooks.lastResult();
    if (!r) return;
    const png = await hooks.client.exportPng(r.paper.w, r.paper.h, 11.81, hooks.settings.paperColor);
    download('occlude.png', png, 'image/png');
  });
  const exportRow = document.createElement('div');
  exportRow.className = 'row';
  exportRow.append(svgAll, pngBtn);
  body.append(table, exportRow, profile.root);

  let refreshing = false;
  return function refresh(): void {
    if (refreshing) return;
    const r = hooks.lastResult();
    table.innerHTML = '';
    if (!r) return;
    refreshing = true;
    const profileJson = profileToJson(
      {
        bed: [prof().machine.bedW, prof().machine.bedH],
        travelFeed: prof().machine.travelFeed,
        zMode: prof().machine.zMode,
        arcSupport: prof().machine.arcSupport,
        resolution: prof().machine.resolution,
      },
      r.paper,
    );
    // Times come from THE ground-truth model (the EBB planner's math with
    // the CURRENT machine settings), per pen as if plotted alone, over the
    // SELECTED chains of the one plan — the same chains the G-code encodes.
    const tol = Math.max(0.0001, prof().machine.resolution);
    const planPromise = hooks.drawing.selectedToolpath(tol);
    Promise.all([hooks.drawing.gcode(profileJson), planPromise])
      .then(([json, chains]) => {
        const jobs = JSON.parse(json) as GcodeJob[];
        table.innerHTML = '';
        for (const job of jobs) {
          const pen = r.pens[job.pen];
          const frags = r.frags.filter((f) => f.pen === job.pen).length;
          const tr = table.insertRow();
          const name = tr.insertCell();
          const sw = document.createElement('span');
          sw.className = 'swatch';
          sw.style.background = pen?.color ?? '#888';
          name.append(sw, document.createTextNode(job.penName));
          const stats = tr.insertCell();
          stats.className = 'num';
          stats.textContent = `${frags} frags`;
          const time = tr.insertCell();
          time.className = 'num';
          const est = estimatePlanMs(chains.filter((c) => c.pen === job.pen), penTimingOf(r.pens, hooks.pens), machineTiming(prof()));
          const mins = est.totalMs / 60000;
          time.title = 'Plot-time estimate: the EBB planner model with current machine settings';
          time.textContent =
            mins >= 1 ? `~${mins.toFixed(1)}min` : `~${Math.ceil(est.totalMs / 1000)}s`;
          const dl = tr.insertCell();
          const gBtn = button('gcode', () =>
            download(`occlude-${job.penName}.gcode`, job.gcode),
          );
          const sBtn = button('svg', async () => {
            const svg = await hooks.drawing.svg(undefined, job.pen);
            download(`occlude-${job.penName}.svg`, svg, 'image/svg+xml');
          });
          dl.append(gBtn, document.createTextNode(' '), sBtn);
        }
      })
      .catch((e: unknown) => {
        table.innerHTML = '';
        const tr = table.insertRow();
        const td = tr.insertCell();
        td.colSpan = 4;
        td.textContent = `export failed: ${e instanceof Error ? e.message : e}`;
      })
      .finally(() => {
        refreshing = false;
      });
  };
}

// ---- small helpers ----

