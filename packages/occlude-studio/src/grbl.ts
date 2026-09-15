/**
 * GRBL driver over Web Serial — the iDraw H (DrawCore) family and any other
 * GRBL 1.1 controller. The studio's other driver is the EBB one (ebb.ts);
 * a machine profile's `driver` picks which one the session talks to.
 *
 * Protocol facts this relies on (GRBL 1.1):
 *  - one `ok` or `error:N` per line sent; `ALARM:N` aborts everything;
 *    `<…>` is a status report answering the real-time `?`; `[...]` are
 *    feedback lines (settings, `$I` version) that precede their `ok`.
 *  - the receive buffer is 128 bytes: the streamer keeps at most
 *    `RX_BUDGET` bytes of unacknowledged lines in flight (character
 *    counting), which is what keeps the planner fed through dense curves.
 *  - real-time bytes bypass the buffer: `!` feed hold, `~` resume, `?`
 *    status, 0x18 soft reset (keeps the position when motion is held).
 *  - `$J=` jogs (cancellable, no modal side effects), `$H` homes when the
 *    controller has homing enabled, `G10 L20 P1 X0 Y0` sets the work origin.
 *
 * Coordinates: the plan is paper mm; the paper offset makes it bed mm; the
 * profile's `flipY` mirrors Y across the bed height for controllers whose Y
 * grows upward from a bottom-left home — the same mapping the G-code export
 * uses, so what plots here is what an exported file plots.
 *
 * The pen is the pen definition's `penUp`/`penDown`: Z heights in `zMode`,
 * spindle S values through M3/M5 otherwise, with `penDelay` settling both
 * ways. Time estimates are coarse (feed-limited, no acceleration model)
 * until the machine is calibrated; they are labelled as such.
 */
import type { PenDef } from 'occlude';

import type { EbbOptions, PlotProgress, ServoOverride } from './ebb.js';
import type { MachineSettings } from './store.js';

