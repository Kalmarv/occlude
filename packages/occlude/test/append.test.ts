import { describe, expect, it } from 'vitest';
import { append, curve, material } from '../src/index.js';

const square = (x: number) => curve([[x, 0], [x + 10, 0], [x + 10, 10], [x, 10]], { closed: true });

describe('append takes any number of materials', () => {
  it('piles a list in the order given, edges renumbered', () => {
    const pile = append(square(0), square(20), square(40));
    expect(pile.n).toBe(12);
    expect(pile.edgeCount).toBe(12);
    expect(pile.x[8]).toBe(40);
    expect(pile.faces().length).toBe(3);
  });
  it('spreads a mapped list', () => {
    const parts = [0, 20, 40, 60].map(square);
    expect(append(parts[0], ...parts.slice(1)).faces().length).toBe(4);
  });
  it('reads a trailing plain object as the options for every side', () => {
    const tagged = material([[0, 0], [1, 0]], { active: 1 });
    const pile = append(tagged, material([[5, 0]]), material([[6, 0]]), { fill: { active: 0 } });
    expect(Array.from(pile.attrs.active)).toEqual([1, 1, 0, 0]);
  });
  it('refuses a side that is not a material', () => {
    expect(() => append(square(0), [[0, 0]] as never)).toThrow(/every side must be a material/);
  });
});
