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
  type GcodeJob, type PenDef, type RenderResult, type PaperDef , exportCollisions , moduleName } from 'occlude';
import { listSketches, loadSketchByName, loadStudioState, saveSketchByName, saveStudioState } from './sketchApi.js';
import {
  DEFAULT_SKETCH, NEW_SKETCH, PAPER_COLORS,
  download, loadUi, savePens, saveProfiles, saveSettings, saveUi,
  type MachineProfile, type Settings, savePapers } from './store.js';
import { serialSupported, type PlotProgress } from './ebb.js';
import { buildConnect, buildManualControls, buildProfileSelect, createSession } from './machine.js';
import {
  executionKey, machineTiming, machineTolerance, penTimingOf,
  type Corner, CORNERS, DEFAULT_CORNER, isCorner,
  type Drawing, type ExecutionSettings, type PlotRecord, type RegionBlob,
} from './drawing.js';
import { registrationMarks } from './diagnostics.js';
import { freeze } from './freeze.js';
import { dualRange } from './rangeSlider.js';
import { saveResult, selectionOf, type ResultMeta } from './resultsApi.js';
import { canonicalJson } from 'occlude';
import type { RenderDraws, RenderClient } from './workerClient.js';
import { iconButton, relabel, setIcon, withIcon } from './icons.js';
import { confirmDialog, notify } from './wa.js';
import { button, checkbox, el, hint, numberInput, pairInput, row, segmented, panel, subpanel as sub, yAxisSelect } from './widgets.js';
import { buildOptimizationPanel } from './optimizationPanel.js';

export interface PanelHooks {
  optimizationView(view: { chains: import('occlude').PlanChain[]; before?: import('occlude').PlanChain[]; after?: import('occlude').PlanChain[] } | null): void;
  isPlotting?: () => boolean;
  pens: PenDef[];
  /** The paper library (server-shared, like pens); settings.paper names one. */
  papers: PaperDef[];
  settings: Settings;
  /** Server-shared machine profiles; settings.activeProfile picks one. */
  profiles: MachineProfile[];
  onChanged(): void;
  /** Paper colour changed: repaint the sheet, don't re-render the ink. */
  onPaperColor(hex: string): void;
  /** The paper library changed (a sheet added, renamed, resized, recoloured). */
  onPapers(): void;
  /** The colour under the ink: the current result's resolved paper colour
   * (a sketch's own `paper`, or the library sheet it ran on), else the
   * panel's. */
  sheetColor(): string;
  lastResult(): RenderResult | null;
  /** The seed the current render actually used (resume checks it). */
  currentSeed(): string | null;
  client: RenderClient;
  /** THE ordered plan of the current render and the selection of it that
   * preview, exports, simulation and the machine all use. */
  drawing: Drawing;
  /** Repaint the preview's selection view (a preview-only toggle moved). */
  onSelectionView(): void;
  /** When the studio shows a frozen saved result instead of a render. */
  frozenResult(): string | null;
  /** The execution settings in force: the active profile and the pen
   * library — or, for a frozen result, the settings it was saved with. */
  execution(): ExecutionSettings;
  /** Build stamp, for saved results. */
  build: string;
  getSource(): string;
  /** Replace the editor's text as one undoable edit (a rewrite of the sketch). */
  replaceSource(source: string): void;
  /** The last render's addressed draws (address, float, value), for Freeze. */
  lastDraws(): RenderDraws | null;
  openSketch(name: string, source: string): void;
  currentName(): string;
  setName(name: string): void;
  importSketchFile(): void;
  downloadSketchFile(): void;
  /** Swap a downloaded file's bundled pen/paper definitions for the local libraries' (by name). */
  relinkUserModules(): void;
  /** A save landed: the studio uploads the finished render as the thumb. */
  afterSave(name: string): void;
  /** Live plot view: mirror the machine's progress in the preview. */
  livePlot: {
    start(plan: Float64Array, pens: PenDef[]): void;
    progress(chain: number): void;
    end(): void;
  };
  /** The registration crosshair on the preview, at the corner in the pen's colour. */
  registration: {
    show(mark: { x: number; y: number; color: string } | null): void;
  };
  /** The region brush over the preview and its blob overlay. */
  brush: {
    start(fn: (x: number, y: number, phase: 'down' | 'move' | 'up') => void): void;
    stop(): void;
    show(blobs: RegionBlob[] | null): void;
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
  const optimization = panel('Optimize path', false);
  optimization.root.classList.add('optimization-panel');
  plot.append(optimization.root);
  buildOptimizationPanel(optimization.body, hooks);
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
      notify('Names: letters, digits, spaces, - and _ (max 64).', 'warning');
      return null;
    }
    await saveSketchByName(name, hooks.getSource());
    hooks.setName(name);
    hooks.afterSave(name);
    return name;
  }
  const saveBtn = withIcon(button('Save', async () => {
    try {
      if ((await save()) === null) {
        notify('Name the sketch first — the title field in the top bar.', 'warning');
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), 'danger');
    }
  }), 'save');
  saveBtn.classList.add('primary');
  saveBtn.title = 'Save to the studio server under the title-bar name (Ctrl+S)';
  const importBtn2 = withIcon(button('Import', hooks.importSketchFile), 'import');
  importBtn2.title = 'Load a .ts sketch file into the editor';
  const dlBtn = withIcon(button('Download', hooks.downloadSketchFile), 'download');
  const relinkBtn = withIcon(button('Relink', hooks.relinkUserModules), 'import');
  relinkBtn.title = 'A downloaded sketch carries its pens and papers inline; Relink swaps them for your libraries\' entries of the same names';
  dlBtn.title = 'Download the current sketch as a .ts file';
  const newBtn = withIcon(button('New', async () => {
    // Losing work needs a prompt; losing nothing shouldn't. Named sketches
    // are dirty when the editor drifted from the server copy; unnamed ones
    // when they aren't just a pristine starter.
    const src = hooks.getSource();
    const name = hooks.currentName().trim();
    const dirty = name
      ? await loadSketchByName(name).then((saved) => saved !== src, () => true)
      : src !== DEFAULT_SKETCH && src !== NEW_SKETCH;
    if (dirty && !(await confirmDialog({ title: 'New sketch', body: 'Replace the editor with a fresh sketch? Unsaved changes are lost.', confirm: 'Replace', danger: true }))) {
      return;
    }
    hooks.openSketch('', NEW_SKETCH);
  }), 'new');
  newBtn.title = 'Start a fresh sketch — name it in the top bar, then Save';
  actionRow.className = 'row grid2';
  actionRow.append(newBtn, saveBtn, importBtn2, dlBtn, relinkBtn);

  // Freeze: write the last render's drawn values back as literals, so an
  // evolved drawing becomes numbers you can edit. A draw that ran more
  // than once has no single value and stays a draw; the seed (with any
  // overrides those still need) is pinned in the sketch's options.
  const freezeBtn = withIcon(button('Freeze', () => {
    const draws = hooks.lastDraws();
    const seed = hooks.currentSeed();
    if (!draws || seed === null) { notify('Render the sketch first — Freeze writes back the values of the last render.', 'warning'); return; }
    const { source, frozen, kept } = freeze(hooks.getSource(), draws, seed);
    hooks.replaceSource(source);
    if (kept) notify(`${frozen} draw${frozen === 1 ? '' : 's'} written as literals; ${kept} site${kept === 1 ? '' : 's'} run more than once and stay draws — the seed is pinned in the sketch options so the drawing is unchanged.`, 'brand', 9000);
  }), 'freeze');
  freezeBtn.title = 'Replace each once-run random call with the value it drew in the last render, and pin the seed in the sketch options. Ctrl+Z undoes it.';
  const freezeRow = el('div', 'row', freezeBtn);

  const hint = document.createElement('div');
  hint.className = 'panel-hint';
  const link = document.createElement('a');
  link.href = '/sketches.html';
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Sketches page';
  hint.append('Saved on the studio server — browse, fork and snapshot on the ', link, '.');

  body.append(actionRow, freezeRow, hint);
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

