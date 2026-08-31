/** occlude studio: wire editor → runner → render worker → preview → panels. */

import './style.css';
import { clearRuntimeMarkers, createEditor, setRuntimeMarker } from './editor.js';
import { buildRail } from './panels.js';
import { Preview } from './preview.js';
import { currentSeed, runSketch } from './runner.js';
import { preloadAssets } from './assetLoader.js';
import {
  download, loadPens, loadSettings, loadSketch, loadSketchName, loadUi,
  saveSketch, saveSketchName, saveUi,
} from './store.js';
import { UiPanel } from './uiPanel.js';
import { RenderClient } from './workerClient.js';
import type { RenderResult } from 'occlude';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/**
 * Crash recovery: the sketch executes synchronously on the main thread, so a
 * runaway loop (`x += 0` mid-edit) freezes or OOM-kills the tab before any
 * error can surface. The sentinel is set just before that dangerous window
 * and cleared right after — if a page load finds it still set, the last run
 * never finished, and rendering starts paused so the bad code can be edited
 * without instantly re-executing.
 */
const RUN_SENTINEL = 'occlude.run-in-progress';

async function boot(): Promise<void> {
  const statusMsg = $('status-msg');
  const statusStats = $('status-stats');
  const statusSeed = $('status-seed');
  const titleEl = $('sketch-title') as HTMLInputElement;

  let crashed = localStorage.getItem(RUN_SENTINEL) !== null;
  localStorage.removeItem(RUN_SENTINEL);
  let renderOn = !crashed;
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
  const settings = loadSettings();
  const client = new RenderClient();
  const editor = createEditor($('editor'), loadSketch());
  const preview = new Preview($('preview') as HTMLCanvasElement);
  let lastResult: RenderResult | null = null;
  let pending: number | null = null;
  let sketchName = loadSketchName();

  function setTitle(): void {
    titleEl.value = sketchName;
  }
  setTitle();
  titleEl.onchange = () => {
    sketchName = titleEl.value.trim();
    saveSketchName(sketchName);
  };

  function renderSeedControls(): void {
    statusSeed.innerHTML = '';
    const seed = currentSeed();
    const label = document.createElement('span');
    label.textContent = `seed ${seed}`;
    const reroll = document.createElement('button');
    reroll.textContent = 'reroll';
    reroll.title = 'New random seed';
    reroll.onclick = () => {
      const url = new URL(location.href);
      url.searchParams.set('seed', String(Math.floor(Math.random() * 2 ** 31)));
      history.replaceState(null, '', url);
      void run();
    };
    const share = document.createElement('button');
    share.textContent = 'copy url';
    share.title = 'Copy a shareable URL with this seed';
    share.onclick = () => {
      const url = new URL(location.href);
      url.searchParams.set('seed', seed);
      void navigator.clipboard.writeText(url.toString());
    };
    statusSeed.append(label, reroll, share);
  }

  async function run(): Promise<void> {
    try {
      await runInner();
    } catch (err) {
      statusMsg.className = 'status-err';
      statusMsg.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  async function runInner(): Promise<void> {
    saveSketch(editor.getValue()); // persist BEFORE executing — survives a crash
    if (!renderOn) {
      statusMsg.className = 'status-err';
      statusMsg.textContent = crashed
        ? 'last run never finished (runaway loop / out of memory?) — rendering is ' +
          'paused so you can fix the sketch; press ▶ render when ready'
        : 'rendering paused — press ▶ render to run the sketch';
      return;
    }
    const emitted = await editor.emit();
    if (!emitted.js) {
      statusMsg.className = 'status-err';
      statusMsg.textContent = emitted.errors[0] ?? 'syntax error';
      return;
    }
    clearRuntimeMarkers(editor.model);
    // Assets referenced by literal name must be fetched/decoded before the
    // synchronous sketch executes.
    try {
      await preloadAssets(emitted.js);
    } catch (err) {
      statusMsg.className = 'status-err';
      statusMsg.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    // Execute + encode on the main thread (cheap); geometry in the worker.
    // This synchronous window is where a runaway loop hangs the tab — the
    // sentinel brackets it so a reload after a crash starts paused.
    localStorage.setItem(RUN_SENTINEL, '1');
    const outcome = runSketch(emitted.js, {
      pens,
      paper: settings.paper === 'Custom' ? settings.customPaper : settings.paper,
      landscape: settings.landscape,
      defaultMarginPct: settings.defaultMarginPct,
      coarsen: 1,
      debugGhost: preview.debug.occluded,
    });
    localStorage.removeItem(RUN_SENTINEL);
    if (outcome.error || !outcome.scene) {
      statusMsg.className = 'status-err';
      statusMsg.textContent =
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      setRuntimeMarker(editor.model, outcome.error);
      return;
    }
    statusMsg.className = 'status-ok';
    statusMsg.textContent = 'rendering…';
    let result: RenderResult | null;
    try {
      result = await client.render(outcome.scene);
    } catch (err) {
      statusMsg.className = 'status-err';
      statusMsg.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    if (result === null) return; // superseded by a newer run
    lastResult = result;
    if (result.stats.shapesIn === 0) {
      statusMsg.className = 'status-err';
      statusMsg.textContent =
        'sketch returned an empty tree — no shapes (check for undefined returns or empty arrays)';
    } else if (result.stats.fragments === 0) {
      statusMsg.className = 'status-err';
      statusMsg.textContent =
        `${result.stats.shapesIn} shape(s) but zero visible strokes — everything is ` +
        'off-paper, fully occluded, or sub-nib (with origin: \'center\', coordinates run ' +
        '±50, so radii/half-sizes belong in 0–50)';
    } else {
      statusMsg.className = 'status-ok';
      statusMsg.textContent = 'ok';
    }
    const s = result.stats;
    statusStats.textContent =
      `${s.fragments} frags · ${s.fillPrims} fill prims · ` +
      `${s.clean} clean · ${s.culledContained + s.culledOffPaper} culled · ` +
      `${s.renderMs.toFixed(1)}ms`;
    preview.setResult(result);
    renderSeedControls();
  }

  function scheduleRun(): void {
    if (pending !== null) clearTimeout(pending);
    pending = window.setTimeout(() => {
      pending = null;
      void run();
    }, 150);
  }

  renderToggle.onclick = () => {
    renderOn = !renderOn;
    if (renderOn) crashed = false; // the crash notice served its purpose
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
    preview,
  };

  const rail = buildRail($('rail'), {
    pens,
    settings,
    client,
    onChanged: () => void run(),
    lastResult: () => lastResult,
    getSource: () => editor.getValue(),
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
        if (file) editor.setValue(await file.text());
        input.value = '';
      };
      input.click();
    },
    downloadSketchFile: () => download(`${sketchName || 'sketch'}.ts`, editor.getValue()),
    livePlot: {
      start: (plan, pens) => preview.startLive(plan, pens),
      progress: (chain) => preview.liveProgress(chain),
      end: () => preview.endLive(),
    },
  });

  // Ctrl/Cmd+S saves to the server-side sketch library, not the web page.
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        editor
          .format()
          .then(() => rail.saveCurrent())
          .then((name) => {
            if (name) {
              statusMsg.className = 'status-ok';
              statusMsg.textContent = `saved '${name}'`;
            } else {
              statusMsg.className = 'status-err';
              statusMsg.textContent = 'name the sketch to save it (Sketches panel)';
            }
          })
          .catch((err: unknown) => {
            statusMsg.className = 'status-err';
            statusMsg.textContent = `save failed: ${
              err instanceof Error ? err.message : String(err)
            }`;
          });
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
      const penTol = lastResult.pens.reduce((tol, pen) => Math.min(tol, pen.width / 4), Infinity);
      const tol = Math.max(0.0001, Math.min(settings.machine.resolution, penTol));
      const plan = await client.exportToolpath(50_000, tol);
      preview.startPlot(
        plan,
        lastResult.pens,
        settings.machine.travelFeed,
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

  void run();

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
