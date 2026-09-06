import { describe, expect, test } from 'vitest';

import { Ebb, lmAxisCompletes, lmCompletable, type PlotProgress } from './ebb.js';
import { liftForTravel } from 'occlude';

const opts = {
  stepsPerMm: 100,
  travelFeed: 6000,
  swapXY: true,
  invertX: true,
  invertY: false,
  penUpPulse: 10_000,
  penDownPulse: 14_200,
  acceleration: 1000,
  travelAcceleration: 1000,
  junctionDeviation: 0.02,
  minimumCruiseRatio: 0.5,
  // The XM tests pin exact packet streams; LM has its own suite below.
  lmMotion: false,
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
  /** Swallow the reply to the next N motion commands, then behave — a lost byte. */
  muteNext = 0;
  readonly writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      const command = new TextDecoder().decode(chunk).replace(/\r$/, '');
      this.commands.push(command);
      if (this.muteMotion && /^(XM|LM|HM)/.test(command)) return;
      if (this.muteNext > 0 && /^(XM|LM)/.test(command)) {
        this.muteNext -= 1;
        return;
      }
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
    await ebb.connect({ penUpPulse: 10_000, penDownPulse: 14_200 });

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
    await ebb.connect({ penUpPulse: 10_000, penDownPulse: 14_200 });
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
    await ebb.connect({ penUpPulse: opts.penUpPulse, penDownPulse: opts.penDownPulse });
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
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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

  test('re-ink threshold parks at origin, pauses once, and resumes to finish', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    // Two 20mm chains with a 10mm re-ink budget: exactly one pause between
    // them (never after the last chain).
    const plan = new Float64Array([0, 0, 2, 5, 5, 25, 5, 0, 0, 2, 25, 15, 5, 15]);
    const ebb = new Ebb();
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
    const pauses: string[] = [];
    await ebb.plot(
      plan,
      [{ name: 'posca', width: 1, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150, reinkMm: 10 }],
      direct,
      (p: PlotProgress) => {
        if (p.state === 'paused') {
          pauses.push(p.warning ?? '');
          ebb.resume();
        }
      },
    );
    expect(pauses).toHaveLength(1);
    expect(pauses[0]).toContain('re-ink posca');
    expect(pauses[0]).toContain('20mm');
    // The park travel returns the carriage exactly to the paper origin
    // between the first chain's pen-up and the second chain's pen-down —
    // a direct (25,5)→(25,15) travel would never pass through (0,0).
    const upIdx = port.commands.indexOf('SP,1,150');
    const down2 = port.commands.indexOf('SP,0,150', upIdx);
    let x = 0;
    let y = 0;
    let parked = false;
    for (const [i, command] of port.commands.entries()) {
      if (!command.startsWith('XM,')) continue;
      const [, dx, dy] = command.split(',').slice(1).map(Number);
      x += dx;
      y += dy;
      if (i > upIdx && i < down2 && x === 0 && y === 0) parked = true;
    }
    expect(parked).toBe(true);
  });

  test('long cruise strokes retain their requested feed without packet explosion', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    const ebb = new Ebb();
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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
      await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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
      await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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
    await ebb.connect({ penUpPulse: o.penUpPulse, penDownPulse: o.penDownPulse });
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

describe('LM completion guard', () => {
  test('the 2026-09-05 wedge: a 252-step decel to the floor stalls one step short', () => {
    // Verbatim from the field serial log: the board never returned OK.
    expect(lmAxisCompletes(865837701, -252, -692648)).toBe(false);
    expect(lmAxisCompletes(852094245, 248, -681654)).toBe(false);
    // A neighbouring block from the same log that did complete.
    expect(lmAxisCompletes(214748365, 31, -346368)).toBe(true);
  });

  test('easing the deceleration makes the wedged block complete with the rate still positive', () => {
    for (const [r, s, a] of [[865837701, -252, -692648], [852094245, 248, -681654]] as const) {
      const [rate, accel] = lmCompletable(r, a, s);
      expect(rate).toBe(r);
      expect(Math.abs(accel)).toBeLessThan(Math.abs(a));
      expect(Math.abs(accel)).toBeGreaterThan(Math.abs(a) * 0.9); // a nudge, not a different move
      expect(lmAxisCompletes(rate, s, accel)).toBe(true);
    }
  });

  test('accelerating and already-completable blocks pass through untouched', () => {
    expect(lmCompletable(85899, 346368, 31)).toEqual([85899, 346368]);
    expect(lmCompletable(214748365, -346368, 31)).toEqual([214748365, -346368]);
  });

  test('a plot whose final travel block is the wedge case now emits only completable LMs', async () => {
    // The traverse geometry: a 6000mm/min pen-up travel that ends 250 steps
    // (2.5mm) short along Y with a 2-step X component, decelerating to the floor.
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const o = { ...opts, lmMotion: true, swapXY: false, invertX: false, travelFeed: 6000, travelAcceleration: 2000 };
    const ebb = new Ebb();
    await ebb.connect({ penUpPulse: o.penUpPulse, penDownPulse: o.penDownPulse });
    const plan = new Float64Array([0, 0, 2, 0, 0, 3, 0, 0, 0, 2, 0.5, 300, 3.5, 300]);
    await ebb.plot(plan, [{ name: 't', width: 0.2, color: '#000', feed: 3000, penDown: 0, penUp: 5, penDelay: 150 }], o, () => undefined);
    const lm = port.commands.filter((c) => c.startsWith('LM,'));
    expect(lm.length).toBeGreaterThan(0);
    for (const cmd of lm) {
      const [r1, s1, d1, r2, s2, d2] = cmd.split(',').slice(1).map(Number);
      expect(lmAxisCompletes(r1, s1, d1)).toBe(true);
      expect(lmAxisCompletes(r2, s2, d2)).toBe(true);
    }
    const sim = simulateLm(port.commands);
    expect(sim.stalled).toBe(false);
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
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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
    // full-feed figure is 1667) + the two settles — nothing else: the 2026-08
    // calibration measured per-chain overhead at zero. Elapsed accumulates
    // the emitter's commanded durations, so both sides are planner-derived
    // and must agree.
    expect(last?.state).toBe('done');
    expect(last!.totalMs).toBeGreaterThan(1900);
    expect(last!.totalMs).toBeLessThan(2200);
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
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
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

describe('lift map + settle curve', () => {
  test('travels take the map lift and settles scale with it; nothing hops without a map', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    // 2×1 map over a 100×50 bed: left cell clears at 15200, right at 13600.
    const liftMap = {
      cols: 2, rows: 1, bedW: 100, bedH: 50, margin: 5,
      thresholds: [15200, 13600], unresolvedAbove: 16000,
    };
    const settleCurve = [
      { pulse: 10000, ms: 600 }, { pulse: 12800, ms: 500 }, { pulse: 13600, ms: 400 },
      { pulse: 14400, ms: 300 }, { pulse: 15200, ms: 200 }, { pulse: 16000, ms: 200 },
    ];
    const direct = { ...opts, swapXY: false, invertX: false, liftMap, liftMarginPulses: 800, settleCurve };
    const plan = new Float64Array([
      0, 0, 2, 20, 25, 25, 25,
      0, 0, 2, 30, 25, 35, 25,
      0, 0, 2, 70, 25, 75, 25,
    ]);
    const ebb = new Ebb();
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
    const pen = { name: 'a', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 600 };
    await ebb.plot(plan, [pen], direct, () => undefined);
    const c = port.commands;
    const model = { penUpPulse: 10000, marginPulses: 800, settleCurve };
    // First chain: travelled into at full lift → falls with the full settle.
    expect(c.indexOf('SP,0,600')).toBeGreaterThan(-1);
    // Travel into chain 1 inside the left cell: map lift, and the pen rises
    // with the settle THAT lift needs.
    const p1 = liftForTravel(liftMap, [25, 25], [30, 25], 800, 10000);
    const i1 = c.indexOf(`SC,4,${p1}`);
    expect(i1).toBeGreaterThan(-1);
    const up1 = Number(c[i1 + 1].split(',')[2]);
    expect(c[i1 + 1].startsWith('SP,1,')).toBe(true);
    expect(up1).toBeLessThan(600);
    expect(up1).toBeGreaterThanOrEqual(150);
    // …and chain 1 falls from that same lift with the same settle.
    expect(c.indexOf(`SP,0,${up1}`, i1)).toBeGreaterThan(i1);
    // Travel into chain 2 approaches the deeper cell: more lift, longer settle.
    const p2 = liftForTravel(liftMap, [35, 25], [70, 25], 800, 10000);
    const i2 = c.indexOf(`SC,4,${p2}`);
    expect(i2).toBeGreaterThan(i1);
    expect(p2).toBeLessThan(p1);
    const up2 = Number(c[i2 + 1].split(',')[2]);
    expect(up2).toBeGreaterThan(up1);
    // Full lift restored at the end; no fixed-fraction hop pulse anywhere.
    expect(c.lastIndexOf('SC,4,10000')).toBeGreaterThan(i2);
    expect(c.some((x) => x === 'SC,4,12520')).toBe(false);
    void model;
  });

  test('without a map every travel is at full lift with the pen\u2019s own settle', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    const plan = new Float64Array([0, 0, 2, 0, 0, 5, 0, 0, 0, 2, 10, 0, 15, 0]);
    const ebb = new Ebb();
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
    await ebb.plot(plan, [{ name: 'a', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 500 }],
      direct, () => undefined);
    const c = port.commands;
    expect(c.filter((x) => x.startsWith('SC,4,')).every((x) => x === 'SC,4,10000')).toBe(true);
    // Every landing, and every pen-up inside the plot (connect and the final
    // park use the driver's own default), waits the pen's full penDelay.
    expect(c.filter((x) => x.startsWith('SP,0')).every((x) => x === 'SP,0,500')).toBe(true);
    const first = c.indexOf('SP,0,500');
    const last = c.lastIndexOf('SP,0,500');
    expect(c.slice(first, last).filter((x) => x.startsWith('SP,1')).every((x) => x === 'SP,1,500')).toBe(true);
  });
});

describe('servo overrides (pen-height cards)', () => {
  const pen = (name: string, penDelay = 500) => ({
    name, width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay,
  });

  test('a pen with `up` is travelled into at that SC,4; `down` lands at that SC,5; both restore', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    // pen 0 plain, pen 1 lift override 12000, pen 2 down override 15000.
    const plan = new Float64Array([
      0, 0, 2, 0, 0, 5, 0,
      1, 0, 2, 10, 0, 15, 0,
      2, 0, 2, 20, 0, 25, 0,
      0, 0, 2, 30, 0, 35, 0,
    ]);
    const servo = [undefined, { up: 12000 }, { down: 15000 }];
    const ebb = new Ebb();
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
    await ebb.plot(plan, [pen('a'), pen('b'), pen('c')], direct, () => undefined,
      undefined, undefined, undefined, (i) => servo[i]);
    const c = port.commands;
    // Lift override is written BEFORE the pen-up that precedes chain 1's
    // travel, and the settle is the full one (an override lift is not a hop).
    const liftSet = c.indexOf('SC,4,12000');
    expect(liftSet).toBeGreaterThan(-1);
    expect(c[liftSet + 1]).toBe('SP,1,500');
    // Chain 2 has no `up`, so full lift is restored before ITS travel…
    const restoreUp = c.indexOf('SC,4,10000', liftSet);
    expect(restoreUp).toBeGreaterThan(liftSet);
    // …and its landing pulse is written right before its pen-down.
    const downSet = c.indexOf('SC,5,15000');
    expect(downSet).toBeGreaterThan(restoreUp);
    expect(c[downSet + 1]).toBe('SP,0,500');
    // Chain 3 (plain) lands at the profile pulse again.
    const restoreDown = c.indexOf('SC,5,14200', downSet);
    expect(restoreDown).toBeGreaterThan(downSet);
    // Registers are only written on change: exactly one write per override.
    expect(c.filter((x) => x === 'SC,4,12000')).toHaveLength(1);
    expect(c.filter((x) => x === 'SC,5,15000')).toHaveLength(1);
    // The plot ends with the profile pair on the board.
    expect(c.lastIndexOf('SC,4,10000')).toBeGreaterThan(c.lastIndexOf('SC,4,12000'));
    expect(c.lastIndexOf('SC,5,14200')).toBeGreaterThan(c.lastIndexOf('SC,5,15000'));
  });

  test('stop() restores an overridden landing pulse', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, swapXY: false, invertX: false };
    // One long chain with a down override so stop() lands mid-stroke.
    const pts: number[] = [];
    for (let i = 0; i <= 400; i++) pts.push(i * 0.5, (i % 2) * 0.5);
    const plan = new Float64Array([0, 0, 401, ...pts]);
    const ebb = new Ebb();
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
    const plotting = ebb.plot(plan, [pen('a')], direct, () => undefined,
      undefined, undefined, undefined, () => ({ down: 16000 }));
    await new Promise((r) => setTimeout(r, 40));
    await ebb.stop();
    await plotting;
    const c = port.commands;
    expect(c.indexOf('SC,5,16000')).toBeGreaterThan(-1);
    expect(c.lastIndexOf('SC,5,14200')).toBeGreaterThan(c.lastIndexOf('SC,5,16000'));
  });
});

