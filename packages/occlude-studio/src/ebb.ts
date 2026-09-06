/**
 * EBB (EiBotBoard / AxiDraw-family) driver over Web Serial — the iDraw's
 * native protocol (no G-code). Facts verified against the physical board
 * (EBB v2.8.1, 2026-08-26):
 *
 * - Commands end with \r; errors start with '!'; most commands answer OK.
 *   V/QG/QM return data with NO OK — special-cased via `expectOk`.
 * - Line endings are inconsistent (\n\r vs \r\n): split on /[\r\n]+/.
 * - FIFO depth 2 with backpressure via delayed OK: the pump is simply
 *   write → await OK → write. Never send unterminated partials.
 * - CoreXY: XM,<ms>,<dx>,<dy> takes XY-space step deltas and mixes
 *   internally; per-MOTOR limit is 25k steps/s and a diagonal puts 2·d on
 *   one motor — durations are clamped in motor space.
 * - No homing switches: user positions by hand while motors are released,
 *   CS zeroes the counters, and HM,<rate> returns to logical 0,0. SR,0 on
 *   connect or the servo powers off after idle and the pen sags onto paper.
 * - Never send: BL, R/RB, CU,1,0.
 */

import type { PenDef } from 'occlude';

import { settleAtLift, travelLiftPulse, type LiftModel, type LiftMap, type SettlePoint } from 'occlude';
import {
  estimatePlanMs, planDurationMs, planPolyline, segmentsToBlocks,
  type MotionBlock, type PlanEstimate, type Point,
} from 'occlude';

// Minimal Web Serial typings (lib.dom doesn't ship them everywhere).
interface SerialPortLike {
  open(opts: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(opts?: {
    filters?: { usbVendorId?: number; usbProductId?: number }[];
  }): Promise<SerialPortLike>;
}

export function serialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator && window.isSecureContext;
}

/**
 * Run one LM axis the way the firmware does — every 40µs add Accel to Rate
 * and Rate to a 31-bit accumulator, step on overflow, after the −Accel/2
 * initial adjustment — and report whether all steps fire before the rate
 * runs out. The continuous math can put the last step within a fraction of
 * a step of the point where the rate reaches zero; when rounding lands it
 * on the wrong side the move never completes and the board's FIFO is
 * wedged for good (field log 2026-09-05: a 252-step decel to the floor took
 * 251 steps and ran negative). Cheap: a block is at most a few thousand ticks.
 */
export function lmAxisCompletes(rate: number, steps: number, accel: number): boolean {
  const target = Math.abs(steps);
  if (target === 0) return true;
  let r = rate - accel / 2;
  let acc = 0;
  let taken = 0;
  // Generous cap: a legitimate block is ≤0.3s = 7500 ticks.
  for (let tick = 0; tick < 50_000 && taken < target; tick++) {
    r += accel;
    if (r <= 0) return false; // the accumulator can never overflow again
    acc += r;
    if (acc >= 0x80000000) {
      acc -= 0x80000000;
      taken += 1;
    }
  }
  return taken >= target;
}

/**
 * Make a decelerating LM axis completable: while the emulated firmware
 * would stall, ease the deceleration toward zero by 1/256 per pass so the
 * rate is still positive when the last step fires. The block then ends a
 * hair faster than planned — a fraction of a percent of travel speed at
 * the end of a travel, invisible — instead of never ending at all.
 */
export function lmCompletable(rate: number, accel: number, steps: number): [number, number] {
  if (steps === 0 || accel >= 0) return [rate, accel];
  let a = accel;
  for (let pass = 0; pass < 64 && !lmAxisCompletes(rate, steps, a); pass++) {
    a = Math.trunc(a * (1 - 1 / 256));
    if (a === 0) break;
  }
  return [rate, a];
}

/** Servo pulses a calibration card pins for one pen's chains. */
export interface ServoOverride {
  up?: number;
  down?: number;
}

export interface PlotProgress {
  /** Commands sent / total. */
  sent: number;
  total: number;
  /** Estimated machine-time elapsed / total, ms. */
  elapsedMs: number;
  totalMs: number;
  penName: string;
  state: 'plotting' | 'paused' | 'done' | 'stopped';
  /** Remaining-time estimate: the planner model blended toward measured
   * wall-clock throughput as the plot progresses (pauses excluded). */
  etaMs: number;
  /** Anomaly report, e.g. a position-drift correction. Sticky per plot. */
  warning?: string;
  /** Chain currently being drawn (plan order) / total — drives the live
   * plot view in the preview. */
  chain?: number;
  chainTotal?: number;
  /** Final report only: measured wall time (pauses excluded) and the model
   * breakdown — the calibration record. */
  wallMs?: number;
  estimate?: PlanEstimate;
}

export interface EbbOptions {
  stepsPerMm: number;
  travelFeed: number; // mm/min
  /** Paper→machine axis mapping. The iDraw's axes are ROTATED relative to
   * the page (verified by drawing): machine +dx = up the page, machine
   * +dy = right. Defaults express that as swap + invert. */
  swapXY: boolean;
  invertX: boolean;
  invertY: boolean;
  /** Servo pulses: pen-UP target (SC,4, where SP,1 drives the horn) and
   * pen-DOWN target (SC,5, SP,0's). Write-only on the board, persisted in
   * the profile. iDraw 2026-09-05 sweep: up 8600 / down 18000. */
  penUpPulse: number;
  penDownPulse: number;
  /** Host-side look-ahead limits. Pen feed remains the per-stroke maximum. */
  acceleration: number; // mm/s²
  /** Pen-up moves have no ink physics or line quality to protect — only the
   * skip-step ceiling. A higher travel accel cuts most of the ramp time on
   * stroke-dense plots, where short hops never reach cruise. */
  travelAcceleration: number; // mm/s²
  junctionDeviation: number; // mm
  minimumCruiseRatio: number;
  /** Pen height (occlude's liftmap.ts): every travel takes the smallest lift
   * that clears along it per the map (full lift without one), and each
   * settle is the pen's penDelay scaled by the settle curve for that lift
   * (unscaled without one). The estimator prices the same way. */
  liftMap?: LiftMap;
  liftMarginPulses?: number;
  settleCurve?: SettlePoint[];
  /** Use the LM command (firmware ≥2.5.3): true constant-acceleration ramps
   * interpolated at 25kHz in hardware, vs the XM fallback's ~40Hz staircase
   * of constant-velocity packets. */
  lmMotion: boolean;
  /** Query the board's step counters every N chains to detect drift
   * (skipped steps); 0 disables. Default 1000. */
  driftCheckEvery?: number;
}

