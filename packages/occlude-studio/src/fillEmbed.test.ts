import { describe, expect, test } from 'vitest';
import {
  canonicalFillSource, embedFills, extractEmbeddedFills, freshFillName, importSketchWithFills,
  rewireFillName, type FillLibrary,
} from './fillEmbed.js';
import {
  BUILTIN_FILL_NAMES as STORE_BUILTINS, FILL_NAME_RE as STORE_NAME_RE, sketchUsesFill,
  // @ts-expect-error plain-JS module shared with the production server
} from '../fill-store.mjs';
import { BUILTIN_FILL_NAMES, FILL_NAME_RE } from 'occlude';

const SKETCH = `import { sketch, circle, fill } from 'occlude';

export default sketch({}, () => circle(50, 50, 20, { fill: fill('grain', { d: 2 }) }));
`;
const GRAIN = `import { fillAsset, rulings } from 'occlude';

export default fillAsset({
  params: { d: 1 },

  generate(region, p) { return rulings(region, { spacing: p.d }); }, // */ tricky
});
`;

describe('export embedding', () => {
  test('round-trips fill sources through a comment-only block', () => {
    const out = embedFills(SKETCH, [{ name: 'grain', source: GRAIN }]);
    expect(out.startsWith(SKETCH)).toBe(true);
    // Every embedded line is a comment: the file is still a valid sketch.
    for (const l of out.slice(SKETCH.length).split('\n')) {
      expect(l === '' || l.startsWith('//')).toBe(true);
    }
    const back = extractEmbeddedFills(out);
    expect(back.sketch).toBe(SKETCH);
    expect(back.fills).toEqual([{ name: 'grain', source: GRAIN }]);
  });

  test('re-exporting replaces the block instead of stacking', () => {
    const once = embedFills(SKETCH, [{ name: 'grain', source: GRAIN }]);
    const twice = embedFills(once, [{ name: 'grain', source: GRAIN }]);
    expect(twice).toBe(once);
    expect(embedFills(once, [])).toBe(SKETCH);
  });

  test('CRLF files and missing final newlines round-trip and compare equal', async () => {
    const noNl = GRAIN.replace(/\n$/, '');
    const crlf = GRAIN.replace(/\n/g, '\r\n');
    expect(canonicalFillSource(noNl)).toBe(GRAIN);
    expect(canonicalFillSource(crlf)).toBe(GRAIN);
    const exported = embedFills(SKETCH, [{ name: 'grain', source: noNl }]);
    // The downloaded file passed through a CRLF-converting editor.
    const back = extractEmbeddedFills(exported.replace(/\n/g, '\r\n'));
    expect(back.fills).toEqual([{ name: 'grain', source: GRAIN }]);
    const lib = { saved: { grain: crlf } as Record<string, string>,
      list: async () => ['grain'], load: async (n: string) => lib.saved[n] ?? null,
      save: async (n: string, s: string) => { lib.saved[n] = s; } };
    const out = await importSketchWithFills(exported, lib);
    expect(out.reused).toEqual(['grain']);
    expect(out.renamed).toEqual([]);
  });

  test('a header quoted in a sketch comment does not truncate the sketch', () => {
    const chatty = SKETCH.replace('export default', '// see: ' + '// ==== occlude fills — embedded by Download .ts; Import .ts restores them to the fill library ====\nexport default');
    const out = embedFills(chatty, [{ name: 'grain', source: GRAIN }]);
    expect(extractEmbeddedFills(out).sketch).toBe(chatty);
  });

  test('a file without a block is just a sketch', () => {
    expect(extractEmbeddedFills(SKETCH)).toEqual({ sketch: SKETCH, fills: [] });
  });
});

describe('rewire + fresh names', () => {
  test('rewires both quote styles and leaves other names alone', () => {
    const src = `fill('grain'); fill("grain", {}); fill('grainy'); fill( 'grain' )`;
    expect(rewireFillName(src, 'grain', 'grain-2')).toBe(
      `fill('grain-2'); fill("grain-2", {}); fill('grainy'); fill( 'grain-2' )`,
    );
  });

  test('fresh names count up from -2 and skip taken and built-in names', () => {
    expect(freshFillName('grain', [])).toBe('grain-2');
    expect(freshFillName('grain', ['grain-2'])).toBe('grain-3');
    expect(freshFillName('grain-7', ['grain-2'])).toBe('grain-3');
    expect(freshFillName('hatch', [])).toBe('hatch-2');
  });
});

describe('import reconciliation', () => {
  function fakeLib(initial: Record<string, string>): FillLibrary & { saved: Record<string, string> } {
    const saved = { ...initial };
    return {
      saved,
      list: async () => Object.keys(saved),
      load: async (n) => saved[n] ?? null,
      save: async (n, s) => { saved[n] = s; },
    };
  }

  test('identical content reuses the name silently', async () => {
    const lib = fakeLib({ grain: GRAIN });
    const out = await importSketchWithFills(embedFills(SKETCH, [{ name: 'grain', source: GRAIN }]), lib);
    expect(out.reused).toEqual(['grain']);
    expect(out.added).toEqual([]);
    expect(out.renamed).toEqual([]);
    expect(out.sketch).toBe(SKETCH);
  });

  test('a missing fill lands under its own name; a mismatch takes a fresh name and rewires', async () => {
    const lib = fakeLib({ grain: GRAIN.replace('spacing: p.d', 'spacing: p.d * 2') });
    const text = embedFills(SKETCH.replace("fill('grain'", "fill('grain', { d: 2 }) && fill('other'"), [
      { name: 'grain', source: GRAIN },
      { name: 'other', source: GRAIN },
    ]);
    const out = await importSketchWithFills(text, lib);
    expect(out.added).toEqual(['other']);
    expect(out.renamed).toEqual([{ from: 'grain', to: 'grain-2' }]);
    expect(lib.saved['grain']).not.toBe(GRAIN); // never overwritten
    expect(lib.saved['grain-2']).toBe(GRAIN);
    expect(out.sketch).toContain("fill('grain-2'");
    expect(out.sketch).not.toContain("fill('grain'");
  });

  test('an embedded built-in name can never shadow the built-in', async () => {
    const lib = fakeLib({});
    const out = await importSketchWithFills(
      embedFills(SKETCH.replace('grain', 'hatch'), [{ name: 'hatch', source: GRAIN }]),
      lib,
    );
    expect(out.renamed).toEqual([{ from: 'hatch', to: 'hatch-2' }]);
    expect(lib.saved['hatch']).toBeUndefined();
  });
});

describe('fill store', () => {
  test('the server-side built-in list and name grammar mirror the package', () => {
    expect([...STORE_BUILTINS].sort()).toEqual([...BUILTIN_FILL_NAMES].sort());
    expect((STORE_NAME_RE as RegExp).source).toBe(FILL_NAME_RE.source);
  });
  test('warn-on-edit scans literal uses only', () => {
    expect(sketchUsesFill(`x = fill('grain', {})`, 'grain')).toBe(true);
    expect(sketchUsesFill(`x = fill("grain")`, 'grain')).toBe(true);
    expect(sketchUsesFill(`x = fill('grainy')`, 'grain')).toBe(false);
    expect(sketchUsesFill(`const n = 'grain'; fill(n)`, 'grain')).toBe(false);
  });
});