describe('calibration cards are a blank slate', () => {
  test('unpinned chains of a card travel at full lift even with a map on the profile', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const liftMap = {
      cols: 1, rows: 1, bedW: 100, bedH: 50, margin: 5, thresholds: [15200], unresolvedAbove: 16000,
    };
    const direct = { ...opts, swapXY: false, invertX: false, liftMap, liftMarginPulses: 800 };
    // pen 0 = frame (unpinned), pen 1 = strip pinned at 14000.
    const plan = new Float64Array([0, 0, 2, 10, 10, 20, 10, 1, 0, 2, 30, 10, 35, 10, 0, 0, 2, 40, 10, 45, 10]);
    const servo = [undefined, { up: 14000 }];
    const ebb = new Ebb();
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
    await ebb.plot(plan, [
      { name: 'frame', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 600 },
      { name: 'strip', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 600 },
    ], direct, () => undefined, undefined, undefined, undefined, (i) => servo[i]);
    const lifts = port.commands.filter((c) => c.startsWith('SC,4,'));
    // Only the pinned pulse and full lift ever appear — the map's 14400 never does.
    expect(new Set(lifts)).toEqual(new Set(['SC,4,10000', 'SC,4,14000']));
  });
});

describe('stall watchdog', () => {
  test('a lost reply mid-plot is recovered: ES, resync, redo the chain, finish', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, lmMotion: true, swapXY: false, invertX: false };
    const ebb = new Ebb();
    ebb.watchdogMs = 150; // field: 8000
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
    // Three strokes; the board "loses" the reply to one motion command
    // during the second.
    const plan = new Float64Array([0, 0, 2, 0, 0, 10, 0, 0, 0, 2, 20, 0, 30, 0, 0, 0, 2, 40, 0, 50, 0]);
    const progress: PlotProgress[] = [];
    let armed = false;
    const plotting = ebb.plot(plan,
      [{ name: 'a', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
      direct, (p) => {
        progress.push(p);
        if (!armed && p.chain === 1) {
          armed = true;
          port.muteNext = 1;
        }
      });
    await plotting;
    const c = port.commands;
    // The watchdog fired, ES went out raw, position was re-read, and the plot
    // went on to finish with the pen parked.
    expect(c.filter((x) => x.trim() === 'ES')).toHaveLength(1);
    expect(progress.some((p) => p.warning?.includes('stall recovered'))).toBe(true);
    expect(progress[progress.length - 1].state).toBe('done');
    // The stalled chain was redone: at least one more pen-down after the ES,
    // preceded by the servo registers being re-armed and a pen-up.
    const es = c.findIndex((x) => x.trim() === 'ES');
    expect(c.slice(es).filter((x) => x === 'SP,0,150').length).toBeGreaterThanOrEqual(1);
    expect(c.slice(es).some((x) => x === 'QS')).toBe(true);
    expect(c.slice(es).some((x) => x === 'SC,4,10000')).toBe(true);
    // Every command after recovery got its reply (no second stall).
    expect(progress.filter((p) => p.warning?.includes('stall')).every((p) => !p.warning?.includes('giving up'))).toBe(true);
  });

  test('a board that never answers gives up after four stalls with a clear error', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, lmMotion: true, swapXY: false, invertX: false };
    const ebb = new Ebb();
    ebb.watchdogMs = 100;
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
    port.muteMotion = true;
    await expect(ebb.plot(new Float64Array([0, 0, 2, 0, 0, 10, 0]),
      [{ name: 'a', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
      direct, () => undefined)).rejects.toThrow(/4 stalls/);
    expect(port.commands.filter((x) => x.trim() === 'ES').length).toBe(4);
  });
});