const MAX_MOTOR_STEPS_PER_MS = 25; // verified: 25k steps/s per motor
// XM is constant-velocity: without host-side ramps every stroke start
// commands the steppers from standstill to cruise instantly, which skips
// steps above modest feeds (open-loop — each skip is a permanent offset;
// found as position drift after pause/resume). Trapezoidal profiles fix it.

interface QueuedCmd {
  line: string;
  expectOk: boolean;
  resolve(lines: string[]): void;
  reject(err: Error): void;
  /** Watchdog: reject with StallError if no reply within this long. */
  timeoutMs?: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** A command's reply never came: the board stopped executing (a move that
 * cannot finish) or a byte was lost on the link. Either way the pump would
 * wait forever without a watchdog. */
export class StallError extends Error {
  constructor(readonly command: string, readonly afterMs: number) {
    super(`no reply to ${command} after ${afterMs}ms`);
    this.name = 'StallError';
  }
}

/** Reply watchdog while plotting. The longest legitimate wait is the two
 * FIFO'd blocks ahead of a command (≤0.3s each) plus a settle (≤1s); 8s is
 * far outside that and far inside a human noticing. */
export const PLOT_WATCHDOG_MS = 8000;

export class Ebb {
  private port: SerialPortLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readAbort: AbortController | null = null;
  private rxBuf = '';
  private rxLines: string[] = [];
  private inFlight: QueuedCmd | null = null;
  private queue: QueuedCmd[] = [];
  private collected: string[] = [];
  version = '';
  penIsUp = true;

  // Dead-reckoned position in STEPS (integers — error-diffused from mm).
  private stepX = 0;
  private stepY = 0;
  // Planned time carried by trajectory chunks too small to cross a step
  // boundary — folded into the next emitted packet so quantization never
  // shortens the profile. Only meaningful within one continuous run.
  // (XM fallback path only; the LM path uses lmCarryV0 instead.)
  private pendingMs = 0;
  // LM path: entry speed of the first skipped sub-step block since the last
  // emitted one, so the eventual emitting block spans the full profile.
  private lmCarryV0: number | null = null;

  // Full serial transcript (both directions, ms timestamps) — the ground
  // truth for "what did the board actually receive/say" when a session
  // misbehaves. Ring-buffered; download via the panel.
  private log: string[] = [];
  private logStart = Date.now();

  private logLine(dir: '>' | '<', text: string): void {
    if (this.log.length >= 20_000) this.log.splice(0, 10_000);
    this.log.push(`${String(Date.now() - this.logStart).padStart(8)} ${dir} ${text}`);
  }

  /** The session's serial transcript as text. */
  transcript(): string {
    return this.log.join('\n');
  }

  private plotAbort = false;
  private plotPause = false;
  plotting = false;
  // Quick-hop board-state tracking: if a plot dies mid-hop (stop, crash),
  // the board would RETAIN the reduced SC,4 lift forever — stop() uses
  // these to restore it. (A retained hop register was the "pen hovers,
  // settings don't matter, reconnect fixes it" field bug.)
  private hopLiftActive = false;
  private fullUpPulse = 0;
  private downOverrideActive = false;
  private profileDownPulse = 0;
  // Set when the user jogs or re-origins during a pause: the coordinate
  // frame moved, so resuming must NOT re-lower the pen — continuing the
  // interrupted stroke from a shifted position would draw a stray line.
  // The current stroke's remainder is traced pen-up; the next chain's own
  // pen-down resumes inking. This is the drift-recovery flow: pause → jog
  // the pen onto the paper origin → Set origin → resume.
  private pauseAdjusted = false;

  async connect(o?: { penUpPulse: number; penDownPulse: number }): Promise<string> {
    const serial = (navigator as unknown as { serial: SerialLike }).serial;
    const port = await serial.requestPort({
      filters: [{ usbVendorId: 0x04d8, usbProductId: 0xfd92 }],
    });
    await port.open({ baudRate: 115200 });
    this.port = port;
    this.writer = port.writable!.getWriter();
    this.readAbort = new AbortController();
    void this.readLoop();
    // No reset on open, no warmup (verified). Configure the servo, but leave
    // the steppers released so the carriage can be positioned by hand. Jog,
    // Home, and Plot enable them immediately before their first motion.
    // Fresh power-up can leave stale bytes (a lone OK) in the CDC buffer;
    // consumed by V's no-OK reply handling they shift every later reply by
    // one and silently corrupt the version (log-verified: LM fell back to
    // XM a whole session because version read "OK"). Drain first — lines
    // with nothing in flight are dropped — and retry V once if it still
    // doesn't look like a banner.
    await new Promise((r) => setTimeout(r, 60));
    const v = await this.cmd('V', false);
    this.version = v[0] ?? '';
    if (!/\d+\.\d+\.\d+/.test(this.version)) {
      const v2 = await this.cmd('V', false);
      this.version = v2[0] ?? this.version;
    }
    await this.cmd('EM,0,0');
    await this.cmd('SR,0');
    if (o) {
      await this.cmd(`SC,4,${Math.round(o.penUpPulse)}`);
      await this.cmd(`SC,5,${Math.round(o.penDownPulse)}`);
    }
    await this.penUp(0);
    // Motor supply check: QC's second value is V+; ~zero = power unplugged.
    try {
      const qc = await this.cmd('QC');
      const vplus = parseInt(qc[0]?.split(',')[1] ?? '0', 10);
      if (vplus < 100) this.version += ' — MOTOR POWER UNPLUGGED?';
    } catch {
      // non-fatal
    }
    // Adopt the board's step counters instead of assuming zero: after a
    // reconnect (tab reload) they still hold the position relative to the
    // last Set origin, so the session resumes registered. Fresh power-up
    // reads 0,0 — identical to the old behavior.
    const pos = await this.queryPosition().catch(() => null);
    if (pos) {
      this.stepX = pos[0];
      this.stepY = pos[1];
    }
    return this.version;
  }

