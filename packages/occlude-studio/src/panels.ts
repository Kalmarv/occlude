/**
 * The control rail: sketch library, pen tray, paper & machine, export.
 * Pens are the one colourful thing in the chrome — each row draws a live
 * stroke sample with the pen's true ink and nib width. Exports run in the
 * render worker against the last rendered buffers, so they never block the
 * editor (or re-render).
 */

import {
  profileToJson,
  type GcodeJob, type PenDef, type RenderResult,
} from 'occlude';
import {
  deleteSketchByName, listSketches, loadSketchByName, saveSketchByName,
} from './sketchApi.js';
import { download, savePens, saveSettings, type Settings } from './store.js';
import { Ebb, serialSupported, type PlotProgress } from './ebb.js';
import type { RenderClient } from './workerClient.js';

export interface PanelHooks {
  pens: PenDef[];
  settings: Settings;
  onChanged(): void;
  lastResult(): RenderResult | null;
  client: RenderClient;
  getSource(): string;
  openSketch(name: string, source: string): void;
  currentName(): string;
  setName(name: string): void;
}

export interface Rail {
  refreshExport(): void;
  refreshSketches(): void;
  /** Save the current sketch under its name (Ctrl+S path). Resolves with the
   * saved name, or null when there is no name yet. */
  saveCurrent(): Promise<string | null>;
}

