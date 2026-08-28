import { describe, expect, test } from 'vitest';

import { Ebb } from './ebb.js';

const opts = {
  stepsPerMm: 100,
  travelFeed: 6000,
  swapXY: true,
  invertX: true,
  invertY: false,
  servoDown: 10_000,
  servoUp: 14_200,
  acceleration: 1000,
  junctionDeviation: 0.02,
  minimumCruiseRatio: 0.5,
};

class FakePort {
  readonly commands: string[] = [];
  private input!: ReadableStreamDefaultController<Uint8Array>;
  readonly readable = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.input = controller;
    },
  });
  readonly writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      const command = new TextDecoder().decode(chunk).replace(/\r$/, '');
      this.commands.push(command);
      const response =
        command === 'V' ? 'EBBv2.8.1\r' : command === 'QC' ? '0,500\rOK\r' : 'OK\r';
      this.input.enqueue(new TextEncoder().encode(response));
    },
  });

  async open(): Promise<void> {}
  async close(): Promise<void> {}
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