  /** Board step counters via QS, inverted from CoreXY motor space to
   * machine XY steps. Null if the response doesn't parse. */
  private async queryPosition(): Promise<[number, number] | null> {
    const qs = await this.cmd('QS');
    const m = /(-?\d+),(-?\d+)/.exec(qs[0] ?? '');
    if (!m) return null;
    const m1 = parseInt(m[1], 10);
    const m2 = parseInt(m[2], 10);
    return [(m1 + m2) / 2, (m1 - m2) / 2];
  }

  /** Wait until queued motion has physically finished (FIFO depth 2 means
   * an OK acknowledges queueing, not completion). Polls QM; gives up after
   * `timeoutMs` and reports false so callers skip rather than misread. */
  private async drainMotion(timeoutMs = 3000): Promise<boolean> {
    const start = Date.now();
    for (;;) {
      const qm = await this.cmd('QM', false);
      const parts = (qm[0] ?? '').split(',').slice(1).map(Number);
      if (parts.length >= 3 && parts.every((p) => p === 0)) return true;
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async disconnect(): Promise<void> {
    this.plotAbort = true;
    try {
      this.readAbort?.abort();
      await this.writer?.close();
    } catch {
      // port already gone
    }
    try {
      await this.port?.close();
    } catch {
      // ignore
    }
    this.port = null;
    this.writer = null;
    this.inFlight = null;
    this.queue = [];
  }

  get connected(): boolean {
    return this.port !== null;
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.port!.readable!.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.rxBuf += decoder.decode(value, { stream: true });
        const parts = this.rxBuf.split(/[\r\n]+/);
        this.rxBuf = parts.pop() ?? '';
        for (const line of parts) {
          if (line.length > 0) this.onLine(line);
        }
      }
    } catch {
      // aborted or unplugged
    } finally {
      reader.releaseLock();
    }
  }

  private onLine(line: string): void {
    this.logLine('<', line);
    const cur = this.inFlight;
    if (!cur) return;
    if (line.startsWith('!')) {
      const err = new Error(`EBB: ${line} (after ${cur.line})`);
      clearTimeout(cur.timer);
      this.inFlight = null;
      cur.reject(err);
      this.pump();
      return;
    }
    if (!cur.expectOk) {
      // Data-only command (V/QG/QM): first data line completes it.
      this.collected.push(line);
      const lines = this.collected;
      this.collected = [];
      clearTimeout(cur.timer);
      this.inFlight = null;
      cur.resolve(lines);
      this.pump();
      return;
    }
    if (line === 'OK') {
      const lines = this.collected;
      this.collected = [];
      clearTimeout(cur.timer);
      this.inFlight = null;
      cur.resolve(lines);
      this.pump();
    } else {
      this.collected.push(line);
    }
  }

  private pump(): void {
    if (this.inFlight || this.queue.length === 0 || !this.writer) return;
    const next = this.queue.shift()!;
    this.inFlight = next;
    this.collected = [];
    this.logLine('>', next.line);
    if (next.timeoutMs) {
      next.timer = setTimeout(() => {
        if (this.inFlight !== next) return;
        // Leave the command in flight: nothing else may be sent until the
        // recovery (emergencyClear) has reset the pipeline.
        this.logLine('<', `(watchdog: no reply after ${next.timeoutMs}ms)`);
        next.reject(new StallError(next.line, next.timeoutMs ?? 0));
      }, next.timeoutMs);
    }
    const bytes = new TextEncoder().encode(next.line + '\r');
    this.writer.write(bytes).catch((e: unknown) => {
      clearTimeout(next.timer);
      this.inFlight = null;
      next.reject(e instanceof Error ? e : new Error(String(e)));
    });
  }

  /** Send one command; resolves with its data lines once OK (or the first
   * data line for no-OK queries) arrives. The write→await-OK pacing IS the
   * flow control — the board's FIFO backpressure does the rest. */
  cmd(line: string, expectOk = true, timeoutMs?: number): Promise<string[]> {
    const t = timeoutMs ?? (this.plotting ? this.watchdogMs : undefined);
    return new Promise((resolve, reject) => {
      this.queue.push({ line, expectOk, resolve, reject, timeoutMs: t });
      this.pump();
    });
  }

  /** Overridable for tests; PLOT_WATCHDOG_MS in the field. */
  watchdogMs = PLOT_WATCHDOG_MS;

  // ---- motion ----

  /** Paper (x right, y down, mm) → machine axes → absolute steps. Rounding
   * the ABSOLUTE position means float error never accumulates into drift. */
  private toSteps(xMm: number, yMm: number, o: EbbOptions): [number, number] {
    const mx = (o.swapXY ? yMm : xMm) * (o.invertX ? -1 : 1);
    const my = (o.swapXY ? xMm : yMm) * (o.invertY ? -1 : 1);
    return [Math.round(mx * o.stepsPerMm), Math.round(my * o.stepsPerMm)];
  }

  /** LM available from firmware 2.5.3. */
  private lmSupported(): boolean {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(this.version);
    if (!m) return false;
    const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return maj > 2 || (maj === 2 && (min > 5 || (min === 5 && pat >= 3)));
  }