function buildPensPanel(body: HTMLElement, hooks: PanelHooks): void {
  let selected: number | null = null;

  const list = document.createElement('div');
  const editHost = document.createElement('div');
  const actions = document.createElement('div');
  actions.className = 'row';

  const addBtn = withIcon(button('Add pen', () => {
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
  }), 'new');
  const importBtn = withIcon(button('Import', () => {
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
        notify(`Pen import failed: ${e instanceof Error ? e.message : e}`, 'danger');
      }
    };
    input.click();
  }), 'import');
  const exportBtn = withIcon(button('Export', () => {
    download('pens.json', JSON.stringify(hooks.pens, null, 2), 'application/json');
  }), 'export');
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
        if (key === 'name') {
          const name = String(v).trim();
          if (!name) { input.value = pen.name; return; }
          const clash = exportCollisions(hooks.pens.filter((p) => p !== pen), name);
          if (hooks.pens.some((p) => p !== pen && p.name === name) || clash.length) {
            notify(`A pen named ${name} exists${clash.length ? ` (or exports as the same @user/pens name: ${clash.join(', ')})` : ''}`, 'danger');
            input.value = pen.name;
            return;
          }
          const from = pen.name;
          pen.name = name;
          persist();
          renderList();
          void reportRenamedReferences('pen', from, name);
          return;
        }
        (pen as unknown as Record<string, string | number>)[key] = v;
        persist();
        renderList();
      };
      form.append(l, input);
    }
    const del = withIcon(button('Delete pen', () => {
      hooks.pens.splice(selected!, 1);
      selected = null;
      persist();
      renderList();
    }), 'trash');
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
      // The pen as a line: its colour, its width (exaggerated a little so
      // a 0.2 and a 0.8 read apart at this size).
      const line = document.createElement('span');
      line.className = 'pen-line';
      line.style.setProperty('--pen-color', pen.color);
      line.style.setProperty('--pen-w', String(pen.width));
      row.append(name, line, meta);
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

/** After a library rename: which stored sketches still name the old entry
 * (by pen name, or by its `@user/*` export). References are reported, never
 * rewritten — a sketch is a program of its author's, and the old name keeps
 * failing loudly where it is used. */
async function reportRenamedReferences(kind: 'pen' | 'paper', from: string, to: string): Promise<void> {
  try {
    const names = (await listSketches()).map((s) => s.name);
    const byName = new RegExp(`['"\`]${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`);
    const byExport = new RegExp(`\\b${moduleName(from)}\\b`);
    const hits: string[] = [];
    for (const name of names) {
      const src = await loadSketchByName(name).catch(() => '');
      if (byName.test(src) || byExport.test(src)) hits.push(name);
    }
    if (hits.length) notify(`${kind} '${from}' is now '${to}' — ${hits.length} stored sketch${hits.length === 1 ? '' : 'es'} still name the old one: ${hits.slice(0, 6).join(', ')}${hits.length > 6 ? ', …' : ''}`, 'warning');
  } catch {
    // the store is unreachable: nothing to report
  }
}

// ---- paper & machine ----

