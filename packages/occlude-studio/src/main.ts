/** occlude studio: wire editor → runner → render worker → preview → panels. */

import './style.css';
import { clearRuntimeMarkers, createEditor, setRuntimeMarker } from './editor.js';
import { Inspector } from './inspector.js';
import { buildRail } from './panels.js';
import { Preview } from './preview.js';
import {
  download, loadPens, loadProfiles, loadSettings, loadSketch, loadSketchName,
  loadUi, saveSketch, saveSketchName, saveUi,
} from './store.js';
import { listFills, loadFill, saveFill } from './fillApi.js';
import { seedOf, stashLive, withSeed,
  createSnapshot, forkSketch, loadSketchByName, putThumb, thumbFromCanvas,
} from './sketchApi.js';
import { customFillNames, embedFills, importSketchWithFills } from './fillEmbed.js';
import { UiPanel } from './uiPanel.js';

declare const __BUILD_STAMP__: string;
import { parseSeed, encodeToolpath, scanUiControls, type EstimateOpts, type PenDef, type PenTiming } from 'occlude';
import { type RenderDraws, RenderClient, type WorkerError } from './workerClient.js';
import { Drawing, machineTiming, machineTolerance, penTimingOf } from './drawing.js';
import { loadResult } from './resultsApi.js';
import type { RenderResult } from 'occlude';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// The sketch executes in the render worker (spec: the worker owns the whole
// sketch runtime; this thread owns the editor only). A runaway loop wedges
// the worker and the client watchdog respawns it — the tab never freezes,
// so the old crash sentinel is gone.

