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
});