interface SerialPortLike {
  open(opts: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
interface SerialLike {
  requestPort(opts?: { filters?: { usbVendorId?: number; usbProductId?: number }[] }): Promise<SerialPortLike>;
}

/** Bytes of unacknowledged lines the controller may hold (its buffer is 128). */
const RX_BUDGET = 120;
/** A line the controller has not acknowledged for this long is a stall. */
const REPLY_TIMEOUT_MS = 20_000;
/** Z feed assumed for pricing pen cycles when the pen is a Z move, mm/min. */
const Z_FEED = 1000;

interface Pending {
  line: string;
  bytes: number;
  feedback: string[];
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class GrblError extends Error {}

export class Grbl {
  private port: SerialPortLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private rxBuf = '';
  private pending: Pending[] = [];
  private inFlightBytes = 0;
  private waiters: (() => void)[] = [];
  private log: string[] = [];
  private t0 = Date.now();
  version = '';
  /** The profile's machine settings; the session assigns them before use. */
  settings: MachineSettings = { bedW: 300, bedH: 218, travelFeed: 6000, zMode: true, arcSupport: false, resolution: 0.2, flipY: false };
  /** The pen manual pen up/down uses when no plot is running. */
  manualPen: PenDef | undefined;
  /** Work position in BED mm (before the Y mirror), tracked from what was sent. */
  private wpos: [number, number] = [0, 0];
  private penIsUp = true;
  plotting = false;
  private plotPause = false;
  private plotAbort = false;
  paperOffset: [number, number] = [0, 0];

  private logLine(dir: '>' | '<', text: string): void {
    this.log.push(`${((Date.now() - this.t0) / 1000).toFixed(3)} ${dir} ${text}`);
    if (this.log.length > 20000) this.log.splice(0, 5000);
  }
  transcript(): string { return this.log.join('\n'); }

  get connected(): boolean { return this.port !== null; }
  get paused(): boolean { return this.plotting && this.plotPause; }

  // ---- connection ----------------------------------------------------------

  async connect(_servo?: unknown, port?: SerialPortLike): Promise<string> {
    if (!port) {
      const serial = (navigator as unknown as { serial: SerialLike }).serial;
      port = await serial.requestPort();
    }
    await port.open({ baudRate: 115200 });
    this.port = port;
    this.writer = port.writable!.getWriter();
    this.t0 = Date.now();
    void this.readLoop();
    // Opening the port resets most boards; give the banner a moment, then
    // wake the parser with an empty line so any stale partial line is closed.
    await new Promise((r) => setTimeout(r, 1200));
    await this.raw('\r\n');
    await new Promise((r) => setTimeout(r, 200));
    const info = await this.cmd('$I').catch(() => [] as string[]);
    this.version = info.find((l) => l.startsWith('[VER:'))?.slice(5).replace(/\]$/, '') || this.banner || 'grbl';
    const status = await this.status().catch(() => '');
    if (/^<Alarm/.test(status)) await this.cmd('$X').catch(() => undefined);
    await this.cmd('G21 G90 G17 G54');
    this.adoptPosition(status);
    return this.version;
  }

  async disconnect(): Promise<void> {
    if (!this.port) return;
    try { await this.writer?.close(); } catch { /* port gone */ }
    try { await this.port.close(); } catch { /* port gone */ }
    this.writer = null;
    this.port = null;
    for (const p of this.pending) { clearTimeout(p.timer); p.reject(new GrblError('disconnected')); }
    this.pending = [];
    this.inFlightBytes = 0;
  }

  private banner = '';
  private statusWaiters: ((line: string) => void)[] = [];

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
        for (const line of parts) if (line.length > 0) this.onLine(line);
      }
    } catch {
      // aborted or unplugged
    } finally {
      reader.releaseLock();
    }
  }

  private onLine(line: string): void {
    this.logLine('<', line);
    if (line.startsWith('<')) {
      const w = this.statusWaiters.shift();
      if (w) w(line);
      return;
    }
    if (line.startsWith('Grbl')) { this.banner = line; return; }
    if (line.startsWith('ALARM')) {
      const err = new GrblError(`${line} — unlock with $X, then home or set the origin again`);
      for (const p of this.pending) { clearTimeout(p.timer); p.reject(err); }
      this.pending = [];
      this.inFlightBytes = 0;
      this.wake();
      return;
    }
    const head = this.pending[0];
    if (!head) return; // unsolicited ([MSG:…] after reset, a stray ok)
    if (line === 'ok' || line.startsWith('error:')) {
      this.pending.shift();
      this.inFlightBytes -= head.bytes;
      clearTimeout(head.timer);
      if (line === 'ok') head.resolve(head.feedback);
      else head.reject(new GrblError(`${line} after ${head.line}`));
      this.wake();
      return;
    }
    head.feedback.push(line);
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  private async raw(text: string): Promise<void> {
    if (!this.writer) throw new GrblError('not connected');
    await this.writer.write(new TextEncoder().encode(text));
  }

  /** Real-time byte: bypasses the buffer and the counter. */
  private async realtime(byte: string): Promise<void> {
    this.logLine('>', `(realtime ${byte === '\x18' ? 'reset' : byte})`);
    await this.raw(byte);
  }

  /** Send one line once the controller has room for it; resolves on its ok
   * with the feedback lines that preceded it. This is the streamer: with
   * several lines in flight the planner never starves. */
  send(line: string, timeoutMs = REPLY_TIMEOUT_MS): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const bytes = line.length + 1;
      const attempt = (): void => {
        if (!this.writer) { reject(new GrblError('not connected')); return; }
        if (this.inFlightBytes + bytes > RX_BUDGET && this.pending.length > 0) { this.waiters.push(attempt); return; }
        const p: Pending = { line, bytes, feedback: [], resolve, reject };
        p.timer = setTimeout(() => {
          if (!this.pending.includes(p)) return;
          this.logLine('<', `(watchdog: no reply to ${line} after ${timeoutMs} ms)`);
          reject(new GrblError(`no reply to ${line} after ${timeoutMs / 1000} s`));
        }, timeoutMs);
        this.pending.push(p);
        this.inFlightBytes += bytes;
        this.logLine('>', line);
        this.raw(line + '\n').catch((e: unknown) => {
          clearTimeout(p.timer);
          this.pending = this.pending.filter((q) => q !== p);
          this.inFlightBytes -= bytes;
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      };
      attempt();
    });
  }

  /** A single command: the same as `send`, kept for the controls and the log. */
  cmd(line: string, _expectOk = true, timeoutMs?: number): Promise<string[]> { return this.send(line, timeoutMs); }

  /** Real-time status report `<State|WPos:x,y,z|…>`. */
  status(timeoutMs = 2000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.statusWaiters = this.statusWaiters.filter((w) => w !== on); reject(new GrblError('no status report')); }, timeoutMs);
      const on = (line: string): void => { clearTimeout(timer); resolve(line); };
      this.statusWaiters.push(on);
      this.raw('?').catch(reject);
    });
  }

  private adoptPosition(status: string): void {
    const w = status.match(/WPos:(-?[\d.]+),(-?[\d.]+)/);
    let x: number, y: number;
    if (w) { x = Number(w[1]); y = Number(w[2]); }
    else {
      const m = status.match(/MPos:(-?[\d.]+),(-?[\d.]+)/), o = status.match(/WCO:(-?[\d.]+),(-?[\d.]+)/);
      if (!m) return;
      x = Number(m[1]) - (o ? Number(o[1]) : 0); y = Number(m[2]) - (o ? Number(o[2]) : 0);
    }
    this.wpos = this.fromMachine([x, y]);
  }

  /** Wait until the controller reports Idle (motion finished). */
  private async waitIdle(timeoutMs = 120_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.status().catch(() => '');
      if (/^<(Idle|Check|Door:0)/.test(s)) { this.adoptPosition(s); return; }
      if (/^<Alarm/.test(s)) throw new GrblError('controller is in alarm');
      if (Date.now() > end) throw new GrblError('motion did not finish');
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // ---- coordinates ----------------------------------------------------------

  /** Bed mm → the coordinates the controller reads. */
  private toMachine(p: readonly [number, number]): [number, number] {
    return this.settings.flipY ? [p[0], this.settings.bedH - p[1]] : [p[0], p[1]];
  }
  private fromMachine(p: readonly [number, number]): [number, number] { return this.toMachine(p); }
  private fmt(v: number): string { return (Math.round(v * 1000) / 1000).toFixed(3); }
  private g0(bed: readonly [number, number]): string {
    const [x, y] = this.toMachine(bed);
    return `G0 X${this.fmt(x)} Y${this.fmt(y)}`;
  }
  private g1(bed: readonly [number, number], feed: number): string {
    const [x, y] = this.toMachine(bed);
    return `G1 X${this.fmt(x)} Y${this.fmt(y)} F${Math.round(feed)}`;
  }

  // ---- pen ----------------------------------------------------------------

  private penUpLines(pen: PenDef | undefined): string[] {
    const delay = pen && pen.penDelay > 0 ? [`G4 P${(pen.penDelay / 1000).toFixed(3)}`] : [];
    if (!this.settings.zMode) return ['M5', ...delay];
    return [`G0 Z${this.fmt(pen?.penUp ?? 5)}`, ...delay];
  }
  private penDownLines(pen: PenDef | undefined): string[] {
    const delay = pen && pen.penDelay > 0 ? [`G4 P${(pen.penDelay / 1000).toFixed(3)}`] : [];
    if (!this.settings.zMode) return [`M3 S${Math.max(1, Math.round(pen?.penDown ?? 1))}`, ...delay];
    return [`G1 Z${this.fmt(pen?.penDown ?? 0)} F${Math.round(pen?.feed ?? 1000)}`, ...delay];
  }

  async penUp(_settleMs = 300): Promise<void> {
    for (const l of this.penUpLines(this.manualPen)) await this.send(l);
    this.penIsUp = true;
  }
  async penDown(_settleMs = 300): Promise<void> {
    for (const l of this.penDownLines(this.manualPen)) await this.send(l);
    this.penIsUp = false;
  }

  // ---- manual motion and origins -------------------------------------------

  bedPosition(_o?: EbbOptions): [number, number] { return [this.wpos[0], this.wpos[1]]; }

  async jog(dxMm: number, dyMm: number, o: EbbOptions): Promise<void> {
    if (!this.penIsUp) await this.penUp();
    const [mx, my] = this.toMachine([dxMm, dyMm]), [zx, zy] = this.toMachine([0, 0]);
    await this.send(`$J=G91 G21 X${this.fmt(mx - zx)} Y${this.fmt(my - zy)} F${Math.round(o.travelFeed || this.settings.travelFeed)}`);
    await this.waitIdle();
  }

  setPaperOrigin(_o?: EbbOptions): [number, number] {
    this.paperOffset = this.wpos.map((v) => Math.round(v * 100) / 100) as [number, number];
    return this.paperOffset;
  }

  async goToPaperOrigin(_o?: EbbOptions): Promise<void> {
    await this.penUp();
    await this.send(this.g0(this.paperOffset));
    await this.waitIdle();
  }

  /** "This is the bed origin": the work coordinate origin, persistent in
   * the controller (G54), and the paper offset is cleared with it. */
  async setOrigin(): Promise<void> {
    await this.send('G10 L20 P1 X0 Y0');
    this.wpos = [0, 0];
    this.paperOffset = [0, 0];
  }

  /** Home with the switches when the controller has them; else return to
   * the work origin. */
  async home(): Promise<void> {
    await this.penUp();
    try {
      await this.send('$H', 90_000);
    } catch (e) {
      if (!(e instanceof GrblError && /error:5/.test(e.message))) throw e;
      await this.send(this.g0([0, 0]));
    }
    await this.waitIdle();
  }

  /** Feed hold, then a soft reset (which keeps the position while held),
   * unlock, pen up. The host pipeline is reset before the controller is. */
  async stop(): Promise<void> {
    this.plotAbort = true;
    this.plotPause = false;
    try {
      await this.realtime('!');
      await new Promise((r) => setTimeout(r, 400));
      await this.realtime('\x18');
    } catch { /* port gone */ }
    for (const p of this.pending) { clearTimeout(p.timer); p.reject(new GrblError('stopped')); }
    this.pending = [];
    this.inFlightBytes = 0;
    this.wake();
    await new Promise((r) => setTimeout(r, 1200));
    await this.send('$X').catch(() => undefined);
    await this.send('G21 G90 G54').catch(() => undefined);
    await this.penUp().catch(() => undefined);
    const s = await this.status().catch(() => '');
    this.adoptPosition(s);
  }

  pause(): void {
    if (!this.plotting || this.plotPause) return;
    this.plotPause = true;
    void this.realtime('!').catch(() => undefined);
  }
  resume(): void {
    if (!this.plotting || !this.plotPause) return;
    this.plotPause = false;
    void this.realtime('~').catch(() => undefined);
  }

  // ---- plotting --------------------------------------------------------------

  /** Same contract as Ebb.plot: a toolpath plan in paper mm, one pen per
   * run by hand, progress callbacks, resume from a chain. Servo arguments
   * are accepted for the shared call site and ignored. */
  async plot(
    plan: Float64Array,
    pens: PenDef[],
    o: EbbOptions,
    onProgress: (p: PlotProgress) => void,
    livePen?: (name: string) => PenDef | undefined,
    _liveServo?: () => { penUpPulse: number; penDownPulse: number },
    onlyPen?: number,
    _servoFor?: (penIndex: number) => ServoOverride | undefined,
    startChain = 0,
  ): Promise<void> {
    interface Chain { pen: number; dot: boolean; pts: Float64Array }
    let chains: Chain[] = [];
    const [offX, offY] = this.paperOffset;
    for (let i = 0; i < plan.length;) {
      const pen = plan[i++], dot = plan[i++] === 1, n = plan[i++];
      const pts = new Float64Array(n * 2);
      for (let k = 0; k < n; k++) { pts[k * 2] = plan[i + k * 2] + offX; pts[k * 2 + 1] = plan[i + k * 2 + 1] + offY; }
      chains.push({ pen, dot, pts });
      i += n * 2;
    }
    if (onlyPen !== undefined) chains = chains.filter((c) => c.pen === onlyPen);
    const first = Math.max(0, Math.min(startChain, chains.length));
    const penOf = (pi: number): PenDef | undefined => { const base = pens[pi]; return (base && livePen?.(base.name)) ?? base; };
    const travelFeed = o.travelFeed || this.settings.travelFeed;

    // Coarse model: feed-limited draw and travel, pen cycles as Z travel plus settle.
    const priceChain = (c: Chain, from: readonly [number, number]): { ms: number; draw: number; travel: number } => {
      const pen = penOf(c.pen), feed = Math.max(1, pen?.feed ?? 1000);
      let draw = 0;
      for (let k = 2; k < c.pts.length; k += 2) draw += Math.hypot(c.pts[k] - c.pts[k - 2], c.pts[k + 1] - c.pts[k - 1]);
      const travel = Math.hypot(c.pts[0] - from[0], c.pts[1] - from[1]);
      const z = this.settings.zMode ? Math.abs((pen?.penUp ?? 5) - (pen?.penDown ?? 0)) : 0;
      const cycle = 2 * ((z / Z_FEED) * 60_000 + (pen?.penDelay ?? 0));
      return { ms: (draw / feed) * 60_000 + (travel / travelFeed) * 60_000 + cycle, draw, travel };
    };
    let totalMs = 0, drawMm = 0, total = 0;
    { let at: [number, number] = this.wpos;
      for (const c of chains.slice(first)) { const p = priceChain(c, at); totalMs += p.ms; drawMm += p.draw; total += c.pts.length / 2 + 4; at = [c.pts[c.pts.length - 2], c.pts[c.pts.length - 1]]; } }

    this.plotAbort = false;
    this.plotPause = false;
    this.plotting = true;
    const started = Date.now();
    let pausedMs = 0, pauseStart = 0, sent = 0, elapsedMs = 0, drawnMm = 0, lastReport = 0;
    const penName = (c: Chain): string => penOf(c.pen)?.name ?? `pen ${c.pen}`;
    const report = (state: PlotProgress['state'], chain: number, force = false): void => {
      const now = Date.now();
      if (!force && now - lastReport < 200) return;
      lastReport = now;
      const wall = now - started - pausedMs;
      const frac = totalMs > 0 ? Math.min(1, elapsedMs / totalMs) : 0;
      const measured = frac > 0.05 ? wall / frac - wall : totalMs - elapsedMs;
      const etaMs = Math.max(0, frac > 0.05 ? measured * 0.7 + (totalMs - elapsedMs) * 0.3 : totalMs - elapsedMs);
      onProgress({ sent, total, elapsedMs, totalMs, penName: chains[chain] ? penName(chains[chain]) : '', state, etaMs, drawnMm, drawMm, chain, chainTotal: chains.length, warning: 'GRBL timing is coarse until the machine is calibrated' });
    };
    let lastPen: number | null = null, current = first;
    try {
      await this.send('G21 G90 G54');
      let at: [number, number] = this.wpos;
      for (let ci = first; ci < chains.length; ci++) {
        const c = chains[ci];
        current = ci;
        while (this.plotPause && !this.plotAbort) {
          if (!pauseStart) pauseStart = Date.now();
          report('paused', ci, true);
          await new Promise((r) => setTimeout(r, 200));
        }
        if (pauseStart) { pausedMs += Date.now() - pauseStart; pauseStart = 0; }
        if (this.plotAbort) break;
        const pen = penOf(c.pen);
        if (lastPen !== c.pen && lastPen !== null && !this.penIsUp) { for (const l of this.penUpLines(penOf(lastPen))) await this.send(l); this.penIsUp = true; }
        lastPen = c.pen;
        const price = priceChain(c, at);
        const startPt: [number, number] = [c.pts[0], c.pts[1]];
        await this.send(this.g0(startPt)); sent++;
        for (const l of this.penDownLines(pen)) { await this.send(l); sent++; }
        this.penIsUp = false;
        if (!c.dot) {
          const feed = Math.max(1, pen?.feed ?? 1000);
          for (let k = 2; k < c.pts.length; k += 2) {
            if (this.plotAbort) break;
            await this.send(this.g1([c.pts[k], c.pts[k + 1]], feed)); sent++;
            drawnMm += Math.hypot(c.pts[k] - c.pts[k - 2], c.pts[k + 1] - c.pts[k - 1]);
            elapsedMs += (Math.hypot(c.pts[k] - c.pts[k - 2], c.pts[k + 1] - c.pts[k - 1]) / feed) * 60_000;
            report('plotting', ci);
          }
        }
        for (const l of this.penUpLines(pen)) { await this.send(l); sent++; }
        this.penIsUp = true;
        at = [c.pts[c.pts.length - 2], c.pts[c.pts.length - 1]];
        this.wpos = at;
        elapsedMs += price.ms - (price.draw / Math.max(1, pen?.feed ?? 1000)) * 60_000;
        report('plotting', ci);
      }
      if (!this.plotAbort) {
        await this.send(this.g0(this.paperOffset));
        await this.waitIdle();
        this.wpos = [this.paperOffset[0], this.paperOffset[1]];
        onProgress({ sent, total, elapsedMs: totalMs, totalMs, penName: '', state: 'done', etaMs: 0, drawnMm, drawMm, chain: chains.length, chainTotal: chains.length, wallMs: Date.now() - started - pausedMs });
      } else {
        onProgress({ sent, total, elapsedMs, totalMs, penName: '', state: 'stopped', etaMs: 0, drawnMm, drawMm, chain: current, chainTotal: chains.length });
      }
    } finally {
      this.plotting = false;
      this.plotPause = false;
    }
  }
}
