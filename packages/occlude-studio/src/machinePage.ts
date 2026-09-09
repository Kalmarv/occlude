/**
 * The Machine page: everything about one plotter that is not "plot this
 * sketch now" — its profile (set once), its calibration (cards run in
 * sequence, readings typed in as they come off the paper), and its serial
 * log. Own connection: Web Serial hands the port to one page at a time, and
 * calibrating is a separate sitting from drawing.
 */

import './style.css';

import type { PenDef } from 'occlude';

import { serialSupported, type PlotProgress } from './ebb.js';
import {
  buildBedLevel,
  buildCalibration, buildConnect, buildLog, buildManualControls, buildProfileForm,
  buildProfileSelect, createSession,
} from './machine.js';
import { loadPens, loadProfiles, loadSettings } from './store.js';
import { el, hint, segmented } from './widgets.js';
import { mountShell } from './shell.js';
mountShell('machine');

const main = document.getElementById('machine-main')!;

async function boot(): Promise<void> {
  if (!serialSupported()) {
    main.append(hint(window.isSecureContext
      ? 'Web Serial needs Chrome or Edge.'
      : 'Web Serial needs a secure context — open the studio over HTTPS (or localhost).'));
    return;
  }
  const pens: PenDef[] = await loadPens();
  const profiles = await loadProfiles();
  const settings = loadSettings();

  const status = el('div', 'panel-hint status-line');
  const showErr = (e: unknown): void => {
    status.textContent = e instanceof Error ? e.message : String(e);
  };
  const m = createSession(profiles, settings, () => pens, showErr);

  // Header strip: which machine, connected or not, what it is doing.
  const connect = buildConnect(m);
  const progress = el('div', 'panel-hint progress-text');
  const bar = document.createElement('progress');
  bar.className = 'plot-progress';
  bar.max = 1;
  bar.value = 0;
  const onProgress = (p: PlotProgress): void => {
    bar.value = p.totalMs > 0 ? Math.min(1, p.elapsedMs / p.totalMs) : 0;
    const eta = Math.max(0, p.etaMs / 60000);
    const base = p.state === 'done' ? 'done' : p.state === 'stopped' ? 'stopped'
      : `${p.state} · ${p.penName} · ${eta.toFixed(1)} min left`;
    progress.textContent = p.warning ? `${base} · ⚠ ${p.warning}` : base;
  };
  const stop = el('button', 'plot-stop', 'Stop');
  stop.onclick = () => void m.ebb.stop().catch(showErr);
  const head = el('div', 'machine-head',
    el('div', 'machine-title', buildProfileSelect(m, profiles, true), connect.root),
    el('div', 'machine-run', stop, bar, progress),
    status,
  );

  // Calibration cards inherit the physical pen's tuning: the pen you'd plot
  // with. First library pen unless chosen here.
  // One choice, two tabs: each tab gets its own select, kept in step.
  let chosenPen = pens[0]?.name ?? '';
  const selects: HTMLSelectElement[] = [];
  const penPicker = (): HTMLSelectElement => {
    const sel = document.createElement('select');
    for (const p of pens) {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.name;
      sel.append(o);
    }
    sel.value = chosenPen;
    sel.onchange = () => { chosenPen = sel.value; for (const other of selects) other.value = chosenPen; };
    selects.push(sel);
    return sel;
  };
  const penSelect = penPicker();
  const basePen = (): PenDef | undefined => pens.find((p) => p.name === chosenPen) ?? pens[0];

  const profile = el('section', 'machine-tab', buildProfileForm(m));
  const calibration = el('section', 'machine-tab',
    el('div', 'cal-side',
      el('h3', undefined, 'Position'),
      hint('Park at the bed corner and Set bed origin before any card; the cards draw from there.'),
      buildManualControls(m),
      el('h3', undefined, 'Pen'),
      hint('Cards inherit this pen’s settle and width.'),
      penSelect,
    ),
    buildCalibration(m, onProgress, basePen),
  );
  const bed = buildBedLevel(m, onProgress, basePen);
  const bedLevel = el('section', 'machine-tab',
    el('div', 'cal-side',
      el('h3', undefined, 'Position'),
      hint('Park at the bed corner and Set bed origin before testing a cell; the check draws from there.'),
      buildManualControls(m),
      el('h3', undefined, 'Pen'),
      hint('The check inherits this pen’s settle and width.'),
      penPicker(),
    ),
    bed.root,
  );
  const log = el('section', 'machine-tab', buildLog(m));

  const tabs = { profile, calibration, bedLevel, log };
  const show = (key: keyof typeof tabs): void => {
    for (const [k, t] of Object.entries(tabs)) t.hidden = k !== key;
    if (key === 'bedLevel') bed.refresh();
    location.hash = key;
  };
  const initial = (location.hash.slice(1) || 'calibration') as keyof typeof tabs;
  const nav = segmented(
    [
      { key: 'profile' as const, label: 'Profile', title: 'Bed, axes, servo, motion — set once' },
      { key: 'calibration' as const, label: 'Calibration', title: 'The cards, in order, and their readings' },
      { key: 'bedLevel' as const, label: 'Bed level', title: 'The lift map cell by cell: see, adjust, test one cell' },
      { key: 'log' as const, label: 'Log', title: 'Serial transcript' },
    ],
    tabs[initial] ? initial : 'calibration',
    show,
  );
  main.append(head, nav.root, profile, calibration, bedLevel, log);
  show(tabs[initial] ? initial : 'calibration');
}

void boot();
