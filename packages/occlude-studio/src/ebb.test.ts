import { describe, expect, test } from 'vitest';

import { Ebb, type PlotProgress } from './ebb.js';

const opts = {
  stepsPerMm: 100,
  travelFeed: 6000,
  swapXY: true,
  invertX: true,
  invertY: false,
  servoDown: 10_000,
  servoUp: 14_200,
  acceleration: 1000,
  travelAcceleration: 1000,
  junctionDeviation: 0.02,
  minimumCruiseRatio: 0.5,
  // The XM tests pin exact packet streams; LM has its own suite below.
  lmMotion: false,
  // Off: existing tests pin exact settle values; quick-hop has its own test.
  quickHopMm: 0,
};

class FakePort {
  readonly commands: string[] = [];
  /** Board step counters reported by QS — override to simulate drift. */
  qs: () => [number, number] = () => [0, 0];
  private input!: ReadableStreamDefaultController<Uint8Array>;
  constructor(private version = 'EBBv2.8.1', private bootNoise = '') {}
  readonly readable = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.input = controller;
      if (this.bootNoise) controller.enqueue(new TextEncoder().encode(this.bootNoise));
    },
  });
  /** When true, motion commands get no reply — a wedged board. */
  muteMotion = false;
  readonly writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      const command = new TextDecoder().decode(chunk).replace(/\r$/, '');
      this.commands.push(command);
      if (this.muteMotion && /^(XM|LM|HM)/.test(command)) return;
      const response =
        command === 'V'
          ? `${this.version}\r`
          : command === 'QC'
            ? '0,500\rOK\r'
            : command === 'QS'
              ? `${this.qs().join(',')}\rOK\r`
              : command === 'QM'
                ? 'QM,0,0,0,0\r'
                : 'OK\r';
      this.input.enqueue(new TextEncoder().encode(response));
    },
  });

  async open(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * Firmware-faithful LM simulator: per 40µs tick and axis, Rate += Accel,
 * accumulator += Rate, step on 2³¹ overflow; initial rate is adjusted by
 * −Accel/2 (firmware ≥2.7); accumulators persist across commands; a command
 * ends when both axes reach their step counts. Positions come back through
 * the CoreXY inverse, so this verifies the actual trajectory the board
 * would execute — not the shape of the command stream.
 */
function simulateLm(commands: string[]): {
  x: number;
  y: number;
  seconds: number;
  stalled: boolean;
  perCmdSeconds: number[];
} {
  let a1 = 0;
  let a2 = 0;
  let acc1 = 0;
  let acc2 = 0;
  let ticks = 0;
  let stalled = false;
  const perCmdSeconds: number[] = [];
  for (const cmd of commands.filter((c) => c.startsWith('LM,'))) {
    const [r1, s1, d1, r2, s2, d2] = cmd.split(',').slice(1).map(Number);
    let rate1 = r1 - d1 / 2;
    let rate2 = r2 - d2 / 2;
    let taken1 = 0;
    let taken2 = 0;
    const t1 = Math.abs(s1);
    const t2 = Math.abs(s2);
    let cmdTicks = 0;
    const cap = 25000 * 60;
    while ((taken1 < t1 || taken2 < t2) && cmdTicks < cap) {
      cmdTicks += 1;
      if (taken1 < t1) {
        rate1 += d1;
        acc1 += rate1;
        if (acc1 >= 0x80000000) {
          acc1 -= 0x80000000;
          taken1 += 1;
        }
      }
      if (taken2 < t2) {
        rate2 += d2;
        acc2 += rate2;
        if (acc2 >= 0x80000000) {
          acc2 -= 0x80000000;
          taken2 += 1;
        }
      }
    }
    if (cmdTicks >= cap) {
      stalled = true;
      break;
    }
    a1 += Math.sign(s1) * taken1;
    a2 += Math.sign(s2) * taken2;
    ticks += cmdTicks;
    perCmdSeconds.push(cmdTicks / 25000);
  }
  // CoreXY inverse: motor1 = x + y, motor2 = x − y.
  return { x: (a1 + a2) / 2, y: (a1 - a2) / 2, seconds: ticks / 25000, stalled, perCmdSeconds };
}

describe('Ebb motor lifecycle', () => {
  test('connect leaves the carriage free until motion is requested', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });

    const ebb = new Ebb();
    await ebb.connect({ servoDown: 10_000, servoUp: 14_200 });

    expect(port.commands).not.toContain('EM,1,1');
    expect(port.commands.slice(0, 2)).toEqual(['V', 'EM,0,0']);
  });

  test('home enables the motors immediately before moving', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });

    const ebb = new Ebb();
    await ebb.connect({ servoDown: 10_000, servoUp: 14_200 });
    await ebb.home();

    expect(port.commands.slice(-3)).toEqual(['SP,1,300', 'EM,1,1', 'HM,2000']);
  });

  test('small circles retain every flattened waypoint', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const points = Array.from({ length: 16 }, (_, i) => {
      const theta = (i * Math.PI * 2) / 15;
      return [10 + Math.cos(theta), 10 + Math.sin(theta)];
    });
    const plan = new Float64Array([0, 0, points.length, ...points.flat()]);
    const ebb = new Ebb();
    await ebb.connect({ servoDown: opts.servoDown, servoUp: opts.servoUp });
    await ebb.plot(
      plan,
      [{ name: 'test', width: 0.2, color: '#000', feed: 3500, penDown: 0, penUp: 5, penDelay: 150 }],
      opts,
      () => undefined,
    );

    const down = port.commands.indexOf('SP,0,150');
    const up = port.commands.indexOf('SP,1,150', down);
    const drawMoves = port.commands.slice(down + 1, up).filter((command) => command.startsWith('XM,'));
    expect(drawMoves.length).toBeGreaterThanOrEqual(15);
  });

  test('slows through a right-angle waypoint instead of treating the run as straight', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    const plan = new Float64Array([0, 0, 3, 0, 0, 20, 0, 20, 20]);
    const ebb = new Ebb();
    await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
    await ebb.plot(
      plan,
      [{ name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
      direct,
      () => undefined,
    );

    const down = port.commands.indexOf('SP,0,150');
    const up = port.commands.indexOf('SP,1,150', down);
    const moves = port.commands
      .slice(down + 1, up)
      .filter((command) => command.startsWith('XM,'))
      .map((command) => command.split(',').slice(1).map(Number));
    let x = 0;
    const corner = moves.findIndex(([_, dx]) => {
      x += dx;
      return x === 2000;
    });
    expect(corner).toBeGreaterThanOrEqual(0);
    const speeds = [moves[corner], moves[corner + 1]].map(
      ([ms, dx, dy]) => (Math.hypot(dx, dy) / direct.stepsPerMm / ms) * 1000,
    );
    expect(Math.max(...speeds)).toBeLessThan(11);
  });

  test('short triangular moves do not collapse into a near-zero-speed packet', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    const plan = new Float64Array([0, 0, 3, 0, 0, 0.05, 0, 0, 0]);
    const ebb = new Ebb();
    await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
    await ebb.plot(
      plan,
      [{ name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
      direct,
      () => undefined,
    );

    const drawMoves = port.commands.filter((command) => command.startsWith('XM,'));
    expect(drawMoves.every((command) => Number(command.split(',')[1]) < 100)).toBe(true);
  });

  test('launches a pen-down chain from physical rest', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    const ebb = new Ebb();
    await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
    await ebb.plot(
      new Float64Array([0, 0, 2, 0, 0, 20, 0]),
      [{ name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
      direct,
      () => undefined,
    );

    const down = port.commands.indexOf('SP,0,150');
    const first = port.commands.slice(down + 1).find((command) => command.startsWith('XM,'))!;
    const [ms, dx, dy] = first.split(',').slice(1).map(Number);
    expect((Math.hypot(dx, dy) / direct.stepsPerMm / ms) * 1000).toBeLessThan(5);
  });

  test('long cruise strokes retain their requested feed without packet explosion', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    const ebb = new Ebb();
    await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
    await ebb.plot(
      new Float64Array([0, 0, 2, 0, 0, 100, 0]),
      [{ name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
      direct,
      () => undefined,
    );

    const down = port.commands.indexOf('SP,0,150');
    const up = port.commands.indexOf('SP,1,150', down);
    const moves = port.commands.slice(down + 1, up).filter((command) => command.startsWith('XM,'));
    const actualMs = moves.reduce((sum, command) => sum + Number(command.split(',')[1]), 0);
    expect(moves.length).toBeLessThan(100);
    expect(actualMs).toBeLessThan(1900);
  });

  test('deceleration-specific spacing preserves timing while adding tail packets', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    const ebb = new Ebb();
    await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
    await ebb.plot(
      new Float64Array([0, 0, 2, 0, 0, 100, 0]),
      [{ name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
      direct,
      () => undefined,
    );

    const down = port.commands.indexOf('SP,0,150');
    const up = port.commands.indexOf('SP,1,150', down);
    const drawMoves = port.commands
      .slice(down + 1, up)
      .filter((command) => command.startsWith('XM,'));
    const actualMs = drawMoves.reduce((sum, command) => sum + Number(command.split(',')[1]), 0);

    // The deceleration-specific distance term adds three tail packets without
    // changing the 2ms-quantized duration of this 100mm stroke.
    expect(drawMoves.length).toBe(96);
    expect(actualMs).toBe(1737);
  });

  test('sub-step launch chunks bank their time into the first physical packet', async () => {
    // The first 5µm launch chunk can round to zero motion, leaving only its
    // TIME. Dropped instead of banked, the first physical packet covers both
    // chunks' distance in half the planned time and launches at double speed.
    // At 80 steps/mm (AxiDraw) 5µm is 0.4 steps — always sub-step. At this
    // machine's 100 steps/mm it is exactly half a step, and whether the
    // rounded target crosses depends on the float error of the start
    // coordinate: 4.995·100 = 499.5000…06 rounds back UP to the current
    // step, so a −x stroke from x=5 deterministically drops its launch chunk.
    const cases: [number, number[]][] = [
      [100, [0, 0, 2, 5, 0, 0, 0]],
      [80, [0, 0, 2, 0, 0, 10, 0]],
    ];
    for (const [stepsPerMm, plan] of cases) {
      const port = new FakePort();
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { serial: { requestPort: async () => port } },
      });
      const direct = { ...opts, swapXY: false, invertX: false, stepsPerMm };
      const ebb = new Ebb();
      await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
      await ebb.plot(
        new Float64Array(plan),
        [{ name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
        direct,
        () => undefined,
      );

      const down = port.commands.indexOf('SP,0,150');
      const first = port.commands.slice(down + 1).find((command) => command.startsWith('XM,'))!;
      const [ms, dx, dy] = first.split(',').slice(1).map(Number);
      expect((Math.hypot(dx, dy) / stepsPerMm / ms) * 1000, `${stepsPerMm} steps/mm`).toBeLessThan(5);
    }
  });

  test('pen-up moves use the travel acceleration profile', async () => {
    // Same 60mm travel at 100mm/s: t = L/v + v/a, so 4× travel accel should
    // save ~75ms of ramp time while the draw stroke is planned identically.
    const travelMs = async (travelAcceleration: number): Promise<number> => {
      const port = new FakePort();
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { serial: { requestPort: async () => port } },
      });
      const direct = { ...opts, swapXY: false, invertX: false, travelAcceleration };
      const ebb = new Ebb();
      await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
      await ebb.plot(
        new Float64Array([0, 0, 2, 60, 0, 70, 0]),
        [{ name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
        direct,
        () => undefined,
      );
      const down = port.commands.indexOf('SP,0,150');
      return port.commands
        .slice(0, down)
        .filter((command) => command.startsWith('XM,'))
        .reduce((sum, command) => sum + Number(command.split(',')[1]), 0);
    };

    const shared = await travelMs(1000);
    const fast = await travelMs(4000);
    expect(fast + 40).toBeLessThan(shared);
  });

  test('onlyPen plots just the selected pen’s chains', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    const plan = new Float64Array([
      0, 0, 2, 0, 0, 5, 0, // pen 0: stroke along x
      1, 0, 2, 10, 10, 10, 15, // pen 1: stroke starting at (10,10)
    ]);
    const pens = [
      { name: 'a', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 },
      { name: 'b', width: 0.2, color: '#f00', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 },
    ];
    const ebb = new Ebb();
    await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
    await ebb.plot(plan, pens, direct, () => undefined, undefined, undefined, 1);

    const downs = port.commands.filter((command) => command === 'SP,0,150');
    expect(downs).toHaveLength(1);
    // The single travel ends at pen 1's chain start, (10,10) → 1000,1000 steps.
    const down = port.commands.indexOf('SP,0,150');
    const travelled = port.commands
      .slice(0, down)
      .filter((command) => command.startsWith('XM,'))
      .map((command) => command.split(',').slice(2).map(Number))
      .reduce(([x, y], [dx, dy]) => [x + dx, y + dy], [0, 0]);
    expect(travelled).toEqual([1000, 1000]);
  });
});

describe('LM motion', () => {
  const lmOpts = { ...opts, lmMotion: true, swapXY: false, invertX: false };
  const pen = [
    { name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 },
  ];

  async function run(plan: Float64Array, o = lmOpts, version?: string): Promise<FakePort> {
    const port = new FakePort(version);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const ebb = new Ebb();
    await ebb.connect({ servoDown: o.servoDown, servoUp: o.servoUp });
    await ebb.plot(plan, pen, o, () => undefined);
    return port;
  }

  test('drives a straight stroke to the exact position in the planned time', async () => {
    const port = await run(new Float64Array([0, 0, 2, 0, 0, 100, 0]));
    const lm = port.commands.filter((c) => c.startsWith('LM,'));
    const sim = simulateLm(lm);
    expect(sim.stalled).toBe(false);
    expect([sim.x, sim.y]).toEqual([10000, 0]);
    // Trapezoid: L/v + v/a at 60mm/s, 1000mm/s² = 1.727s.
    expect(sim.seconds).toBeGreaterThan(1.7);
    expect(sim.seconds).toBeLessThan(1.8);
    // The same stroke costs ~96 XM packets.
    expect(lm.length).toBeLessThan(15);
  });

  test('negative and diagonal strokes land exactly', async () => {
    const port = await run(new Float64Array([0, 0, 2, 10, 7, 0, 0]));
    const down = port.commands.indexOf('SP,0,150');
    const travel = simulateLm(port.commands.slice(0, down));
    expect([travel.x, travel.y]).toEqual([1000, 700]);
    const all = simulateLm(port.commands);
    expect(all.stalled).toBe(false);
    expect([all.x, all.y]).toEqual([0, 0]);
  });

  test('sub-step waypoints complete exactly without stalling', async () => {
    const n = 100;
    const points = Array.from({ length: n }, (_, i) => [(i + 1) * 0.005, 0]).flat();
    const port = await run(new Float64Array([0, 0, n, ...points]));
    const sim = simulateLm(port.commands);
    expect(sim.stalled).toBe(false);
    expect([sim.x, sim.y]).toEqual([50, 0]);
  });

  test('blocks respect the duration cap', async () => {
    const port = await run(new Float64Array([0, 0, 2, 0, 0, 400, 0]));
    const sim = simulateLm(port.commands);
    expect(sim.stalled).toBe(false);
    expect(Math.max(...sim.perCmdSeconds)).toBeLessThan(0.3);
  });

  test('travel uses the pen-up acceleration profile', async () => {
    const travelSeconds = async (travelAcceleration: number): Promise<number> => {
      const port = await run(
        new Float64Array([0, 0, 2, 60, 0, 70, 0]),
        { ...lmOpts, travelAcceleration },
      );
      const down = port.commands.indexOf('SP,0,150');
      return simulateLm(port.commands.slice(0, down)).seconds;
    };
    // t = L/v + v/a over 60mm at 100mm/s: 700ms at 1000, 625ms at 4000.
    expect((await travelSeconds(1000)) - (await travelSeconds(4000))).toBeGreaterThan(0.05);
  });

  test('falls back to XM below firmware 2.5.3', async () => {
    const port = await run(new Float64Array([0, 0, 2, 0, 0, 20, 0]), lmOpts, 'EBBv2.4.5');
    expect(port.commands.some((c) => c.startsWith('LM,'))).toBe(false);
    expect(port.commands.some((c) => c.startsWith('XM,'))).toBe(true);
  });
});

describe('stop robustness', () => {
  test('stop bypasses a wedged queue, releases motors, and Home still works', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    const ebb = new Ebb();
    await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
    // The board goes silent on a motion command mid-plot (full FIFO or a
    // stalled move): the old stop() queued ES behind it and nothing —
    // including Home — could ever send again.
    port.muteMotion = true;
    const plotting = ebb
      .plot(
        new Float64Array([0, 0, 2, 0, 0, 50, 0]),
        [{ name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
        direct,
        () => undefined,
      )
      .catch(() => undefined); // rejected in-flight command surfaces here
    await new Promise((r) => setTimeout(r, 50)); // let a motion cmd wedge
    port.muteMotion = false;
    await ebb.stop();
    expect(port.commands.some((c) => c.includes('ES'))).toBe(true);
    expect(port.commands.at(-1)).toBe('EM,0,0'); // gantry unlocked
    await ebb.home();
    expect(port.commands.at(-1)).toBe('HM,2000'); // pipeline alive again
    await plotting;
    // The transcript captured both directions for the postmortem.
    expect(ebb.transcript()).toContain('> ES (raw, queue bypassed)');
    expect(ebb.transcript()).toContain('< OK');
  });
});

describe('progress estimation', () => {
  test('totals come from planner trapezoids and elapsed converges to them', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    const ebb = new Ebb();
    await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
    let last: PlotProgress | undefined;
    await ebb.plot(
      new Float64Array([0, 0, 2, 0, 0, 100, 0]),
      [{ name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
      direct,
      (p) => {
        last = p;
      },
    );
    // 100mm at 60mm/s with 1000mm/s² ramps: 1727ms of motion (the naive
    // full-feed figure is 1667) + settle overheads. Elapsed accumulates the
    // emitter's commanded durations, so both sides are planner-derived and
    // must agree.
    expect(last?.state).toBe('done');
    expect(last!.totalMs).toBeGreaterThan(2200);
    expect(last!.totalMs).toBeLessThan(2500);
    expect(Math.abs(last!.elapsedMs - last!.totalMs)).toBeLessThan(0.05 * last!.totalMs);
    expect(last!.etaMs).toBeLessThan(150);
  });
});

describe('position integrity (QS)', () => {
  const direct = { ...opts, swapXY: false, invertX: false };
  const pen = [
    { name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 },
  ];

  function setup(port: FakePort): Ebb {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    return new Ebb();
  }

  test('connect adopts the board counters, so a reconnect stays registered', async () => {
    const port = new FakePort();
    port.qs = () => [200, 0]; // motor space → machine (100, 100) steps = (1, 1)mm
    const ebb = setup(port);
    await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
    await ebb.plot(new Float64Array([0, 0, 2, 1, 1, 2, 1]), pen, direct, () => undefined);
    // The chain starts exactly where the board says we are: no travel move.
    const down = port.commands.indexOf('SP,0,150');
    const travel = port.commands
      .slice(0, down)
      .filter((c) => c.startsWith('XM,') || c.startsWith('LM,'));
    expect(travel).toEqual([]);
  });

  test('end-of-plot drift is reported and the board counters adopted', async () => {
    const port = new FakePort();
    let calls = 0;
    port.qs = () => (++calls <= 1 ? [0, 0] : [1100, 1100]); // machine (1100, 0)
    const ebb = setup(port);
    await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
    const reports: (string | undefined)[] = [];
    await ebb.plot(new Float64Array([0, 0, 2, 0, 0, 10, 0]), pen, direct, (p) =>
      reports.push(p.warning),
    );
    // Host dead-reckons (1000, 0); the board claims (1100, 0).
    expect(reports.at(-1)).toContain('drift 100,0');
  });

  test('jog or Set origin during a pause keeps the pen up on resume', async () => {
    const port = new FakePort();
    const ebb = setup(port);
    await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
    let state = '';
    const plotting = ebb.plot(
      new Float64Array([0, 0, 2, 0, 0, 30, 0, 0, 0, 2, 5, 5, 6, 5]),
      pen,
      direct,
      (p) => {
        state = p.state;
      },
    );
    ebb.pause(); // lands at the first draw block of chain 1
    while (state !== 'paused') await new Promise((r) => setTimeout(r, 20));
    await ebb.setOrigin(); // drift recovery: re-true the coordinate frame
    ebb.resume();
    await plotting;
    // Chain 1's initial pen-down and chain 2's — but NO re-lower at resume:
    // the frame moved, so the interrupted stroke's remainder stays inkless.
    expect(port.commands.filter((c) => c === 'SP,0,150')).toHaveLength(2);
  });
});

describe('quick-hop lifts', () => {
  test('short gaps hop at reduced height and settle; long gaps restore full', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false, quickHopMm: 15 };
    // Chains at x 0-5, 10-15, 20-25 (5mm gaps → hop), then 100-105 (far →
    // full), all on y 0.
    const plan = new Float64Array([
      0, 0, 2, 0, 0, 5, 0,
      0, 0, 2, 10, 0, 15, 0,
      0, 0, 2, 20, 0, 25, 0,
      0, 0, 2, 100, 0, 105, 0,
    ]);
    const ebb = new Ebb();
    await ebb.connect({ servoDown: direct.servoDown, servoUp: direct.servoUp });
    await ebb.plot(
      plan,
      [{ name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 500 }],
      direct,
      () => undefined,
    );

    const c = port.commands;
    // REGISTER SEMANTICS: SP,1 (up) targets SC,4; SP,0 (down) targets SC,5.
    // Hop adjusts SC,4 ONLY — touching SC,5 would lower the pen-DOWN
    // target and strokes would hover (the 2026-08-30 field bug). Hop
    // pulse: 14200 + (10000−14200)×0.4 = 12520. Asymmetric settles: up
    // 0.4×500 = 200; down 0.5×500 = 250 (the fall must COMPLETE).
    const hopSet = c.indexOf('SC,4,12520');
    expect(hopSet).toBeGreaterThan(-1);
    expect(c.filter((cmd) => cmd.startsWith('SC,5')).length).toBe(1); // connect only
    expect(c.indexOf('SP,1,200', hopSet)).toBeGreaterThan(hopSet);
    expect(c.indexOf('SP,0,250', hopSet)).toBeGreaterThan(hopSet);
    // Before the 75mm travel to the last chain, full lift is restored and
    // the full settle returns.
    const restore = c.indexOf('SC,4,10000', hopSet);
    expect(restore).toBeGreaterThan(hopSet);
    expect(c.indexOf('SP,1,500', restore)).toBeGreaterThan(restore);
    // The final full-lift restore never leaves the board in hop mode.
    expect(c.lastIndexOf('SC,4,10000')).toBeGreaterThan(c.lastIndexOf('SC,4,12520'));
    // First chain's pen-down (before any hop decision) uses the full settle.
    expect(c.indexOf('SP,0,500')).toBeLessThan(c.indexOf('SC,4,12520'));
  });
});

describe('connect resilience', () => {
  test('stale bytes at power-up cannot corrupt the version or disable LM', async () => {
    // A lone OK left in the CDC buffer used to be consumed as V's reply:
    // version read "OK", the firmware check failed, and LM silently fell
    // back to XM for the whole session (log-verified field bug).
    const port = new FakePort('EBBv13_and_above EB Firmware Version 2.8.1', 'OK\r');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const ebb = new Ebb();
    const v = await ebb.connect({ servoDown: 10_000, servoUp: 14_200 });
    expect(v).toMatch(/\d+\.\d+\.\d+/);
    const direct = { ...opts, swapXY: false, invertX: false, lmMotion: true };
    await ebb.plot(
      new Float64Array([0, 0, 2, 0, 0, 20, 0]),
      [{ name: 'test', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
      direct,
      () => undefined,
    );
    expect(port.commands.some((c) => c.startsWith('LM,'))).toBe(true);
  });
});
