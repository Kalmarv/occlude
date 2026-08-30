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
import {
  planDurationMs, planPolyline, segmentsToBlocks, type MotionBlock, type Point,
} from './motion.js';

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
  /** Servo positions (SC,4 / SC,5 — write-only on the board, persisted in
   * the app). Verified working: down 10000, up 16000 (~5mm lift). */
  servoDown: number;
  servoUp: number;
  /** Host-side look-ahead limits. Pen feed remains the per-stroke maximum. */
  acceleration: number; // mm/s²
  /** Pen-up moves have no ink physics or line quality to protect — only the
   * skip-step ceiling. A higher travel accel cuts most of the ramp time on
   * stroke-dense plots, where short hops never reach cruise. */
  travelAcceleration: number; // mm/s²
  junctionDeviation: number; // mm
  minimumCruiseRatio: number;
  /** Quick-hop: for travels shorter than this (mm), lift the pen to only
   * ~40% height with proportionally shorter settles. On hatch/stipple-dense
   * plots the pen cycle is ~95% of plot time, so this is the big lever.
   * 0 disables. */
  quickHopMm: number;
  /** Use the LM command (firmware ≥2.5.3): true constant-acceleration ramps
   * interpolated at 25kHz in hardware, vs the XM fallback's ~40Hz staircase
   * of constant-velocity packets. */
  lmMotion: boolean;
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
}

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
  // Set when the user jogs or re-origins during a pause: the coordinate
  // frame moved, so resuming must NOT re-lower the pen — continuing the
  // interrupted stroke from a shifted position would draw a stray line.
  // The current stroke's remainder is traced pen-up; the next chain's own
  // pen-down resumes inking. This is the drift-recovery flow: pause → jog
  // the pen onto the paper origin → Set origin → resume.
  private pauseAdjusted = false;

  async connect(o?: { servoDown: number; servoUp: number }): Promise<string> {
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
    const v = await this.cmd('V', false);
    this.version = v[0] ?? '';
    await this.cmd('EM,0,0');
    await this.cmd('SR,0');
    if (o) {
      await this.cmd(`SC,4,${Math.round(o.servoDown)}`);
      await this.cmd(`SC,5,${Math.round(o.servoUp)}`);
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
      this.inFlight = null;
      cur.resolve(lines);
      this.pump();
      return;
    }
    if (line === 'OK') {
      const lines = this.collected;
      this.collected = [];
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
    const bytes = new TextEncoder().encode(next.line + '\r');
    this.writer.write(bytes).catch((e: unknown) => {
      this.inFlight = null;
      next.reject(e instanceof Error ? e : new Error(String(e)));
    });
  }

  /** Send one command; resolves with its data lines once OK (or the first
   * data line for no-OK queries) arrives. The write→await-OK pacing IS the
   * flow control — the board's FIFO backpressure does the rest. */
  cmd(line: string, expectOk = true): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.queue.push({ line, expectOk, resolve, reject });
      this.pump();
    });
  }

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
    const [rate1, accel1] = axisRate(steps1, Math.abs(dx + dy));
    const [rate2, accel2] = axisRate(steps2, Math.abs(dx - dy));
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

  async jog(dxMm: number, dyMm: number, o: EbbOptions): Promise<void> {
    if (this.plotting && this.plotPause) this.pauseAdjusted = true;
    // Invert the paper→machine mapping to recover current paper position.
    const mx = (this.stepX / o.stepsPerMm) * (o.invertX ? -1 : 1);
    const my = (this.stepY / o.stepsPerMm) * (o.invertY ? -1 : 1);
    const x = (o.swapXY ? my : mx) + dxMm;
    const y = (o.swapXY ? mx : my) + dyMm;
    await this.cmd('EM,1,1');
    await this.moveRun([[x, y]], o.travelFeed, o);
  }

  /** Zero the board's step counters here — "this is the paper origin". */
  async setOrigin(): Promise<void> {
    if (this.plotting && this.plotPause) this.pauseAdjusted = true;
    await this.cmd('CS');
    this.stepX = 0;
    this.stepY = 0;
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
    this.logLine('>', 'ES (raw, queue bypassed)');
    try {
      await this.writer?.write(new TextEncoder().encode('\rES\r'));
    } catch {
      // port gone
    }
    const err = new Error('stopped');
    const stranded = [this.inFlight, ...this.queue].filter(
      (c): c is QueuedCmd => c !== null,
    );
    this.inFlight = null;
    this.queue = [];
    this.collected = [];
    for (const c of stranded) c.reject(err);
    // Late replies (the aborted command's OK, ES's own response) arrive
    // with nothing in flight and are dropped by onLine; give them time to
    // flush so they can't be attributed to the next queued command.
    await new Promise((r) => setTimeout(r, 300));
    await this.penUp().catch(() => undefined);
    // Unlock the gantry: after an abort the next step is usually a manual
    // re-park, and held steppers fight the hand.
    await this.cmd('EM,0,0').catch(() => undefined);
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
    liveServo?: () => { servoDown: number; servoUp: number },
    /** Plot only this pen's chains (index into `pens`); omit for all. */
    onlyPen?: number,
  ): Promise<void> {
    interface Chain {
      pen: number;
      dot: boolean;
      pts: Float64Array;
    }
    let chains: Chain[] = [];
    for (let i = 0; i < plan.length; ) {
      const pen = plan[i++];
      const dot = plan[i++] === 1;
      const n = plan[i++];
      chains.push({ pen, dot, pts: plan.subarray(i, i + n * 2) });
      i += n * 2;
    }
    if (onlyPen !== undefined) chains = chains.filter((c) => c.pen === onlyPen);
    // Totals for progress: the machine-time estimate sums the planner's
    // actual trapezoids per move — a stroke that never reaches feed (dense
    // corners, short segments) is counted at its planned speed, not the
    // "always at full feed" fiction that undershot on exactly the plots
    // that take longest.
    let total = 0;
    let totalMs = 0;
    {
      const drawAccel = Math.max(1, o.acceleration);
      const travelAccel = Math.max(1, o.travelAcceleration);
      const limits = (maxVelocity: number, acceleration: number) => ({
        maxVelocity: Math.max(1, maxVelocity),
        acceleration,
        junctionDeviation: Math.max(0, o.junctionDeviation),
        minimumCruiseRatio: o.minimumCruiseRatio,
        startVelocity: 0,
        endVelocity: 0,
      });
      let px = 0;
      let py = 0;
      chains.forEach((c, i) => {
        const base = pens[c.pen];
        const pen = (base && livePen?.(base.name)) ?? base;
        const feed = pen?.feed ?? 3000;
        const travel: Point[] = [[px, py], [c.pts[0], c.pts[1]]];
        totalMs += planDurationMs(
          planPolyline(travel, limits(o.travelFeed / 60, travelAccel)),
          travelAccel,
        );
        total += 3; // travel + pen down + pen up
        if (!c.dot) {
          const poly: Point[] = [];
          for (let k = 0; k < c.pts.length; k += 2) poly.push([c.pts[k], c.pts[k + 1]]);
          totalMs += planDurationMs(planPolyline(poly, limits(feed / 60, drawAccel)), drawAccel);
          total += poly.length - 1;
        }
        // Pen-cycle cost mirrors the quick-hop rule the plot loop applies:
        // down at the height set by the travel INTO this chain, up at the
        // height chosen for the travel OUT of it.
        const settle = Math.max(pen?.penDelay ?? 300, 150);
        const hopSettle = Math.max(150, Math.round(settle * 0.4));
        const gapIn = Math.hypot(c.pts[0] - px, c.pts[1] - py);
        const nxt = chains[i + 1];
        px = c.pts[c.pts.length - 2];
        py = c.pts[c.pts.length - 1];
        const gapOut = nxt ? Math.hypot(nxt.pts[0] - px, nxt.pts[1] - py) : Infinity;
        const hop = (g: number): boolean => o.quickHopMm > 0 && g <= o.quickHopMm;
        const down = i > 0 && hop(gapIn) ? hopSettle : settle;
        const up = hop(gapOut) ? hopSettle : settle;
        totalMs += down + up + 300;
      });
    }

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
      onProgress({ sent, total, elapsedMs, totalMs, penName, state, etaMs, warning });
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

    // Quick-hop lift state: between close-together strokes the pen rises to
    // only ~40% height with proportionally shorter settles — on hatch- and
    // stipple-dense plots the pen cycle is ~95% of plot time. Full lift is
    // always restored for long travels, pauses, aborts, and the plot end.
    const HOP = 0.4;
    let hopMode = false;
    const servo = (): { servoDown: number; servoUp: number } =>
      liveServo?.() ?? { servoDown: o.servoDown, servoUp: o.servoUp };
    const setLift = async (hop: boolean): Promise<void> => {
      if (hop === hopMode) return;
      hopMode = hop;
      const sv = servo();
      const up = hop ? sv.servoDown + (sv.servoUp - sv.servoDown) * HOP : sv.servoUp;
      await this.cmd(`SC,5,${Math.round(up)}`);
    };
    const hopSettleOf = (settle: number): number => Math.max(150, Math.round(settle * HOP));

    try {
      for (const [chainIndex, c] of chains.entries()) {
        const base = pens[c.pen];
        const pen = (base && livePen?.(base.name)) ?? base;
        const feed = pen?.feed ?? 3000;
        // Settle = time for the servo to physically travel before motion
        // resumes. Too short: strokes start faint (pen still descending)
        // or travels drag (pen still lifting). Too long: the pen dwells
        // inked-and-stationary at every stroke start — wet pens bleed a
        // dot. Tune per pen via penDelay; 150 is a hard physical floor.
        const settle = Math.max(pen?.penDelay ?? 300, 150);
        const penName = pen?.name ?? '';
        // Pause dance: raise, wait, re-lower (drawing only). The run
        // replans its ramp from rest afterwards. If the user jogged or
        // re-origined while paused (drift recovery), the pen stays UP —
        // the coordinate frame moved, so finishing the interrupted stroke
        // inked would draw a stray line; the next chain re-inks normally.
        const pauseUp = async (): Promise<void> => {
          const wasUp = this.penIsUp;
          await setLift(false); // pauses always get the full, safe lift
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
              const sv = liveServo();
              await this.cmd(`SC,4,${Math.round(sv.servoDown)}`);
              await this.cmd(`SC,5,${Math.round(sv.servoUp)}`);
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
        const downSettle = hopMode ? hopSettleOf(settle) : settle;
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
        // Lift height for the NEXT travel: hop when the next chain starts
        // nearby, full otherwise (and always full for the last chain).
        const next = chains[chainIndex + 1];
        const gapOut = next
          ? Math.hypot(
              next.pts[0] - c.pts[c.pts.length - 2],
              next.pts[1] - c.pts[c.pts.length - 1],
            )
          : Infinity;
        await setLift(o.quickHopMm > 0 && gapOut <= o.quickHopMm);
        const upSettle = hopMode ? hopSettleOf(settle) : settle;
        await this.penUp(upSettle);
        sent += 1;
        elapsedMs += downSettle + upSettle + 300; // mirrors the totals' pen-cycle term
        // Cheap health check while the pen is already up between chains.
        if (chainIndex % 25 === 24) await verifyPosition();
        report('plotting', penName);
      }
      await setLift(false).catch(() => undefined); // never leave hop height behind
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
