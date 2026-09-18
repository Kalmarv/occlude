import { describe, expect, it } from 'vitest';

import { CATALOGUE } from './catalogue.js';
import { wordInputs, wordOf, type CatalogueWord } from './model.js';

const word = (name: string): CatalogueWord => {
  const found = wordOf(CATALOGUE, name);
  if (!found) throw new Error(`the catalogue has no ${name}`);
  return found;
};

describe('the catalogue', () => {
  it('holds the words the palette promises', () => {
    for (const name of ['circle', 't.sample', 'polygon', 't.throw', 'view', 'box']) expect(wordOf(CATALOGUE, name), name).toBeDefined();
  });

  it('gives circle three numbers and a shape, and its shape options after', () => {
    const inputs = wordInputs(word('circle'));
    expect(inputs.slice(0, 3).map((i) => i.name)).toEqual(['x', 'y', 'r']);
    expect(inputs.slice(0, 3).map((i) => i.takes?.socket)).toEqual(['Number', 'Number', 'Number']);
    expect(inputs[3]).toMatchObject({ option: 'pen', control: 'text' });
    expect(word('circle').returns).toBe('shape');
  });

  it('gives t.sample a shape and a count, and a material back', () => {
    const inputs = wordInputs(word('t.sample'));
    expect(inputs.map((i) => i.name)).toEqual(['shape', 'count', 'spacing', 'tolerance']);
    // One socket carries what every overload of the word takes there:
    // `t.sample` samples a shape's boundary and a surface's curves alike.
    expect(inputs[0].takes).toEqual({ socket: 'Geometry', kinds: ['shape', 'curves'] });
    expect(inputs[1].takes).toEqual({ socket: 'Number' });
    expect(word('t.sample').returns).toBe('material');
  });

  it('gives polygon an area and the options a shape takes', () => {
    const inputs = wordInputs(word('polygon'));
    expect(inputs[0].takes?.socket).toBe('Geometry');
    expect([...inputs[0].takes!.kinds!].sort()).toEqual(['faces', 'material', 'points', 'shape']);
    expect(inputs.find((i) => i.name === 'opaque')?.control).toBe('check');
    expect(inputs.find((i) => i.name === 'pen')?.control).toBe('text');
    expect(word('polygon').returns).toBe('shape');
  });

  it('gives every word a module, a call and a group', () => {
    for (const w of CATALOGUE.words) {
      expect(w.call, w.word).toMatch(/^(\{self\}|[A-Za-z_$][A-Za-z0-9_$]*)(\.[A-Za-z_$][A-Za-z0-9_$]*)?$/);
      // A page is a link, not a licence: a word the reference does not
      // document is still a node, and it carries no link.
      if (w.page !== '') expect(w.page, w.word).toMatch(/^\/docs\/reference\//);
      expect(w.group, w.word).not.toBe('');
      // A receiver word hangs off its receiver, and nothing else: its first
      // input is that receiver, and there is no import for it.
      expect(w.call.startsWith('{self}'), w.word).toBe(w.self !== undefined);
      if (w.self) {
        expect(wordInputs(w)[0], w.word).toMatchObject({ name: w.self.param, self: true, optional: false });
        expect(w.import, w.word).toBeNull();
      } else if (w.receiver === 't') expect(w.import, w.word).toBeNull();
      else expect(w.import, w.word).not.toBeNull();
    }
  });

  it('gives every input either a socket or a control, and never both', () => {
    for (const w of CATALOGUE.words) {
      for (const i of wordInputs(w)) {
        expect(Boolean(i.takes) !== Boolean(i.control), `${w.word}.${i.name}`).toBe(true);
        if (i.control === 'menu') expect(i.choices?.length, `${w.word}.${i.name}`).toBeGreaterThan(0);
      }
    }
  });

  it('holds no duplicate word', () => {
    const seen = new Set<string>();
    for (const w of CATALOGUE.words) {
      expect(seen.has(w.word), w.word).toBe(false);
      seen.add(w.word);
    }
  });
});
