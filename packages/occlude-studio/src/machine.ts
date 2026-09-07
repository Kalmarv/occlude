/**
 * The machine session and its controls, shared by the studio rail's Plot mode
 * and the Machine page. One Ebb per page (Web Serial hands a port to one page
 * at a time); every control reads the ACTIVE profile through `prof()` — never
 * captured — so a profile switch is followed instantly.
 *
 * Builders return DOM. Layout and colour live in style.css; the vocabulary
 * here is the machine's: origins, seat, lift, settle.
 */

import { liftMapFromCounts, parseCounts, refineLiftMap, type LiftMap, type PenDef } from 'occlude';

import { cellTestPulses, heatColour, liftCells, nudgeCell, RUNG, setCellThreshold, type LiftCell } from './liftGrid.js';

import {
  backlashSquares, calDots, calHatch, calLines, calSegments, cornerRinging,
  downSweep, liftGrid, liftTraverse, registrationProbe, settleLift, type Diagnostic,
} from './diagnostics.js';
import { Ebb, type EbbOptions, type PlotProgress } from './ebb.js';
import { download, saveProfiles, saveSettings, type MachineProfile, type Settings } from './store.js';
import { button, checkbox, el, hint, numberInput, row } from './widgets.js';

export interface MachineSession {
  ebb: Ebb;
  /** The active profile, live. */
  prof(): MachineProfile;
  opts(): EbbOptions;
  /** Save the profiles to the server (and the local cache). */
  persist(): void;
  /** Library pens, live (calibration cards inherit the physical pen's tuning). */
  pens(): PenDef[];
  /** Surface an error where the user is looking. */
  showErr(e: unknown): void;
  /** Subscribe to profile switches (forms re-render). */
  onProfileSwitch(fn: () => void): void;
  switchProfile(name: string): void;
  /** Set by the host so a switch can refresh estimates etc. */
  onChanged?: () => void;
}

export function createSession(
  profiles: MachineProfile[],
  settings: Settings,
  pens: () => PenDef[],
  showErr: (e: unknown) => void,
): MachineSession {
  const ebb = new Ebb();
  const prof = (): MachineProfile =>
    profiles.find((pp) => pp.name === settings.activeProfile) ?? profiles[0];
  const listeners: (() => void)[] = [];
  const session: MachineSession = {
    ebb,
    prof,
    opts: () => ({
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
      liftMap: prof().ebb.liftMap,
      liftMarginPulses: prof().ebb.liftMarginPulses,
      settleCurve: prof().ebb.settleCurve,
      driftCheckEvery: prof().ebb.driftCheckEvery,
    }),
    persist: () => saveProfiles(profiles),
    pens,
    showErr,
    onProfileSwitch: (fn) => listeners.push(fn),
    switchProfile: (name) => {
      settings.activeProfile = name;
      saveSettings(settings);
      for (const fn of listeners) fn();
      session.onChanged?.();
    },
  };
  return session;
}

// ---- connect --------------------------------------------------------------

