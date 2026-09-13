/**
 * A downloaded sketch carries its pens and papers: the @user/* imports it
 * makes are bundled as inline definitions and relinked back to library
 * imports on request — a round trip that changes no other line.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PENS, DEFAULT_PAPERS, assetTable, fillTable } from 'occlude';
import { bundleUserImports, relinkUserImports, scanBundled, scanUserImports } from './userEmbed.js';
import { runSketch, type RunConfig } from './runner.js';

const pens = [{ ...DEFAULT_PENS[0], name: 'fineliner', color: '#111111' }, { ...DEFAULT_PENS[1], name: 'micron-03' }];
const papers = DEFAULT_PAPERS;
const src = `import { sketch, circle } from 'occlude';
import { fineliner, micron_03 as thin } from '@user/pens';
import { Letter } from '@user/papers';

export default sketch({ paper: Letter({ color: '#F5F0E6' }), pens: { blue: fineliner({ color: '#2457D6' }), thin: thin() } }, (t) => [
  circle(50, 50, 20, { stroke: 'blue' }),
  circle(50, 50, 10, { stroke: 'thin' }),
]);
`;

describe('bundling pens and papers into a download', () => {
  it('replaces each import with an inline definition and adds the occlude factories', () => {
    expect(scanUserImports(src)).toEqual([
      { kind: 'pens', entries: [{ id: 'fineliner', local: 'fineliner' }, { id: 'micron_03', local: 'thin' }] },
      { kind: 'papers', entries: [{ id: 'Letter', local: 'Letter' }] },
    ]);
    const out = bundleUserImports(src, pens, papers);
    expect(out.missing).toEqual([]);
    expect(out.bundled).toEqual(['fineliner', 'micron-03', 'Letter']);
    expect(out.source).not.toContain("from '@user/");
    expect(out.source).toContain("import { sketch, circle, penModel, paperModel } from 'occlude';");
    expect(out.source).toContain('// ---- @user/pens bundled: micron-03 ----\nconst thin = penModel({');
    expect(out.source).toContain('// ---- @user/papers bundled: Letter ----\nconst Letter = paperModel({"w":215.9,"h":279.4,"color":"#f6f2ea"});');
    expect(scanBundled(out.source).map((b) => [b.kind, b.name, b.local])).toEqual([['pens', 'fineliner', 'fineliner'], ['pens', 'micron-03', 'thin'], ['papers', 'Letter', 'Letter']]);
  });

  it('a bundled file runs with its own definitions, whatever the recipient\'s libraries hold', () => {
    const bundled = bundleUserImports(src, pens, papers).source;
    const cjs = bundled
      .replace("import { sketch, circle, penModel, paperModel } from 'occlude';", 'const { sketch, circle, penModel, paperModel } = require("occlude");')
      .replace('export default ', 'module.exports.default = ');
    const cfg: RunConfig = { pens: [{ ...DEFAULT_PENS[2], name: 'fineliner', width: 9 }], papers: [], paper: 'Square20', landscape: false, defaultMarginPct: 5, coarsen: 1 };
    const out = runSketch(cjs, cfg, 1, assetTable(), fillTable([]));
    expect(out.error).toBeNull();
    expect(out.run!.pens.get('blue')!.width).toBe(DEFAULT_PENS[0].width); // the bundled fineliner, not the recipient's width-9 one
    expect(out.run!.paper).toEqual({ w: 215.9, h: 279.4, color: '#F5F0E6' });
  });

  it('relink restores the imports when the local libraries have every name, and refuses otherwise', () => {
    const bundled = bundleUserImports(src, pens, papers).source;
    const back = relinkUserImports(bundled, pens, papers);
    expect(back.missing).toEqual([]);
    expect(back.relinked).toEqual(['fineliner', 'micron-03', 'Letter']);
    expect(back.source).toBe(src);
    const partial = relinkUserImports(bundled, [pens[0]], papers);
    expect(partial.missing).toEqual(['@user/pens:micron-03']);
    expect(partial.source).toBe(bundled);
  });

  it('an import the library lacks is left in place and reported', () => {
    const out = bundleUserImports(src, [pens[0]], papers);
    expect(out.missing).toEqual(['@user/pens:micron_03']);
    expect(out.source).toContain("import { micron_03 as thin } from '@user/pens';");
    expect(out.source).toContain('const fineliner = penModel(');
  });
});
