/**
 * GRBL driver over Web Serial — the iDraw H (DrawCore) family and any other
 * GRBL 1.1 controller. The studio's other driver is the EBB one (ebb.ts);
 * a machine profile's `driver` picks which one the session talks to. Both
 * drivers share one plot and manual-control surface (plot, pause, resume,
 * stop, jog, origins, re-ink pauses, the one time model for progress).
 *
 * Protocol facts this relies on (GRBL 1.1, read off the DrawCore V2.23
 * board 2026-09-16, working/plotter-report.md):
 *  - one `ok` or `error:N` per line sent; `ALARM:N` aborts everything;
 *    `<…>` is a status report answering the real-time `?` (no `ok`);
 *    `[...]` and `$n=v` are feedback lines that precede their `ok`.
 *  - a line is at most 79 characters; the receive buffer is 128 bytes, so
 *    the streamer keeps at most `RX_BUDGET` bytes of unacknowledged lines
 *    in flight (character counting), which keeps the planner fed. `ok`
 *    means "buffered", not "executed": the planner holds up to 15 blocks.
 *  - real-time bytes bypass the buffer: `!` feed hold (a controlled stop
 *    with the pen still on the paper), `~` resume, `?` status, 0x18 soft
 *    reset (discards the planner, keeps the machine position, and on the
 *    DrawCore physically lifts the pen while its Z count stays put).
 *  - `$J=` jogs (cancellable, no modal side effects) run only from Idle;
 *    `$H` homes (with `$HX`/`$HY` per axis when `[OPT:` lists `H`, which
 *    matters on a board with no Z switch); `G10 L20 P1 X0 Y0` sets the
 *    persistent work origin; `G92 Z` re-declares the pen height.
 *  - opening or closing the port does not reset the board and does not
 *    stop motion: a stop is `!` then 0x18, never a disconnect.
 *
 * Coordinates: the plan is paper mm; the paper offset makes it bed mm
 * (y down the sheet from the top-left corner); the profile's `yAxis` says
 * how the controller counts Y ('down' as is, 'up' mirrored across the bed
 * height, 'negative' as -y) — the same mapping the G-code export uses, so
 * what plots here is what an exported file plots.
 *
 * The pen heights are the machine's (`penUp`/`penDown` on the profile: Z
 * in `zMode`, the S value through M3/M5 otherwise), with each pen's
 * `penDelay` settling both ways; a calibration card may override the
 * heights per pen index through the shared `servoFor` hook. Pause stops
 * feeding at the next point, lets the planner drain and lifts the pen, so
 * the machine is Idle while paused (jog, re-origin, pen up/down all work);
 * resume lowers the pen and carries on from that point. Stop is the hard
 * stop (hold, reset, pen height re-declared). The motors are locked for
 * the plot's duration ($1=255, as the vendor's software does) and the
 * board's own idle delay is put back after.
 */
import { schedulePlan, type PenDef, type PlanEstimate, type PlanSchedule } from 'occlude';

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
/** GRBL's line buffer is 80 bytes including the terminator. */
const MAX_LINE = 79;
/** A line the controller has not acknowledged for this long is a stall. */
const REPLY_TIMEOUT_MS = 20_000;

