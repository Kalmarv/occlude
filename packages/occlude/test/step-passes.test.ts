import { describe, expect, it } from 'vitest';
import {
  curve,
  material,
  force,
  type StepRule,
  type Handle,
} from '../src/material.js';
import type { PointSelection } from '../src/relation.js';

describe('selection-first step passes', () => {
  it('runs passes within each iteration and records only whole iterations', () => {
    const calls: string[] = [];
    const move: StepRule = (prev, next, k) => {
      calls.push(`move:${k}`);
      next.move(prev.points, [1, 0]);
    };
    const double: StepRule = (prev, next, k) => {
      calls.push(`double:${k}`);
      next.move(prev.points, (p) => [p.x, 0]);
    };
    const seed = material([[0, 0]]);
    const out = seed.steps(3, move, double, { every: 2 });
    expect(calls).toEqual([
      'move:0',
      'double:0',
      'move:1',
      'double:1',
      'move:2',
      'double:2',
    ]);
    expect(out.x[0]).toBe(14);
    expect(out.iteration).toBe(3);
    expect(out.history.map((h) => [h.iteration, h.material.x[0]])).toEqual([
      [0, 0],
      [2, 6],
      [3, 14],
    ]);
    expect(out.history.every((h) => h.material.history.length === 0)).toBe(
      true,
    );
    const more = out.steps(1, move, double, { every: 1 });
    expect(more.iteration).toBe(4);
    expect(more.history.map((h) => h.iteration)).toEqual([3, 4]);
    expect(out.x[0]).toBe(14);
    expect(seed.x[0]).toBe(0);
    expect(seed.steps(0, move, double, { every: 1 }).history).toHaveLength(1);
  });
  it('distinguishes selection before movement from inspection in a later pass', () => {
    const seed = curve(
      [
        [0, 0],
        [4, 0],
      ],
      { closed: false },
    );
    const one = seed.steps(1, (prev, next) => {
      next.move(prev.points, (p) => [p.x, 0]);
      next.splitEdges(prev.edges.filter((e) => e.length > 5));
    });
    const two = seed.steps(
      1,
      (prev, next) => next.move(prev.points, (p) => [p.x, 0]),
      (prev, next) => next.splitEdges(prev.edges.filter((e) => e.length > 5)),
    );
    expect(one.pts).toEqual([
      [0, 0],
      [8, 0],
    ]);
    expect(two.pts).toEqual([
      [0, 0],
      [4, 0],
      [8, 0],
    ]);
    expect(two.iteration).toBe(1);
  });
  it('extrudes captured parents, allows constants, and exposes children in the following pass', () => {
    const seed = material([[0, 0]], { active: 1 });
    const tree = seed.steps(
      3,
      (prev, next) => {
        const tips = prev.points.filter((p) => p.active === 1);
        next.extrude(tips, (p) => ({
          position: [p.x + 1, p.y],
          attributes: { active: 1 },
        }));
        next.set(tips, { active: 0 });
      },
      (prev, next, k) => {
        expect(prev.n).toBe(k + 2);
        expect(prev.points.filter((p) => p.active === 1)).toHaveLength(1);
        next.move(
          prev.points.filter((p) => p.active === 1),
          [0, 1],
        );
      },
    );
    expect(tree.pts).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect([...tree.attrs.active]).toEqual([0, 0, 0, 1]);
  });
  it('preserves frozen force identity and callback reads within one pass', () => {
    const seed = curve(
      [
        [0, 0],
        [2, 0],
      ],
      { closed: false },
    );
    const out = seed.steps(1, (prev, next) => {
      next.move(
        prev.points,
        force.attract(prev, { radius: 10, excludeConnected: true }),
      );
      next.move(prev.points, (p) => [p.x, 0]);
      next.move(prev.points, (p) => [p.x, 0]);
    });
    expect(out.pts).toEqual([
      [0, 0],
      [6, 0],
    ]);
  });
  it('resolves multiple extruded tips hitting one edge in the same batch', () => {
    const seed = curve(
      [
        [0, 0],
        [10, 0],
      ],
      { closed: false, active: 0 },
    );
    const out = seed.steps(1, (prev, next) => {
      next.extrude(prev.points, (p) => ({
        to: next.split(prev.edge(0), { at: p.index === 0 ? 0.2 : 0.7 }),
      }));
    });
    expect(out.pts).toEqual([
      [0, 0],
      [2, 0],
      [7, 0],
      [10, 0],
    ]);
  });
  it('rejects references crossing a pass boundary and preserves input when a later pass fails', () => {
    let selection: PointSelection;
    let handle: Handle;
    const seed = material([[0, 0]]);
    expect(() =>
      seed.steps(
        1,
        (prev, next) => {
          selection = prev.points;
          next.move(selection, [1, 0]);
        },
        (_, next) => next.move(selection, [1, 0]),
      ),
    ).toThrow(/another state/);
    expect(() =>
      seed.steps(
        1,
        (_, next) => {
          handle = next.addPoint([1, 0], {});
        },
        (prev, next) => next.connect(prev.vertex(0), handle),
      ),
    ).toThrow(/another edit batch/);
    expect(seed.pts).toEqual([[0, 0]]);
  });
  it('removes legacy callback-first and predicate signatures', () => {
    const seed = curve(
      [
        [0, 0],
        [1, 0],
      ],
      { closed: false },
    );
    expect(() =>
      seed.steps(1, (_, next) => {
        // @ts-expect-error explicit targets are required
        next.move((p) => [1, 0]);
      }),
    ).toThrow();
    expect(() =>
      seed.steps(1, (_, next) => {
        // @ts-expect-error use prev.edges.filter
        next.splitEdges((e) => e.length > 0);
      }),
    ).toThrow(/edge selection/);
    seed.steps(1, (prev, next) => {
      expect('extend' in next).toBe(false);
      next.setEdges(prev.edges, {});
    });
  });
});
