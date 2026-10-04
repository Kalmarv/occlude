/**
 * The G-code a plot sends, recorded line for line: the driver's own plot
 * loop run against a simulated controller that answers at once. The file is
 * what the real board would receive from Plot with the same plan, pen,
 * origin, hop and motor lock — so another sender (the UUNA TEK software, a
 * script) can stream exactly those bytes, and the link can be tested without
 * the studio in the middle.
 *
 * The simulation is a plain GRBL: `ok` to every line, `$I`/`$$`/`$#` answered,
 * a status report that follows the absolute moves, Idle whenever asked. Only
 * the lines of the plot itself are kept; the connect sequence (pen-height
 * declaration, reset) is not part of the file, so stream it to a board that
 * the studio has connected and set up, as for a studio plot.
 */
import type { PenDef } from 'occlude';

import type { EbbOptions } from './ebb.js';
import { Grbl, type SerialPortLike } from './grbl.js';

class SimulatedPort implements SerialPortLike {
  readonly lines: string[] = [];
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private input!: ReadableStreamDefaultController<Uint8Array>;
  private pos = [0, 0, 0];

  constructor(private settings: Map<number, number>) {}

  async open(): Promise<void> {
    this.readable = new ReadableStream<Uint8Array>({ start: (c) => { this.input = c; } });
    this.writable = new WritableStream<Uint8Array>({ write: (chunk) => this.receive(new TextDecoder().decode(chunk)) });
  }

  async close(): Promise<void> { /* nothing to release */ }

  private reply(text: string): void { this.input.enqueue(new TextEncoder().encode(text)); }

  private receive(text: string): void {
    if (text === '?') {
      this.reply(`<Idle|MPos:${this.pos.map((v) => v.toFixed(3)).join(',')}|FS:0,0|WCO:0.000,0.000,0.000>\r\n`);
      return;
    }
    if (text === '!' || text === '~') return;
    if (text === '\x18') { this.reply("\r\nGrbl 1.1h ['$' for help]\r\n"); return; }
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) { if (raw.length) this.reply('ok\r\n'); continue; }
      this.lines.push(line);
      if (line === '$I') this.reply('[VER:1.1h simulated:]\r\n[OPT:VZHDL,15,128]\r\n');
      if (line === '$$') this.reply([...this.settings].map(([k, v]) => `$${k}=${v}\r\n`).join(''));
      if (line === '$#') this.reply('[G54:0.000,0.000,0.000]\r\n[G92:0.000,0.000,0.000]\r\n');
      if (/^G[01]\b/.test(line) && !/G91/.test(line)) {
        for (const [i, axis] of ['X', 'Y', 'Z'].entries()) {
          const m = new RegExp(`\\b${axis}(-?\\d+(?:\\.\\d+)?)`).exec(line);
          if (m) this.pos[i] = Number(m[1]);
        }
      }
      this.reply('ok\r\n');
    }
  }
}

/**
 * Run `source`'s plot loop for this plan against the simulation and return
 * the lines it sends. `source` is the live driver: its profile, the board's
 * settings it last read, the paper offset, seat offset and travel hop all
 * carry over, so the recording is the plot Plot would run now.
 */
export async function recordPlot(
  source: Grbl,
  plan: Float64Array,
  pens: PenDef[],
  opts: EbbOptions,
  onlyPen?: number,
): Promise<string[]> {
  const rec = new Grbl();
  rec.settings = { ...source.settings };
  const board = new Map(source.grblSettings);
  if (!board.size && source.settings.idleDelay !== undefined) board.set(1, source.settings.idleDelay);
  const port = new SimulatedPort(board);
  await rec.connect(undefined, port);
  rec.paperOffset = [...source.paperOffset] as [number, number];
  rec.seatOffsetMm = source.seatOffsetMm;
  rec.travelLiftMm = source.travelLiftMm;
  port.lines.length = 0; // the connect sequence is not part of the plot
  await rec.plot(plan, pens, opts, () => undefined, undefined, undefined, onlyPen);
  const lines = [...port.lines];
  await rec.disconnect();
  return lines;
}
