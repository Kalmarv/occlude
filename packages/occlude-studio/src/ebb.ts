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
import { planPolyline, type Point } from './motion.js';

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
  junctionDeviation: number; // mm
  minimumCruiseRatio: number;
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

  private plotAbort = false;
  private plotPause = false;
  plotting = false;

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
    return this.version;
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

  /** Move to an absolute mm position over an explicit duration. Steps are
   * derived by rounding the ABSOLUTE position, so float error never
   * accumulates into drift; duration is clamped to the per-motor step-rate
   * ceiling (CoreXY: a diagonal doubles one motor's rate). */
  private async stepTo(xMm: number, yMm: number, ms: number, o: EbbOptions): Promise<void> {
    // Paper (x right, y down, mm) → machine axes, then absolute steps.
    const mx = (o.swapXY ? yMm : xMm) * (o.invertX ? -1 : 1);
    const my = (o.swapXY ? xMm : yMm) * (o.invertY ? -1 : 1);
    const sx = Math.round(mx * o.stepsPerMm);
    const sy = Math.round(my * o.stepsPerMm);
    const dx = sx - this.stepX;
    const dy = sy - this.stepY;
    if (dx === 0 && dy === 0) return;
    const motor = Math.max(Math.abs(dx + dy), Math.abs(dx - dy));
    const clamped = Math.max(Math.ceil(ms), Math.ceil(motor / MAX_MOTOR_STEPS_PER_MS), 2);
    await this.cmd(`XM,${clamped},${dx},${dy}`);
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
    onSegment?: (segMm: number) => void,
  ): Promise<void> {
    // Current logical paper position (invert the axis mapping).
    const curPaper = (): [number, number] => {
      const mx = (this.stepX / o.stepsPerMm) * (o.invertX ? -1 : 1);
      const my = (this.stepY / o.stepsPerMm) * (o.invertY ? -1 : 1);
      return o.swapXY ? [my, mx] : [mx, my];
    };
    let remaining = pts;
    while (remaining.length > 0 && !this.plotAbort) {
      const [cx, cy] = curPaper();
      const vt = Math.max(1, feedMmMin / 60);
      const accel = Math.max(1, o.acceleration);
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
          // Also bound the velocity change per packet. In particular, the
          // packets touching a corner should be close to the planned junction
          // speed instead of averaging a large part of the deceleration ramp.
          const maxDv = 1;
          const velocityDs = Math.max(0.005, (2 * vHere * maxDv + maxDv * maxDv) / (2 * accel));
          const ds = Math.min(phaseEnd - s, 4, Math.max(0.005, Math.min(vHere * 0.025, velocityDs)));
          const s2 = s + ds;
          const vAvg = Math.max(1e-3, (vHere + vAt(s2)) / 2);
          const t = s2 / segment.length;
          const x = segment.start[0] + (segment.end[0] - segment.start[0]) * t;
          const y = segment.start[1] + (segment.end[1] - segment.start[1]) * t;
          await this.stepTo(x, y, (ds / vAvg) * 1000, o);
          onSegment?.(ds);
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

  /** Emergency stop: abort motion, clear the FIFO, raise the pen. */
  async stop(): Promise<void> {
    this.plotAbort = true;
    // ES jumps the queue conceptually; fine to send through it — the board
    // aborts current+queued motion on receipt.
    await this.cmd('ES', true).catch(() => undefined);
    await this.penUp().catch(() => undefined);
  }

  pause(): void {
    this.plotPause = true;
  }

  resume(): void {
    this.plotPause = false;
  }

  /**
   * Plot a toolpath plan (`wasm_export_toolpath` layout: [pen, dot, n,
   * x0, y0, …] per chain, paper mm, already in tour order).
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
  ): Promise<void> {
    interface Chain {
      pen: number;
      dot: boolean;
      pts: Float64Array;
    }
    const chains: Chain[] = [];
    for (let i = 0; i < plan.length; ) {
      const pen = plan[i++];
      const dot = plan[i++] === 1;
      const n = plan[i++];
      chains.push({ pen, dot, pts: plan.subarray(i, i + n * 2) });
      i += n * 2;
    }
    // Totals for progress: commands and machine-time estimate.
    let total = 0;
    let totalMs = 0;
    {
      let px = 0;
      let py = 0;
      for (const c of chains) {
        const base = pens[c.pen];
        const pen = (base && livePen?.(base.name)) ?? base;
        const feed = pen?.feed ?? 3000;
        totalMs += (Math.hypot(c.pts[0] - px, c.pts[1] - py) / o.travelFeed) * 60_000;
        total += 3; // travel + pen down + pen up
        for (let k = 2; k < c.pts.length; k += 2) {
          totalMs +=
            (Math.hypot(c.pts[k] - c.pts[k - 2], c.pts[k + 1] - c.pts[k - 1]) / feed) * 60_000;
          total += 1;
        }
        totalMs += 2 * Math.max(pen?.penDelay ?? 300, 150) + 300;
        px = c.pts[c.pts.length - 2];
        py = c.pts[c.pts.length - 1];
      }
    }

    this.plotAbort = false;
    this.plotPause = false;
    this.plotting = true;
    await this.cmd('EM,1,1');
    let sent = 0;
    let elapsedMs = 0;
    const report = (state: PlotProgress['state'], penName = ''): void =>
      onProgress({ sent, total, elapsedMs, totalMs, penName, state });

    try {
      for (const c of chains) {
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
        // replans its ramp from rest afterwards.
        const pauseUp = async (): Promise<void> => {
          const wasUp = this.penIsUp;
          if (!wasUp) await this.penUp(settle);
          report('paused', penName);
          while (this.plotPause && !this.plotAbort) {
            await new Promise((r) => setTimeout(r, 150));
          }
          if (!this.plotAbort) {
            if (liveServo) {
              const sv = liveServo();
              await this.cmd(`SC,4,${Math.round(sv.servoDown)}`);
              await this.cmd(`SC,5,${Math.round(sv.servoUp)}`);
            }
            if (!wasUp) await this.penDown(settle);
          }
        };
        if (this.plotAbort) break;
        // Travel (pen up), ramped.
        await this.moveRun([[c.pts[0], c.pts[1]]], o.travelFeed, o, pauseUp);
        sent += 1;
        if (this.plotAbort) break;
        await this.penDown(settle);
        sent += 1;
        if (!c.dot) {
          const run: [number, number][] = [];
          for (let k = 2; k < c.pts.length; k += 2) run.push([c.pts[k], c.pts[k + 1]]);
          await this.moveRun(run, feed, o, pauseUp, (segMm) => {
            sent += 1;
            elapsedMs += (segMm / feed) * 60_000;
            if (sent % 25 === 0) report('plotting', penName);
          });
        }
        if (this.plotAbort) break;
        await this.penUp(settle);
        sent += 1;
        elapsedMs += 2 * settle;
        report('plotting', penName);
      }
      if (!this.plotAbort) {
        await this.penUp();
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
