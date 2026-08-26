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
 * - No homing switches: user jogs to origin, CS zeroes the counters,
 *   HM,<rate> returns to logical 0,0. SR,0 on connect or the servo powers
 *   off after idle and the pen sags onto the paper.
 * - Never send: BL, R/RB, CU,1,0.
 */

import type { PenDef } from 'occlude';

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
}

const MAX_MOTOR_STEPS_PER_MS = 25; // verified: 25k steps/s per motor

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
    // No reset on open, no warmup (verified). Configure:
    // SR,0 — disable servo idle power-off (pen sag); EM,1,1 — 1/16 µstep.
    const v = await this.cmd('V', false);
    this.version = v[0] ?? '';
    await this.cmd('SR,0');
    if (o) {
      await this.cmd(`SC,4,${Math.round(o.servoDown)}`);
      await this.cmd(`SC,5,${Math.round(o.servoUp)}`);
    }
    await this.penUp(0);
    await this.cmd('EM,1,1');
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

  /** Move to absolute mm position (in the user's origin frame). Steps are
   * derived by rounding the ABSOLUTE position, so float error never
   * accumulates into drift. Duration from feed, clamped to the per-motor
   * step-rate ceiling (CoreXY: a diagonal doubles one motor's rate). */
  private async moveTo(xMm: number, yMm: number, feed: number, o: EbbOptions): Promise<void> {
    // Paper (x right, y down, mm) → machine axes, then absolute steps.
    const mx = (o.swapXY ? yMm : xMm) * (o.invertX ? -1 : 1);
    const my = (o.swapXY ? xMm : yMm) * (o.invertY ? -1 : 1);
    const sx = Math.round(mx * o.stepsPerMm);
    const sy = Math.round(my * o.stepsPerMm);
    const dx = sx - this.stepX;
    const dy = sy - this.stepY;
    if (dx === 0 && dy === 0) return;
    const distMm = Math.hypot(dx, dy) / o.stepsPerMm;
    let ms = Math.ceil((distMm / Math.max(1, feed)) * 60_000);
    const motor = Math.max(Math.abs(dx + dy), Math.abs(dx - dy));
    ms = Math.max(ms, Math.ceil(motor / MAX_MOTOR_STEPS_PER_MS), 2);
    await this.cmd(`XM,${ms},${dx},${dy}`);
    this.stepX = sx;
    this.stepY = sy;
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
    await this.moveTo(x, y, o.travelFeed, o);
  }

  /** Zero the board's step counters here — "this is the paper origin". */
  async setOrigin(): Promise<void> {
    await this.cmd('CS');
    this.stepX = 0;
    this.stepY = 0;
  }

  async home(): Promise<void> {
    await this.penUp();
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
        const pen = pens[c.pen];
        const feed = pen?.feed ?? 3000;
        totalMs += (Math.hypot(c.pts[0] - px, c.pts[1] - py) / o.travelFeed) * 60_000;
        total += 3; // travel + pen down + pen up
        for (let k = 2; k < c.pts.length; k += 2) {
          totalMs +=
            (Math.hypot(c.pts[k] - c.pts[k - 2], c.pts[k + 1] - c.pts[k - 1]) / feed) * 60_000;
          total += 1;
        }
        totalMs += 2 * Math.max(pen?.penDelay ?? 100, 500) + 300;
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
        const pen = pens[c.pen];
        const feed = pen?.feed ?? 3000;
        const settle = Math.max(pen?.penDelay ?? 100, 500);
        // Travel (pen is up between chains).
        await this.waitIfPaused(report, pen?.name ?? '');
        if (this.plotAbort) break;
        await this.moveTo(c.pts[0], c.pts[1], o.travelFeed, o);
        sent += 1;
        await this.penDown(settle);
        sent += 1;
        if (!c.dot) {
          for (let k = 2; k < c.pts.length; k += 2) {
            await this.waitIfPaused(report, pen?.name ?? '');
            if (this.plotAbort) break;
            const segMm = Math.hypot(c.pts[k] - c.pts[k - 2], c.pts[k + 1] - c.pts[k - 1]);
            await this.moveTo(c.pts[k], c.pts[k + 1], feed, o);
            sent += 1;
            elapsedMs += (segMm / feed) * 60_000;
            if (sent % 10 === 0) report('plotting', pen?.name ?? '');
          }
        }
        if (this.plotAbort) break;
        await this.penUp(settle);
        sent += 1;
        elapsedMs += 2 * settle;
        report('plotting', pen?.name ?? '');
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

  private async waitIfPaused(
    report: (s: PlotProgress['state'], pen: string) => void,
    pen: string,
  ): Promise<void> {
    if (!this.plotPause) return;
    const wasUp = this.penIsUp;
    await this.penUp();
    report('paused', pen);
    while (this.plotPause && !this.plotAbort) {
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!this.plotAbort && !wasUp) {
      await this.penDown();
    }
  }
}