/** Connect/Disconnect with a status line: a brass dot when the board answers. */
export function buildConnect(m: MachineSession): { root: HTMLElement; status: HTMLElement } {
  const status = el('span', 'conn-status', 'not connected');
  const dot = el('span', 'conn-dot');
  const btn = button('Connect', async () => {
    try {
      if (m.ebb.connected) {
        await m.ebb.disconnect();
        btn.textContent = 'Connect';
        status.textContent = 'not connected';
        dot.classList.remove('on');
        return;
      }
      const v = await m.ebb.connect({ penUpPulse: m.prof().ebb.penUpPulse, penDownPulse: m.prof().ebb.penDownPulse });
      btn.textContent = 'Disconnect';
      status.textContent = v || 'connected';
      dot.classList.add('on');
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  });
  btn.className = 'primary connect';
  const root = el('div', 'connect-row', btn, dot, status);
  return { root, status };
}

// ---- profiles -------------------------------------------------------------

/** The profile selector alone (rail); `manage` adds duplicate/delete (page). */
export function buildProfileSelect(
  m: MachineSession,
  profiles: MachineProfile[],
  manage: boolean,
): HTMLElement {
  const select = document.createElement('select');
  const render = (): void => {
    select.innerHTML = '';
    for (const pp of profiles) {
      const o = document.createElement('option');
      o.value = pp.name;
      o.textContent = pp.name;
      o.selected = pp.name === m.prof().name;
      select.append(o);
    }
  };
  select.onchange = () => m.switchProfile(select.value);
  m.onProfileSwitch(render);
  render();
  const wrap = el('div', 'row', select);
  if (manage) {
    const dup = button('Duplicate', () => {
      const name = prompt('New profile name', `${m.prof().name} copy`)?.trim();
      if (!name || profiles.some((pp) => pp.name === name)) return;
      profiles.push({ ...structuredClone(m.prof()), name });
      m.persist();
      m.switchProfile(name);
    });
    dup.title = 'Copy the active profile (e.g. a large-format regime of the same machine)';
    const del = button('Delete', () => {
      if (profiles.length <= 1) return;
      if (!confirm(`Delete machine profile '${m.prof().name}'?`)) return;
      const i = profiles.findIndex((pp) => pp.name === m.prof().name);
      profiles.splice(i, 1);
      m.persist();
      m.switchProfile(profiles[0].name);
    });
    del.className = 'danger-quiet';
    wrap.append(dup, del);
  }
  return wrap;
}

// ---- manual control ---------------------------------------------------------

/**
 * Jog pad, pen, seating, origins. `compact` is the rail's Plot mode; the
 * page gets the same controls with room to label them.
 */
export function buildManualControls(m: MachineSession): HTMLElement {
  const { ebb } = m;
  const jogStep = numberInput(10, 1, () => undefined);
  jogStep.title = 'jog distance, mm';
  jogStep.className = 'jog-step';
  const jog = (dx: number, dy: number, glyph: string, title: string): HTMLButtonElement => {
    const b = button(glyph, async () => {
      const d = Math.abs(parseFloat(jogStep.value) || 10);
      await ebb.jog(dx * d, dy * d, m.opts()).catch(m.showErr);
    });
    b.title = title;
    return b;
  };
  const pad = el('div', 'jog-pad',
    el('span'), jog(0, -1, '↑', 'jog up'), el('span'),
    jog(-1, 0, '←', 'jog left'), jogStep, jog(1, 0, '→', 'jog right'),
    el('span'), jog(0, 1, '↓', 'jog down'), el('span'),
  );

  const penUp = button('Pen up', () => void ebb.penUp().catch(m.showErr));
  const penDown = button('Pen down', () => void ebb.penDown().catch(m.showErr));
  // Seating: the servo as the shim. Step 1 parks the horn at the seat pulse
  // with the pen down so the slider sits off its stop; loosen, let the pen
  // fall to the paper, clamp. Step 2 restores the down pulse: the paper holds
  // the slider up by exactly the seat lift. Same preload for every pen.
  let seating = false;
  const seatTitle =
    'Repeatable seating: parks the horn at the seat pulse with the pen down so the slider sits off its stop. ' +
    'Loosen the clamp, let the pen fall to the paper, clamp, press again to restore the down pulse.';
  const seat = button('Seat pen', async () => {
    if (!ebb.connected || ebb.plotting) return;
    try {
      const e = m.prof().ebb;
      if (!seating) {
        await ebb.cmd(`SC,5,${Math.round(e.seatPulse)}`);
        await ebb.penDown(300);
        seating = true;
        seat.textContent = 'Clamped, finish seating';
        seat.classList.add('armed');
        seat.title = 'The horn is holding the slider at the seat pulse. Loosen the clamp, let the pen fall to the paper, clamp it, then press this.';
      } else {
        await ebb.cmd(`SC,5,${Math.round(e.penDownPulse)}`);
        await ebb.penDown(300);
        seating = false;
        seat.textContent = 'Seat pen';
        seat.classList.remove('armed');
        seat.title = seatTitle;
      }
    } catch (err) {
      m.showErr(err);
    }
  });
  seat.title = seatTitle;
  const penRow = el('div', 'row', penUp, penDown, seat);

  // Two origins: the BED corner (the lift map's frame — same physical corner
  // every time) and the PAPER corner (an offset, no zeroing).
  const paperStatus = el('span', 'origin-status');
  const showPaper = (): void => {
    const [x, y] = ebb.paperOffset;
    paperStatus.textContent = x === 0 && y === 0 ? 'paper at bed origin' : `paper at ${x}, ${y} mm`;
  };
  showPaper();
  const setBed = button('Bed origin', () => void ebb.setOrigin().then(showPaper).catch(m.showErr));
  setBed.title = 'Zero the machine here: the BED corner the lift map was measured from. Use the same corner every time. Clears the paper origin.';
  const setPaper = button('Paper origin', () => {
    if (!ebb.connected) return;
    ebb.setPaperOrigin(m.opts());
    showPaper();
  });
  setPaper.title = 'Record the current position as the sheet’s corner, without zeroing. Plots draw from here; the lift map still reads bed coordinates.';
  const goPaper = button('Go to paper', () => void ebb.goToPaperOrigin(m.opts()).catch(m.showErr));
  const home = button('Home', () => void ebb.home().then(showPaper).catch(m.showErr));
  home.title = 'Return to the bed origin';
  const release = button('Release', () => void ebb.cmd('EM,0,0').catch(m.showErr));
  release.title = 'De-energise the steppers so the carriage can be moved by hand';
  const origins = el('div', 'origins',
    el('div', 'row', setBed, setPaper),
    el('div', 'row', goPaper, home),
    el('div', 'row', paperStatus),
    el('div', 'row', release),
  );

  return el('div', 'manual', pad, penRow, origins);
}

// ---- profile form (Machine page) -----------------------------------------

/** Bed, motion, servo: the set-once numbers of one machine, one form. */
export function buildProfileForm(m: MachineSession): HTMLElement {
  const root = el('div', 'profile-form');
  const render = (): void => {
    const p = m.prof();
    const e = p.ebb;
    const mc = p.machine;
    const save = (): void => m.persist();
    const section = (title: string, note: string, ...rows: HTMLElement[]): HTMLElement =>
      el('section', 'form-section', el('h3', undefined, title), hint(note), ...rows);

    const bed = section(
      'Bed',
      'The travel from the bed origin. The lift grid covers it; the fit check uses it.',
      row('Width mm', numberInput(mc.bedW, 1, (v) => { mc.bedW = v; save(); })),
      row('Height mm', numberInput(mc.bedH, 1, (v) => { mc.bedH = v; save(); })),
      row('Travel mm/min', numberInput(mc.travelFeed, 100, (v) => { mc.travelFeed = Math.max(1, v); save(); }),
        'Pen-up travel feed'),
    );

    const flips = el('div', 'row',
      checkbox('Swap XY', e.swapXY, (v) => { e.swapXY = v; save(); }),
      checkbox('Invert X', e.invertX, (v) => { e.invertX = v; save(); }),
      checkbox('Invert Y', e.invertY, (v) => { e.invertY = v; save(); }),
    );
    const axes = section(
      'Axes',
      'Paper to machine mapping. Verify steps/mm with the calibration sheet’s 100 mm ruler.',
      row('Steps/mm', numberInput(e.stepsPerMm, 0.1, (v) => { e.stepsPerMm = v; save(); })),
      flips,
    );

    // SC registers are board state: apply edits immediately when connected.
    const upIn = numberInput(e.penUpPulse, 100, (v) => {
      e.penUpPulse = v; save();
      if (m.ebb.connected) void m.ebb.cmd(`SC,4,${Math.round(v)}`).catch(m.showErr);
    });
    upIn.title = 'Pen UP pulse (SC,4). Lower = more lift; below ~8600 the horn stalls on this machine.';
    const downIn = numberInput(e.penDownPulse, 100, (v) => {
      e.penDownPulse = v; save();
      if (m.ebb.connected) void m.ebb.cmd(`SC,5,${Math.round(v)}`).catch(m.showErr);
    });
    downIn.title = 'Pen DOWN pulse (SC,5). Above the release point found by the down sweep.';
    const servo = section(
      'Servo',
      'Pulses in 1/12 MHz ticks, write-only on the board. Found by the calibration cards.',
      row('Pen up', upIn, 'SC,4 — the full lift'),
      row('Pen down', downIn, 'SC,5 — horn fully clear of the slider'),
      row('Seat pulse', numberInput(e.seatPulse, 100, (v) => { e.seatPulse = Math.round(v); save(); }),
        'Where the horn lifts the slider just off its stop: the preload every pen gets (Seat pen)'),
      row('Lift margin', numberInput(e.liftMarginPulses, 100, (v) => { e.liftMarginPulses = Math.max(0, Math.round(v)); save(); }),
        'Pulses of extra lift below each lift-map cell’s last-clean pulse (one ladder rung = 800)'),
    );

    const lm = checkbox('Hardware ramps (LM)', e.lmMotion, (v) => { e.lmMotion = v; save(); });
    lm.title = 'Constant-acceleration moves interpolated at 25 kHz in firmware. Off = XM packets (firmware < 2.5.3).';
    const motion = section(
      'Motion',
      'Look-ahead planning limits. Corner ringing and the timing cards tune these.',
      row('Draw accel mm/s²', numberInput(e.acceleration, 50, (v) => { e.acceleration = Math.max(1, v); save(); })),
      row('Travel accel mm/s²', numberInput(e.travelAcceleration, 50, (v) => { e.travelAcceleration = Math.max(1, v); save(); })),
      row('Junction mm', numberInput(e.junctionDeviation, 0.005, (v) => { e.junctionDeviation = Math.max(0, v); save(); }),
        'Cornering tolerance'),
      row('Min cruise', numberInput(e.minimumCruiseRatio, 0.05, (v) => { e.minimumCruiseRatio = Math.max(0, Math.min(0.99, v)); save(); }),
        '0–0.99; suppresses speed spikes on short moves'),
      row('Drift check every', numberInput(e.driftCheckEvery, 100, (v) => { e.driftCheckEvery = Math.max(0, Math.round(v)); save(); }),
        'Chains between position checks (each drains the FIFO ~0.5 s). 0 = at plot end only'),
      lm,
    );
    root.replaceChildren(bed, axes, servo, motion);
  };
  m.onProfileSwitch(render);
  render();
  return root;
}

// ---- calibration (Machine page) --------------------------------------------

/**
 * The cards, in the order they are run. Each step: what it measures, the
 * button, and where its reading goes. Readings are typed in as they are read
 * off the paper and become profile state (lift map, settle curve).
 */
/** Plot one card on the connected machine; a no-op while disconnected or busy. */
export function cardRunner(m: MachineSession, onProgress: (p: PlotProgress) => void): (d: Diagnostic) => Promise<void> {
  const { ebb } = m;
  return async (d: Diagnostic): Promise<void> => {
    if (!ebb.connected || ebb.plotting) return;
    try {
      await ebb.plot(
        d.plan, d.pens, m.opts(), onProgress, undefined, undefined, undefined,
        d.servo ? (i) => d.servo?.[i] : undefined,
      );
    } catch (e) {
      m.showErr(e);
    }
  };
}

export function buildCalibration(
  m: MachineSession,
  onProgress: (p: PlotProgress) => void,
  basePen: () => PenDef | undefined,
): HTMLElement {
  const run = cardRunner(m, onProgress);

  // Ladder: six lift pulses for the pen-height cards. 0/0 = wide first pass.
  let ladderFrom = 0;
  let ladderTo = 0;
  const ladder = (from: number, to: number, n: number): number[] =>
    Array.from({ length: n }, (_, i) => Math.round((from + ((to - from) * i) / (n - 1)) / 100) * 100);
  const liftPulses = (): number[] => {
    const e = m.prof().ebb;
    return ladder(ladderFrom || e.penUpPulse, ladderTo || e.penDownPulse - 2000, 6);
  };
  const downPulses = (): number[] => {
    const e = m.prof().ebb;
    const from = Math.min(e.seatPulse - 200, e.penDownPulse - 1200);
    return Array.from({ length: 6 }, (_, i) => Math.round(from + ((e.penDownPulse - from) * i) / 5));
  };
  const fromIn = numberInput(0, 100, (v) => { ladderFrom = v; });
  fromIn.placeholder = 'from';
  fromIn.title = 'Most lift in the ladder (SC,4). 0 = the profile’s pen-up pulse.';
  const toIn = numberInput(0, 100, (v) => { ladderTo = v; });
  toIn.placeholder = 'to';
  toIn.title = 'Least lift in the ladder. 0 = 2000 below the pen-down pulse.';
  const ladderRow = row('Lift ladder', el('div', 'row', fromIn, toIn),
    'Six pulses from ‘from’ to ‘to’ for the lift cards. Leave 0/0 for the wide first pass; then narrow onto where ink started.');

  const step = (n: number, title: string, what: string, ...body: HTMLElement[]): HTMLElement =>
    el('li', 'cal-step', el('div', 'cal-head', el('span', 'cal-num', String(n)), el('h3', undefined, title)), hint(what), ...body);

  // 1 seat
  const seatNote = hint(
    'Position → Seat pen: the horn holds the slider at the seat pulse; loosen the clamp, let the pen fall to the paper, clamp, press again.',
  );

  // 2 traverse
  const traverse = button('Run lift traverse (~5 min)', () => run(liftTraverse(basePen(), {
    bedW: m.prof().machine.bedW, bedH: m.prof().machine.bedH, pulses: liftPulses(),
    rows: m.prof().machine.bedH >= m.prof().machine.bedW ? 12 : 8,
    cols: m.prof().machine.bedH >= m.prof().machine.bedW ? 8 : 12,
  })));

  // 3 grid + counts
  const refine = document.createElement('input');
  refine.type = 'checkbox';
  const refineLabel = el('label', 'row', refine, ' refine: unresolved cells only');
  const grid = button('Run lift grid (~1 h)', () => {
    const { bedW, bedH } = m.prof().machine;
    const across = 8;
    const portrait = bedH >= bedW;
    const cols = portrait ? across : Math.max(2, Math.round((across * bedW) / bedH));
    const rows = portrait ? Math.max(2, Math.round((across * bedH) / bedW)) : across;
    const map = m.prof().ebb.liftMap;
    const only = refine.checked && map && map.cols === cols && map.rows === rows
      ? (r: number, c: number) => map.thresholds[r * cols + c] === null
      : undefined;
    return run(liftGrid(basePen(), { bedW, bedH, pulses: liftPulses(), cols, rows, only, dashes: only ? 4 : undefined }));
  });
  const counts = document.createElement('textarea');
  counts.rows = 4;
  counts.placeholder = 'diagonals per cell, one line per row of cells: 0,0,1,2 - 0,1,2,3 …';
  const mapStatus = hint('');
  const describe = (): void => {
    const map = m.prof().ebb.liftMap;
    const curve = m.prof().ebb.settleCurve;
    const curveText = curve && curve.length
      ? `Settle curve: ${[...curve].sort((a, b) => a.pulse - b.pulse).map((p) => `${p.pulse} → ${p.ms} ms`).join(', ')}.`
      : 'No settle curve: every lift settles for the pen’s full penDelay.';
    if (!map) {
      mapStatus.textContent = `No lift map: every travel at full lift. ${curveText}`;
      return;
    }
    const known = map.thresholds.filter((t): t is number => t !== null);
    mapStatus.textContent =
      `Lift map ${map.cols}×${map.rows}: worst cell clears at ${Math.min(...known)}, ` +
      `${map.thresholds.length - known.length} cells unresolved (≥ ${map.unresolvedAbove}). ${curveText}`;
  };
  const applyMap = button('Apply as lift map', () => {
    try {
      const rows = parseCounts(counts.value);
      const { bedW, bedH } = m.prof().machine;
      const g = { cols: rows[0]?.length ?? 0, rows: rows.length, bedW, bedH, margin: 8 };
      const existing = m.prof().ebb.liftMap;
      const refining = existing && existing.cols === g.cols && existing.rows === g.rows && refine.checked;
      m.prof().ebb.liftMap = refining ? refineLiftMap(existing, rows, liftPulses()) : liftMapFromCounts(rows, liftPulses(), g);
      m.persist();
      describe();
    } catch (e) {
      m.showErr(e);
    }
  });
  const clearMap = button('Clear map', () => { delete m.prof().ebb.liftMap; m.persist(); describe(); });
  clearMap.className = 'danger-quiet';

  // 4 settle × lift + curve
  const settle = button('Run settle × lift (~10 min)', () =>
    run(settleLift(basePen(), { pulses: liftPulses(), settles: [200, 300, 400, 500, 600, 700] })));
  const curveIn = document.createElement('input');
  curveIn.type = 'text';
  curveIn.placeholder = 'lowest clean settle per column, e.g. 600,500,400,300,200,200';
  const applyCurve = button('Apply as settle curve', () => {
    try {
      const ms = curveIn.value.split(/[\s,]+/).filter(Boolean).map(Number);
      const pulses = liftPulses();
      if (ms.length !== pulses.length || ms.some((v) => !Number.isFinite(v) || v <= 0)) {
        throw new Error(`settle curve: expected ${pulses.length} values for the ladder ${pulses.join(', ')}`);
      }
      const full = m.prof().ebb.penUpPulse;
      const points = pulses.map((p, i) => ({ pulse: p, ms: ms[i] }));
      if (!points.some((p) => p.pulse === full)) points.push({ pulse: full, ms: Math.max(...ms) });
      m.prof().ebb.settleCurve = points;
      m.persist();
      describe();
    } catch (e) {
      m.showErr(e);
    }
  });
  const clearCurve = button('Clear curve', () => { delete m.prof().ebb.settleCurve; m.persist(); describe(); });
  clearCurve.className = 'danger-quiet';

  // 5 down sweep
  const down = button('Run down sweep (~2 min)', () => run(downSweep(basePen(), { pulses: downPulses() })));

  // 6 motion cards
  const motion = el('div', 'row',
    button('Registration probe', () => run(registrationProbe(basePen()))),
    button('Backlash squares', () => run(backlashSquares(basePen()))),
    button('Corner ringing', () => run(cornerRinging(basePen()))),
  );
  const timing = el('div', 'row',
    button('Dots ×120', () => run(calDots(basePen()))),
    button('Long lines ×40', () => run(calLines(basePen()))),
    button('Dense zigzags', () => run(calSegments(basePen()))),
    button('Hatch square', () => run(calHatch(basePen()))),
  );

  describe();
  m.onProfileSwitch(describe);

  const list = el('ol', 'cal-steps',
    step(1, 'Seat the pen', 'Same preload for every pen, from the servo rather than a shim.', seatNote),
    step(2, 'Lift traverse', 'The fast silhouette of the sag: pen-up sweeps across the bed at each lift pulse. Ink between the edge ticks is where that lift dragged.',
      ladderRow, el('div', 'row', traverse)),
    step(3, 'Lift grid', 'The map. Short hops in every cell at each lift pulse; a zigzag joining the dashes means that lift dragged. Count the diagonals per cell and paste them here, row 0 nearest the origin.',
      el('div', 'row', grid, refineLabel), counts, el('div', 'row', applyMap, clearMap)),
    step(4, 'Settle by lift', 'How long each lift needs before the carriage may move. Columns are the ladder pulses, rows are settles. Type the lowest clean row per column.',
      el('div', 'row', settle), curveIn, el('div', 'row', applyCurve, clearCurve)),
    step(5, 'Down sweep', 'Where the horn releases the pen. Hatch patches at pen-down pulses from just below the seat pulse; the first solid patch is the lowest safe down pulse. Run at 0,0.',
      el('div', 'row', down)),
    step(6, 'Motion', 'Step loss, backlash, cornering ceiling; and the four timing cards the estimator is fitted from.',
      motion, timing),
  );
  return el('div', 'calibration', mapStatus, list);
}

/** A ruler in inches along one edge of the bed plan, 0 at the bed origin;
 * ticks every inch, halves shorter, labels on the whole inches. Positions
 * are percentages, so the ruler follows the frame at any size. */
function inchRuler(lengthMm: number, side: 'top' | 'left'): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', `lift-map-ruler ${side}`);
  const inches = lengthMm / 25.4;
  const T = 18; // ruler thickness, px
  for (let half = 0; half * 0.5 <= inches + 1e-9; half++) {
    const at = (half * 0.5 * 25.4 * 100) / lengthMm;
    const whole = half % 2 === 0;
    const len = whole ? 7 : 4;
    const line = document.createElementNS(NS, 'line');
    if (side === 'top') {
      line.setAttribute('x1', `${at}%`); line.setAttribute('x2', `${at}%`);
      line.setAttribute('y1', String(T)); line.setAttribute('y2', String(T - len));
    } else {
      line.setAttribute('y1', `${at}%`); line.setAttribute('y2', `${at}%`);
      line.setAttribute('x1', String(T)); line.setAttribute('x2', String(T - len));
    }
    svg.append(line);
    if (whole) {
      const text = document.createElementNS(NS, 'text');
      text.textContent = String(half / 2);
      if (side === 'top') {
        text.setAttribute('x', `${at}%`); text.setAttribute('y', '8');
        text.setAttribute('text-anchor', half === 0 ? 'start' : 'middle');
      } else {
        text.setAttribute('x', '8'); text.setAttribute('y', `${at}%`);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('dominant-baseline', half === 0 ? 'hanging' : 'middle');
      }
      svg.append(text);
    }
  }
  return svg;
}

