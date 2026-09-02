/** occlude studio: wire editor → runner → render worker → preview → panels. */

import './style.css';
import { clearRuntimeMarkers, createEditor, setRuntimeMarker } from './editor.js';
import { buildRail } from './panels.js';
import { Preview } from './preview.js';
import {
  download, loadPens, loadProfiles, loadSettings, loadSketch, loadSketchName,
  loadUi, saveSketch, saveSketchName, saveUi,
} from './store.js';
import { listFills, loadFill, saveFill } from './fillApi.js';
import {
  createSnapshot, forkSketch, loadSketchByName, putThumb, thumbFromCanvas,
} from './sketchApi.js';
import { customFillNames, embedFills, importSketchWithFills } from './fillEmbed.js';
import { UiPanel } from './uiPanel.js';
import { RenderClient, type WorkerError } from './workerClient.js';
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
  if (!profiles.some((p) => p.name === settings.activeProfile)) {
    settings.activeProfile = profiles[0].name;
  }
  const client = new RenderClient();
  const editor = createEditor($('editor'), loadSketch());
  const preview = new Preview($('preview') as HTMLCanvasElement);
  let lastResult: RenderResult | null = null;
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
  let seed: string | null = new URL(location.href).searchParams.get('seed');

  function renderSeedControls(used: string): void {
    statusSeed.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = `seed ${used}`;
    const reroll = document.createElement('button');
    reroll.textContent = 'reroll';
    reroll.title = 'New random seed';
    reroll.onclick = () => {
      seed = String(Math.floor(Math.random() * 2 ** 31));
      const url = new URL(location.href);
      url.searchParams.set('seed', seed);
      history.replaceState(null, '', url);
      void run();
    };
    const share = document.createElement('button');
    share.textContent = 'copy url';
    share.title = 'Copy a shareable URL with this seed';
    share.onclick = () => {
      const url = new URL(location.href);
      url.searchParams.set('seed', used);
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
    saveSketch(editor.getValue()); // persist BEFORE executing — survives anything
    if (!renderOn) {
      statusMsg.className = 'status-err';
      statusMsg.textContent = 'rendering paused — press ▶ render to run the sketch';
      return;
    }
    const emitted = await editor.emit();
    if (!emitted.js) {
      statusMsg.className = 'status-err';
      statusMsg.textContent = emitted.errors[0] ?? 'syntax error';
      return;
    }

    clearRuntimeMarkers(editor.model);
    statusMsg.className = 'status-ok';
    statusMsg.textContent = 'rendering…';
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
          seed,
        },
      });
    } catch (err) {
      statusMsg.className = 'status-err';
      statusMsg.textContent = err instanceof Error ? err.message : String(err);
      if ((err as WorkerError).sketch) setRuntimeMarker(editor.model, err);
      return;
    }
    if (reply === null) return; // superseded by a newer run
    const result: RenderResult = reply.result;
    // Capture the seed the worker actually used (the rolled session seed on
    // a fresh run) so respawns and shares stay sticky.
    seed = reply.seedUsed;
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
      statusMsg.textContent = note ? `ok · ${note}` : 'ok';
      note = null;
    }
    const s = result.stats;
    statusStats.textContent =
      `${s.fragments} frags · ${s.fillPrims} fill prims · ` +
      `${s.clean} clean · ${s.culledContained + s.culledOffPaper} culled · ` +
      `${s.renderMs.toFixed(1)}ms`;
    preview.setResult(result);
    uiPanel.setProbes(reply.probes);
    renderSeedControls(reply.seedUsed);
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
    profiles,
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
  });

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
      const label = prompt('Snapshot label (optional):', '') ?? null;
      if (label === null) return;
      const id = await createSnapshot(name, { seed, label });
      const png = await thumbFromCanvas($('preview') as HTMLCanvasElement);
      if (png) await putThumb(name, png, id);
      status(true, `snapshot of '${name}' saved (seed ${seed ?? '—'})`);
    } catch (err) {
      status(false, `snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  ($('btn-fork') as HTMLButtonElement).onclick = async () => {
    try {
      const name = await rail.saveCurrent();
      if (!name) {
        status(false, 'name and save the sketch before forking it');
        return;
      }
      const to = prompt(`Fork '${name}' as:`, `${name}-2`)?.trim();
      if (!to) return;
      const made = await forkSketch(name, to);
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
      const activeProf = profiles.find((p) => p.name === settings.activeProfile) ?? profiles[0];
      const tol = Math.max(0.0001, Math.min(activeProf.machine.resolution, penTol));
      const plan = await client.exportToolpath(50_000, tol);
      preview.startPlot(
        plan,
        lastResult.pens,
        (profiles.find((p) => p.name === settings.activeProfile) ?? profiles[0]).machine.travelFeed,
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