  /** Move to an absolute mm position over an explicit duration. Duration is
   * clamped to the per-motor step-rate ceiling (CoreXY: a diagonal doubles
   * one motor's rate). XM fallback path for firmware without LM. */
  private async stepTo(xMm: number, yMm: number, ms: number, o: EbbOptions): Promise<void> {
    const [sx, sy] = this.toSteps(xMm, yMm, o);
    const dx = sx - this.stepX;
    const dy = sy - this.stepY;
    if (dx === 0 && dy === 0) {
      this.pendingMs += ms;
      return;
    }
    const motor = Math.max(Math.abs(dx + dy), Math.abs(dx - dy));
    const clamped = Math.max(
      Math.ceil(ms + this.pendingMs),
      Math.ceil(motor / MAX_MOTOR_STEPS_PER_MS),
      2,
    );
    this.pendingMs = 0;
    await this.cmd(`XM,${clamped},${dx},${dy}`);
    this.stepX = sx;
    this.stepY = sy;
  }

  /**
   * Emit one constant-acceleration block as an LM command. The board adds
   * Accel to Rate and Rate to a 32-bit accumulator every 40µs, stepping on
   * overflow — a continuous ramp, not a velocity staircase. Conventions per
   * EBB ≥2.5.3 (verified against saxi's source): steps carry the sign,
   * rates are magnitudes. Per-axis rates are the cartesian rate projected
   * onto the step vector then CoreXY-mixed, so both axes derive the same
   * duration and finish together.
   */
  private async lmBlock(block: MotionBlock, o: EbbOptions): Promise<void> {
    const [sx, sy] = this.toSteps(block.x1, block.y1, o);
    const dx = sx - this.stepX;
    const dy = sy - this.stepY;
    if (dx === 0 && dy === 0) {
      // Sub-step block: remember its entry speed so the eventual emitting
      // block spans the whole profile since the last physical step.
      this.lmCarryV0 = this.lmCarryV0 ?? block.v0;
      return;
    }
    // Floor BOTH rates at 1 step/s (0.01mm/s — imperceptible): a rate at
    // exactly 0 plus rounding (and the firmware's −Accel/2 initial-rate
    // adjustment) can leave the accumulator unable to fire the remaining
    // steps — a move that never completes wedges the board's FIFO hard.
    const v0 = Math.max((this.lmCarryV0 ?? block.v0) * o.stepsPerMm, 1);
    const v1 = Math.max(block.v1 * o.stepsPerMm, 1);
    this.lmCarryV0 = null;
    const steps1 = dx + dy;
    const steps2 = dx - dy;
    const norm = Math.hypot(dx, dy);
    const axisRate = (steps: number, share: number): [number, number] => {
      if (steps === 0) return [0, 0];
      const r0 = (v0 * share) / norm;
      const r1 = (v1 * share) / norm;
      const initialRate = Math.round(r0 * (0x80000000 / 25000));
      const finalRate = Math.round(r1 * (0x80000000 / 25000));
      const moveTime = (2 * Math.abs(steps)) / (r0 + r1);
      const deltaR = Math.round((finalRate - initialRate) / (moveTime * 25000));
      return [initialRate, deltaR];
    };
    const [rate1, accel1] = lmCompletable(...axisRate(steps1, Math.abs(dx + dy)), steps1);
    const [rate2, accel2] = lmCompletable(...axisRate(steps2, Math.abs(dx - dy)), steps2);
    await this.cmd(`LM,${rate1},${steps1},${accel1},${rate2},${steps2},${accel2}`);
    this.stepX = sx;
    this.stepY = sy;
  }

  /**
   * Drive a polyline with a trapezoidal velocity profile: accelerate from
   * V_START to the feed, cruise, decelerate back — the steppers never see
   * a velocity step they can't follow. Long segments are subdivided so
   * the ramp has resolution. `onPause` (when provided) is awaited between
   * segments when a pause is requested; after it returns, the profile is
   * REPLANNED from rest for the remaining points — a resume is a fresh
   * ramp, not a cold start at cruise speed.
   */
  private async moveRun(
    pts: [number, number][],
    feedMmMin: number,
    o: EbbOptions,
    onPause?: () => Promise<void>,
    /** Called per emitted packet/block with its COMMANDED duration, ms —
     * elapsed time accounting is exact by construction. */
    onSegment?: (ms: number) => void,
  ): Promise<void> {
    // Current logical paper position (invert the axis mapping).
    const curPaper = (): [number, number] => {
      const mx = (this.stepX / o.stepsPerMm) * (o.invertX ? -1 : 1);
      const my = (this.stepY / o.stepsPerMm) * (o.invertY ? -1 : 1);
      return o.swapXY ? [my, mx] : [mx, my];
    };
    let remaining = pts;
    while (remaining.length > 0 && !this.plotAbort) {
      // Each pass plans from rest; sub-step time from before this boundary
      // (a previous run, or motion preceding a pause) has no profile here.
      this.pendingMs = 0;
      const [cx, cy] = curPaper();
      const vt = Math.max(1, feedMmMin / 60);
      // The pen state IS the tooling profile: raised means travel/jog.
      const accel = Math.max(1, this.penIsUp ? o.travelAcceleration : o.acceleration);
      const poly: Point[] = [[cx, cy], ...remaining];
      const planned = planPolyline(poly, {
        maxVelocity: vt,
        acceleration: accel,
        junctionDeviation: Math.max(0, o.junctionDeviation),
        minimumCruiseRatio: o.minimumCruiseRatio,
        startVelocity: 0,
        endVelocity: 0,
      });
      let paused = false;
      if (o.lmMotion && this.lmSupported()) {
        this.lmCarryV0 = null;
        for (const block of segmentsToBlocks(planned, accel)) {
          if (this.plotAbort) return;
          if (this.plotPause && onPause) {
            await onPause();
            // Position is implicit; keep the current segment's endpoint and
            // every following waypoint for the replan-from-rest.
            remaining = planned.slice(block.seg).map((p) => p.end);
            paused = true;
            break;
          }
          await this.lmBlock(block, o);
          const blockMm = Math.hypot(block.x1 - block.x0, block.y1 - block.y0);
          onSegment?.((2 * blockMm * 1000) / Math.max(1e-9, block.v0 + block.v1));
        }
        if (!paused) return;
        continue;
      }
      for (let i = 0; i < planned.length; i++) {
        const segment = planned[i];
        let s = 0;
        const vAt = (at: number): number =>
          Math.min(
            segment.cruiseVelocity,
            Math.sqrt(segment.startVelocity ** 2 + 2 * accel * at),
            Math.sqrt(segment.endVelocity ** 2 + 2 * accel * Math.max(0, segment.length - at)),
          );
        const accelEnd = Math.max(
          0,
          (segment.cruiseVelocity ** 2 - segment.startVelocity ** 2) / (2 * accel),
        );
        const decelStart = Math.min(
          segment.length,
          segment.length - (segment.cruiseVelocity ** 2 - segment.endVelocity ** 2) / (2 * accel),
        );
        while (s < segment.length - 1e-9) {
          if (this.plotAbort) return;
          if (this.plotPause && onPause) {
            await onPause();
            // The current machine position is implicit; retain this segment's
            // endpoint and every following source waypoint for replanning.
            remaining = planned.slice(i).map((p) => p.end);
            paused = true;
            break;
          }
          const vHere = vAt(s);
          // About 25ms per EBB constant-velocity command. Unlike the old
          // arc-length sampler, source waypoints and trapezoid phase changes
          // are hard boundaries, making average endpoint velocity exact.
          let phaseEnd = segment.length;
          if (accelEnd > s + 1e-9) phaseEnd = accelEnd;
          else if (decelStart > s + 1e-9) phaseEnd = decelStart;
          // Use the time quantum at cruise. During accel/decel, also cap the
          // speed change to 4mm/s, half the empirically safe 8mm/s launch
          // step; applying that cap to cruise created ~1ms packets that the
          // EBB rounded to 2ms, roughly halving feed and flooding the serial
          // command stream.
          const timeDs = Math.max(0.005, vHere * 0.025);
          const inAccel = s < accelEnd - 1e-9;
          const inDecel = s >= decelStart - 1e-9;
          const maxDv = 4;
          const velocityDs = inDecel
            ? Math.max(0.005, (2 * vHere * maxDv - maxDv * maxDv) / (2 * accel))
            : (2 * vHere * maxDv + maxDv * maxDv) / (2 * accel);
          const ramping = inAccel || inDecel;
          const ds = Math.min(phaseEnd - s, 4, ramping ? Math.min(timeDs, velocityDs) : timeDs);
          const s2 = s + ds;
          const vAvg = Math.max(1e-3, (vHere + vAt(s2)) / 2);
          const t = s2 / segment.length;
          const x = segment.start[0] + (segment.end[0] - segment.start[0]) * t;
          const y = segment.start[1] + (segment.end[1] - segment.start[1]) * t;
          await this.stepTo(x, y, (ds / vAvg) * 1000, o);
          onSegment?.((ds / vAvg) * 1000);
          s = s2;
        }
        if (paused) break;
      }
      if (!paused) return;
    }
  }

