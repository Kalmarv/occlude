import { describe, expect, it } from 'vitest';
import { decimalsOf, formatValue, numberAt, scrubbed } from './scrub.js';

const at = (line: string, col: number): string | null => numberAt(line, col)?.text ?? null;

describe('numberAt', () => {
  it('finds the literal under the column', () => {
    const line = 'circle(50, 50, 25)';
    expect(at(line, 7)).toBe('50');
    expect(at(line, 15)).toBe('25');
    expect(at(line, 0)).toBe(null); // over `c`, no number there
  });

  it('keeps a decimal literal whole', () => {
    expect(at('rnd(0.28, 0.5)', 5)).toBe('0.28');
    expect(at('t.decimate(.15)', 12)).toBe('.15');
  });

  it('takes a unary minus so a drag can cross zero', () => {
    expect(at('ui(-47, { min: -50 })', 5)).toBe('-47');
    expect(at('[-1, 1]', 2)).toBe('-1');
    expect(at('return -3;', 8)).toBe('-3');
  });

  it('leaves a subtraction alone', () => {
    expect(at('b.w - 20', 6)).toBe('20');
    expect(numberAt('b.w - 20', 6)?.startCol).toBe(6);
  });

  it('skips what a drag would corrupt', () => {
    expect(at('const Ivy2 = 3;', 9)).toBe(null);      // identifier
    expect(at('0x1f', 1)).toBe(null);                  // hex
    expect(at('1e-9', 0)).toBe(null);                  // exponent
    expect(at("image('beach-2.jpg')", 14)).toBe(null); // string
    expect(at('// seed 1627492744', 10)).toBe(null);   // comment
  });

  it('reads a number after a string on the same line', () => {
    expect(at("label('W 2', 50, 8)", 13)).toBe('50');
  });
});

describe('scrubbing', () => {
  it('steps by the literal’s own precision', () => {
    expect(decimalsOf('0.28')).toBe(2);
    expect(decimalsOf('180')).toBe(0);
    expect(scrubbed('180', 40)).toBe('190');
    expect(scrubbed('0.28', 40)).toBe('0.38');
    expect(scrubbed('0.28', -40)).toBe('0.18');
  });

  it('shift is coarse, ctrl is fine', () => {
    expect(scrubbed('180', 40, { coarse: true })).toBe('280');
    expect(scrubbed('180', 40, { fine: true })).toBe('181.0');
    expect(scrubbed('0.28', 40, { fine: true })).toBe('0.290');
  });

  it('never writes a negative zero', () => {
    expect(formatValue(-0, 2)).toBe('0.00');
    expect(scrubbed('1', -4)).toBe('0');
  });
});
