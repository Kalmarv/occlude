import { describe, expect, it } from 'vitest';
import type { PenDef } from 'occlude';

import { Grbl } from './grbl.js';
import { recordPlot } from './grblRecord.js';
import type { MachineSettings } from './store.js';

const pen: PenDef = { name: 'fine', width: 0.3, color: '#000', feed: 3000, penDown: 0, penUp: 5, penDelay: 100 };
const h1: MachineSettings = {
  bedW: 594, bedH: 841, travelFeed: 8000, zMode: true, arcSupport: true, resolution: 0.2,
  yAxis: 'negative', acceleration: 2000, travelAcceleration: 2000, junctionDeviation: 0.01, resetLiftsPen: true,
  penUp: 0.5, penDown: 10, penFeed: 5000, penSettleMs: 0, idleDelay: 25,
};
const plan = (chains: [number, boolean, number[]][]): Float64Array => Float64Array.from(chains.flatMap(([p, dot, pts]) => [p, dot ? 1 : 0, pts.length / 2, ...pts]));

describe('recording the G-code a plot sends', () => {
  it('is the plot loop line for line: motor lock, pen cycle, strokes, release, return', async () => {
    const live = new Grbl();
    live.settings = h1;
    live.paperOffset = [10, 20];
    const lines = await recordPlot(live, plan([[0, false, [0, 0, 5, 0]], [0, false, [0, 5, 5, 5]]]), [pen], { travelFeed: 8000 } as never);
    expect(lines).toEqual([
      'G21 G90 G54', '$1=255', 'G0 Z0.500',
      'G1 X10.000 Y-20.000 F8000', 'G1 Z10.000 F5000', 'G1 X15.000 Y-20.000 F3000', 'G0 Z7.000',
      'G1 X10.000 Y-25.000 F8000', 'G1 Z10.000 F5000', 'G1 X15.000 Y-25.000 F3000', 'G0 Z0.500',
      '$1=25', 'G1 X0.000 Y0.000 F8000',
    ]);
    // The live driver is untouched: no port, nothing sent.
    expect(live.connected).toBe(false);
  });
});
