import { describe, expect, it } from 'vitest';
import { Grbl } from './grbl.js';
import type { PenDef } from 'occlude';
import type { MachineSettings } from './store.js';

/** A GRBL 1.1 board as the DrawCore behaves (working/plotter-report.md):
 * no banner on open, feedback + ok for $I and $$, a status report for ?,
 * ok for everything else. Moves complete instantly, so the reported
 * position is the last acknowledged target; `!` holds, 0x18 resets to Idle
 * with the position kept and the pen physically up. */
class FakeGrblPort {
  readonly commands: string[] = [];
  readonly realtime: string[] = [];
  private input!: ReadableStreamDefaultController<Uint8Array>;
  state = 'Idle';
  pos = [0, 0, 0];
  wco = [0, 0, 0];
  /** Reply latency per line, so a plot takes real time and can be paused. */
  delayMs = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  readonly readable = new ReadableStream<Uint8Array>({ start: (controller) => { this.input = controller; } });
  readonly writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      const text = new TextDecoder().decode(chunk);
      for (const ch of text) if (ch === '?' || ch === '!' || ch === '~' || ch === '\x18') this.realtime.push(ch);
      if (text === '?') { this.reply(`<${this.state}|MPos:${this.pos.map((v) => v.toFixed(3)).join(',')}|FS:0,0|WCO:${this.wco.map((v) => v.toFixed(3)).join(',')}>\r\n`, true); return; }
      if (text === '!') { if (this.state === 'Run') this.state = 'Hold:0'; return; }
      if (text === '~') { if (this.state.startsWith('Hold')) this.state = 'Idle'; return; }
      if (text === '\x18') {
        for (const t of this.timers) clearTimeout(t);
        this.timers = [];
        this.state = 'Idle';
        this.reply("\r\nGrbl 1.1h DrawCore V2.23 ['$' for help]\r\n", true);
        return;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const cmd = line.replace(/\r$/, '');
        this.commands.push(cmd);
        this.move(cmd);
        let reply = 'ok\r\n';
        if (cmd === '$I') reply = '[VER:1.1h DrawCore V2.23.20260721:]\r\n[OPT:VZHDL,15,128]\r\nok\r\n';
        if (cmd === '$$') reply = '$1=254\r\n$10=3\r\n$110=15000.000\r\n$111=12000.000\r\n$120=3000.000\r\n$121=2000.000\r\n$11=0.010\r\n$130=594.000\r\n$131=841.000\r\nok\r\n';
        this.reply(reply, false);
      }
    },
  });
  private reply(text: string, now: boolean): void {
    if (now || !this.delayMs) { this.input.enqueue(new TextEncoder().encode(text)); return; }
    const t = setTimeout(() => {
      this.input.enqueue(new TextEncoder().encode(text));
      this.timers = this.timers.filter((x) => x !== t);
      if (!this.timers.length && this.state === 'Run') this.state = 'Idle'; // the last queued move finished
    }, this.delayMs);
    this.timers.push(t);
  }
  private move(cmd: string): void {
    const rel = cmd.startsWith('$J=') || cmd.includes('G91');
    const axis = (name: string): number | undefined => { const m = cmd.match(new RegExp(`${name}(-?[\\d.]+)`)); return m ? Number(m[1]) : undefined; };
    const g10 = cmd.match(/^G10 L20 P1(.*)$/);
    if (g10) { for (const [i, name] of ['X', 'Y', 'Z'].entries()) { const v = axis(name); if (v !== undefined) this.wco[i] = this.pos[i] - v; } return; }
    if (!/^(\$J=|G0|G1)/.test(cmd)) return;
    if (cmd === '$J=' || !/[XYZ]-?[\d.]/.test(cmd)) return;
    const x = axis('X'), y = axis('Y'), z = axis('Z');
    if (x !== undefined) this.pos[0] = rel ? this.pos[0] + x : x;
    if (y !== undefined) this.pos[1] = rel ? this.pos[1] + y : y;
    if (z !== undefined) this.pos[2] = rel ? this.pos[2] + z : z;
    if (this.delayMs && !cmd.startsWith('$J=')) this.state = 'Run';
  }
  async open(): Promise<void> { /* opened */ }
  async close(): Promise<void> { /* closed */ }
}

