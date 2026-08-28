import { describe, expect, test } from 'vitest';

import { planPolyline } from './motion.js';

const limits = {
  maxVelocity: 60,
  acceleration: 1000,
  junctionDeviation: 0.02,
  minimumCruiseRatio: 0.5,
  startVelocity: 8,
  endVelocity: 8,
};

describe('polyline look-ahead planner', () => {
  test('does not slow down at a collinear waypoint', () => {
    const plan = planPolyline(
      [
        [0, 0],
        [20, 0],
        [40, 0],
      ],
      limits,
    );

    expect(plan).toHaveLength(2);
    expect(plan[0].endVelocity).toBeCloseTo(60);
    expect(plan[1].startVelocity).toBeCloseTo(60);
  });

  test('limits a right-angle junction using junction deviation', () => {
    const plan = planPolyline(
      [
        [0, 0],
        [20, 0],
        [20, 20],
      ],
      limits,
    );
    const expected = Math.sqrt(
      (limits.acceleration * limits.junctionDeviation * Math.SQRT1_2) / (1 - Math.SQRT1_2),
    );

    expect(plan[0].endVelocity).toBeCloseTo(expected);
    expect(plan[1].startVelocity).toBeCloseTo(expected);
  });

  test('curvature-limits a finely segmented two millimeter circle', () => {
    const points = Array.from({ length: 24 }, (_, i) => {
      const theta = (i * Math.PI * 2) / 23;
      return [Math.cos(theta), Math.sin(theta)] as [number, number];
    });
    const plan = planPolyline(points, limits);
    const interior = plan.slice(2, -2).map((segment) => segment.startVelocity);

    expect(Math.max(...interior)).toBeLessThanOrEqual(Math.sqrt(limits.acceleration) * 1.03);
    expect(Math.max(...interior)).toBeGreaterThan(Math.sqrt(limits.acceleration) * 0.9);
  });

  test('backward and forward passes keep every junction acceleration-reachable', () => {
    const plan = planPolyline(
      [
        [0, 0],
        [0.2, 0],
        [0.4, 0],
        [20, 0],
        [20, 20],
      ],
      limits,
    );

    for (const segment of plan) {
      expect(segment.endVelocity ** 2 - segment.startVelocity ** 2).toBeLessThanOrEqual(
        2 * limits.acceleration * segment.length + 1e-9,
      );
      expect(segment.startVelocity ** 2 - segment.endVelocity ** 2).toBeLessThanOrEqual(
        2 * limits.acceleration * segment.length + 1e-9,
      );
      expect(segment.cruiseVelocity).toBeLessThanOrEqual(limits.maxVelocity);
    }
  });

  test('stops for an exact reversal', () => {
    const plan = planPolyline(
      [
        [0, 0],
        [10, 0],
        [0, 0],
      ],
      limits,
    );

    expect(plan[0].endVelocity).toBe(0);
    expect(plan[1].startVelocity).toBe(0);
  });

  test('minimum cruise ratio suppresses speed spikes on short segments', () => {
    const plan = planPolyline(
      [
        [0, 0],
        [1, 0],
      ],
      { ...limits, startVelocity: 0, endVelocity: 0 },
    );

    expect(plan[0].cruiseVelocity).toBeCloseTo(Math.sqrt(500));
  });

  test('minimum cruise limiting never puts cruise below a junction speed', () => {
    const plan = planPolyline(
      [
        [0, 0],
        [20, 0],
        [20.1, 0],
      ],
      { ...limits, startVelocity: 60, endVelocity: 0 },
    );

    for (const segment of plan) {
      expect(segment.cruiseVelocity).toBeGreaterThanOrEqual(segment.startVelocity);
      expect(segment.cruiseVelocity).toBeGreaterThanOrEqual(segment.endVelocity);
    }
  });
});