interface Pending {
  line: string;
  bytes: number;
  feedback: string[];
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class GrblError extends Error {}

/** GRBL 1.1 error codes the studio is likely to meet, in words. */
const ERROR_TEXT: Record<number, string> = {
  1: 'expected a command letter', 2: 'bad number format', 3: 'invalid $ statement', 5: 'homing is not enabled on this board',
  8: 'the board is not idle', 9: 'locked out: the board is in alarm or still jogging', 11: 'line too long',
  15: 'jog target exceeds travel', 20: 'unsupported command', 22: 'no feed rate set', 33: 'invalid target', 35: 'arc needs I/J offsets',
};
const describeError = (line: string): string => {
  const code = Number(line.match(/^error:(\d+)/)?.[1]);
  return ERROR_TEXT[code] ? `${line} (${ERROR_TEXT[code]})` : line;
};

/** A parsed `<…>` status report. */
export interface GrblStatus {
  state: string;
  /** Work position (machine minus the work offset), in the controller's own frame. */
  work: [number, number, number];
  machine: [number, number, number];
  pins: string;
  raw: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Grbl {
  private port: SerialPortLike | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private rxBuf = '';
  private pending: Pending[] = [];
  private inFlightBytes = 0;
  /** Lines waiting for buffer room: retried on every ok, rejected by a flush. */
  private waiters: { attempt: () => void; reject: (err: Error) => void }[] = [];
  private log: string[] = [];
  private t0 = Date.now();
  version = '';
  /** `[OPT:…]` letters from `$I`: H = single-axis homing, Z = homing sets the origin. */
  optFlags = '';
  /** The controller's `$$` settings by number, read at connect and on demand. */
  grblSettings = new Map<number, number>();
  /** The profile's machine settings; the session assigns them before use. */
  settings: MachineSettings = { bedW: 300, bedH: 218, travelFeed: 6000, zMode: true, arcSupport: false, resolution: 0.2 };
  /** The pen manual pen up/down uses when no plot is running. */
  manualPen: PenDef | undefined;
  /** Seat offset, mm above full pen-down: where the carriage sits while a
   * pen is clamped, so the nib meets the paper there and pen-down loads
   * the lift spring by this much. Chosen on the control panel per plot. */
  seatOffsetMm = 2;
  /** Work position in BED mm, from the last status report or what was sent. */
  private wpos: [number, number] = [0, 0];
  /** Work coordinate offset in the controller's frame; reports carry it only every few polls. */
  private wco: [number, number, number] = [0, 0, 0];
  lastStatus: GrblStatus | null = null;
  private penIsUp = false;
  plotting = false;
  private plotPause = false;
  private plotAbort = false;
  /** Jogged or re-origined while paused: the frame moved under the stroke. */
  private pauseAdjusted = false;
  /** The hold → reset → resync in progress, so a resume waits for it. */
  private flush: Promise<void> | null = null;
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
    this.penIsUp = false; // unknown until a pen-up is sent
    void this.readLoop();
    // A board that resets on open prints its banner now (the DrawCore does
    // not reset and prints nothing); then close any stale partial line.
    await sleep(300);
    await this.raw('\r\n');
    await sleep(100);
    const info = await this.cmd('$I').catch(() => [] as string[]);
    this.version = info.find((l) => l.startsWith('[VER:'))?.slice(5).replace(/\]$/, '') || this.banner || 'grbl';
    this.optFlags = info.find((l) => l.startsWith('[OPT:'))?.slice(5).split(',')[0] ?? '';
    await this.readSettings().catch(() => undefined);
    // One-time restore (2026-09-16): an earlier build set $1=255; the board
    // goes back to its stock idle delay. Remove once it has run.
    if (this.grblSettings.get(1) === 255) { await this.cmd('$1=254').catch(() => undefined); this.grblSettings.set(1, 254); }
    await this.status().catch(() => null);
    // Start from a known pen: a soft reset drops the motors, the spring
    // lifts the pen to its rest, and the height is declared there. Whatever
    // the board was doing before the port opened, it is Idle now.
    await this.flushMotion('connected');
    return this.version;
  }