/**
 * Bed level: the lift map as a heat grid of per-cell thresholds, one cell
 * selected for editing, and a one-cell check card so an adjustment can be
 * verified without re-running the whole grid. Pulses, lower = more lift
 * (see liftGrid.ts). Edits go straight into the active profile.
 */
export function buildBedLevel(
  m: MachineSession,
  onProgress: (p: PlotProgress) => void,
  basePen: () => PenDef | undefined,
): { root: HTMLElement; refresh: () => void } {
  const run = cardRunner(m, onProgress);
  const status = hint('');
  const mapGrid = el('div', 'lift-map');
  let selected: { r: number; c: number } | undefined;
  const writeMap = (next: LiftMap): void => {
    m.prof().ebb.liftMap = next;
    m.persist();
    renderMap();
  };
  const renderMap = (): void => {
    const map = m.prof().ebb.liftMap;
    const e = m.prof().ebb;
    mapGrid.replaceChildren();
    if (!map) {
      status.textContent = 'No lift map: every travel is at full lift. Run the lift grid card under Calibration to measure one.';
      return;
    }
    const cells = liftCells(map, e.liftMarginPulses, e.penUpPulse);
    const values = cells.map((c) => c.value);
    const unresolved = cells.filter((c) => c.threshold === null).length;
    status.textContent =
      `${map.cols}×${map.rows} cells over ${map.bedW}×${map.bedH} mm, row 0 at the bed origin. ` +
      `Each cell holds the last pulse that cleared the paper there; the driver travels ${e.liftMarginPulses} pulses below it. ` +
      `Lower pulse = more lift. A pen that drags in a cell wants that cell one rung (${RUNG}) lower. ` +
      `${unresolved} cells unresolved (clean at every rung, counted as ${map.unresolvedAbove}).`;
    const legend = el('div', 'lift-map-legend',
      el('span', undefined, `least lift ${Math.max(...values)}`),
      el('span', 'lift-map-scale'),
      el('span', undefined, `most lift ${Math.min(...values)}`),
    );
    // The bed at its true proportions: the frame is the bed, its padding the
    // card's margin, and every cell keeps the cell's own mm aspect.
    const bed = el('div', 'lift-map-bed');
    bed.style.aspectRatio = `${map.bedW} / ${map.bedH}`;
    bed.style.padding = `${(100 * map.margin) / map.bedH}% ${(100 * map.margin) / map.bedW}%`;
    const grid = el('div', 'lift-map-grid');
    grid.style.gridTemplateColumns = `repeat(${map.cols}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${map.rows}, minmax(0, 1fr))`;
    for (const cell of cells) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lift-cell' + (cell.threshold === null ? ' unresolved' : '') +
        (selected && selected.r === cell.r && selected.c === cell.c ? ' selected' : '');
      b.style.background = heatColour(cell.heat);
      b.textContent = cell.threshold === null ? `≥${map.unresolvedAbove}` : String(cell.threshold);
      b.title = `row ${cell.r}, col ${cell.c}: last clean ${cell.threshold ?? `≥ ${map.unresolvedAbove}`}, travels at ${cell.travel}`;
      b.onclick = () => { selected = { r: cell.r, c: cell.c }; renderMap(); };
      grid.append(b);
    }
    bed.append(grid);
    mapGrid.append(legend, el('div', 'lift-map-rulers',
      el('span', 'lift-map-corner', 'in'),
      inchRuler(map.bedW, 'top'),
      inchRuler(map.bedH, 'left'),
      bed,
    ));
    const cell = selected && cells.find((c) => c.r === selected!.r && c.c === selected!.c);
    mapGrid.append(cell ? detailFor(map, cell) : hint('Click a cell to adjust it and test it.'));
  };
  const detailFor = (map: LiftMap, cell: LiftCell): HTMLElement => {
    const value = numberInput(cell.value, 100, (v) => writeMap(setCellThreshold(map, cell.r, cell.c, v)));
    value.title = 'Last clean pulse in this cell.';
    const less = button(`−${RUNG} (more lift)`, () => writeMap(nudgeCell(map, cell.r, cell.c, -RUNG)));
    const more = button(`+${RUNG} (less lift)`, () => writeMap(nudgeCell(map, cell.r, cell.c, RUNG)));
    const unresolved = button('unresolved', () => writeMap(setCellThreshold(map, cell.r, cell.c, null)));
    unresolved.title = 'Clean at every rung of the ladder: counts as the ladder top.';
    const pulses = cellTestPulses(cell);
    const check = button(`Test this cell (${pulses.join(' / ')})`, () => {
      const { bedW, bedH } = m.prof().machine;
      return run(liftGrid(basePen(), {
        bedW, bedH, cols: map.cols, rows: map.rows, pulses, dashes: 4,
        only: (r, c) => r === cell.r && c === cell.c,
      }));
    });
    check.title = pulses.length > 1
      ? 'Dashes in this cell only: the left strip at the travel lift the driver uses here (should be clean), the right at the cell’s threshold (the last clean rung). Position at the bed origin first.'
      : 'Dashes in this cell only, at the travel lift the driver uses here. Position at the bed origin first.';
    return el('div', 'lift-detail',
      el('span', 'cell-name', `row ${cell.r}, col ${cell.c}`),
      value, less, more, unresolved,
      el('span', undefined, `travels at ${cell.travel}`),
      check,
    );
  };
  renderMap();
  m.onProfileSwitch(renderMap);
  return { root: el('div', 'bed-level', status, mapGrid), refresh: renderMap };
}

/** Serial transcript: the first artifact when the machine misbehaves. */
export function buildLog(m: MachineSession): HTMLElement {
  const pre = el('pre', 'serial-log');
  const refresh = (): void => { pre.textContent = m.ebb.transcript() || '(no traffic yet)'; pre.scrollTop = pre.scrollHeight; };
  const dl = button('Download serial log', () => download('ebb-log.txt', m.ebb.transcript() || '(no traffic yet)', 'text/plain'));
  const rf = button('Refresh', refresh);
  refresh();
  return el('div', 'log', el('div', 'row', dl, rf), pre);
}