async function boot(): Promise<void> {
  const statusMsg = $('status-msg');
  const statusStats = $('status-stats');
  const statusSeed = $('status-seed');
  $('status-build').textContent = __BUILD_STAMP__;
  const titleEl = $('sketch-title') as HTMLInputElement;

  let renderOn = true;
  const renderToggle = $('render-toggle') as HTMLButtonElement;
  function syncRenderToggle(): void {
    renderToggle.textContent = renderOn ? '⏸ live' : '▶ render';
    renderToggle.title = renderOn
      ? 'Preview is live — click to pause re-rendering while you edit'
      : 'Preview is paused — click to render the sketch';
    renderToggle.classList.toggle('paused', !renderOn);
  }
  syncRenderToggle();

  const pens = await loadPens();
  const profiles = await loadProfiles();
  const settings = loadSettings();
  // A sketch opened from the docs arrives with the sheet it was shown on
  // and the pens it was written for: apply the sheet, add any pen the
  // library lacks for THIS session (the library file is not written), and
  // say so — the drawing should look as it did on the docs page.
  let openedNote: string | null = null;
  try {
    const raw = localStorage.getItem('occlude.openSettings');
    if (raw) {
      localStorage.removeItem('occlude.openSettings');
      const open = JSON.parse(raw) as { paper?: string; customPaper?: { w: number; h: number }; landscape?: boolean; defaultMarginPct?: number; pens?: PenDef[] };
      if (open.paper) settings.paper = open.paper;
      if (open.customPaper) settings.customPaper = open.customPaper;
      if (open.landscape !== undefined) settings.landscape = open.landscape;
      if (open.defaultMarginPct !== undefined) settings.defaultMarginPct = open.defaultMarginPct;
      const added: string[] = [];
      for (const pen of open.pens ?? []) {
        if (!pens.some((p) => p.name === pen.name)) { pens.push(pen); added.push(pen.name); }
      }
      openedNote = `opened from the docs on ${settings.paper === 'Custom' ? `${settings.customPaper.w}×${settings.customPaper.h} mm` : settings.paper}${settings.landscape ? ' landscape' : ''}` +
        (added.length ? ` — docs pens added for this session: ${added.join(', ')} (not saved to your library)` : '');
    }
  } catch {
    openedNote = null;
  }
  if (!profiles.some((p) => p.name === settings.activeProfile)) {
    settings.activeProfile = profiles[0].name;
  }
  const client = new RenderClient();
  const editor = createEditor($('editor'), loadSketch());
  const preview = new Preview($('preview') as HTMLCanvasElement);
  preview.setPaperColor(settings.paperColor);
  // The material inspector: its registry is made by the run, so flipping it
  // reruns the sketch (like the occlusion ghost); everything after that is
  // a repaint or one payload request.
  const inspector = new Inspector(preview, client, () => void run());
  editor.onInspectGeometry(request => inspector.openGeometry(request));
  let lastResult: RenderResult | null = null;
  const activeProfile = () => profiles.find((p) => p.name === settings.activeProfile) ?? profiles[0];
  /** A frozen result runs under the settings it was SAVED with — its pens'
   * feed and settle, its profile's timing and tolerance — not the current
   * library or the active profile. */
  let frozenExecution: { name: string; opts: EstimateOpts; tolerance: number; pens: PenDef[] } | null = null;
  const execution = (): { opts: EstimateOpts; penOf: (pen: number) => PenTiming | undefined; tolerance: number; profile: string; pens: PenDef[] } => {
    if (frozenExecution) {
      return { opts: frozenExecution.opts, penOf: penTimingOf(frozenExecution.pens, frozenExecution.pens), tolerance: frozenExecution.tolerance, profile: frozenExecution.name, pens: frozenExecution.pens };
    }
    const prof = activeProfile();
    const rp = lastResult?.pens ?? [];
    return { opts: machineTiming(prof), penOf: penTimingOf(rp, pens), tolerance: machineTolerance(prof, rp), profile: prof.name, pens: rp.map((p) => pens.find((q) => q.name === p.name) ?? p) };
  };
  // THE ordered plan of the current render, and the selection of it that
  // the preview, exports, simulation and machine share.
  const drawing = new Drawing(client, () => execution());
  const showSelection = (): void => {
    const plan = drawing.plan;
    const sel = drawing.plotSelection;
    // A frozen result has no fragments: the plan IS the picture, always.
    if (!plan || !sel || (!frozenId && !drawing.region && sel.fromChain === 0 && sel.toChain === plan.chains.length)) preview.setSelection(null);
    else {
      let keep: Uint8Array | undefined;
      if (drawing.region) {
        keep = new Uint8Array(plan.chains.length);
        for (const i of drawing.plotIndices() ?? []) keep[i] = 1;
      }
      preview.setSelection({ chains: plan.chains, from: sel.fromChain, to: sel.toChain, keep, showOmitted: drawing.showOmitted });
    }
  };
  // Render-status ownership: the newest run's sequence number and the one
  // elapsed-time ticker (see runInner).
  let runSeq = 0;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let pending: number | null = null;
  let sketchName = loadSketchName();
  /** One-shot note appended to the next 'ok' status (import summaries). */
  let note: string | null = null;

  function setTitle(): void {
    titleEl.value = sketchName;
  }
  setTitle();
  titleEl.onchange = () => {
    sketchName = titleEl.value.trim();
    saveSketchName(sketchName);
  };

  // Seed ownership lives HERE now: the worker has no ?seed= in its URL and
  // its session seed dies on watchdog respawn, so the main thread passes the
  // seed explicitly and captures whatever the worker actually used.
  let seed: string | null = seedOf(location.href);
  /** A saved result opened frozen: the source is NOT executed; the plan
   * comes from the saved bytes and every consumer reads that. */
  const frozenId: string | null = new URL(location.href).searchParams.get('result');
  let seedUsed: string | null = null; // what the worker actually rendered with

  let lastOverrides: { hit: string[]; dropped: string[] } = { hit: [], dropped: [] };
  let lastDraws: RenderDraws | null = null;
  function renderSeedControls(used: string): void {
    statusSeed.innerHTML = '';
    const label = document.createElement('span');
    const { seed: base, overrides } = parseSeed(used);
    const n = Object.keys(overrides).length;
    label.textContent = n ? `seed ${base} +${n}` : `seed ${used}`;
    if (n || lastOverrides.dropped.length) {
      const lines = Object.keys(overrides).sort().map((k) => `${k} = ${overrides[k].toFixed(4)}`);
      if (lastOverrides.dropped.length) lines.push(`dropped (no such draw now): ${lastOverrides.dropped.join(', ')}`);
      label.title = `${n} draw${n === 1 ? '' : 's'} overridden by evolution\n${lines.join('\n')}`;
    }
    if (lastOverrides.dropped.length) {
      const dropped = document.createElement('span');
      dropped.className = 'status-warn';
      dropped.textContent = `${lastOverrides.dropped.length} dropped`;
      dropped.title = 'Overrides naming draws this source no longer makes; the seed decides those again';
      label.append(' ', dropped);
    }
    const reroll = document.createElement('button');
    reroll.textContent = 'reroll';
    reroll.title = 'New random seed';
    reroll.onclick = () => {
      seed = String(Math.floor(Math.random() * 2 ** 31));
      history.replaceState(null, '', withSeed(location.href, seed));
      void run();
    };
    const share = document.createElement('button');
    share.textContent = 'copy url';
    share.title = 'Copy a shareable URL with this seed';
    share.onclick = () => {
      void navigator.clipboard.writeText(new URL(withSeed(location.href, used), location.origin).toString());
    };
    statusSeed.append(label, reroll, share);
  }

  async function run(): Promise<void> {
    const ticket = ++runSeq;
    if (pending !== null) { clearTimeout(pending); pending = null; }
    if (ticker) { clearInterval(ticker); ticker = null; }
    inspector.invalidate();
    client.releaseInspections();
    try {
      await runInner(ticket);
    } catch (err) {
      if (ticket !== runSeq) return;
      statusMsg.className = 'status-err';
      statusMsg.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  async function runInner(ticket: number): Promise<void> {
    saveSketch(editor.getValue()); // persist BEFORE executing — survives anything
    if (frozenId) {
      statusMsg.className = 'status-err';
      statusMsg.textContent = `showing saved result ${frozenId} — the source is not executed here; open the studio without ?result to render`;
      return;
    }
    if (!renderOn) {
      statusMsg.className = 'status-err';
      statusMsg.textContent = 'rendering paused — press ▶ render to run the sketch';
      return;
    }
    const inspecting = inspector.enabled;
    const emitted = await editor.emit(inspecting);
    if (ticket !== runSeq) return;
    if (!emitted.js) {
      statusMsg.className = 'status-err';
      statusMsg.textContent = emitted.errors[0] ?? 'syntax error';
      inspector.invalidate('Current source could not compile — no live capture');
      return;
    }

    clearRuntimeMarkers(editor.model);
    statusMsg.className = 'status-ok';
    statusMsg.textContent = 'rendering…';
    // While a render runs (and after one fails) the canvas still shows the
    // PREVIOUS result: say so, with the elapsed time, and dim it. One
    // ticker for the whole page, owned by the newest run: an older run
    // still in flight must neither write the status nor clear the ticker.
    const myRun = ticket;
    const started = performance.now();
    preview.setStale(lastResult !== null);
    if (ticker) clearInterval(ticker);
    ticker = setInterval(() => {
      const s = Math.round((performance.now() - started) / 1000);
      statusMsg.textContent = s >= 1
        ? `rendering… ${s}s${lastResult ? ' — showing previous result' : ''}`
        : 'rendering…';
    }, 1000);
    const finish = () => {
      if (myRun !== runSeq) return false; // a newer run owns the status now
      if (ticker) clearInterval(ticker);
      ticker = null;
      return true;
    };
    // The worker runs everything: asset preload, sketch execution, encode,
    // wasm. Each request carries the full config so a respawned worker
    // self-heals.
    let reply;
    try {
      reply = await client.render({
        js: emitted.js,
        cfg: {
          pens,
          paper: settings.paper === 'Custom' ? settings.customPaper : settings.paper,
          landscape: settings.landscape,
          defaultMarginPct: settings.defaultMarginPct,
          coarsen: 1,
          debugGhost: preview.debug.occluded,
          inspect: inspecting,
          inspectionCompiled: inspecting,
          seed,
          draws: true, // the run's draws, for Freeze
        },
      });
    } catch (err) {
      if ((err as WorkerError).sketch) setRuntimeMarker(editor.model, err);
      if (!finish()) return; // superseded: the newer run reports
      inspector.invalidate('Current run failed — no live capture');
      statusMsg.className = 'status-err';
      statusMsg.textContent =
        (err instanceof Error ? err.message : String(err)) +
        (lastResult ? ' — showing previous result' : '');
      return;
    }
    if (reply === null) return; // superseded by a newer run, which owns the status
    const latest = finish();
    if (latest) preview.setStale(false);
    const result: RenderResult = reply.result;
    // An older run landing behind a newer one still shows its drawing (the
    // newer will replace it), but the status line belongs to the newer run.
    const say = (cls: string, text: string) => {
      if (!latest) return;
      statusMsg.className = cls;
      statusMsg.textContent = text;
    };
    // Capture the seed the worker actually used (the rolled session seed on
    // a fresh run) so respawns and shares stay sticky.
    seed = reply.seedUsed;
    lastResult = result;
    if (result.stats.shapesIn === 0) {
      say('status-err', 'sketch returned an empty tree — no shapes (check for undefined returns or empty arrays)');
    } else if (result.stats.fragments === 0) {
      say(
        'status-err',
        `${result.stats.shapesIn} shape(s) but zero visible strokes — everything is ` +
          'off-paper, fully occluded, or sub-nib (with origin: \'center\', coordinates run ' +
          '±50, so radii/half-sizes belong in 0–50)',
      );
    } else {
      say('status-ok', note ? `ok · ${note}` : 'ok');
      if (latest) note = null;
    }
    const s = result.stats;
    statusStats.textContent =
      `${s.fragments} frags · ${s.fillPrims} fill prims · ` +
      `${s.clean} clean · ${s.culledContained + s.culledOffPaper} culled · ` +
      `${s.renderMs.toFixed(1)}ms`;
    preview.setResult(result);
    // Adopt this render's plan (identity verified); the standing selection
    // request re-resolves against it. A stale reply cannot outrun a newer
    // plan: setPlan is keyed by the plan it was given.
    if (latest) {
      drawing.setPlan(reply.plan, result.pens, reply.draw ?? {}).catch((err: unknown) => {
        say('status-err', `plan: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    uiPanel.setProbes(reply.probes);
    if (latest) inspector.onRender(reply);
    seedUsed = reply.seedUsed;
    lastOverrides = reply.overrides;
    lastDraws = reply.draws ?? null;
    renderSeedControls(reply.seedUsed);
  }

  function scheduleRun(): void {
    runSeq++;
    inspector.invalidate('Previous run — source changed');
    client.releaseInspections();
    if (ticker) { clearInterval(ticker); ticker = null; }
    if (pending !== null) clearTimeout(pending);
    pending = window.setTimeout(() => {
      pending = null;
      void run();
    }, 150);
  }

  renderToggle.onclick = () => {
    renderOn = !renderOn;
    syncRenderToggle();
    void run();
  };

  const uiPanel = new UiPanel($('bench'), editor);
  uiPanel.sync();
  editor.onChange(() => uiPanel.sync());
  editor.onChange(scheduleRun);
  // Debug/automation handle (used by headless driving; harmless otherwise).
  (window as unknown as Record<string, unknown>).__occlude = {
    editor,
    result: () => lastResult,
    drawing,
    preview,
    inspector,
    /** What the controls panel sees in the source right now (debugging). */
    controls: () => scanUiControls(editor.getValue()),
  };

  const rail = buildRail($('rail'), {
    pens,
    profiles,
    settings,
    client,
    drawing,
    onSelectionView: showSelection,
    frozenResult: () => frozenId,
    execution: () => {
      const e = execution();
      return { profile: e.profile, tolerance: e.tolerance, timing: e.opts, pens: e.pens.map((p) => ({ name: p.name, feed: p.feed, penDelay: p.penDelay })) };
    },
    build: __BUILD_STAMP__,
    onChanged: () => void run(),
    onPaperColor: (hex) => preview.setPaperColor(hex),
    lastResult: () => lastResult,
    currentSeed: () => seedUsed,
    getSource: () => editor.getValue(),
    replaceSource: (source) => editor.replaceValue(source),
    lastDraws: () => lastDraws,
    openSketch: (name, source) => {
      sketchName = name;
      saveSketchName(name);
      setTitle();
      editor.setValue(source); // triggers a run via onChange
    },
    currentName: () => sketchName,
    setName: (name) => {
      sketchName = name;
      saveSketchName(name);
      setTitle();
    },
    importSketchFile: () => {
      const input = $('file-input') as HTMLInputElement;
      input.onchange = async () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        const text = await file.text();
        // Embedded fills reconcile with the library first: identical
        // content reuses the name, a mismatch lands under a fresh name and
        // the sketch is rewired — never a prompt, never an overwrite.
        try {
          const out = await importSketchWithFills(text, {
            list: async () => (await listFills()).map((f) => f.name),
            load: loadFill,
            save: saveFill,
          });
          const parts: string[] = [];
          if (out.added.length) parts.push(`fills added: ${out.added.join(', ')}`);
          if (out.reused.length) parts.push(`fills reused: ${out.reused.join(', ')}`);
          for (const r of out.renamed) parts.push(`fill '${r.from}' differs — imported as '${r.to}', sketch rewired`);
          if (parts.length) note = parts.join(' · ');
          editor.setValue(out.sketch);
        } catch (err) {
          statusMsg.className = 'status-err';
          statusMsg.textContent = `import failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      };
      input.click();
    },
    afterSave: (name) => {
      // The finished render, scaled down: no re-render, the canvas is painted.
      void thumbFromCanvas($('preview') as HTMLCanvasElement).then((png) => {
        if (png) return putThumb(name, png);
      }).catch(() => undefined);
    },
    downloadSketchFile: async () => {
      // Embed the resolved source of every custom fill the sketch uses, in
      // a comment-only block: the file stays a valid sketch and travels
      // complete (fill files import nothing but occlude).
      const src = editor.getValue();
      const fills: { name: string; source: string }[] = [];
      for (const name of customFillNames(src)) {
        const source = await loadFill(name).catch(() => null);
        if (source !== null) fills.push({ name, source });
      }
      download(`${sketchName || 'sketch'}.ts`, embedFills(src, fills));
    },
    livePlot: {
      start: (plan, pens) => preview.startLive(plan, pens),
      progress: (chain) => preview.liveProgress(chain),
      end: () => preview.endLive(),
    },
    brush: {
      start: (fn) => { preview.brush = fn; $('preview').classList.add('painting'); },
      stop: () => { preview.brush = null; $('preview').classList.remove('painting'); },
      show: (blobs) => { preview.regionBlobs = blobs; preview.draw(); },
    },
  });

  drawing.onChange(() => {
    showSelection();
    rail.refreshExport();
  });

  if (openedNote) note = openedNote;

  // Snapshot: freeze this source with the seed it rendered under. Fork: a
  // new sketch from this one, opened here. Both live on the Sketches page.
  const status = (ok: boolean, text: string): void => {
    statusMsg.className = ok ? 'status-ok' : 'status-err';
    statusMsg.textContent = text;
  };
  ($('btn-snapshot') as HTMLButtonElement).onclick = async () => {
    try {
      const name = await rail.saveCurrent();
      if (!name) {
        status(false, 'name the sketch to snapshot it (title bar)');
        return;
      }
      const parsed = parseSeed(seed ?? '');
      const id = await createSnapshot(name, { seed: seed === null ? null : parsed.seed, overrides: parsed.overrides, label: '' });
      const png = await thumbFromCanvas($('preview') as HTMLCanvasElement);
      if (png) await putThumb(name, png, id);
      status(true, `snapshot of '${name}' saved (seed ${seed ?? '—'})`);
    } catch (err) {
      status(false, `snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // Evolve renders the editor's buffer as it is; nothing is saved until a
  // Keep on that page, which saves the source first so the tag has one.
  ($('btn-evolve') as HTMLButtonElement).onclick = () => {
    stashLive({ name: sketchName.trim(), source: editor.getValue() });
    const u = new URLSearchParams({ live: '1' });
    if (sketchName.trim()) u.set('sketch', sketchName.trim());
    location.href = withSeed(`/evolve.html?${u.toString()}`, seedUsed);
  };
  ($('btn-fork') as HTMLButtonElement).onclick = async () => {
    try {
      const name = await rail.saveCurrent();
      if (!name) {
        status(false, 'name and save the sketch before forking it');
        return;
      }
      // Forks are not named, like snapshots: the server picks `<name>-<n>`.
      const made = await forkSketch(name);
      const source = await loadSketchByName(made);
      sketchName = made;
      saveSketchName(made);
      setTitle();
      editor.setValue(source);
      status(true, `forked '${name}' → '${made}'`);
    } catch (err) {
      status(false, `fork failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Save: the top bar's icon and Ctrl/Cmd+S, to the server-side sketch
  // library, not the web page.
  const saveNow = (): void => {
    editor
      .format()
      .then(() => rail.saveCurrent())
      .then((name) => {
        if (name) {
          statusMsg.className = 'status-ok';
          statusMsg.textContent = `saved '${name}'`;
        } else {
          statusMsg.className = 'status-err';
          statusMsg.textContent = 'name the sketch to save it (title bar)';
        }
      })
      .catch((err: unknown) => {
        statusMsg.className = 'status-err';
        statusMsg.textContent = `save failed: ${err instanceof Error ? err.message : String(err)}`;
      });
  };
  ($('btn-save-top') as HTMLButtonElement).onclick = saveNow;
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        saveNow();
      }
    },
    true,
  );

  // ---- layout: resizable editor + collapsible rail ----
  const ui = loadUi();
  const workbench = $('workbench');
  const railBtn = $('btn-rail') as HTMLButtonElement;
  const applyUi = (): void => {
    if (ui.editorW !== null) {
      workbench.style.setProperty('--editor-w', `${ui.editorW}px`);
    } else {
      workbench.style.removeProperty('--editor-w');
    }
    // Inline style would beat .rail-collapsed's `--rail-w: 0` — only pin
    // the custom width while the rail is open (grey-column regression).
    if (ui.railW !== null && ui.railOpen) {
      workbench.style.setProperty('--rail-w', `${ui.railW}px`);
    } else {
      workbench.style.removeProperty('--rail-w');
    }
    workbench.classList.toggle('rail-collapsed', !ui.railOpen);
    railBtn.setAttribute('aria-pressed', String(ui.railOpen));
  };
  applyUi();
  railBtn.onclick = () => {
    ui.railOpen = !ui.railOpen;
    applyUi();
    saveUi(ui);
  };
  // Drag to resize, double-click to reset to the default width.
  const attachResizer = (
    el: HTMLElement,
    resize: (ev: PointerEvent) => void,
    reset: () => void,
  ): void => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      const move = (ev: PointerEvent): void => {
        resize(ev);
        applyUi();
      };
      const up = (): void => {
        el.classList.remove('dragging');
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        saveUi(ui);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
    el.addEventListener('dblclick', () => {
      reset();
      applyUi();
      saveUi(ui);
    });
  };
  attachResizer(
    $('editor-resizer'),
    (ev) => {
      const max = Math.max(320, window.innerWidth * 0.75);
      ui.editorW = Math.min(max, Math.max(260, ev.clientX));
    },
    () => {
      ui.editorW = null;
    },
  );
  attachResizer(
    $('rail-resizer'),
    (ev) => {
      const max = Math.max(320, window.innerWidth * 0.5);
      ui.railW = Math.min(max, Math.max(220, window.innerWidth - ev.clientX));
    },
    () => {
      ui.railW = null;
    },
  );

  // ---- animated plot preview ----
  const plotBtn = $('btn-plot') as HTMLButtonElement;
  const speedSel = $('plot-speed') as HTMLSelectElement;
  const fmtTime = (s: number): string => {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  speedSel.onchange = () => preview.setPlotSpeed(parseFloat(speedSel.value));
  plotBtn.onclick = async () => {
    if (preview.plotting) {
      preview.stopPlot();
      plotBtn.textContent = '▶ Plot';
      statusMsg.className = 'status-ok';
      statusMsg.textContent = 'ok';
      return;
    }
    if (!lastResult) return;
    plotBtn.textContent = '■ Stop';
    try {
      const activeProf = activeProfile();
      const tol = machineTolerance(activeProf, lastResult.pens);
      // The same tour budget as Plot and Export: the simulation must show
      // the order the machine will actually run.
      // The SELECTED chains of the one plan — what Plot and Export use too.
      const plan = encodeToolpath(await drawing.selectedToolpath(tol));
      preview.startPlot(
        plan,
        lastResult.pens,
        machineTiming(activeProf),
        parseFloat(speedSel.value),
        (elapsed, total, pen) => {
          statusMsg.className = 'status-ok';
          statusMsg.textContent =
            `plotting ${fmtTime(elapsed)} / ${fmtTime(total)}` + (pen ? ` · ${pen}` : '');
        },
        () => {
          plotBtn.textContent = '▶ Plot';
          statusMsg.className = 'status-ok';
          statusMsg.textContent = 'plot complete';
        },
      );
    } catch (err) {
      plotBtn.textContent = '▶ Plot';
      statusMsg.className = 'status-err';
      statusMsg.textContent = err instanceof Error ? err.message : String(err);
    }
  };

  $('btn-fit').onclick = () => preview.fit();
  const dbgWire = (id: string, key: 'occluded' | 'bridges' | 'cuts'): void => {
    ($(id) as HTMLInputElement).onchange = (e) => {
      preview.debug[key] = (e.target as HTMLInputElement).checked;
      // The ghost is engine-computed — re-render to get (or drop) it; the
      // other layers just repaint.
      if (key === 'occluded') void run();
      else preview.draw();
    };
  };
  dbgWire('dbg-occluded', 'occluded');
  dbgWire('dbg-bridges', 'bridges');
  dbgWire('dbg-cuts', 'cuts');

  if (frozenId) {
    // Preserved content, not regeneration: the saved plan bytes are verified
    // against their hash, adopted by the worker, and shown as the drawing.
    // Pens come from the record, not the mutable library.
    void (async () => {
      try {
        const { meta, plan: bytes } = await loadResult(frozenId);
        if (!meta.profile) throw new Error('this result was saved without a machine profile; it can be shown and exported, not timed');
        frozenExecution = { name: meta.profile.name, opts: meta.profile.timing as EstimateOpts, tolerance: meta.profile.tolerance, pens: meta.pens };
        await client.loadPlan(bytes, meta.settings, meta.planHash, meta.pens);
        const paper = meta.paper;
        const frozen = {
          frags: [], prims: [], pens: meta.pens, paper,
          stats: { shapesIn: 0, fragments: 0, fillPrims: 0, clean: 0, culledContained: 0, culledOffPaper: 0, renderMs: 0 },
          frame: { offsetX: 0, offsetY: 0, inner: { innerW: paper.w, innerH: paper.h } },
          raw: { prims: new Float64Array(0), frags: new Float64Array(0) },
        } as unknown as RenderResult;
        lastResult = frozen;
        preview.setResult(frozen);
        inspector.clear('a saved result has no inspectable material — it is preserved output, not a run');
        await drawing.setPlan({ buffer: bytes, settings: meta.settings, planHash: meta.planHash }, meta.pens);
        drawing.showOmitted = false;
        showSelection();
        preview.setSelection({ chains: drawing.plan!.chains, from: 0, to: drawing.plan!.chains.length, showOmitted: false });
        statusMsg.className = 'status-ok';
        statusMsg.textContent = `saved result ${frozenId}: ${meta.selection.count} chains of ${meta.provenance.sketch ?? 'a sketch'} (seed ${meta.provenance.seed ?? '—'}), frozen — source not executed`;
        statusStats.textContent = `plan ${meta.planHash.slice(0, 12)}… · from ${meta.sourcePlanHash.slice(0, 12)}… chains ${meta.selection.from}–${meta.selection.to} · saved ${meta.savedAt.slice(0, 16).replace('T', ' ')} · build ${meta.build}`;
      } catch (err) {
        statusMsg.className = 'status-err';
        statusMsg.textContent = `saved result ${frozenId}: ${err instanceof Error ? err.message : String(err)} — the SVG on the Results page is still usable`;
      }
    })();
  } else {
    void run();
  }

  // Stale-tab guard: the server reports its build id; when a deploy changes
  // it, say so instead of letting the tab run old code silently.
  void (async () => {
    const fetchBuild = async (): Promise<string | null> => {
      try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return null;
        return ((await res.json()) as { build: string }).build;
      } catch {
        return null; // dev server has no /api/version
      }
    };
    const initial = await fetchBuild();
    if (initial === null) return;
    setInterval(() => {
      void fetchBuild().then((build) => {
        if (build !== null && build !== initial) {
          statusMsg.className = 'status-err';
          statusMsg.textContent = 'a new studio build was deployed — reload to pick it up (Ctrl+Shift+R)';
        }
      });
    }, 30_000);
  })();
}

void boot();