  async penUp(settleMs = 300): Promise<void> {
    await this.cmd(settleMs > 0 ? `SP,1,${Math.round(settleMs)}` : 'SP,1');
    this.penIsUp = true;
  }

  async penDown(settleMs = 300): Promise<void> {
    await this.cmd(settleMs > 0 ? `SP,0,${Math.round(settleMs)}` : 'SP,0');
    this.penIsUp = false;
  }

  /** Current position in BED mm (the frame Set origin zeroed), inverting
   * the paper→machine axis mapping. */
  bedPosition(o: EbbOptions): [number, number] {
    const mx = (this.stepX / o.stepsPerMm) * (o.invertX ? -1 : 1);
    const my = (this.stepY / o.stepsPerMm) * (o.invertY ? -1 : 1);
    return o.swapXY ? [my, mx] : [mx, my];
  }

  async jog(dxMm: number, dyMm: number, o: EbbOptions): Promise<void> {
    if (this.plotting && this.plotPause) this.pauseAdjusted = true;
    const [x, y] = this.bedPosition(o);
    await this.cmd('EM,1,1');
    await this.moveRun([[x + dxMm, y + dyMm]], o.travelFeed, o);
  }

  /**
   * Two origins. The BED origin is where Set origin zeroed the board's step
   * counters — the frame the lift map was measured in, so it must be the
   * same bed corner every time. The PAPER origin is an offset from it: jog
   * to the sheet's corner and record it here, without zeroing anything.
   * Plots draw at the offset, the map is looked up in bed coordinates, Home
   * returns to the bed corner.
   */
  paperOffset: [number, number] = [0, 0];

  setPaperOrigin(o: EbbOptions): [number, number] {
    this.paperOffset = this.bedPosition(o).map((v) => Math.round(v * 100) / 100) as [number, number];
    return this.paperOffset;
  }

  /** Travel to the paper origin (pen up). */
  async goToPaperOrigin(o: EbbOptions): Promise<void> {
    await this.penUp();
    await this.cmd('EM,1,1');
    await this.moveRun([[this.paperOffset[0], this.paperOffset[1]]], o.travelFeed, o);
  }

  /** Zero the board's step counters here — "this is the BED origin". Also
   * clears the paper offset: the frame it was measured in is gone. */
  async setOrigin(): Promise<void> {
    if (this.plotting && this.plotPause) this.pauseAdjusted = true;
    await this.cmd('CS');
    this.stepX = 0;
    this.stepY = 0;
    this.paperOffset = [0, 0];
  }

  async home(): Promise<void> {
    await this.penUp();
    await this.cmd('EM,1,1');
    await this.cmd('HM,2000');
    this.stepX = 0;
    this.stepY = 0;
  }