function buildPaperPanel(body: HTMLElement, hooks: PanelHooks): void {
  const s = hooks.settings;
  const papers = hooks.papers;
  const persist = (): void => {
    saveSettings(s);
    hooks.onChanged();
  };
  const persistLibrary = (): void => {
    savePapers(papers);
    hooks.onPapers();
  };
  const current = (): PaperDef => papers.find((p) => p.name === s.paper) ?? papers[0];

  // The sheet: one of the library's papers. The library is edited right
  // here — a sheet is a named size and a stock colour, and every run
  // captures the library, so `@user/papers` offers exactly these.
  const paperSel = document.createElement('select');
  const syncSelect = (): void => {
    paperSel.replaceChildren(...papers.map((p) => new Option(p.name, p.name)));
    paperSel.value = current().name;
  };
  syncSelect();

  // Size: inputs display in the chosen unit (remembered), storage is mm.
  const MM_PER_IN = 25.4;
  const toUnit = (mm: number): number => (s.paperUnit === 'in' ? mm / MM_PER_IN : mm);
  // inches resolve to whole micrometres, so 8.5 in is 215.9 mm, not 215.89999999999998
  const fromUnit = (v: number): number => (s.paperUnit === 'in' ? Math.round(v * MM_PER_IN * 1e6) / 1e6 : v);
  const fmt = (mm: number): string =>
    s.paperUnit === 'in' ? String(+toUnit(mm).toFixed(3)) : String(+mm.toFixed(1));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.title = 'The sheet\'s name in the library — what a sketch imports from @user/papers';
  const cw = document.createElement('input');
  const ch = document.createElement('input');
  for (const el of [cw, ch]) {
    el.type = 'number';
    el.step = 'any';
    el.style.width = '4.5em';
  }
  const unitSel = document.createElement('select');
  for (const u of ['mm', 'in']) unitSel.append(new Option(u, u));
  unitSel.value = s.paperUnit;
  const syncSize = (): void => {
    const p = current();
    nameInput.value = p.name;
    cw.value = fmt(p.w);
    ch.value = fmt(p.h);
  };
  syncSize();
  const readSize = (): void => {
    const w = fromUnit(parseFloat(cw.value));
    const h = fromUnit(parseFloat(ch.value));
    if (Number.isFinite(w) && w > 10 && Number.isFinite(h) && h > 10) {
      const p = current();
      p.w = Math.min(w, 5000);
      p.h = Math.min(h, 5000);
      persistLibrary();
      persist();
    }
    syncSize();
  };
  cw.onchange = readSize;
  ch.onchange = readSize;
  unitSel.onchange = () => {
    s.paperUnit = unitSel.value as 'mm' | 'in';
    saveSettings(s);
    syncSize();
  };
  nameInput.onchange = () => {
    const name = nameInput.value.trim();
    const p = current();
    if (!name || name === p.name) { syncSize(); return; }
    const clash = exportCollisions(papers.filter((q) => q !== p), name);
    if (papers.some((q) => q.name === name) || clash.length) {
      notify(`A paper named ${name} exists${clash.length ? ` (or exports as the same @user/papers name: ${clash.join(', ')})` : ''}`, 'danger');
      syncSize();
      return;
    }
    const from = p.name;
    p.name = name;
    s.paper = name;
    persistLibrary();
    persist();
    syncSelect();
    void reportRenamedReferences('paper', from, name);
  };
  const sizeWrap = document.createElement('div');
  sizeWrap.className = 'row';
  const times = document.createElement('span');
  times.textContent = '\u00d7';
  sizeWrap.append(cw, times, ch, unitSel);

  // Paper colour: the stock's, kept in the library with the sheet. What
  // the preview and both exports paint under the ink; changing it never
  // re-renders — the ink is identical, the sheet is not.
  const colorSel = document.createElement('select');
  for (const name of [...PAPER_COLORS.map((c) => c.name), 'Custom']) colorSel.append(new Option(name, name));
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.style.flex = '0 0 3.2em';
  colorInput.title = 'The sheet colour, exactly — saved with the paper';
  const syncColor = (): void => {
    const hex = current().color ?? s.paperColor;
    colorInput.value = hex;
    colorSel.value = PAPER_COLORS.find((c) => c.hex === hex)?.name ?? 'Custom';
  };
  const applyColor = (hex: string): void => {
    current().color = hex;
    s.paperColor = hex;
    saveSettings(s);
    persistLibrary();
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

  const choose = (name: string): void => {
    s.paper = name;
    s.paperColor = current().color ?? s.paperColor;
    saveSettings(s);
    hooks.onPaperColor(s.paperColor);
    syncSelect();
    syncSize();
    syncColor();
    hooks.onChanged();
  };
  paperSel.onchange = () => choose(paperSel.value);
  syncColor();

  const addBtn = withIcon(button('Add paper', () => {
    const base = current();
    let name = `${base.name}-copy`;
    for (let k = 2; papers.some((p) => p.name === name) || exportCollisions(papers, name).length; k++) name = `${base.name}-copy-${k}`;
    papers.push({ name, w: base.w, h: base.h, color: base.color });
    persistLibrary();
    choose(name);
  }), 'new');
  addBtn.title = 'A new sheet in the library, copied from this one — rename and resize it';
  const delBtn = withIcon(button('Delete', () => {
    if (papers.length < 2) { notify('The library keeps at least one paper', 'danger'); return; }
    const i = papers.findIndex((p) => p.name === s.paper);
    papers.splice(i < 0 ? 0 : i, 1);
    persistLibrary();
    choose(papers[Math.max(0, Math.min(i, papers.length - 1))].name);
  }), 'trash');
  delBtn.title = 'Remove this sheet from the library';
  const actions = document.createElement('div');
  actions.className = 'row';
  actions.append(addBtn, delBtn);

  const landscape = checkbox('Landscape', s.landscape, (v) => {
    s.landscape = v;
    persist();
  });

  const marginInput = numberInput(s.defaultMarginPct, 0.5, (v) => {
    s.defaultMarginPct = v;
    persist();
  });

  body.append(
    row('Paper', paperSel),
    row('Name', nameInput, 'The library name: import { a4 } from \'@user/papers\' in a sketch'),
    row('Size', sizeWrap),
    row('Color', colorWrap, 'The stock you are plotting on — preview and exports both use it; saved with the paper'),
    actions,
    landscape,
    row('Margin %', marginInput, 'Used when the sketch does not set a margin'),
  );
}

// ---- the ordered drawing: choose a prefix or interval of the plan ----

/** djb2 of the source — provenance only, never an identity for a plan. */
const hashSource = (src: string): string => {
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h * 33) ^ src.charCodeAt(i)) >>> 0;
  return h.toString(16);
};