export function buildRail(rail: HTMLElement, hooks: PanelHooks): Rail {
  rail.innerHTML = '';
  const sketchesPanel = panel('Sketches', true);
  const pensPanel = panel('Pens', true);
  const paperPanel = panel('Paper & machine', false);
  const plotPanel = panel('Plot (serial)', false);
  const exportPanel = panel('Export', false);
  rail.append(sketchesPanel.root, pensPanel.root, paperPanel.root, plotPanel.root, exportPanel.root);

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

// ---- sketch library (server-side store, shared across devices) ----

function buildSketchesPanel(
  body: HTMLElement,
  hooks: PanelHooks,
): { refresh(): void; save(): Promise<string | null> } {
  const nameRow = document.createElement('div');
  nameRow.className = 'row';
  const nameInput = document.createElement('input');
  nameInput.placeholder = 'sketch name';
  nameInput.value = hooks.currentName();
  nameInput.onchange = () => hooks.setName(nameInput.value.trim());
  async function save(): Promise<string | null> {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return null;
    }
    if (!/^[a-zA-Z0-9 _-]{1,64}$/.test(name)) {
      alert('Names: letters, digits, spaces, - and _ (max 64).');
      return null;
    }
    await saveSketchByName(name, hooks.getSource());
    hooks.setName(name);
    await refresh();
    return name;
  }
  const saveBtn = button('Save', async () => {
    try {
      if ((await save()) === null && !nameInput.value.trim()) {
        alert('Give the sketch a name first.');
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  });
  saveBtn.className = 'primary';
  saveBtn.style.flex = 'none';
  nameRow.append(nameInput, saveBtn);

  const list = document.createElement('div');
  const hint = document.createElement('div');
  hint.className = 'panel-hint';
  hint.textContent = 'Saved on the studio server — open them from any browser.';

  async function refresh(): Promise<void> {
    let sketches;
    try {
      sketches = await listSketches();
    } catch {
      list.textContent = 'sketch store unavailable';
      return;
    }
    list.innerHTML = '';
    if (sketches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'panel-hint';
      empty.textContent = 'No saved sketches yet — name this one and press Save.';
      list.append(empty);
      return;
    }
    for (const s of sketches) {
      const row = document.createElement('div');
      row.className = `sketch-row${s.name === hooks.currentName() ? ' selected' : ''}`;
      const name = document.createElement('span');
      name.className = 'sketch-name';
      name.textContent = s.name;
      const when = document.createElement('span');
      when.className = 'sketch-when';
      when.textContent = ago(s.mtime);
      const del = button('×', async () => {
        if (!confirm(`Delete sketch '${s.name}' from the server?`)) return;
        await deleteSketchByName(s.name);
        await refresh();
      });
      del.title = `Delete ${s.name}`;
      del.className = 'sketch-del';
      row.append(name, when, del);
      row.onclick = async (e) => {
        if (e.target === del) return;
        try {
          const src = await loadSketchByName(s.name);
          hooks.openSketch(s.name, src);
          nameInput.value = s.name;
          await refresh();
        } catch (err) {
          alert(err instanceof Error ? err.message : String(err));
        }
      };
      list.append(row);
    }
  }

  body.append(nameRow, list, hint);
  void refresh();
  return { refresh: () => void refresh(), save };
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
    ];
    for (const [label, key, type] of fields) {
      const l = document.createElement('label');
      l.textContent = label;
      const input = document.createElement('input');
      input.type = type;
      if (type === 'number') input.step = key === 'width' ? '0.05' : '10';
      input.value = String(pen[key]);
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

  const marginInput = numberInput(s.defaultMarginPct, 0.5, (v) => {
    s.defaultMarginPct = v;
    persist();
  });

  body.append(
    row('Paper', paperSel),
    customRow,
    landscape,
    row('Margin %', marginInput, 'Used when the sketch does not call margin()'),
  );

  const m = s.machine;
  body.append(
    row('Bed mm', pairInput(m.bedW, m.bedH, (a, b) => {
      m.bedW = a;
      m.bedH = b;
      persist();
    })),
    row('Travel', numberInput(m.travelFeed, 100, (v) => {
      m.travelFeed = v;
      persist();
    })),
    row('Resolution', numberInput(m.resolution, 0.005, (v) => {
      m.resolution = v;
      persist();
    })),
    checkbox('Pen via Z axis (off = M3/M5)', m.zMode, (v) => {
      m.zMode = v;
      persist();
    }),
    checkbox('Emit G2/G3 arcs', m.arcSupport, (v) => {
      m.arcSupport = v;
      persist();
    }),
  );
}

// ---- plot: EBB (AxiDraw-family) over Web Serial ----

function buildPlotPanel(body: HTMLElement, hooks: PanelHooks): void {
  const s = hooks.settings;
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
    'EBB/iDraw over USB. Connect leaves the rails free: position the pen by hand → Set origin → Plot.';

  const ebb = new Ebb();
  const status = document.createElement('div');
  status.className = 'panel-hint';
  status.textContent = 'not connected';

  const opts = (): import('./ebb.js').EbbOptions => ({
    stepsPerMm: s.ebb.stepsPerMm,
    travelFeed: s.machine.travelFeed,
    swapXY: s.ebb.swapXY,
    invertX: s.ebb.invertX,
    invertY: s.ebb.invertY,
    servoDown: s.ebb.servoDown,
    servoUp: s.ebb.servoUp,
  });
  const persist = (): void => saveSettings(s);

  const connectBtn = button('Connect', async () => {
    try {
      if (ebb.connected) {
        await ebb.disconnect();
        connectBtn.textContent = 'Connect';
        status.textContent = 'not connected';
        return;
      }
      const v = await ebb.connect({ servoDown: s.ebb.servoDown, servoUp: s.ebb.servoUp });
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
  penRow.append(
    button('Pen up', () => void ebb.penUp().catch(showErr)),
    button('Pen down', () => void ebb.penDown().catch(showErr)),
    button('Set origin', () => void ebb.setOrigin().catch(showErr)),
    button('Home', () => void ebb.home().catch(showErr)),
  );

  // Calibration + orientation.
  const spm = numberInput(s.ebb.stepsPerMm, 0.1, (v) => {
    s.ebb.stepsPerMm = v;
    persist();
  });
  // Axis mapping (measured: the iDraw's axes are rotated 90° vs the page —
  // defaults are swap + invert X; only touch these for a different machine).
  const flips = document.createElement('div');
  flips.className = 'row';
  flips.append(
    checkbox('Swap XY', s.ebb.swapXY, (v) => {
      s.ebb.swapXY = v;
      persist();
    }),
    checkbox('Inv X', s.ebb.invertX, (v) => {
      s.ebb.invertX = v;
      persist();
    }),
    checkbox('Inv Y', s.ebb.invertY, (v) => {
      s.ebb.invertY = v;
      persist();
    }),
  );
  const servoRow = document.createElement('div');
  servoRow.className = 'row';
  const servoDownIn = numberInput(s.ebb.servoDown, 100, (v) => {
    s.ebb.servoDown = v;
    persist();
  });
  const servoUpIn = numberInput(s.ebb.servoUp, 100, (v) => {
    s.ebb.servoUp = v;
    persist();
  });
  servoRow.append(servoDownIn, servoUpIn);

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
    bar.value = p.totalMs > 0 ? Math.min(1, p.elapsedMs / p.totalMs) : 0;
    const eta = Math.max(0, (p.totalMs - p.elapsedMs) / 60000);
    progressText.textContent =
      p.state === 'done'
        ? 'done'
        : p.state === 'stopped'
          ? 'stopped'
          : `${p.state} \u00b7 ${p.penName} \u00b7 ~${eta.toFixed(1)} min left`;
    pauseBtn.textContent = p.state === 'paused' ? 'Resume' : 'Pause';
  }

  const plotBtn = button('\u25b6 Plot', async () => {
    if (!ebb.connected || ebb.plotting) return;
    const r = hooks.lastResult();
    if (!r) return;
    try {
      // Match G-code export: machine resolution is the geometric error
      // ceiling, with nib/4 avoiding needless points for broad pens.
      const penTol = r.pens.reduce((tol, pen) => Math.min(tol, pen.width / 4), Infinity);
      const tol = Math.max(0.0001, Math.min(s.machine.resolution, penTol));
      const plan = await hooks.client.exportToolpath(200_000, tol);
      await ebb.plot(
        plan,
        r.pens,
        opts(),
        onProgress,
        (name) => hooks.pens.find((p) => p.name === name),
        () => ({ servoDown: s.ebb.servoDown, servoUp: s.ebb.servoUp }),
      );
    } catch (e) {
      showErr(e);
    }
  });
  plotBtn.className = 'primary';
  const pauseBtn = button('Pause', () => {
    if (ebb.plotting) {
      if (pauseBtn.textContent === 'Pause') ebb.pause();
      else ebb.resume();
    }
  });
  const stopBtn = button('\u25a0 Stop', () => void ebb.stop().catch(showErr));
  const plotRow = document.createElement('div');
  plotRow.className = 'row';
  plotRow.append(plotBtn, pauseBtn, stopBtn);

  body.append(
    hint,
    connectBtn,
    status,
    jogRow,
    penRow,
    row('Steps/mm', spm, 'Measured 100 on this iDraw; verify any new machine with the cal-sheet ruler'),
    flips,
    row('Servo dn/up', servoRow, 'SC,4 / SC,5 positions — write-only on the board, so tuned values live here'),
    plotRow,
    bar,
    progressText,
  );
}

// ---- export (runs in the render worker on the last rendered buffers) ----

function buildExportPanel(body: HTMLElement, hooks: PanelHooks): () => void {
  const table = document.createElement('table');
  table.className = 'export-table';
  const svgAll = button('Download SVG (all pens)', async () => {
    const r = hooks.lastResult();
    if (!r) return;
    const svg = await hooks.client.exportSvg(r.paper.w, r.paper.h, '#f6f2ea', -1);
    download('occlude.svg', svg, 'image/svg+xml');
  });
  svgAll.className = 'primary';
  const pngBtn = button('Download PNG (300 dpi)', async () => {
    const r = hooks.lastResult();
    if (!r) return;
    const png = await hooks.client.exportPng(r.paper.w, r.paper.h, 11.81, '#f6f2ea');
    download('occlude.png', png, 'image/png');
  });
  const exportRow = document.createElement('div');
  exportRow.className = 'row';
  exportRow.append(svgAll, pngBtn);
  body.append(table, exportRow);

  let refreshing = false;
  return function refresh(): void {
    if (refreshing) return;
    const r = hooks.lastResult();
    table.innerHTML = '';
    if (!r) return;
    refreshing = true;
    const s = hooks.settings;
    const profileJson = profileToJson(
      {
        bed: [s.machine.bedW, s.machine.bedH],
        travelFeed: s.machine.travelFeed,
        zMode: s.machine.zMode,
        arcSupport: s.machine.arcSupport,
        resolution: s.machine.resolution,
      },
      r.paper,
    );
    hooks.client
      .exportGcode(profileJson, 200_000)
      .then((json) => {
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
          const mins = job.estSeconds / 60;
          time.textContent =
            mins >= 1 ? `~${mins.toFixed(1)}min` : `~${Math.ceil(job.estSeconds)}s`;
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
  input.onchange = () => onchange(parseFloat(input.value));
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
