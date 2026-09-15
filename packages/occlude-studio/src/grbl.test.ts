import { describe, expect, it } from 'vitest';
import { Grbl } from './grbl.js';
import type { PenDef } from 'occlude';

/** A GRBL 1.1 board: banner on open, feedback + ok for $I, status for ?, ok for everything else. */
class FakeGrblPort {
  readonly commands: string[] = [];
  readonly realtime: string[] = [];
  private input!: ReadableStreamDefaultController<Uint8Array>;
  state = 'Idle';
  /** Reply latency per line, so a plot takes real time and can be paused. */
  delayMs = 0;
  readonly readable = new ReadableStream<Uint8Array>({
    start: (controller) => { this.input = controller; controller.enqueue(new TextEncoder().encode("\r\nGrbl 1.1h ['$' for help]\r\n")); },
  });
  readonly writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      const text = new TextDecoder().decode(chunk);
      for (const ch of text) if (ch === '?' || ch === '!' || ch === '~' || ch === '\x18') this.realtime.push(ch);
      if (text === '?') { this.input.enqueue(new TextEncoder().encode(`<${this.state}|MPos:0.000,0.000,0.000|WCO:0.000,0.000,0.000>\r\n`)); return; }
      if (text === '!' || text === '~') return;
      if (text === '\x18') { this.input.enqueue(new TextEncoder().encode("\r\nGrbl 1.1h ['$' for help]\r\n")); return; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        this.commands.push(line.replace(/\r$/, ''));
        const reply = line.startsWith('$I') ? '[VER:1.1h.20190825:][OPT:V,15,128]\r\nok\r\n'.replace('][', ']\r\n[') : 'ok\r\n';
        if (this.delayMs) setTimeout(() => this.input.enqueue(new TextEncoder().encode(reply)), this.delayMs);
        else this.input.enqueue(new TextEncoder().encode(reply));
      }
    },
  });
  async open(): Promise<void> { /* opened */ }
  async close(): Promise<void> { /* closed */ }
}

const pen: PenDef = { name: 'fine', width: 0.3, color: '#000', feed: 3000, penDown: 0, penUp: 5, penDelay: 100 };
const opts = { travelFeed: 8000 } as never;
const plan = (chains: [number, boolean, number[]][]): Float64Array => Float64Array.from(chains.flatMap(([p, dot, pts]) => [p, dot ? 1 : 0, pts.length / 2, ...pts]));

describe('GRBL driver', () => {
  it('connects, reads the version, and streams a plan as Z-pen G-code in the mirrored frame', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = { bedW: 594, bedH: 100, travelFeed: 8000, zMode: true, arcSupport: false, resolution: 0.2, flipY: true };
    expect(await g.connect(undefined, port as never)).toBe('1.1h.20190825:');
    expect(port.commands).toContain('G21 G90 G17 G54');
    const seen: string[] = [];
    await g.plot(plan([[0, false, [10, 10, 20, 20]], [0, true, [30, 30]]]), [pen], opts, (p) => seen.push(p.state));
    const sent = port.commands.slice(port.commands.indexOf('G21 G90 G54') + 1);
    expect(sent).toEqual([
      'G0 X10.000 Y90.000', 'G1 Z0.000 F3000', 'G4 P0.100',
      'G1 X20.000 Y80.000 F3000',
      'G0 Z5.000', 'G4 P0.100',
      'G0 X30.000 Y70.000', 'G1 Z0.000 F3000', 'G4 P0.100', 'G0 Z5.000', 'G4 P0.100',
      'G0 X0.000 Y100.000',
    ]);
    expect(seen.at(-1)).toBe('done');
    expect(port.realtime).toContain('?');
  });

  it('uses M3/M5 when the pen is a spindle value and keeps the frame unmirrored', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = { bedW: 300, bedH: 218, travelFeed: 6000, zMode: false, arcSupport: false, resolution: 0.2, flipY: false };
    await g.connect(undefined, port as never);
    await g.plot(plan([[0, false, [1, 2, 3, 4]]]), [{ ...pen, penDown: 900, penDelay: 0 }], opts, () => undefined);
    const sent = port.commands.slice(port.commands.indexOf('G21 G90 G54') + 1);
    expect(sent).toEqual(['G0 X1.000 Y2.000', 'M3 S900', 'G1 X3.000 Y4.000 F3000', 'M5', 'G0 X0.000 Y0.000']);
  });

  it('pause and resume are feed hold and cycle start; stop is hold, reset, unlock, pen up', async () => {
    const port = new FakeGrblPort();
    port.delayMs = 3;
    const g = new Grbl();
    g.settings = { bedW: 300, bedH: 218, travelFeed: 6000, zMode: true, arcSupport: false, resolution: 0.2, flipY: false };
    g.manualPen = pen;
    await g.connect(undefined, port as never);
    port.delayMs = 3;
    const pts: number[] = [];
    for (let i = 0; i < 40; i++) pts.push(i, i);
    const states: string[] = [];
    const run = g.plot(plan([[0, false, pts], [0, false, pts]]), [pen], opts, (p) => states.push(p.state));
    await new Promise((r) => setTimeout(r, 20));
    g.pause();
    await new Promise((r) => setTimeout(r, 250));
    expect(g.paused).toBe(true);
    g.resume();
    await run;
    expect(port.realtime.filter((c) => c === '!')).toHaveLength(1);
    expect(port.realtime.filter((c) => c === '~')).toHaveLength(1);
    expect(states).toContain('paused');
    const stopping = g.plot(plan([[0, false, pts]]), [pen], opts, (p) => states.push(p.state));
    await new Promise((r) => setTimeout(r, 10));
    await g.stop();
    await stopping;
    expect(port.realtime).toContain('\x18');
    expect(port.commands.slice(-4)).toEqual(['$X', 'G21 G90 G54', 'G0 Z5.000', 'G4 P0.100']);
    expect(states.at(-1)).toBe('stopped');
  });

  it('sets the work origin, records the paper origin, and jogs in the bed frame', async () => {
    const port = new FakeGrblPort();
    const g = new Grbl();
    g.settings = { bedW: 594, bedH: 841, travelFeed: 10000, zMode: true, arcSupport: false, resolution: 0.2, flipY: true };
    g.manualPen = pen;
    await g.connect(undefined, port as never);
    await g.setOrigin();
    expect(port.commands).toContain('G10 L20 P1 X0 Y0');
    await g.jog(10, 20, { travelFeed: 10000 } as never);
    expect(port.commands.at(-1)).toBe('$J=G91 G21 X10.000 Y-20.000 F10000');
  });
});