const fmtMin = (ms: number): string => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.ceil(ms / 1000)} s`);

function buildDrawingPanel(body: HTMLElement, hooks: PanelHooks): void {
  const d = hooks.drawing;
  const readout = document.createElement('div');
  readout.className = 'panel-hint drawing-readout';
  const omitted = checkbox('Ghost the omitted ink (preview only)', d.showOmitted, (v) => { d.showOmitted = v; hooks.onSelectionView(); });
  const refresh = (): void => {
    const plan = d.plan;
    const r = d.current;
    if (!plan || !r) {
      readout.textContent = 'render a sketch to see its plan';
      return;
    }
    const n = plan.chains.length;
    const final = r.final;
    const parts: string[] = [];
    const req = r.request;
    const asked = req.chains ? `chains ${req.chains[0]}–${req.chains[1]}` : req.progress ? `${Math.round(req.progress[0] * 100)}–${Math.round(req.progress[1] * 100)}% of chains` : req.minutes ? `${req.minutes[0]}–${req.minutes[1]} min` : 'the whole plan';
    parts.push(`t.draw: ${asked}${req.budget !== undefined ? `, budget ${req.budget} min` : ''}`);
    parts.push(`chains ${final.fromChain}–${final.toChain} of ${n} (${final.count} selected)`);
    if (r.effective) parts.push(`effective ${fmtMin(r.effective.fromMs)}–${fmtMin(r.effective.toMs)}`);
    if (r.estimate) parts.push(`standalone ETA ${fmtMin(r.estimate.totalMs)}` + (final.count < n && r.fullMs !== undefined ? ` (full plan ${fmtMin(r.fullMs)})` : ''));
    if (r.fit) parts.push(r.fit.dropped > 0 ? `budget: ${r.fit.dropped} chains dropped, ${fmtMin(r.fit.unusedMs)} unused` : `budget: fits, ${fmtMin(r.fit.unusedMs)} unused`);
    parts.push(`path: tour ${plan.settings.tourBudget.toLocaleString()}, bridge ${plan.settings.bridgeGapMm.map((g) => g.toFixed(2)).join('/')} mm`);
    readout.textContent = parts.join(' · ');
  };
  d.onChange(refresh);
  refresh();

  // Save the chosen result: the SELECTED chains as a plan of their own
  // (exact bytes), the frozen SVG of that selection, and every setting
  // needed to read it back — published only when all of it is written.
  const saveNote = document.createElement('div');
  saveNote.className = 'panel-hint';
  const saveBtn = withIcon(button('Save result', async () => {
    const plan = d.plan;
    const r = d.current;
    const result = hooks.lastResult();
    if (!plan || !r || !result) return;
    saveBtn.disabled = true;
    const paperColor = result.paper.color ?? hooks.sheetColor();
    const capturedExecution = hooks.execution();
    try {
      // ONE consistent result: `plan` and `r` are captured now; every await
      // below re-checks that no newer render replaced them, and the SVG is
      // asked for by this plan's hash and range (the worker refuses a stale
      // hash), so a save can never mix two renders.
      const final = r.final;
      const captured = { planHash: plan.planHash, from: final.fromChain, to: final.toChain };
      const { encodePlanBuffer, hashPlan } = await import('occlude');
      const chains = plan.chains.slice(final.fromChain, final.toChain);
      const bytes = encodePlanBuffer(chains);
      const savedHash = await hashPlan(bytes, plan.settings);
      const drifted = () => d.plan !== plan;
      if (drifted()) throw new Error('the drawing changed while saving — nothing was saved; save again');
      const three = await hooks.client.captureThree(plan.planHash);
      if (drifted()) throw new Error('the drawing changed while saving — nothing was saved; save again');
      const meta: ResultMeta = {
        three,
        schemaVersion: plan.schemaVersion,
        planHash: savedHash,
        sourcePlanHash: plan.planHash,
        selection: selectionOf(final),
        request: r.request,
        settings: plan.settings,
        pens: result.pens.map((pen) => ({ name: pen.name, width: pen.width, color: pen.color, feed: pen.feed, penDown: pen.penDown, penUp: pen.penUp, penDelay: pen.penDelay })),
        // the resolved sheet, colour included: reopening the result shows and exports it as saved
        paper: { w: result.paper.w, h: result.paper.h, color: paperColor },
        profile: { name: capturedExecution.profile, timing: capturedExecution.timing, tolerance: capturedExecution.tolerance },
        eta: { standaloneMs: r.estimate?.totalMs ?? 0, fullMs: r.fullMs ?? 0 },
        build: hooks.build,
        provenance: { sketch: hooks.currentName() || null, sourceHash: hashSource(hooks.getSource()), seed: hooks.currentSeed() },
        fullPlanSaved: false,
      };
      const svg = await d.svgOf(captured, paperColor, -1);
      if (drifted()) throw new Error('the drawing changed while saving — nothing was saved; save again');
      const id = await saveResult(meta, svg, bytes);
      saveNote.innerHTML = '';
      const link = document.createElement('a');
      link.href = `/results.html#${id}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = id;
      saveNote.append(`saved result `, link, ` — ${final.count} chains, ${fmtMin(r.estimate?.totalMs ?? 0)}`);
    } catch (e) {
      saveNote.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      saveBtn.disabled = false;
    }
  }), 'save');
  saveBtn.classList.add('primary');
  saveBtn.title = 'Keep exactly this selection as resolved output — plan bytes, SVG and settings — so it can be shown, exported and plotted later without running the sketch';
  const resultsLink = document.createElement('a');
  resultsLink.href = '/results.html';
  resultsLink.target = '_blank';
  resultsLink.rel = 'noopener';
  resultsLink.textContent = 'Results page';
  const saveRow = el('div', 'row', saveBtn, resultsLink);

  readout.title = 'The range is code: t.draw({ progress: [0, ui(0.3)] }) — or chains / minutes, with a budget — and t.plan({ optimize, bridge }) for the path. Nothing is re-solved, reordered or re-bridged by selecting, and ink hidden by later shapes stays hidden. Export, Simulate and Plot all draw exactly this.';
  body.append(
    readout,
    omitted,
    saveRow,
    saveNote,
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
  const dr = () => m.driver();
  hooks.isPlotting = () => dr().plotting;
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
    const color = pen ? pen.color : null;
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
    const mm = `${Math.round(p.drawnMm).toLocaleString()} / ${Math.round(p.drawMm).toLocaleString()} mm`;
    const reink = p.reinkInMm !== undefined ? ` · re-ink in ${Math.round(p.reinkInMm).toLocaleString()} mm` : '';
    const base =
      p.state === 'done'
        ? `done · ${mm}`
        : p.state === 'stopped'
          ? `stopped · ${mm}`
          : `${p.state} · ${p.penName} · ${eta.toFixed(1)} min left · ${mm}${reink}`;
    progressText.textContent = p.warning ? `${base} · ⚠ ${p.warning}` : base;
    setIcon(pauseBtn, p.state === 'paused' ? 'play' : 'pause', p.state === 'paused' ? 'Resume' : 'Pause');
    body.classList.toggle('plotting', p.state === 'plotting' || p.state === 'paused');
  }

  /** The plan for the current render at a pen selection (undefined = all),
   * with the bed-fit check. Shared by Plot and Resume. */
  const buildPlan = async (r: RenderResult, penIndex: number | undefined): Promise<Float64Array | null> => {
    const tol = machineTolerance(prof(), penIndex === undefined ? r.pens : [r.pens[penIndex] ?? r.pens[0]]);
    // The SELECTED chains of the plan, source indices kept; the driver's
    // pen filter is an execution filter over that same sequence.
    const flat = await hooks.drawing.plotToolpath(tol);
    executed = penIndex === undefined ? flat : flat.filter((c) => c.pen === penIndex);
    const plan = encodeToolpath(flat);
    const bb = chainsBounds(executed);
    const bed = prof().machine;
    const [ox, oy] = dr().paperOffset;
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

  // Saved progress: which plan, which selection of it, the frame, and the
  // chain the machine reached — after a stop, a crashed tab, or a power loss.
  type SavedPlot = PlotRecord;
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
    const range = saved.repair?.region
      ? `a painted region (${saved.executed?.split(':')[0] ?? '?'} chains)`
      : saved.selection ? `chains ${saved.selection.from}–${saved.selection.to} of the plan` : 'the whole plan';
    const from = saved.resultId ? ` (saved result ${saved.resultId})` : '';
    savedText.textContent =
      `Unfinished: ${saved.sketch}${from}, ${pen}, ${range}, executed chain ${saved.chain} of ${saved.chainTotal}` +
      (saved.sourceChain !== null ? ` (plan row ${saved.sourceChain})` : '') +
      (saved.registration
        ? `, registered at (${saved.registration[0]}, ${saved.registration[1]}). After a power loss, stand the tip on the drawn mark and press Draw registration first.`
        : `, paper at ${saved.paperOffset[0]}, ${saved.paperOffset[1]} mm. After a power loss, re-park at the bed corner and Set bed origin first.`);
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
    const record = (chain: number, chainTotal: number): void => {
      putProgress({
        sketch: hooks.currentName(),
        sourceHash: hashSource(hooks.getSource()),
        seed: hooks.currentSeed(),
        penIndex: penIndex ?? null,
        paperOffset: [...dr().paperOffset] as [number, number],
        chain, chainTotal,
        sourceChain: executed[chain]?.index ?? null,
        ...hooks.drawing.recordFields(),
        resultId: hooks.frozenResult(),
        execution: hooks.execution(),
        ts: new Date().toISOString(),
      });
      lastSavedChain = chain;
      lastSavedAt = Date.now();
    };
    // The live view walks what the machine executes: the driver reports
    // chain indices into the pen-filtered list, so with a pen selected the
    // view must be built from that list, not the whole plan, or it follows
    // the other pen's chains.
    hooks.livePlot.start(encodeToolpath(executed), r.pens);
    try {
      await dr().plot(
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
        (name) => r.pens.find((p) => p.name === name),
        () => ({ penUpPulse: prof().ebb.penUpPulse, penDownPulse: prof().ebb.penDownPulse }),
        penIndex, undefined, startChain,
      );
    } finally {
      hooks.livePlot.end();
    }
  };

  const plotBtn = iconButton('play', 'Plot', async () => {
    if (!dr().connected || dr().plotting) return;
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
  plotBtn.classList.add('plot-go');
  plotBtn.title = 'Plot on the connected machine — pen and paper, for real';
  const pauseBtn = iconButton('pause', 'Pause', () => {
    if (!dr().plotting) return;
    if (pauseBtn.title === 'Pause') dr().pause();
    else dr().resume();
  });
  const stopBtn = iconButton('stop', 'Stop', () => void dr().stop().catch(showErr));
  stopBtn.className = 'plot-stop';
  const frameBtn = iconButton('frame', 'Frame — trace the drawable outline pen-up', async () => {
    if (!dr().connected || dr().plotting) return;
    const r = hooks.lastResult();
    if (!r) return;
    try {
      // Policy: frame the SELECTED ink — what this run will put on paper.
      const flat = await hooks.drawing.plotToolpath(Math.max(0.0001, prof().machine.resolution));
      const bb = chainsBounds(flat);
      // Pen-up perimeter of the selection's bounding box, at the paper
      // offset: the placement check no model can do. Bed positions, walked
      // from wherever the head stands (the bed origin, or a registration
      // mark) and back there.
      const [ox, oy] = dr().paperOffset;
      const start = dr().bedPosition(m.opts());
      const x0 = ox + bb.x, y0 = oy + bb.y;
      const stops: [number, number][] = [[x0, y0], [x0 + bb.w, y0], [x0 + bb.w, y0 + bb.h], [x0, y0 + bb.h], [x0, y0], start];
      let at = start;
      for (const p of stops) { await dr().jog(p[0] - at[0], p[1] - at[1], m.opts()); at = p; }
    } catch (e) {
      showErr(e);
    }
  });
  frameBtn.title = 'Frame — trace the plan’s bounding box pen-up in the current frame (paper origin or registration) — see where the piece lands before committing ink';
  // Registration corners: a right angle at the sheet's top-left and another
  // at its bottom-right, drawn with the selected pen. Between pens: marks,
  // tape, swap, marks again — the brackets coincide iff the new pen sits
  // where the old one did, and the pair traces the sheet's bounds.
  const marksBtn = iconButton('marks', 'Marks — draw a right angle at the sheet’s top-left and bottom-right', async () => {
    if (!dr().connected || dr().plotting) return;
    const r = hooks.lastResult();
    if (!r) return;
    try {
      // The sheet in paper mm: the diagnostic is plotted with the paper offset,
      // so (0,0) is the sheet's own corner.
      const bb = { x: 0, y: 0, w: r.paper.w, h: r.paper.h };
      const raw = parseInt(penSelect.value, 10);
      const chosen = raw >= 0 ? r.pens[raw] : r.pens[0];
      const pen = chosen ?? undefined;
      const d = registrationMarks(pen, bb);
      await dr().plot(d.plan, d.pens, m.opts(), onProgress);
    } catch (e) {
      showErr(e);
    }
  });
  marksBtn.title = 'Marks — draw a right angle at the sheet’s top-left and bottom-right with the selected pen, the legs running inward so the pair traces the sheet’s bounds. Before a pen change: marks, tape over them, swap pens, marks again — line the brackets up and the pens are registered.';

  const resumeBtn = button('Resume', async () => {
    if (!dr().connected || dr().plotting || !saved) return;
    const r = hooks.lastResult();
    if (!r) return;
    try {
      const sv = saved;
      // Identity, not heuristics: the current plan must BE the saved plan.
      const plan = hooks.drawing.plan;
      if (sv.planHash) {
        if (sv.resultId && plan?.planHash !== sv.planHash) {
          // The plot ran from saved bytes: load those, not the source.
          location.href = `/?result=${encodeURIComponent(sv.resultId)}`;
          return;
        }
        if (!plan) throw new Error('resume: render the saved sketch first');
        if (plan.planHash !== sv.planHash) {
          throw new Error(
            `resume: the current drawing is not the saved plan (hash ${plan.planHash.slice(0, 8)}… vs ${sv.planHash.slice(0, 8)}…) — ` +
            `open "${sv.sketch}" unchanged with seed ${sv.seed ?? '—'}, the same pens and paper`,
          );
        }
        await hooks.drawing.settled();
        if (sv.repair) hooks.drawing.setRepairs(sv.repair.minutes, sv.repair.region);
        if (sv.executed) {
          const now = hooks.drawing.plotFingerprint();
          if (now !== sv.executed) {
            throw new Error(`resume: the saved plot executed ${sv.executed.split(':')[0]} chains; the same sketch, repairs and t.draw now give ${now?.split(':')[0] ?? '?'} — the plan or the selection changed`);
          }
        } else {
          const cur = hooks.drawing.plotSelection!;
          if (sv.selection && (cur.fromChain !== sv.selection.from || cur.toChain !== sv.selection.to)) {
            throw new Error(`resume: the saved plot drew chains ${sv.selection.from}–${sv.selection.to}; the sketch's t.draw now resolves to ${cur.fromChain}–${cur.toChain}`);
          }
        }
        // Execution identity too: the same geometry under other timing,
        // tolerance or pen settle is a different plot.
        if (sv.execution && executionKey(sv.execution) !== executionKey(hooks.execution())) {
          const now = hooks.execution();
          const diffs: string[] = [];
          if (sv.execution.profile !== now.profile) diffs.push(`profile ${sv.execution.profile} → ${now.profile}`);
          if (sv.execution.tolerance !== now.tolerance) diffs.push(`tolerance ${sv.execution.tolerance} → ${now.tolerance}`);
          if (canonicalJson(sv.execution.timing) !== canonicalJson(now.timing)) diffs.push('machine timing');
          if (canonicalJson(sv.execution.pens) !== canonicalJson(now.pens)) diffs.push('pen feed/settle');
          throw new Error(`resume: execution settings changed since the plot (${diffs.join(', ') || 'settings'}) — restore them, or start a new plot`);
        }
      } else if (hooks.currentName() !== sv.sketch || hashSource(hooks.getSource()) !== sv.sourceHash || (hooks.currentSeed() ?? null) !== sv.seed) {
        throw new Error(`resume: load the saved sketch "${sv.sketch}" unchanged (seed ${sv.seed}) first — this record predates plan identities`);
      }
      // The frame too: a plot registered at a mark resumes only from that mark.
      hooks.drawing.checkRegistration(sv);
      dr().paperOffset = [...sv.paperOffset] as [number, number];
      m.frameChanged();
      const penIndex = sv.penIndex === null ? undefined : sv.penIndex;
      await runPlot(penIndex, sv.chain);
    } catch (e) {
      showErr(e);
    }
  });
  resumeBtn.title = 'Carry on from the saved chain at the saved paper offset — only when the current render IS the saved plan (same hash), the same range is selected, and the sketch is registered where the plot was.';
  const clearSavedBtn = button('Forget', clearProgress);
  savedBox.append(savedText, el('div', 'row', resumeBtn, clearSavedBtn));

  // Registration: a point on the sheet a pen tip can be put on by hand.
  // Mark it on the preview, draw it on scrap with the current pen, and later
  // (a pen change, a resume, the next day) stand the tip on the drawn mark
  // and declare it: every pass lines up on it. The point is studio state on
  // the sketch, saved with its name, never source.
  const d = hooks.drawing;
  const regText = hint('');
  const selectedPen = (): PenDef | undefined => {
    const pens = hooks.lastResult()?.pens ?? [];
    const raw = parseInt(penSelect.value, 10);
    return (raw >= 0 ? pens[raw] : undefined) ?? pens[0];
  };
  const cornerName = (c: Corner): string => c.replace('-', ' ');
  const showRegistration = (): void => {
    const p = d.registration;
    hooks.registration.show(p ? { x: p[0], y: p[1], color: selectedPen()?.color ?? '#000' } : null);
    cornerSel.value = d.registrationCorner;
    const here = dr().registeredAt;
    regText.textContent = !p
      ? 'Registration: render the sketch first — the mark goes at a corner of its sheet.'
      : `Registration at the ${cornerName(d.registrationCorner)} corner, (${p[0]}, ${p[1]}) mm` +
        (here && here[0] === p[0] && here[1] === p[1] ? ' · the machine stands in this frame' : '');
  };
  // One corner per sketch, loaded when a render of another sketch lands.
  let regFor: string | null = null;
  const followSketch = (): void => {
    const name = hooks.currentName();
    if (name === regFor) return;
    regFor = name;
    d.setRegistrationCorner(DEFAULT_CORNER);
    if (!name) return;
    void loadStudioState(name)
      .then((st) => { if (regFor === name) d.setRegistrationCorner(isCorner(st.registration) ? st.registration : DEFAULT_CORNER); })
      .catch(showErr);
  };
  d.onRegistrationChange(showRegistration);
  d.onChange(() => { followSketch(); showRegistration(); });
  penSelect.addEventListener('change', showRegistration);
  const cornerSel = document.createElement('select');
  for (const c of CORNERS) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = cornerName(c);
    cornerSel.append(opt);
  }
  cornerSel.value = DEFAULT_CORNER;
  cornerSel.title = 'The corner of the sheet the registration mark is drawn at; kept with the sketch.';
  cornerSel.addEventListener('change', () => {
    const corner = cornerSel.value;
    if (!isCorner(corner)) return;
    d.setRegistrationCorner(corner);
    const name = hooks.currentName();
    if (name) void saveStudioState(name, { registration: corner }).catch(showErr);
  });
  const drawRegBtn = button('Draw registration', async () => {
    if (!dr().connected || dr().plotting) return;
    try {
      const pen = selectedPen();
      if (!pen) throw new Error('draw registration: render the sketch first');
      const p = d.registration;
      if (!p) throw new Error('draw registration: render the sketch first — the mark goes at a corner of its sheet');
      await dr().drawRegistration(p, pen, m.opts());
      m.frameChanged();
      showRegistration();
    } catch (e) {
      showErr(e);
    }
  });
  drawRegBtn.title = 'Stand the tip where the sheet’s corner goes (or on a drawn mark), then press: the machine is here, at the corner. It draws the mark around the tip with the selected pen (a 25 mm circle, a cross, a tick toward +x), lifts, and returns over the point. Plot, Frame, Marks and Resume then run from it.';
  const registrationBox = el('div', 'registration',
    el('div', 'row', cornerSel, drawRegBtn),
    regText,
  );

  const connect = buildConnect(m);
  const transport = el('div', 'transport', plotBtn, pauseBtn, stopBtn, frameBtn, marksBtn);
  const manual = buildManualControls(m);

  // Plot only: a repair interval on the plan's timeline. Studio state, not
  // the sketch's: it narrows what Plot, Frame and Marks run and what the
  // preview keeps in ink, and is recorded with the plot's progress.
  const repairText = hint('');
  const fmtMinutes = (min: number): string => (min >= 10 ? min.toFixed(1) : min.toFixed(2));
  const slider = dualRange({
    min: 0, max: 1, step: 0.01, from: 0, to: 1,
    onInput: (a, b) => d.setRepair([a, b]),
  });
  const fromIn = numberInput(0, 0.1, (v) => { const [, b] = slider.get(); d.setRepair([Math.max(0, v), Math.max(v, b)]); });
  const toIn = numberInput(0, 0.1, (v) => { const [a] = slider.get(); d.setRepair([Math.min(a, v), v]); });
  fromIn.title = 'Start of the repair, minutes into the plot';
  toIn.title = 'End of the repair, minutes into the plot';
  const clearRepair = button('Whole plan', () => { paintOff(); d.setRepairs(null, null); });
  clearRepair.className = 'danger-quiet';
  clearRepair.title = 'Drop the interval and the painted region: plot everything selected';
  slider.root.title = 'Drag the handles to plot only an interval of the plan, in minutes — a dried pen, a faint patch. Exports still draw the whole selection.';
  // Region: paint blobs over the preview; chains with ink under any blob
  // are in. Painting is additive; Clear region starts over.
  let radius = 8;
  const radiusIn = numberInput(radius, 1, (v) => { radius = Math.max(0.5, v); });
  radiusIn.title = 'Brush radius, mm';
  radiusIn.setAttribute('aria-label', 'Brush radius, mm');
  const paintBtn: HTMLButtonElement = withIcon(button('Paint region', () => (paintBtn.classList.contains('armed') ? paintOff() : paintOn())), 'brush');
  paintBtn.title = 'Circle-select over the preview: drag to paint the patch to redo. Wheel still zooms; pan with the right button or after Done.';
  const clearRegion = button('Clear region', () => { d.setRegion(null); });
  clearRegion.className = 'danger-quiet';
  let blobs: RegionBlob[] = [];
  const paintOn = (): void => {
    blobs = d.region ? [...d.region] : [];
    paintBtn.classList.add('armed');
    relabel(paintBtn, 'Done painting');
    hooks.brush.start((x, y, phase) => {
      const last = blobs[blobs.length - 1];
      const apart = !last || Math.hypot(x - last.x, y - last.y) >= radius / 3;
      if (phase === 'down' || apart) {
        blobs.push({ x, y, r: radius });
        hooks.brush.show(blobs);
      }
      if (phase === 'up') d.setRegion(blobs); // commit the stroke, close or not
    });
  };
  const paintOff = (): void => {
    paintBtn.classList.remove('armed');
    relabel(paintBtn, 'Paint region');
    hooks.brush.stop();
    if (blobs.length) d.setRegion(blobs);
  };
  const repairLabel = el('label', undefined, 'Plot only');
  repairLabel.title = 'Narrows what Plot, Frame and Marks run and what the preview keeps in ink. Studio state, not the sketch: exports still draw the whole selection.';
  const repairBox = el('div', 'repair',
    el('div', 'row', repairLabel, slider.root),
    el('div', 'row', fromIn, el('span', 'repair-dash', 'to'), toIn, el('span', 'repair-dash', 'min')),
    el('div', 'row', paintBtn, radiusIn, el('span', 'repair-dash', 'mm')),
    el('div', 'row grid2', clearRepair, clearRegion),
    repairText,
  );
  const showRepair = (): void => {
    const total = (d.current?.fullMs ?? 0) / 60000;
    slider.setMax(Math.max(0.01, +total.toFixed(2)));
    const info = d.repairInfo();
    hooks.brush.show(d.region);
    const idx = d.plotIndices();
    const region = d.region ? ` · region of ${d.region.length} dabs` : '';
    if (!d.repair || !info) {
      slider.set(0, total);
      fromIn.value = '0';
      toIn.value = fmtMinutes(total);
      repairText.textContent = d.region && idx
        ? `${idx.length.toLocaleString()} chains under the region${region}`
        : total > 0 ? `Whole plan · ${fmtMinutes(total)} min` : '';
      repairBox.classList.toggle('active', !!d.region);
      return;
    }
    const [a, b] = d.repair;
    slider.set(Math.min(a, total), Math.min(b, total));
    fromIn.value = fmtMinutes(a);
    toIn.value = fmtMinutes(b);
    repairText.textContent = `${(idx?.length ?? info.count).toLocaleString()} chains · rows ${info.fromChain}–${info.toChain} · ${fmtMinutes(a)}–${fmtMinutes(Math.min(b, total))} of ${fmtMinutes(total)} min${region}`;
    repairText.title = 'Exports still draw the whole selection.';
    repairBox.classList.add('active');
  };
  d.onRepairChange(() => { showRepair(); hooks.onSelectionView(); });
  d.onChange(showRepair);
  showRepair();

  body.append(
    el('div', 'plot-head', buildProfileSelect(m, hooks.profiles, false), connect.root),
    status,
    row('Pen', penSelect, 'Plots this pen only — for multi-pen sketches: plot, swap the pen, pick the next, plot again'),
    transport,
    bar,
    progressText,
    registrationBox,
    repairBox,
    savedBox,
    el('h4', 'band-title', 'Manual control'),
    manual,
    hint('Profile, calibration and the serial log live on the Machine page.'),
  );
  refreshPenSelect();
  followSketch();
  showRegistration();
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
      row('Y axis', yAxisSelect(m.yAxis ?? 'down', (v) => {
        m.yAxis = v;
        persistProfile();
      }), 'How the controller counts Y against the paper (down the sheet from the top-left)'),
    );
  }
  renderGcodeProfile();
  onProfileSwitch.push(renderGcodeProfile);

  const table = document.createElement('table');
  table.className = 'export-table';
  const svgAll = button('Download SVG (selection, all pens)', async () => {
    if (!hooks.lastResult()) return;
    const svg = await hooks.drawing.svg(hooks.sheetColor(), -1);
    download('occlude.svg', svg, 'image/svg+xml');
  });
  svgAll.className = 'primary';
  const pngBtn = button('Download PNG (300 dpi)', async () => {
    const r = hooks.lastResult();
    if (!r) return;
    await hooks.drawing.settled();
    const png = await hooks.client.planPng(hooks.drawing.range(), r.paper.w, r.paper.h, 11.81, hooks.sheetColor());
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
        yAxis: prof().machine.yAxis ?? 'down',
        ...(prof().machine.penUp !== undefined ? { penUp: prof().machine.penUp } : {}),
        ...(prof().machine.penDown !== undefined ? { penDown: prof().machine.penDown } : {}),
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
          const est = estimatePlanMs(chains.filter((c) => c.pen === job.pen), penTimingOf(r.pens), machineTiming(prof()));
          const mins = est.totalMs / 60000;
          const inkMm = est.drawMm + est.dots * (pen?.width ?? 0);
          const reinkMm = pen?.reinkMm ?? 0;
          const pumps = reinkMm > 0 ? Math.floor(inkMm / reinkMm) : 0;
          time.title =
            'Plot-time estimate: the EBB planner model with current machine settings. ' +
            `Ink: ${Math.round(est.drawMm).toLocaleString()} mm of strokes` +
            (est.dots ? ` + ${est.dots.toLocaleString()} dots` : '') +
            `; travel ${Math.round(est.travelMm).toLocaleString()} mm.` +
            (reinkMm > 0 ? ` Re-ink every ${reinkMm} mm → ${pumps} pause${pumps === 1 ? '' : 's'}.` : '');
          time.textContent =
            (mins >= 1 ? `~${mins.toFixed(1)}min` : `~${Math.ceil(est.totalMs / 1000)}s`) +
            ` · ${Math.round(inkMm).toLocaleString()} mm` +
            (reinkMm > 0 ? ` · ${pumps} re-ink` : '');
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
