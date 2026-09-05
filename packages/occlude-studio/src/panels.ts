/**
 * The control rail: sketch library, pen tray, paper & machine, export.
 * Pens are the one colourful thing in the chrome — each row draws a live
 * stroke sample with the pen's true ink and nib width. Exports run in the
 * render worker against the last rendered buffers, so they never block the
 * editor (or re-render).
 */

import {
  estimatePlanMs, profileToJson,
  type GcodeJob, type PenDef, type RenderResult,
} from 'occlude';
import { loadSketchByName, saveSketchByName } from './sketchApi.js';
import {
  DEFAULT_SKETCH, NEW_SKETCH, PAPER_COLORS,
  download, savePens, saveProfiles, saveSettings,
  type MachineProfile, type Settings,
} from './store.js';
import { Ebb, serialSupported, type PlotProgress } from './ebb.js';
import {
  backlashSquares, calDots, calHatch, calLines, calSegments, cornerRinging,
  registrationProbe, type Diagnostic,
} from './diagnostics.js';
import type { RenderClient } from './workerClient.js';

export interface PanelHooks {
  pens: PenDef[];
  settings: Settings;
  /** Server-shared machine profiles; settings.activeProfile picks one. */
  profiles: MachineProfile[];
  onChanged(): void;
  /** Paper colour changed: repaint the sheet, don't re-render the ink. */
  onPaperColor(hex: string): void;
  lastResult(): RenderResult | null;
  client: RenderClient;
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

/** Extent of a toolpath plan in paper mm (origin = plot origin). */
function planBbox(plan: Float64Array): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (let i = 0; i < plan.length; ) {
    i += 2; // pen, dot
    const n = plan[i++];
    for (let k = 0; k < n; k++) {
      const x = plan[i++];
      const y = plan[i++];
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Callbacks re-rendering profile-bound controls after a profile switch —
 * the single mechanism keeping the UI and the active profile in lockstep. */
const onProfileSwitch: (() => void)[] = [];

export function buildRail(rail: HTMLElement, hooks: PanelHooks): Rail {
  onProfileSwitch.length = 0;
  rail.innerHTML = '';
  const sketchesPanel = panel('Sketch', true);
  const pensPanel = panel('Pens', true);
  const paperPanel = panel('Paper', false);
  const plotPanel = panel('Plot', false);
  const exportPanel = panel('Export', false);
  rail.append(
    sketchesPanel.root, pensPanel.root, paperPanel.root,
    plotPanel.root, exportPanel.root,
  );

  const sketches = buildSketchesPanel(sketchesPanel.body, hooks);
  buildPensPanel(pensPanel.body, hooks);
  buildPaperPanel(paperPanel.body, hooks);
  buildPlotPanel(plotPanel.body, hooks);
  const refreshExport = buildExportPanel(exportPanel.body, hooks);
  exportPanel.root.addEventListener('toggle', () => {
    if ((exportPanel.root as HTMLDetailsElement).open) refreshExport();
  });
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

  function renderList(): void {
    list.innerHTML = '';
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
      list.append(row);
      requestAnimationFrame(() => strokeSample(sample, pen));
    });
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

// ---- plot: EBB (AxiDraw-family) over Web Serial ----

function buildPlotPanel(body: HTMLElement, hooks: PanelHooks): void {
  const s = hooks.settings;
  /** The ACTIVE profile — always read through this, never captured, so
   * every control and estimate follows a profile switch instantly. */
  const prof = (): MachineProfile =>
    hooks.profiles.find((pp) => pp.name === s.activeProfile) ?? hooks.profiles[0];
  const hint = document.createElement('div');
  hint.className = 'panel-hint';
  if (!serialSupported()) {
    hint.textContent = window.isSecureContext
      ? 'Web Serial needs Chrome or Edge.'
      : 'Web Serial needs a secure context — open the studio over HTTPS (or localhost).';
    body.append(hint);
    return;
  }
  hint.textContent =
    'EBB/iDraw over USB — position the carriage by hand, Set origin (Manual control), then Plot.';
  hint.title =
    'Connect leaves the rails free. PEN CONTACT IS MECHANICAL — the servo only lifts, it cannot ' +
    'press: with Pen down, seat the pen low in the clamp so its tip preloads into the sheet; ' +
    'dropped-out lines mean seating depth, not firmware. Full chapter: Docs → Plotting from the studio.';

  const ebb = new Ebb();
  const status = document.createElement('div');
  status.className = 'panel-hint';
  status.textContent = 'not connected';

  const opts = (): import('./ebb.js').EbbOptions => ({
    stepsPerMm: prof().ebb.stepsPerMm,
    travelFeed: prof().machine.travelFeed,
    swapXY: prof().ebb.swapXY,
    invertX: prof().ebb.invertX,
    invertY: prof().ebb.invertY,
    penUpPulse: prof().ebb.penUpPulse,
    penDownPulse: prof().ebb.penDownPulse,
    acceleration: prof().ebb.acceleration,
    travelAcceleration: prof().ebb.travelAcceleration,
    junctionDeviation: prof().ebb.junctionDeviation,
    minimumCruiseRatio: prof().ebb.minimumCruiseRatio,
    lmMotion: prof().ebb.lmMotion,
    quickHopMm: prof().ebb.quickHopMm,
    driftCheckEvery: prof().ebb.driftCheckEvery,
  });
  const persist = (): void => saveProfiles(hooks.profiles);

  const connectBtn = button('Connect', async () => {
    try {
      if (ebb.connected) {
        await ebb.disconnect();
        connectBtn.textContent = 'Connect';
        status.textContent = 'not connected';
        return;
      }
      const v = await ebb.connect({ penUpPulse: prof().ebb.penUpPulse, penDownPulse: prof().ebb.penDownPulse });
      connectBtn.textContent = 'Disconnect';
      status.textContent = v || 'connected';
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  });
  connectBtn.className = 'primary';

  // Jog pad.
  const jogStep = numberInput(10, 1, () => undefined);
  jogStep.title = 'jog distance, mm';
  jogStep.style.width = '3.5em';
  const jog = (dx: number, dy: number) =>
    button(dx === 0 ? (dy < 0 ? '\u2191' : '\u2193') : dx < 0 ? '\u2190' : '\u2192', async () => {
      const d = Math.abs(parseFloat(jogStep.value) || 10);
      await ebb.jog(dx * d, dy * d, opts()).catch(showErr);
    });
  const jogRow = document.createElement('div');
  jogRow.className = 'row';
  jogRow.append(jog(-1, 0), jog(0, -1), jog(0, 1), jog(1, 0), jogStep);

  const penRow = document.createElement('div');
  penRow.className = 'row';
  penRow.style.flexWrap = 'wrap';
  const penDownBtn = button('Pen down', () => void ebb.penDown().catch(showErr));
  penDownBtn.title =
    'Servo contact is mechanical — with the pen down, seat it low in the clamp so the tip ' +
    'preloads into the sheet';
  penRow.append(
    button('Pen up', () => void ebb.penUp().catch(showErr)),
    penDownBtn,
    button('Set origin', () => void ebb.setOrigin().catch(showErr)),
    button('Home', () => void ebb.home().catch(showErr)),
    button('Release', () => void ebb.cmd('EM,0,0').catch(showErr)),
  );
  const logRow = document.createElement('div');
  logRow.className = 'row';
  logRow.append(
    button('Download serial log', () =>
      download('ebb-log.txt', ebb.transcript() || '(no traffic yet)', 'text/plain'),
    ),
  );


  // Pen to plot. No physical pen changer: a multi-pen sketch is plotted one
  // pen per run — plot, swap the pen by hand, pick the next, plot again.
  // Options mirror the last render, rebuilt on open so they never go stale.
  const penSelect = document.createElement('select');
  const refreshPenSelect = (): void => {
    const prev = penSelect.selectedOptions[0]?.textContent ?? '';
    penSelect.innerHTML = '';
    const pens = hooks.lastResult()?.pens ?? [];
    if (pens.length > 1) {
      // All logical pens in one pass with the installed physical pen —
      // each chain still uses its own pen's feed and penDelay (how the
      // settle-sweep card plots per-column settles in a single run).
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
  };
  penSelect.addEventListener('pointerdown', refreshPenSelect);
  refreshPenSelect();

  // Plot controls.
  const bar = document.createElement('progress');
  bar.max = 1;
  bar.value = 0;
  bar.style.width = '100%';
  const progressText = document.createElement('div');
  progressText.className = 'panel-hint';

  function showErr(e: unknown): void {
    status.textContent = e instanceof Error ? e.message : String(e);
  }
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
            quickHopMm: prof().ebb.quickHopMm,
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
          : `${p.state} \u00b7 ${p.penName} \u00b7 ~${eta.toFixed(1)} min left`;
    progressText.textContent = p.warning ? `${base} \u00b7 \u26a0 ${p.warning}` : base;
    pauseBtn.textContent = p.state === 'paused' ? 'Resume' : 'Pause';
  }

  const plotBtn = button('\u25b6 Plot', async () => {
    if (!ebb.connected || ebb.plotting) return;
    const r = hooks.lastResult();
    if (!r) return;
    try {
      refreshPenSelect();
      const raw = parseInt(penSelect.value, 10);
      const allPens = raw === -1;
      const penIndex = allPens ? undefined : Math.min(raw || 0, r.pens.length - 1);
      // Match G-code export: machine resolution is the geometric error
      // ceiling, with nib/4 avoiding needless points for broad pens.
      const penTol = allPens
        ? r.pens.reduce((t, p) => Math.min(t, p.width / 4), Infinity)
        : (r.pens[penIndex!]?.width ?? Infinity) / 4;
      const tol = Math.max(0.0001, Math.min(prof().machine.resolution, penTol));
      const plan = await hooks.client.exportToolpath(200_000, tol);
      // Physical fit: refuse extents the bed cannot hold (placement is the
      // operator's via Set origin — the Frame button verifies that part).
      const bb = planBbox(plan);
      const bed = prof().machine;
      if (bb.x + bb.w > bed.bedW + 0.5 || bb.y + bb.h > bed.bedH + 0.5) {
        showErr(
          `plan needs ${(bb.x + bb.w).toFixed(0)}×${(bb.y + bb.h).toFixed(0)}mm from origin — ` +
          `exceeds the ${prof().name} bed (${bed.bedW}×${bed.bedH}mm); not plotting`,
        );
        return;
      }
      hooks.livePlot.start(plan, r.pens);
      await ebb.plot(
        plan,
        r.pens,
        opts(),
        onProgress,
        (name) => hooks.pens.find((p) => p.name === name),
        () => ({ penUpPulse: prof().ebb.penUpPulse, penDownPulse: prof().ebb.penDownPulse }),
        penIndex,
      );
    } catch (e) {
      showErr(e);
    } finally {
      hooks.livePlot.end();
    }
  });
  plotBtn.className = 'primary danger';
  plotBtn.title = 'Plot on the connected machine — pen and paper, for real';
  const pauseBtn = button('Pause', () => {
    if (ebb.plotting) {
      if (pauseBtn.textContent === 'Pause') ebb.pause();
      else ebb.resume();
    }
  });
  const stopBtn = button('\u25a0 Stop', () => void ebb.stop().catch(showErr));
  const frameBtn = button('Frame', async () => {
    if (!ebb.connected || ebb.plotting) return;
    const r = hooks.lastResult();
    if (!r) return;
    try {
      const tol = Math.max(0.0001, prof().machine.resolution);
      const plan = await hooks.client.exportToolpath(200_000, tol);
      const bb = planBbox(plan);
      // Pen-up perimeter of the plan's bounding box: the placement check no
      // model can do — the machine shows you where the piece will land.
      const legs: [number, number][] = [
        [bb.x, bb.y], [bb.w, 0], [0, bb.h], [-bb.w, 0], [0, -bb.h], [-bb.x, -bb.y],
      ];
      for (const [dx, dy] of legs) await ebb.jog(dx, dy, opts());
    } catch (e) {
      showErr(e);
    }
  });
  frameBtn.title =
    "Trace the plan's bounding box pen-up from the origin — verify placement physically before committing ink";
  const plotRow = document.createElement('div');
  plotRow.className = 'row';
  plotRow.append(plotBtn, pauseBtn, stopBtn, frameBtn);

  // Machine diagnostics: the cal sheet characterizes pens; these
  // characterize the machine. They run through the normal plot pipeline,
  // so Pause/Stop, progress, and the QS drift check all apply. Position
  // the origin bottom-left of a clear area first; footprints are in hints.
  const diag = document.createElement('details');
  diag.className = 'subpanel';
  const diagSummary = document.createElement('summary');
  diagSummary.textContent = 'Machine diagnostics';
  diag.append(diagSummary);
  // Patterns inherit the PHYSICAL pen's tuning (penDelay especially — the
  // patterns are short strokes, so a too-short settle reads as "the pen
  // never reaches the paper"): the Plot-pen selection resolved to its
  // library definition, else the first library pen.
  const diagBasePen = (): import('occlude').PenDef | undefined => {
    const name = penSelect.selectedOptions[0]?.textContent ?? '';
    return hooks.pens.find((p) => p.name === name) ?? hooks.pens[0];
  };
  const addDiag = (
    label: string,
    hint: string,
    build: (base?: import('occlude').PenDef) => Diagnostic,
  ): void => {
    const b = button(label, async () => {
      if (!ebb.connected || ebb.plotting) return;
      try {
        const d = build(diagBasePen());
        hooks.livePlot.start(d.plan, d.pens);
        await ebb.plot(d.plan, d.pens, opts(), onProgress);
      } catch (e) {
        showErr(e);
      } finally {
        hooks.livePlot.end();
      }
    });
    const h = document.createElement('div');
    h.className = 'panel-hint';
    h.textContent = hint;
    diag.append(b, h);
  };
  const cal = document.createElement('details');
  cal.className = 'subpanel';
  const calSummary = document.createElement('summary');
  calSummary.textContent = 'Calibration plots';
  cal.append(calSummary);
  const calHint = document.createElement('div');
  calHint.className = 'panel-hint';
  calHint.textContent =
    'Small single-primitive plots — each isolates one cost axis. Completed ' +
    'plots log model-vs-wall time on the server; plotstats --fit learns the ' +
    'correction. Origin bottom-left of a clear ~70\u00d770mm area.';
  cal.append(calHint);
  const addCal = (label: string, build: (base?: PenDef) => Diagnostic): void => {
    const b = button(label, async () => {
      if (!ebb.connected || ebb.plotting) return;
      try {
        const d = build(diagBasePen());
        hooks.livePlot.start(d.plan, d.pens);
        await ebb.plot(d.plan, d.pens, opts(), onProgress);
      } catch (e) {
        showErr(e);
      } finally {
        hooks.livePlot.end();
      }
    });
    cal.append(b);
  };
  addCal('Dots \u00d7120 (taps)', calDots);
  addCal('Long lines \u00d740 (feed+travel)', calLines);
  addCal('Dense zigzags (serial overhead)', calSegments);
  addCal('Hatch square (mixed)', calHatch);

  addDiag(
    'Registration probe (~120\u00d764mm)',
    '+ drawn first, \u2715 drawn last at the same spot, heavy fast travel between. Offset between their centers = steps lost during the run; direction says which motor.',
    registrationProbe,
  );
  addDiag(
    'Backlash squares (~45\u00d720mm)',
    'Left square repeats every edge in the same direction; right square goes there-and-back. Doubled edges on the right square only = backlash at direction reversals.',
    backlashSquares,
  );
  addDiag(
    'Corner ringing (~66\u00d770mm)',
    'The same right-angle comb at 2000/4000/6000 mm/min, 1\u20133 tick marks. The first row whose corners wiggle is the cornering ceiling \u2014 tune junction deviation just below it.',
    cornerRinging,
  );

  // Daily controls up top; set-once bands collapsed beneath. Band contents
  // are RENDER FUNCTIONS over the active profile — a profile switch rebuilds
  // them, so what you see is always the profile you're editing.
  const manual = sub('Manual control');
  manual.body.append(jogRow, penRow);

  const tuning = sub('Motion tuning');
  function renderTuning(): void {
    const e = prof().ebb;
    const lmCheck = checkbox('LM motion (hardware ramps)', e.lmMotion, (v) => {
      e.lmMotion = v;
      persist();
    });
    lmCheck.title =
      'Hardware-interpolated constant-acceleration moves (25 kHz firmware ramps). ' +
      'Uncheck to fall back to XM packets (firmware < 2.5.3).';
    tuning.body.replaceChildren(
      row('Accel mm/s²', numberInput(e.acceleration, 50, (v) => {
        e.acceleration = Math.max(1, v);
        persist();
      }), 'Drawing acceleration — lower is gentler, higher reaches the pen feed sooner'),
      row('Travel mm/s²', numberInput(e.travelAcceleration, 50, (v) => {
        e.travelAcceleration = Math.max(1, v);
        persist();
      }), 'Acceleration for pen-up moves — no ink at stake, so it can run harder'),
      row('Junction mm', numberInput(e.junctionDeviation, 0.005, (v) => {
        e.junctionDeviation = Math.max(0, v);
        persist();
      }), 'Cornering tolerance for Marlin/Klipper-style look-ahead'),
      row('Min cruise', numberInput(e.minimumCruiseRatio, 0.05, (v) => {
        e.minimumCruiseRatio = Math.max(0, Math.min(0.99, v));
        persist();
      }), '0–0.99; suppresses vibration-producing speed spikes on short moves'),
      row('Quick hop mm', numberInput(e.quickHopMm, 5, (v) => {
        e.quickHopMm = Math.max(0, v);
        persist();
      }), 'Travels shorter than this lift the pen only ~40% with shorter settles. 0 disables — the large-format setting, where gantry deflection needs the full lift'),
      row('Drift check', numberInput(e.driftCheckEvery, 100, (v) => {
        e.driftCheckEvery = Math.max(0, Math.round(v));
        persist();
      }), 'Chains between mid-plot QS position checks — each drains the FIFO (a deliberate ~0.5s pause). 0 = check only at plot end'),
      lmCheck,
    );
  }

  const setup = sub('Machine setup');
  function renderSetup(): void {
    const e = prof().ebb;
    const flips = document.createElement('div');
    flips.className = 'row';
    flips.append(
      checkbox('Swap XY', e.swapXY, (v) => {
        e.swapXY = v;
        persist();
      }),
      checkbox('Inv X', e.invertX, (v) => {
        e.invertX = v;
        persist();
      }),
      checkbox('Inv Y', e.invertY, (v) => {
        e.invertY = v;
        persist();
      }),
    );
    const servoRow = document.createElement('div');
    servoRow.className = 'row';
    // SC positions are board state: apply edits immediately when connected.
    // SC,4 is what the Pen up button (SP,1) drives to; SC,5 is Pen down's
    // (SP,0) target. The horn moves on the next SP, not on the SC write.
    const upIn = numberInput(e.penUpPulse, 100, (v) => {
      e.penUpPulse = v;
      persist();
      if (ebb.connected) void ebb.cmd(`SC,4,${Math.round(v)}`).catch(showErr);
    });
    upIn.title = 'Pen UP pulse (SC,4). Lower = higher lift on the iDraw; below ~8600 the horn stalls.';
    const downIn = numberInput(e.penDownPulse, 100, (v) => {
      e.penDownPulse = v;
      persist();
      if (ebb.connected) void ebb.cmd(`SC,5,${Math.round(v)}`).catch(showErr);
    });
    downIn.title =
      'Pen DOWN pulse (SC,5). Must fully clear the slider so the pen rests on its own weight; ' +
      'the bracket stops the horn at ~18200.';
    servoRow.append(upIn, downIn);
    setup.body.replaceChildren(
      row('Steps/mm', numberInput(e.stepsPerMm, 0.1, (v) => {
        e.stepsPerMm = v;
        persist();
      }), 'Verify a new machine with the cal-sheet ruler'),
      flips,
      row(
        'Servo up/down',
        servoRow,
        'Pen-up (SC,4) and pen-down (SC,5) pulses — write-only on the board, so tuned values live here',
      ),
    );
  }

  // Machine profile selector: the one switch everything above follows.
  const profileSelect = document.createElement('select');
  function renderProfiles(): void {
    profileSelect.innerHTML = '';
    for (const pp of hooks.profiles) {
      const o = document.createElement('option');
      o.value = pp.name;
      o.textContent = pp.name;
      o.selected = pp.name === s.activeProfile;
      profileSelect.append(o);
    }
    tuning.root.querySelector('summary')!.textContent = `Motion tuning — ${prof().name}`;
    setup.root.querySelector('summary')!.textContent = `Machine setup — ${prof().name}`;
    renderTuning();
    renderSetup();
    for (const fn of onProfileSwitch) fn();
  }
  profileSelect.onchange = () => {
    s.activeProfile = profileSelect.value;
    saveSettings(s);
    renderProfiles();
    hooks.onChanged(); // estimates follow the machine
  };
  const dupBtn = button('⧉', () => {
    const name = prompt('New profile name', `${prof().name} copy`)?.trim();
    if (!name || hooks.profiles.some((pp) => pp.name === name)) return;
    hooks.profiles.push({ ...structuredClone(prof()), name });
    s.activeProfile = name;
    saveSettings(s);
    persist();
    renderProfiles();
  });
  dupBtn.title = 'Duplicate the active profile (e.g. an A3 regime with quick hop off)';
  const delBtn = button('×', () => {
    if (hooks.profiles.length <= 1) return;
    if (!confirm(`Delete machine profile '${prof().name}'?`)) return;
    const i = hooks.profiles.findIndex((pp) => pp.name === s.activeProfile);
    hooks.profiles.splice(i, 1);
    s.activeProfile = hooks.profiles[0].name;
    saveSettings(s);
    persist();
    renderProfiles();
    hooks.onChanged();
  });
  delBtn.title = 'Delete the active profile';
  const profileRow = document.createElement('div');
  profileRow.className = 'row';
  const profileLabel = document.createElement('label');
  profileLabel.textContent = 'Machine';
  profileRow.append(profileLabel, profileSelect, dupBtn, delBtn);
  renderProfiles();

  diag.append(logRow);

  body.append(
    hint,
    profileRow,
    connectBtn,
    status,
    row('Plot pen', penSelect, 'Plots this pen only — for multi-pen sketches: plot, swap the pen, pick the next, plot again'),
    plotRow,
    bar,
    progressText,
    manual.root,
    tuning.root,
    setup.root,
    cal,
    diag,
  );
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
  const svgAll = button('Download SVG (all pens)', async () => {
    const r = hooks.lastResult();
    if (!r) return;
    const svg = await hooks.client.exportSvg(r.paper.w, r.paper.h, hooks.settings.paperColor, -1);
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
    // the CURRENT machine settings), per pen as if plotted alone — the
    // G-code jobs' own estimates assume a generic G-code machine and were
    // the source of wildly divergent numbers.
    const tol = Math.max(0.0001, prof().machine.resolution);
    const planPromise = hooks.client.exportToolpath(200_000, tol).then((plan) => {
      const chains: { pen: number; dot: boolean; pts: Float64Array }[] = [];
      for (let i = 0; i < plan.length; ) {
        const pen = plan[i++];
        const dot = plan[i++] === 1;
        const n = plan[i++];
        chains.push({ pen, dot, pts: plan.subarray(i, i + n * 2) });
        i += n * 2;
      }
      return chains;
    });
    Promise.all([hooks.client.exportGcode(profileJson, 200_000), planPromise])
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
          const est = estimatePlanMs(
            chains.filter((c) => c.pen === job.pen),
            () => {
              const pd = hooks.pens.find((pp) => pp.name === job.penName) ?? pen;
              return pd ? { feed: pd.feed, penDelay: pd.penDelay } : undefined;
            },
            {
              travelFeed: prof().machine.travelFeed,
              acceleration: prof().ebb.acceleration,
              travelAcceleration: prof().ebb.travelAcceleration,
              junctionDeviation: prof().ebb.junctionDeviation,
              minimumCruiseRatio: prof().ebb.minimumCruiseRatio,
              quickHopMm: prof().ebb.quickHopMm,
            },
          );
          const mins = est.totalMs / 60000;
          time.title = 'Plot-time estimate: the EBB planner model with current machine settings';
          time.textContent =
            mins >= 1 ? `~${mins.toFixed(1)}min` : `~${Math.ceil(est.totalMs / 1000)}s`;
          const dl = tr.insertCell();
          const gBtn = button('gcode', () =>
            download(`occlude-${job.penName}.gcode`, job.gcode),
          );
          const sBtn = button('svg', async () => {
            const svg = await hooks.client.exportSvg(r.paper.w, r.paper.h, undefined, job.pen);
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

function button(label: string, onclick: () => void | Promise<void>): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = () => void onclick();
  return b;
}

function row(label: string, control: HTMLElement, title?: string): HTMLDivElement {
  const r = document.createElement('div');
  r.className = 'row';
  if (title) r.title = title;
  const l = document.createElement('label');
  l.textContent = label;
  r.append(l, control);
  return r;
}

function checkbox(label: string, value: boolean, onchange: (v: boolean) => void): HTMLLabelElement {
  const l = document.createElement('label');
  l.className = 'row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = value;
  input.style.flex = 'none';
  input.onchange = () => onchange(input.checked);
  l.append(input, document.createTextNode(` ${label}`));
  return l;
}

function numberInput(value: number, step: number, onchange: (v: number) => void): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step);
  input.value = String(value);
  input.onchange = () => {
    const next = parseFloat(input.value);
    if (Number.isFinite(next)) onchange(next);
    else input.value = String(value);
  };
  return input;
}

function pairInput(
  a: number,
  b: number,
  onchange: (a: number, b: number) => void,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'row';
  const ia = numberInput(a, 1, (v) => onchange(v, parseFloat(ib.value)));
  const ib = numberInput(b, 1, (v) => onchange(parseFloat(ia.value), v));
  wrap.append(ia, ib);
  return wrap;
}