  /** Emergency stop: abort motion, clear the FIFO, raise the pen. ES is
   * written RAW, bypassing the command queue — the queue may be wedged
   * behind a motion command whose OK the board is withholding (full FIFO),
   * in which case a queued ES would never send and every later command
   * (Home included) would silently wait forever. After the raw write the
   * host pipeline is reset and given a moment to drain orphan replies. */
  async stop(): Promise<void> {
    this.plotAbort = true;
    await this.emergencyClear('stopped');
    if (this.hopLiftActive && this.fullUpPulse > 0) {
      // A stopped hop plot must not leave the reduced lift on the board.
      this.hopLiftActive = false;
      await this.cmd(`SC,4,${this.fullUpPulse}`).catch(() => undefined);
    }
    if (this.downOverrideActive && this.profileDownPulse > 0) {
      // Nor a calibration card's landing pulse.
      this.downOverrideActive = false;
      await this.cmd(`SC,5,${this.profileDownPulse}`).catch(() => undefined);
    }
    await this.penUp().catch(() => undefined);
    // Unlock the gantry: after an abort the next step is usually a manual
    // re-park, and held steppers fight the hand.
    await this.cmd('EM,0,0').catch(() => undefined);
  }

  /** Raw ES (abort motion, clear the board's FIFO), bypassing the queue,
   * then reset the host pipeline: strand every queued command, and give
   * late replies (the aborted command's OK, ES's own) time to arrive with
   * nothing in flight so onLine drops them instead of attributing them to
   * the next command. Used by stop() and by stall recovery. */
  private async emergencyClear(reason: string): Promise<void> {
    this.logLine('>', `ES (raw, queue bypassed) — ${reason}`);
    try {
      await this.writer?.write(new TextEncoder().encode('\rES\r'));
    } catch {
      // port gone
    }
    const err = new Error(reason);
    const stranded = [this.inFlight, ...this.queue].filter(
      (c): c is QueuedCmd => c !== null,
    );
    for (const c of stranded) clearTimeout(c.timer);
    this.inFlight = null;
    this.queue = [];
    this.collected = [];
    for (const c of stranded) c.reject(err);
    await new Promise((r) => setTimeout(r, 300));
  }

  pause(): void {
    this.plotPause = true;
  }

  resume(): void {
    this.plotPause = false;
  }