describe('paper origin', () => {
  test('plots draw at the paper offset in bed coordinates; Set origin clears it', async () => {
    const port = new FakePort();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { serial: { requestPort: async () => port } },
    });
    const direct = { ...opts, lmMotion: true, swapXY: false, invertX: false };
    const ebb = new Ebb();
    await ebb.connect({ penUpPulse: direct.penUpPulse, penDownPulse: direct.penDownPulse });
    // Jog to the sheet's corner and record it, without zeroing the board.
    await ebb.jog(100, 50, direct);
    expect(ebb.setPaperOrigin(direct)).toEqual([100, 50]);
    expect(port.commands.filter((c) => c === 'CS')).toHaveLength(0);
    // A stroke at paper (0,0)→(10,0) lands at bed (100,50)→(110,50).
    const before = port.commands.length;
    await ebb.plot(new Float64Array([0, 0, 2, 0, 0, 10, 0]),
      [{ name: 'a', width: 0.2, color: '#000', feed: 3600, penDown: 0, penUp: 5, penDelay: 150 }],
      direct, () => undefined);
    const down = port.commands.indexOf('SP,0,150', before);
    const drawn = port.commands.slice(down).find((c) => c.startsWith('LM,'));
    // The LM stream (home is HM, not simulated) ends at the stroke's end,
    // bed (110, 50): the paper offset was applied.
    const sim = simulateLm(port.commands);
    expect(sim.stalled).toBe(false);
    expect(drawn).toBeDefined();
    expect([sim.x, sim.y]).toEqual([11000, 5000]);
    // Set (bed) origin forgets the paper offset.
    await ebb.setOrigin();
    expect(ebb.paperOffset).toEqual([0, 0]);
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
    const v = await ebb.connect({ penUpPulse: 10_000, penDownPulse: 14_200 });
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
