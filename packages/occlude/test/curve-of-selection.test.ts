import { describe, it, expect } from 'vitest';
import { material, curve } from '../src/index.js';

describe('curve of a point selection', () => {
  it('is the chain through the points, without the source edges or their columns', () => {
    const src = material([[0, 0], [10, 0], [10, 10], [0, 10]], { edges: [[0, 1], [1, 2], [2, 3]] }).edges.set('strength', 2);
    const c = curve(src.points.filter((p) => p.x > 0 || p.y > 0), { closed: true });
    expect(c.points.length).toBe(3);
    expect(c.edges.length).toBe(3);
    expect(c.curves.at(0)!.closed).toBe(true);
  });
});