  /**
   * Plot a toolpath plan (`wasm_export_toolpath` layout: [pen, dot, n,
   * x0, y0, …] per chain, paper mm, already in tour order). There is no
   * physical pen changer: multi-pen sketches are plotted one pen per run
   * (`onlyPen` selects which), swapping the pen by hand in between.
   */
  async plot(
    plan: Float64Array,
    pens: PenDef[],
    o: EbbOptions,
    onProgress: (p: PlotProgress) => void,
    /** Resolve the CURRENT pen definition by name — lets feed/penDelay
     * edits made mid-plot (paused or not) apply from the next chain. */
    livePen?: (name: string) => PenDef | undefined,
    /** Current servo positions — re-sent on resume so pause → adjust →
     * resume also covers pen height. */
    liveServo?: () => { penUpPulse: number; penDownPulse: number },
    /** Plot only this pen's chains (index into `pens`); omit for all. */
    onlyPen?: number,
    /** Per-pen servo overrides (machine calibration cards): chains of a pen
     * with `up` are TRAVELLED INTO at that SC,4 pulse instead of the
     * full/hop lift, and chains with `down` LAND at that SC,5 pulse. The
     * very first travel of a plot is always at full lift (the pen was
     * raised at connect). Both registers are restored at the end, on stop,
     * and re-derived after a pause. */
    servoFor?: (penIndex: number) => ServoOverride | undefined,
  ): Promise<void> {
    interface Chain {
      pen: number;
      dot: boolean;
      pts: Float64Array;
    }
    let chains: Chain[] = [];
    // Plan points are paper mm; the machine, the lift map and the estimate
    // all work in BED mm, so the paper offset is applied once, here.
    const [offX, offY] = this.paperOffset;
    for (let i = 0; i < plan.length; ) {
      const pen = plan[i++];
      const dot = plan[i++] === 1;
      const n = plan[i++];
      const pts = new Float64Array(n * 2);
      for (let k = 0; k < n; k++) {
        pts[k * 2] = plan[i + k * 2] + offX;
        pts[k * 2 + 1] = plan[i + k * 2 + 1] + offY;
      }
      chains.push({ pen, dot, pts });
      i += n * 2;
    }
    if (onlyPen !== undefined) chains = chains.filter((c) => c.pen === onlyPen);
    // Totals for progress: the machine-time estimate sums the planner's
    // actual trapezoids per move — a stroke that never reaches feed (dense
    // corners, short segments) is counted at its planned speed, not the
    // "always at full feed" fiction that undershot on exactly the plots
    // that take longest.
    // Totals for progress: THE shared ground-truth model (estimatePlanMs) —
    // the same numbers plotstats and the export panel show.
    const liftModel: LiftModel = {
      penUpPulse: o.penUpPulse,
      map: o.liftMap,
      marginPulses: o.liftMarginPulses ?? 800,
      settleCurve: o.settleCurve,
    };
    const estimate: PlanEstimate = estimatePlanMs(
      chains,
      (pi) => {
        const base = pens[pi];
        const pen = (base && livePen?.(base.name)) ?? base;
        return pen ? { feed: pen.feed, penDelay: pen.penDelay } : undefined;
      },
      {
        travelFeed: o.travelFeed,
        acceleration: o.acceleration,
        travelAcceleration: o.travelAcceleration,
        junctionDeviation: o.junctionDeviation,
        minimumCruiseRatio: o.minimumCruiseRatio,
        lift: liftModel,
      },
    );
    const total = estimate.commands;
    const totalMs = estimate.totalMs;

    this.plotAbort = false;
    this.plotPause = false;
    this.plotting = true;
    await this.cmd('EM,1,1');
    let sent = 0;
    let elapsedMs = 0;
    let warning: string | undefined;
    // ETA: pure planner model early, blended toward measured wall-clock
    // throughput once there is real data (>5s of drawing, past 5% —
    // serial overhead and settle waits make wall time run above commanded
    // machine time by a plot-specific factor the model can't know).
    const wallStart = Date.now();
    let pausedWallMs = 0;
    let curChain = 0;
    let inkedMm = 0; // drawn mm since the last re-ink pause (pen.reinkMm)
    const report = (state: PlotProgress['state'], penName = ''): void => {
      const modelRemaining = Math.max(0, totalMs - elapsedMs);
      let etaMs = modelRemaining;
      const wall = Date.now() - wallStart - pausedWallMs;
      if (totalMs > 0 && elapsedMs > 0 && wall > 5000) {
        const rate = Math.min(3, Math.max(0.5, wall / elapsedMs));
        const progress = elapsedMs / totalMs;
        const w = Math.min(0.85, Math.max(0, (progress - 0.05) * 4));
        etaMs = modelRemaining * (1 - w + w * rate);
      }
      onProgress({
        sent, total, elapsedMs, totalMs, penName, state, etaMs, warning,
        chain: curChain, chainTotal: chains.length,
        ...(state === 'done' || state === 'stopped'
          ? { wallMs: Date.now() - wallStart - pausedWallMs, estimate }
          : {}),
      });
    };
    // Dead-reckoning vs the board's own counters. A mismatch means commands
    // were lost or mangled in flight (open loop: PHYSICAL skips are invisible
    // to both sides — that's what the pause→jog to origin→Set origin→resume
    // flow is for). Adopt the board's truth so later moves replan from where
    // the machine actually is instead of compounding the divergence.
    const verifyPosition = async (): Promise<void> => {
      if (!(await this.drainMotion())) return;
      const pos = await this.queryPosition().catch(() => null);
      if (!pos) return;
      const dx = pos[0] - this.stepX;
      const dy = pos[1] - this.stepY;
      if (dx !== 0 || dy !== 0) {
        this.stepX = pos[0];
        this.stepY = pos[1];
        warning = `drift ${dx},${dy} steps — adopted board counters`;
      }
    };

    // Pen height. Every travel has a LIFT PULSE (SC,4): from the map (the
    // smallest lift that clears along the travel, less the margin), full
    // without a map, or a calibration override. Every landing has a DOWN
    // PULSE (SC,5): the profile's, or an override. Registers are written
    // only on change; full lift is restored for pauses, aborts, plot end.
    // REGISTER SEMANTICS (learned the hard way, serial log 2026-08-30):
    // SP,0 (pen DOWN) drives the servo to SC,5; SP,1 (UP) to SC,4 —
    // standard EBB. Lift adjusts SC,4 ONLY and never touches SC,5, or it
    // moves the pen's DOWN position and strokes hover above the paper.
    const servo = (): { penUpPulse: number; penDownPulse: number } =>
      liveServo?.() ?? { penUpPulse: o.penUpPulse, penDownPulse: o.penDownPulse };
    const model = (): LiftModel => ({ ...liftModel, penUpPulse: servo().penUpPulse });
    type LiftKind = 'full' | 'map' | 'override';
    let liftKind = 'full' as LiftKind; // widened: closures below reassign it
    let liftPulse = Math.round(servo().penUpPulse); // what SC,4 holds now
    let downPulse = Math.round(servo().penDownPulse); // what SC,5 holds now
    const setLift = async (kind: LiftKind, pulse: number): Promise<void> => {
      liftKind = kind;
      this.fullUpPulse = Math.round(servo().penUpPulse);
      this.hopLiftActive = pulse !== this.fullUpPulse;
      if (pulse === liftPulse) return;
      liftPulse = pulse;
      await this.cmd(`SC,4,${pulse}`);
    };
    const setLiftFull = (): Promise<void> => setLift('full', Math.round(servo().penUpPulse));
    /** Lift for the travel INTO `next` (chosen before the pen-up that
     * precedes it): override → model (map or full). A calibration card
     * (servoFor present) is a blank slate: its unpinned chains — frames,
     * ticks — travel at FULL lift, never through the map they are there to
     * measure or check. */
    const liftFor = (next: Chain | undefined, from: [number, number]): Promise<void> => {
      const ov = next && servoFor?.(next.pen);
      if (ov?.up !== undefined) return setLift('override', Math.round(ov.up));
      if (!next || servoFor) return setLiftFull();
      const pulse = travelLiftPulse(model(), from, [next.pts[0], next.pts[1]]);
      return setLift(pulse === Math.round(servo().penUpPulse) ? 'full' : 'map', pulse);
    };
    /** Settle for a servo move at the given lift: the pen's penDelay scaled
     * by the curve (THE shared clock); a calibration override is the card's
     * own settle, unscaled — the card is measuring it. */
    const settleFor = (penDelay: number, kind: LiftKind, pulse: number): number =>
      kind === 'override' ? Math.max(penDelay, 150) : settleAtLift(penDelay, pulse, model());
    const setDown = async (pulse: number): Promise<void> => {
      this.downOverrideActive = pulse !== Math.round(servo().penDownPulse);
      this.profileDownPulse = Math.round(servo().penDownPulse);
      if (pulse === downPulse) return;
      downPulse = pulse;
      await this.cmd(`SC,5,${pulse}`);
    };
    const downFor = (c: Chain): Promise<void> =>
      setDown(Math.round(servoFor?.(c.pen)?.down ?? servo().penDownPulse));
    // Asymmetric on purpose: pen-DOWN must physically complete before ink
    // matters (a truncated fall reads as "pen not all the way down" on
    // dense strokes), so it keeps more margin; pen-UP can start the travel
    // a hair early harmlessly.

    let stalls = 0;
    try {
      let chainIndex = 0;
      while (chainIndex < chains.length) {
        const c = chains[chainIndex];
        curChain = chainIndex;
        try {
        const base = pens[c.pen];
        const pen = (base && livePen?.(base.name)) ?? base;
        const feed = pen?.feed ?? 3000;
        // Settle = time for the servo to physically travel before motion
        // resumes. Too short: strokes start faint (pen still descending)
        // or travels drag (pen still lifting). Too long: the pen dwells
        // inked-and-stationary at every stroke start — wet pens bleed a
        // dot. Tune per pen via penDelay; 150 is a hard physical floor.
        const penDelay = pen?.penDelay ?? 300;
        const settle = Math.max(penDelay, 150); // full-lift settle (pauses, re-ink)
        const penName = pen?.name ?? '';
        // Pause dance: raise, wait, re-lower (drawing only). The run
        // replans its ramp from rest afterwards. If the user jogged or
        // re-origined while paused (drift recovery), the pen stays UP —
        // the coordinate frame moved, so finishing the interrupted stroke
        // inked would draw a stray line; the next chain re-inks normally.
        const pauseUp = async (): Promise<void> => {
          const wasUp = this.penIsUp;
          await setLiftFull(); // pauses always get the full, safe lift
          if (!wasUp) await this.penUp(settle);
          this.pauseAdjusted = false;
          report('paused', penName);
          const pauseWall0 = Date.now();
          while (this.plotPause && !this.plotAbort) {
            await new Promise((r) => setTimeout(r, 150));
          }
          pausedWallMs += Date.now() - pauseWall0;
          if (!this.plotAbort) {
            if (liveServo) {
              // The panel may have edited the pulses while paused: the
              // board now holds the profile pair, so the trackers follow.
              const sv = liveServo();
              liftPulse = Math.round(sv.penUpPulse);
              downPulse = Math.round(sv.penDownPulse);
              await this.cmd(`SC,4,${liftPulse}`);
              await this.cmd(`SC,5,${downPulse}`);
              await downFor(c); // this chain's landing pulse, if overridden
            }
            if (!wasUp && !this.pauseAdjusted) await this.penDown(settle);
          }
        };
        if (this.plotAbort) break;
        // Travel (pen up), ramped.
        await this.moveRun([[c.pts[0], c.pts[1]]], o.travelFeed, o, pauseUp, (ms) => {
          elapsedMs += ms;
        });
        sent += 1;
        if (this.plotAbort) break;
        // The pen falls from the lift it travelled in at.
        const downSettle = settleFor(penDelay, liftKind, liftPulse);
        await downFor(c);
        await this.penDown(downSettle);
        sent += 1;
        if (!c.dot) {
          const run: [number, number][] = [];
          for (let k = 2; k < c.pts.length; k += 2) run.push([c.pts[k], c.pts[k + 1]]);
          await this.moveRun(run, feed, o, pauseUp, (ms) => {
            sent += 1;
            elapsedMs += ms;
            if (sent % 25 === 0) report('plotting', penName);
          });
        }
        if (this.plotAbort) break;
        // Lift for the NEXT travel (full for the last chain), and the pen
        // rises to it with the settle that lift needs.
        const next = chains[chainIndex + 1];
        await liftFor(next, [c.pts[c.pts.length - 2], c.pts[c.pts.length - 1]]);
        const upSettle = settleFor(penDelay, liftKind, liftPulse);
        await this.penUp(upSettle);
        sent += 1;
        elapsedMs += downSettle + upSettle; // mirrors the totals' pen-cycle term
        // Re-ink pause (pen.reinkMm): pump markers and dip-style pens run
        // lean after a bounded length of ink. At the stroke boundary the pen
        // is already up — park at the paper origin (the gantry's stiffest
        // corner, clear of wet ink) and wait for Resume; the next chain's
        // travel returns from there naturally. Steppers stay energized
        // throughout, holding position against the handling.
        if (!c.dot) {
          for (let k = 2; k < c.pts.length; k += 2) {
            inkedMm += Math.hypot(c.pts[k] - c.pts[k - 2], c.pts[k + 1] - c.pts[k - 1]);
          }
        }
        const reinkAt = pen?.reinkMm ?? 0;
        if (reinkAt > 0 && inkedMm >= reinkAt && chainIndex < chains.length - 1 && !this.plotAbort) {
          await setLiftFull();
          await this.moveRun([[offX, offY]], o.travelFeed, o);
          warning = `re-ink ${penName}: ${Math.round(inkedMm)}mm drawn — pump/refill, then Resume`;
          this.plotPause = true;
          await pauseUp();
          warning = undefined;
          inkedMm = 0;
        }
        // Position health check while the pen is already up between chains.
        // Sparse on purpose: each check drains the FIFO (waits out queued
        // settles, ~0.1-1s) — every 25 chains cost minutes on 30k-chain
        // plots and visible hitching. Lost-command drift is rare and also
        // caught at plot end; ~every 8 minutes is plenty.
        const every = o.driftCheckEvery ?? 1000;
        if (every > 0 && chainIndex % every === every - 1) await verifyPosition();
        report('plotting', penName);
        chainIndex += 1;
        } catch (e) {
          // Stall recovery: the board stopped answering (a move that cannot
          // finish, or a lost byte). Abort and clear the board, adopt its
          // step counters as the truth, re-arm the servo registers, and redo
          // this chain from its start pen-up. Bounded: a board that keeps
          // stalling is a hardware problem to look at, not to loop on.
          if (!(e instanceof StallError) || this.plotAbort) throw e;
          stalls += 1;
          await this.emergencyClear(`stall: ${e.message}`);
          if (stalls > 3) throw new Error(`${e.message} — 4 stalls, giving up`);
          const pos = await this.queryPosition().catch(() => null);
          if (pos) {
            this.stepX = pos[0];
            this.stepY = pos[1];
          }
          this.lmCarryV0 = null;
          this.pendingMs = 0;
          liftPulse = -1; // registers may or may not have been written: re-send
          downPulse = -1;
          await setLiftFull();
          await setDown(Math.round(servo().penDownPulse));
          await this.penUp(Math.max(pens[c.pen]?.penDelay ?? 300, 150));
          warning = `board stall recovered at chain ${chainIndex + 1} (${e.command}) — redoing it`;
          report('plotting', pens[c.pen]?.name ?? '');
        }
      }
      // Never leave a reduced lift or an overridden landing on the board.
      await setLiftFull().catch(() => undefined);
      await setDown(Math.round(servo().penDownPulse)).catch(() => undefined);
      if (!this.plotAbort) {
        await this.penUp();
        await verifyPosition(); // before home() zeroes the counters
        await this.home();
        await this.cmd('EM,0,0'); // release motors so the sheet swap is easy
        report('done');
      } else {
        report('stopped');
      }
    } finally {
      this.plotting = false;
    }
  }

}