// The pen's own Z is the library default and must not matter: the machine's heights win.
const pen: PenDef = { name: 'fine', width: 0.3, color: '#000', feed: 3000, penDown: 0, penUp: 5, penDelay: 100 };
const opts = { travelFeed: 12000 } as never;
const h1: MachineSettings = {
  bedW: 594, bedH: 841, travelFeed: 12000, zMode: true, arcSupport: true, resolution: 0.2,
  yAxis: 'negative', acceleration: 2000, travelAcceleration: 2000, junctionDeviation: 0.01, resetLiftsPen: true, penUp: 0, penDown: 10,
};
const plan = (chains: [number, boolean, number[]][]): Float64Array => Float64Array.from(chains.flatMap(([p, dot, pts]) => [p, dot ? 1 : 0, pts.length / 2, ...pts]));
const after = (port: FakeGrblPort, marker: string): string[] => port.commands.slice(port.commands.lastIndexOf(marker) + 1);
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('GRBL driver', () => {
  it('connects without a banner, reads the version, the option flags and the settings', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = h1;
    expect(await g.connect(undefined, port as never)).toBe('1.1h DrawCore V2.23.20260721:');
    expect(g.optFlags).toBe('VZHDL');
    expect(g.grblSettings.get(110)).toBe(15000);
    expect(g.grblSettings.get(11)).toBe(0.01);
    expect(port.commands.some((c) => c.startsWith('$1='))).toBe(false); // nothing is written to the board
    expect(port.commands).toContain('G21 G90 G17 G54');
    expect(port.realtime).toContain('\x18'); // reset: motors off, the spring lifts the pen…
    expect(port.commands.at(-1)).toBe('G10 L20 P1 Z0.000'); // …and that is declared as pen-up
    expect(port.realtime).toContain('?');
  });

  it('streams a plan in the negative-Y frame with Z pen moves and the one time model', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = h1;
    await g.connect(undefined, port as never);
    const reports: { state: string; totalMs: number; estimate?: unknown }[] = [];
    await g.plot(plan([[0, false, [10, 10, 20, 20]], [0, true, [30, 30]]]), [pen], opts, (p) => reports.push({ state: p.state, totalMs: p.totalMs, estimate: p.estimate }));
    expect(after(port, 'G21 G90 G54')).toEqual([
      '$1=255',
      'G0 Z0.000', 'G4 P0.100',
      'G0 X10.000 Y-10.000', 'G1 Z10.000 F3000', 'G4 P0.100',
      'G1 X20.000 Y-20.000 F3000',
      'G0 Z0.000', 'G4 P0.100',
      'G0 X30.000 Y-30.000', 'G1 Z10.000 F3000', 'G4 P0.100', 'G0 Z0.000', 'G4 P0.100',
      'G0 X0.000 Y0.000',
      '$1=254',
    ]);
    const last = reports.at(-1)!;
    expect(last.state).toBe('done');
    expect(last.totalMs).toBeGreaterThan(0);
    expect(last.estimate).toBeDefined();
  });

  it('mirrors across the bed in the Y-up frame and uses M3/M5 for a spindle pen', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = { ...h1, bedH: 100, yAxis: 'up', zMode: false };
    await g.connect(undefined, port as never);
    g.settings = { ...g.settings, penDown: 900 };
    await g.plot(plan([[0, false, [1, 2, 3, 4]]]), [{ ...pen, penDelay: 0 }], opts, () => undefined);
    expect(after(port, 'G21 G90 G54')).toEqual(['$1=255', 'M5', 'G0 X1.000 Y98.000', 'M3 S900', 'G1 X3.000 Y96.000 F3000', 'M5', 'G0 X0.000 Y100.000', '$1=254']);
  });

  it('clamps feeds to the controller limits and refuses over-long lines', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = h1;
    await g.connect(undefined, port as never);
    await g.plot(plan([[0, false, [0, 0, 5, 5]]]), [{ ...pen, feed: 30000, penDelay: 0 }], { travelFeed: 99999 } as never, () => undefined);
    expect(port.commands).toContain('G1 X5.000 Y-5.000 F12000');
    await expect(g.send('G1 ' + 'X1.000 '.repeat(20))).rejects.toThrow('79');
  });

  it('pauses between points: queued moves finish, the pen lifts, resume lowers it and continues', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = h1;
    g.manualPen = pen;
    await g.connect(undefined, port as never);
    port.delayMs = 3;
    const pts: number[] = [];
    for (let i = 0; i < 60; i++) pts.push(i, 0);
    const states: string[] = [];
    const run = g.plot(plan([[0, false, pts], [0, false, [0, 5, 10, 5]]]), [pen], opts, (p) => states.push(p.state));
    const holdsBefore = port.realtime.filter((c) => c === '!').length;
    await tick(40);
    g.pause();
    await tick(600);
    expect(g.paused).toBe(true);
    expect(port.realtime.filter((c) => c === '!')).toHaveLength(holdsBefore); // no feed hold
    expect(port.realtime.filter((c) => c === '\x18')).toHaveLength(1); // connect's only
    const beforeResume = port.commands.length;
    expect(port.commands.slice(-2)).toEqual(['G0 Z0.000', 'G4 P0.100']); // lifted while paused
    g.resume();
    await run;
    const resumed = port.commands.slice(beforeResume);
    expect(resumed.slice(0, 2)).toEqual(['G1 Z10.000 F3000', 'G4 P0.100']); // lowered again…
    expect(resumed[2]).toMatch(/^G1 X\d/); // …and the stroke goes on, no travel back to its start
    expect(states).toContain('paused');
    expect(states.at(-1)).toBe('done');
    expect(port.commands.indexOf('$1=255')).toBeGreaterThan(-1); // motors locked for the plot…
    expect(port.commands.at(-1)).toBe('$1=254'); // …and released after
  });

  it('skips the rest of an interrupted stroke when the frame moved during the pause', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = h1;
    g.manualPen = pen;
    await g.connect(undefined, port as never);
    port.delayMs = 3;
    const pts: number[] = [];
    for (let i = 0; i < 60; i++) pts.push(i, 0);
    const run = g.plot(plan([[0, false, pts], [0, false, [0, 5, 10, 5]]]), [pen], opts, () => undefined);
    await tick(40);
    g.pause();
    await tick(600);
    await g.jog(1, 1, opts);
    expect(port.commands.at(-1)).toBe('$J=G91 G21 X1.000 Y-1.000 F12000');
    const held = port.commands.length;
    g.resume();
    await run;
    expect(port.commands.slice(held)[0]).toBe('G0 X0.000 Y-5.000'); // straight to the next chain
  });

  it('stops by hold, reset and pen re-declaration, and reports stopped', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = h1;
    g.manualPen = pen;
    await g.connect(undefined, port as never);
    port.delayMs = 3;
    const pts: number[] = [];
    for (let i = 0; i < 60; i++) pts.push(i, i);
    const states: string[] = [];
    const run = g.plot(plan([[0, false, pts]]), [pen], opts, (p) => states.push(p.state));
    await tick(30);
    await g.stop();
    await run;
    expect(port.realtime).toContain('\x18');
    expect(port.commands.slice(-3, -1)).toEqual(['G21 G90 G17 G54', 'G10 L20 P1 Z0.000']);
    expect(port.commands.at(-1)).toBe('$1=254'); // motors released after the stop
    expect(states.at(-1)).toBe('stopped');
    expect(g.plotting).toBe(false);
  });

  it('drives the pen up after a reset on a controller that does not lift it', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = { ...h1, resetLiftsPen: false };
    g.manualPen = pen;
    await g.connect(undefined, port as never);
    await g.stop();
    expect(port.commands.at(-1)).toBe('G0 Z0.000');
  });

  it('homes one axis at a time when the board offers it and zeroes the work origin there', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = h1;
    g.manualPen = pen;
    await g.connect(undefined, port as never);
    await g.home();
    const cmds = after(port, 'G10 L20 P1 Z0.000'); // everything after connect's pen declaration
    expect(cmds.slice(0, 2)).toEqual(['G0 Z0.000', 'G4 P0.100']);
    expect(cmds).toContain('$HY');
    expect(cmds).toContain('$HX');
    expect(cmds.indexOf('$HY')).toBeLessThan(cmds.indexOf('$HX'));
    expect(cmds.at(-1)).toBe('G10 L20 P1 X0 Y0');
  });

  it('records the paper origin and jogs in the bed frame', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = h1;
    g.manualPen = pen;
    await g.connect(undefined, port as never);
    await g.jog(10, 20, opts);
    expect(port.commands.at(-1)).toBe('$J=G91 G21 X10.000 Y-20.000 F12000');
    expect(g.setPaperOrigin()).toEqual([10, 20]);
    await g.goToPaperOrigin();
    expect(port.commands.at(-1)).toBe('G0 X10.000 Y-20.000');
  });

  it('queues a pen move behind a running jog instead of sending it into the Jog state', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = h1;
    g.manualPen = pen;
    await g.connect(undefined, port as never);
    port.delayMs = 3;
    const jog = g.jog(10, 0, opts);
    const up = g.penUp();
    const polls = port.realtime.filter((c) => c === '?').length;
    await Promise.all([jog, up]);
    const i = port.commands.indexOf('$J=G91 G21 X10.000 Y0.000 F12000');
    expect(i).toBeGreaterThan(-1);
    expect(port.commands.slice(i + 1)).toEqual(['G0 Z0.000', 'G4 P0.100']);
    expect(port.realtime.filter((c) => c === '?').length).toBeGreaterThan(polls); // waited for Idle in between
    await expect(g.send('G4 P0.6').then(() => port.commands.at(-1))).resolves.toBe('G4 P0.6');
  });

  it('lets a card pin the pen-down height per pen index', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = h1;
    await g.connect(undefined, port as never);
    await g.plot(plan([[0, false, [0, 0, 5, 0]], [1, false, [0, 6, 5, 6]]]), [{ ...pen, penDelay: 0 }, { ...pen, name: 'b', penDelay: 0 }], opts, () => undefined,
      undefined, undefined, undefined, (i) => [{ down: 6 }, { down: 8 }][i]);
    expect(port.commands).toContain('G1 Z6.000 F3000');
    expect(port.commands).toContain('G1 Z8.000 F3000');
  });

  it('seats the pen at the seat height and lifts it again', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = h1;
    g.seatOffsetMm = 3;
    g.manualPen = pen;
    await g.connect(undefined, port as never);
    await g.seat();
    expect(port.commands.at(-1)).toBe('G1 Z7.000 F1500'); // pen-down 10 less the 3 mm seat offset
    await g.penUp();
    expect(port.commands.slice(-2)).toEqual(['G0 Z0.000', 'G4 P0.100']);
  });

  it('hops above the paper contact between strokes and lifts fully at the end', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = { ...h1, penUp: 0.5, travelLift: 1, penFeed: 5000, penSettleMs: 0 };
    g.seatOffsetMm = 2; // contact at Z8; a 1 mm hop is Z7
    await g.connect(undefined, port as never);
    const reports: { penDelay?: number; totalMs: number }[] = [];
    await g.plot(plan([[0, false, [0, 0, 5, 0]], [0, false, [0, 5, 5, 5]]]), [pen], opts, (p) => reports.push({ totalMs: p.totalMs }));
    expect(after(port, '$1=255')).toEqual([
      'G0 Z0.500',
      'G0 X0.000 Y0.000', 'G1 Z10.000 F5000', 'G1 X5.000 Y0.000 F3000', 'G0 Z7.000',
      'G0 X0.000 Y-5.000', 'G1 Z10.000 F5000', 'G1 X5.000 Y-5.000 F3000', 'G0 Z0.500',
      'G0 X0.000 Y0.000', '$1=254',
    ]);
    expect(reports.at(-1)!.totalMs).toBeGreaterThan(0);
  });

  it('parks at the bed origin for a re-ink pause and carries on after resume', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = h1;
    await g.connect(undefined, port as never);
    const warnings: string[] = [];
    const run = g.plot(
      plan([[0, false, [0, 0, 30, 0]], [0, false, [0, 10, 30, 10]]]),
      [{ ...pen, reinkMm: 20, penDelay: 0 }], opts,
      (p) => { if (p.warning) warnings.push(p.warning); if (p.state === 'paused' && g.paused) setTimeout(() => g.resume(), 50); },
    );
    await run;
    expect(warnings.some((w) => w.includes('re-ink'))).toBe(true);
    const cmds = after(port, 'G1 X30.000 Y0.000 F3000');
    expect(cmds.slice(0, 2)).toEqual(['G0 Z0.000', 'G0 X0.000 Y0.000']);
    expect(cmds).toContain('G0 X0.000 Y-10.000');
  });
});