  async disconnect(): Promise<void> {
    if (!this.port) return;
    // Closing the port does not stop the machine: stop it first.
    if (this.plotting) await this.stop().catch(() => undefined);
    try { await this.writer?.close(); } catch { /* port gone */ }
    try { await this.port.close(); } catch { /* port gone */ }
    this.writer = null;
    this.port = null;
    this.abortPending('disconnected');
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
      this.abortPending(`${line} — unlock with $X, then home or set the origin again`);
      return;
    }
    const head = this.pending[0];
    if (!head) return; // unsolicited ([MSG:…] after reset, a stray ok)
    if (line === 'ok' || line.startsWith('error:')) {
      this.pending.shift();
      this.inFlightBytes -= head.bytes;
      clearTimeout(head.timer);
      if (line === 'ok') head.resolve(head.feedback);
      else head.reject(new GrblError(`${describeError(line)} after ${head.line}`));
      this.wake();
      return;
    }
    head.feedback.push(line);
  }

  private abortPending(reason: string): void {
    const err = new GrblError(reason);
    for (const p of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending = [];
    this.inFlightBytes = 0;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.reject(err);
  }

  private wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w.attempt();
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
      if (line.length > MAX_LINE) { reject(new GrblError(`line longer than ${MAX_LINE} characters: ${line}`)); return; }
      const bytes = line.length + 1;
      const attempt = (): void => {
        if (!this.writer) { reject(new GrblError('not connected')); return; }
        if (this.inFlightBytes + bytes > RX_BUDGET && this.pending.length > 0) { this.waiters.push({ attempt, reject }); return; }
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

  /** `$$`: the controller's settings, cached on the driver for the profile
   * form and the feed clamp. */
  async readSettings(): Promise<Map<number, number>> {
    const lines = await this.cmd('$$');
    const next = new Map<number, number>();
    for (const l of lines) {
      const m = l.match(/^\$(\d+)=(-?[\d.]+)$/);
      if (m) next.set(Number(m[1]), Number(m[2]));
    }
    if (next.size) this.grblSettings = next;
    return this.grblSettings;
  }

  /** Real-time status report, parsed. */
  status(timeoutMs = 2000): Promise<GrblStatus> {
    return new Promise<GrblStatus>((resolve, reject) => {
      const timer = setTimeout(() => { this.statusWaiters = this.statusWaiters.filter((w) => w !== on); reject(new GrblError('no status report')); }, timeoutMs);
      const on = (line: string): void => { clearTimeout(timer); resolve(this.parseStatus(line)); };
      this.statusWaiters.push(on);
      this.raw('?').catch(reject);
    });
  }

  private parseStatus(line: string): GrblStatus {
    const state = line.match(/^<([A-Za-z]+(?::\d+)?)/)?.[1] ?? '';
    const triple = (key: string): [number, number, number] | null => {
      const m = line.match(new RegExp(`${key}:(-?[\\d.]+),(-?[\\d.]+)(?:,(-?[\\d.]+))?`));
      return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
    };
    const wcoNow = triple('WCO');
    if (wcoNow) this.wco = wcoNow;
    const mpos = triple('MPos'), wposNow = triple('WPos');
    const work: [number, number, number] = wposNow ?? (mpos ? [mpos[0] - this.wco[0], mpos[1] - this.wco[1], mpos[2] - this.wco[2]] : [0, 0, 0]);
    const machine: [number, number, number] = mpos ?? [work[0] + this.wco[0], work[1] + this.wco[1], work[2] + this.wco[2]];
    const status: GrblStatus = { state, work, machine, pins: line.match(/Pn:([A-Z]+)/)?.[1] ?? '', raw: line };
    this.lastStatus = status;
    if (mpos || wposNow) this.wpos = this.fromMachine([work[0], work[1]]);
    return status;
  }

  /** Wait until the controller reports one of these states. */
  private async waitState(states: RegExp, timeoutMs: number): Promise<GrblStatus> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.status().catch(() => null);
      if (s && states.test(s.state)) return s;
      if (s?.state === 'Alarm') throw new GrblError('controller is in alarm');
      if (Date.now() > end) throw new GrblError('motion did not finish');
      await sleep(150);
    }
  }
  /** Wait until motion has finished. */
  private waitIdle(timeoutMs = 120_000): Promise<GrblStatus> { return this.waitState(/^(Idle|Check|Door:0)$/, timeoutMs); }

  // ---- coordinates ----------------------------------------------------------

  /** Bed mm → the coordinates the controller reads. Every mapping is its
   * own inverse, so `fromMachine` is the same function. */
  private toMachine(p: readonly [number, number]): [number, number] {
    switch (this.settings.yAxis ?? 'down') {
      case 'up': return [p[0], this.settings.bedH - p[1]];
      case 'negative': return [p[0], -p[1]];
      default: return [p[0], p[1]];
    }
  }
  private fromMachine(p: readonly [number, number]): [number, number] { return this.toMachine(p); }
  private fmt(v: number): string { return (Math.round(v * 1000) / 1000).toFixed(3); }
  /** The controller clamps over-limit feeds silently; clamp here so the
   * time model prices what actually happens. */
  private clampFeed(feed: number): number {
    const limits = [this.grblSettings.get(110), this.grblSettings.get(111)].filter((v): v is number => v !== undefined && v > 0);
    return Math.max(1, Math.round(limits.length ? Math.min(feed, ...limits) : feed));
  }
  private g0(bed: readonly [number, number]): string {
    const [x, y] = this.toMachine(bed);
    return `G0 X${this.fmt(x)} Y${this.fmt(y)}`;
  }
  private g1(bed: readonly [number, number], feed: number): string {
    const [x, y] = this.toMachine(bed);
    return `G1 X${this.fmt(x)} Y${this.fmt(y)} F${this.clampFeed(feed)}`;
  }

  // ---- pen ----------------------------------------------------------------

  private upHeight(override?: ServoOverride): number { return override?.up ?? this.settings.penUp ?? 5; }
  private downHeight(override?: ServoOverride): number { return override?.down ?? this.settings.penDown ?? 0; }
  /** Where the nib meets the paper: the seat offset above full pen-down,
   * toward pen-up whichever numeric direction that is on this machine. */
  private contactHeight(): number {
    const down = this.downHeight(), up = this.upHeight(), offset = Math.max(0, this.seatOffsetMm);
    return down >= up ? Math.max(up, down - offset) : Math.min(up, down + offset);
  }
  /** The travel lift between strokes: `travelLift` mm above the paper
   * contact, never below the full pen-up. The nib leaves the paper at the
   * seat height, so the preload below it is unloaded first and does not
   * count as clearance. */
  private hopHeight(override?: ServoOverride): number {
    const full = this.upHeight(override), lift = this.settings.travelLift ?? 0;
    if (override?.up !== undefined || !(lift > 0)) return full;
    const contact = this.contactHeight(), down = this.downHeight();
    return down >= full ? Math.max(full, contact - lift) : Math.min(full, contact + lift);
  }
  private settleMs(pen: PenDef | undefined): number { return this.settings.penSettleMs ?? pen?.penDelay ?? 0; }
  private penFeedFor(pen: PenDef | undefined): number { return this.clampFeed(this.settings.penFeed ?? pen?.feed ?? 1000); }
  private penUpLines(pen: PenDef | undefined, override?: ServoOverride, full = true): string[] {
    const settle = this.settleMs(pen), delay = settle > 0 ? [`G4 P${(settle / 1000).toFixed(3)}`] : [];
    if (!this.settings.zMode) return ['M5', ...delay];
    return [`G0 Z${this.fmt(full ? this.upHeight(override) : this.hopHeight(override))}`, ...delay];
  }
  private penDownLines(pen: PenDef | undefined, override?: ServoOverride): string[] {
    const settle = this.settleMs(pen), delay = settle > 0 ? [`G4 P${(settle / 1000).toFixed(3)}`] : [];
    if (!this.settings.zMode) return [`M3 S${Math.max(1, Math.round(this.downHeight(override)))}`, ...delay];
    return [`G1 Z${this.fmt(this.downHeight(override))} F${this.penFeedFor(pen)}`, ...delay];
  }

  penUp(_settleMs = 300): Promise<void> {
    if (this.plotting && !this.plotPause) return this.liftNow();
    return this.manual(() => this.liftNow());
  }
  private async liftNow(): Promise<void> {
    for (const l of this.penUpLines(this.manualPen)) await this.send(l);
    this.penIsUp = true;
  }
  /** Park the carriage at the seat height so a pen can be clamped with
   * the lift spring's preload above full pen-down. With the board's idle
   * delay the released motor's detent holds it within about a millimetre,
   * which the preload absorbs. */
  seat(): Promise<void> {
    if (this.plotting && !this.plotPause) return Promise.reject(new GrblError('the plot owns the pen; pause first'));
    return this.manual(async () => {
      await this.send(`G1 Z${this.fmt(this.contactHeight())} F${this.clampFeed(1500)}`);
      await this.waitIdle();
      this.penIsUp = false;
    });
  }
  penDown(_settleMs = 300): Promise<void> {
    if (this.plotting && !this.plotPause) return Promise.reject(new GrblError('the plot owns the pen; pause first'));
    return this.manual(async () => {
      for (const l of this.penDownLines(this.manualPen)) await this.send(l);
      this.penIsUp = false;
    });
  }

  /** After a soft reset the DrawCore's pen is physically up while its Z
   * count still says where it was: driving to the pen-up height would run
   * the belt into its stop. `resetLiftsPen` re-declares the current height
   * as pen-up instead, through the work offset (G10 L20, which this board
   * honours; its G92 left Z untouched, serial log 2026-09-16), and reads
   * the offset back to be sure. Other controllers get a real lift. */
  private async resyncPen(): Promise<void> {
    if (!this.settings.zMode) { await this.send('M5'); this.penIsUp = true; return; }
    const up = this.upHeight();
    if (this.settings.resetLiftsPen) {
      await this.send(`G10 L20 P1 Z${this.fmt(up)}`);
      const s = await this.status().catch(() => null);
      if (s && Math.abs(s.work[2] - up) > 0.01) {
        await this.send(`G92 Z${this.fmt(up)}`);
        const t = await this.status().catch(() => null);
        if (t && Math.abs(t.work[2] - up) > 0.01) this.logLine('<', `(pen height declaration not honoured: work Z reads ${t.work[2]}, expected ${up})`);
      }
    } else {
      await this.send(`G0 Z${this.fmt(up)}`);
    }
    this.penIsUp = true;
  }

  // ---- manual motion and origins -------------------------------------------

  /** Manual controls arrive from buttons faster than the machine moves: a
   * pen move sent into a running jog is refused (error:9), so every manual
   * operation waits for the previous one, and for Idle, before it sends. */
  private manualQueue: Promise<unknown> = Promise.resolve();
  private manual<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.manualQueue.catch(() => undefined).then(async () => {
      if (this.lastStatus && /^(Jog|Run|Home)/.test(this.lastStatus.state)) await this.waitIdle().catch(() => undefined);
      return fn();
    });
    this.manualQueue = run;
    return run;
  }

  bedPosition(_o?: EbbOptions): [number, number] { return [this.wpos[0], this.wpos[1]]; }

  jog(dxMm: number, dyMm: number, o: EbbOptions): Promise<void> {
    if (this.plotting && !this.plotPause) return Promise.reject(new GrblError('pause the plot before jogging'));
    return this.manual(async () => {
      if (!this.penIsUp) await this.liftNow();
      const [mx, my] = this.toMachine([dxMm, dyMm]), [zx, zy] = this.toMachine([0, 0]);
      await this.send(`$J=G91 G21 X${this.fmt(mx - zx)} Y${this.fmt(my - zy)} F${this.clampFeed(o.travelFeed || this.settings.travelFeed)}`);
      await this.waitIdle();
      if (this.plotting) this.pauseAdjusted = true;
    });
  }

  setPaperOrigin(_o?: EbbOptions): [number, number] {
    this.paperOffset = this.wpos.map((v) => Math.round(v * 100) / 100) as [number, number];
    if (this.plotting) this.pauseAdjusted = true;
    return this.paperOffset;
  }

  goToPaperOrigin(_o?: EbbOptions): Promise<void> {
    if (this.plotting && !this.plotPause) return Promise.reject(new GrblError('pause the plot first'));
    return this.manual(async () => {
      await this.liftNow();
      await this.send(this.g0(this.paperOffset));
      await this.waitIdle();
      if (this.plotting) this.pauseAdjusted = true;
    });
  }

  /** "This is the bed origin": the work coordinate origin, persistent in
   * the controller (G54), and the paper offset is cleared with it. */
  async setOrigin(): Promise<void> {
    await this.send('G10 L20 P1 X0 Y0');
    this.wpos = [0, 0];
    this.paperOffset = [0, 0];
    if (this.plotting) this.pauseAdjusted = true;
    await this.status().catch(() => null); // picks up the new offset
  }

  /** Run the homing cycle and make the switch corner the bed origin. With
   * single-axis homing available (`[OPT:` H) the axes go one at a time,
   * which keeps a Z with no switch out of the cycle; without homing
   * (error:5) it is a return to the work origin. */
  home(): Promise<void> {
    if (this.plotting && !this.plotPause) return Promise.reject(new GrblError('pause the plot first'));
    return this.manual(() => this.homeNow());
  }
  private async homeNow(): Promise<void> {
    await this.liftNow();
    try {
      if (this.optFlags.includes('H')) { await this.send('$HY', 90_000); await this.send('$HX', 90_000); }
      else await this.send('$H', 90_000);
      await this.waitIdle();
      await this.setOrigin();
    } catch (e) {
      if (!(e instanceof GrblError && /error:5/.test(e.message))) throw e;
      await this.send(this.g0([0, 0]));
      await this.waitIdle();
    }
  }

  /** Bring the machine to Idle with nothing queued: feed hold, wait for the
   * deceleration, soft reset (position kept), unlock, restore the modal
   * state, re-declare the pen height. Every line in flight is rejected with
   * `reason` so the plot loop knows why. */
  private async flushMotion(reason: string): Promise<void> {
    try {
      await this.realtime('!');
      await this.waitState(/^(Hold:0|Idle|Door:0|Alarm|Check)$/, 5000).catch(() => undefined);
      await this.realtime('\x18');
    } catch { /* port gone */ }
    this.abortPending(reason);
    await sleep(600);
    const s = await this.status().catch(() => null);
    if (s?.state === 'Alarm') await this.send('$X').catch(() => undefined);
    await this.send('G21 G90 G17 G54').catch(() => undefined);
    await this.resyncPen().catch(() => undefined);
    await this.status().catch(() => null);
  }

  async stop(): Promise<void> {
    this.plotAbort = true;
    this.plotPause = false;
    this.flush = this.flushMotion('stopped');
    await this.flush;
  }

  /** Pause the way the vendor's own software and the EBB driver do: the
   * plot stops feeding at the next point, the planner drains, the pen
   * lifts. No hold, no reset: resume lowers the pen and continues. */
  pause(): void {
    if (!this.plotting || this.plotPause) return;
    this.plotPause = true;
    this.pauseAdjusted = false;
  }
  resume(): void {
    if (!this.plotting || !this.plotPause) return;
    this.plotPause = false;
  }

  // ---- plotting --------------------------------------------------------------

  /** Same contract as Ebb.plot: a toolpath plan in paper mm, one pen per
   * run by hand, progress callbacks, re-ink pauses, resume from a chain.
   * `servoFor` gives a card its per-pen height overrides (Z here); the
   * live servo hook is the EBB's and ignored. */
  async plot(
    plan: Float64Array,
    pens: PenDef[],
    o: EbbOptions,
    onProgress: (p: PlotProgress) => void,
    livePen?: (name: string) => PenDef | undefined,
    _liveServo?: () => { penUpPulse: number; penDownPulse: number },
    onlyPen?: number,
    servoFor?: (penIndex: number) => ServoOverride | undefined,
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
    const travelFeed = this.clampFeed(o.travelFeed || this.settings.travelFeed);

    // Totals for progress: THE shared time model, priced with what this
    // controller's own planner enforces (its accelerations and junction
    // deviation, from the profile), full lifts at each pen's own settle.
    const timing = {
      travelFeed,
      acceleration: this.settings.acceleration ?? 1000,
      travelAcceleration: this.settings.travelAcceleration ?? this.settings.acceleration ?? 1000,
      junctionDeviation: this.settings.junctionDeviation ?? 0.01,
      minimumCruiseRatio: 0,
    };
    // A pen cycle in the model is two "settles": here each is one Z move
    // between the travel lift and pen-down at the pen feed, plus any dwell.
    const penTiming = (pi: number): { feed: number; penDelay: number } | undefined => {
      const pen = penOf(pi);
      if (!pen) return undefined;
      const zMove = this.settings.zMode ? Math.abs(this.downHeight() - this.hopHeight()) / this.penFeedFor(pen) * 60_000 : 0;
      return { feed: this.clampFeed(pen.feed), penDelay: zMove + this.settleMs(pen) };
    };
    const remaining = chains.slice(first);
    const schedule: PlanSchedule = schedulePlan(remaining, penTiming, timing);
    const estimate: PlanEstimate = schedule.estimate;
    const total = estimate.commands;
    const totalMs = estimate.totalMs;
    const chainEndMs = (ci: number): number => { const k = ci - first; return schedule.chainStartMs[k] + schedule.chainDurMs[k]; };

    this.plotAbort = false;
    this.plotPause = false;
    this.pauseAdjusted = false;
    this.plotting = true;
    const wallStart = Date.now();
    let pausedWallMs = 0, sent = 0, elapsedMs = 0, drawnMm = 0, inkedMm = 0, lastReport = 0;
    let warning: string | undefined, reinkInMm: number | undefined, curChain = first;
    const penName = (c: Chain | undefined): string => (c ? penOf(c.pen)?.name ?? `pen ${c.pen}` : '');
    const report = (state: PlotProgress['state'], force = false): void => {
      const now = Date.now();
      if (!force && state === 'plotting' && now - lastReport < 200) return;
      lastReport = now;
      // ETA: the model early, blended toward measured throughput once there is data.
      const modelRemaining = Math.max(0, totalMs - elapsedMs);
      let etaMs = modelRemaining;
      const wall = now - wallStart - pausedWallMs;
      if (totalMs > 0 && elapsedMs > 0 && wall > 5000) {
        const rate = Math.min(3, Math.max(0.5, wall / elapsedMs));
        const progress = elapsedMs / totalMs;
        const w = Math.min(0.85, Math.max(0, (progress - 0.05) * 4));
        etaMs = modelRemaining * (1 - w + w * rate);
      }
      onProgress({
        sent, total, elapsedMs, totalMs, penName: penName(chains[curChain]), state, etaMs, warning,
        drawnMm, drawMm: estimate.drawMm, reinkInMm, chain: curChain, chainTotal: chains.length,
        ...(state === 'done' || state === 'stopped' ? { wallMs: Date.now() - wallStart - pausedWallMs, estimate } : {}),
      });
    };
    /** Wait out a pause; true if the plot goes on. */
    const waitResume = async (): Promise<boolean> => {
      const pauseWall0 = Date.now();
      report('paused', true);
      while (this.plotPause && !this.plotAbort) await sleep(150);
      pausedWallMs += Date.now() - pauseWall0;
      return !this.plotAbort;
    };
    /** A pause requested while drawing: let the queued moves finish, lift,
     * wait. True if the stroke goes on from here (pen lowered again);
     * false if it must not (stopped, or the frame moved under it). */
    const pauseHere = async (pen: PenDef | undefined, override: ServoOverride | undefined): Promise<boolean> => {
      await this.waitIdle();
      if (!this.penIsUp) { for (const l of this.penUpLines(pen, override)) await this.send(l); this.penIsUp = true; }
      if (!(await waitResume())) return false;
      if (this.pauseAdjusted) return false;
      for (const l of this.penDownLines(pen, override)) await this.send(l);
      this.penIsUp = false;
      return true;
    };
    // The plot owns the motors: locked for its duration (the vendor's own
    // software does the same), back to the board's own idle delay after.
    const idleDelay = this.grblSettings.get(1);
    const lockMotors = idleDelay !== undefined && idleDelay !== 255;

    try {
      await this.send('G21 G90 G54');
      if (lockMotors) await this.send('$1=255');
      // Raise before anything moves, whatever the tracker says.
      for (const l of this.penUpLines(penOf(chains[first]?.pen ?? 0))) await this.send(l);
      this.penIsUp = true;
      let ci = first;
      chainLoop: while (ci < chains.length) {
        const c = chains[ci];
        curChain = ci;
        const pen = penOf(c.pen), override = servoFor?.(c.pen);
        try {
          if (this.plotPause && !(await waitResume())) break;
          if (this.plotAbort) break;
          await this.send(this.g0([c.pts[0], c.pts[1]])); sent++;
          for (const l of this.penDownLines(pen, override)) { await this.send(l); sent++; }
          this.penIsUp = false;
          if (!c.dot) {
            const n = c.pts.length / 2;
            for (let k = 2; k < c.pts.length; k += 2) {
              if (this.plotPause) {
                // Between two points of the stroke: finish what is queued,
                // lift, wait; carry on from this point, or skip the rest of
                // the stroke when the frame moved (it would be a stray line).
                if (!(await pauseHere(pen, override))) { if (this.plotAbort) break chainLoop; ci += 1; continue chainLoop; }
              }
              await this.send(this.g1([c.pts[k], c.pts[k + 1]], pen?.feed ?? 1000)); sent++;
              const start = schedule.chainStartMs[ci - first], dur = schedule.chainDurMs[ci - first];
              elapsedMs = start + dur * ((k / 2) / Math.max(1, n - 1));
              report('plotting');
            }
          }
          // The lift for the travel out: a hop between strokes, full at the end.
          for (const l of this.penUpLines(pen, override, ci === chains.length - 1)) { await this.send(l); sent++; }
          this.penIsUp = true;
        } catch (e) {
          if (this.plotAbort) break;
          throw e;
        }
        // Ink accounting for progress and the re-ink budget (a dot lays a nib width).
        let ink = c.dot ? (pen?.width ?? 0) : 0;
        if (!c.dot) for (let k = 2; k < c.pts.length; k += 2) ink += Math.hypot(c.pts[k] - c.pts[k - 2], c.pts[k + 1] - c.pts[k - 1]);
        inkedMm += ink; drawnMm += ink;
        elapsedMs = chainEndMs(ci);
        this.wpos = [c.pts[c.pts.length - 2], c.pts[c.pts.length - 1]];
        const reinkAt = pen?.reinkMm ?? 0;
        reinkInMm = reinkAt > 0 ? Math.max(0, reinkAt - inkedMm) : undefined;
        if (reinkAt > 0 && inkedMm >= reinkAt && ci < chains.length - 1 && !this.plotAbort) {
          // Park at the bed origin (off the sheet when the paper is offset)
          // with nothing queued, so the pen can be pumped or refilled and
          // the next chain's travel returns from there.
          await this.send(this.g0([0, 0]));
          await this.waitIdle();
          this.wpos = [0, 0];
          warning = `re-ink ${penName(c)}: ${Math.round(inkedMm)}mm since the last — parked at the bed origin; pump/refill, then Resume`;
          this.plotPause = true;
          this.pauseAdjusted = false;
          const goOn = await waitResume();
          warning = undefined;
          inkedMm = 0;
          reinkInMm = reinkAt;
          if (!goOn) break;
          if (!this.penIsUp) { for (const l of this.penUpLines(pen)) await this.send(l); this.penIsUp = true; }
        }
        report('plotting');
        ci += 1;
      }
      if (!this.plotAbort) {
        await this.send(this.g0([0, 0]));
        await this.waitIdle();
        this.wpos = [0, 0];
        elapsedMs = totalMs;
        report('done', true);
      } else {
        report('stopped', true);
      }
    } finally {
      await this.flush?.catch(() => undefined); // a stop's flush finishes before the motors are released
      if (lockMotors) await this.send(`$1=${idleDelay}`).catch(() => undefined);
      this.plotting = false;
      this.plotPause = false;
    }
  }
}
