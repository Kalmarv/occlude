/**
 * A downloaded sketch carries its pens and papers: the @user/* imports it
 * makes are bundled as inline definitions and relinked back to library
 * imports on request. Every bundled file is EXECUTED here — transpiled by
 * esbuild as the studio's editor emits it, run through the runner against
 * a recipient whose libraries differ — so the definitions that apply are
 * the bundled ones, whatever the import forms the sketch used.
 */

import { describe, expect, it } from 'vitest';
import { transformSync } from '../../occlude/node_modules/esbuild/lib/main.js';
import { DEFAULT_PENS, DEFAULT_PAPERS, assetTable, fillTable } from 'occlude';
import { bundleUserImports, relinkUserImports, scanBundled, scanUserImports } from './userEmbed.js';
import { runSketch, type RunConfig } from './runner.js';

const pens = [{ ...DEFAULT_PENS[0], name: 'fineliner', color: '#111111', width: 0.3 }, { ...DEFAULT_PENS[1], name: 'micron-03', width: 0.35 }];
const papers = DEFAULT_PAPERS;
/** A recipient whose libraries hold OTHER definitions under the same names. */
const recipient: RunConfig = {
  pens: [{ ...DEFAULT_PENS[2], name: 'fineliner', width: 9 }, { ...DEFAULT_PENS[2], name: 'micron-03', width: 9 }],
  papers: [{ name: 'Letter', w: 1, h: 1 }],
  paper: 'Square20', landscape: false, defaultMarginPct: 5, coarsen: 1,
};
const body = `
export default sketch({ paper: Letter({ color: '#F5F0E6' }), pens: { blue: fineliner({ color: '#2457D6' }), thin: thin() } }, (t) => [
  circle(50, 50, 20, { stroke: 'blue' }),
  circle(50, 50, 10, { stroke: 'thin' }),
]);
`;
const named = `import { sketch, circle } from 'occlude';
import { fineliner, micron_03 as thin } from '@user/pens';
import { Letter } from '@user/papers';
${body}`;

/** Run a sketch source as the editor would: TS → CommonJS, then the runner. */
function execute(source: string, cfg = recipient) {
  const js = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
  const out = runSketch(js, cfg, 1, assetTable(), fillTable([]));
  if (out.error) throw out.error;
  return out.run!;
}

const expectBundledDefinitions = (source: string): void => {
  const run = execute(source);
  expect(run.pens.get('blue')!.width).toBe(0.3); // the bundled fineliner, not the recipient's width-9 one
  expect(run.pens.get('thin')!.width).toBe(0.35);
  expect(run.paper).toEqual({ w: 215.9, h: 279.4, color: '#F5F0E6' });
};

describe('bundling pens and papers into a download', () => {
  it('replaces each import with an inline definition, adds the occlude factories, and the file runs on its own definitions', () => {
    expect(scanUserImports(named)).toEqual([
      { kind: 'pens', entries: [{ id: 'fineliner', local: 'fineliner' }, { id: 'micron_03', local: 'thin' }] },
      { kind: 'papers', entries: [{ id: 'Letter', local: 'Letter' }] },
    ]);
    const out = bundleUserImports(named, pens, papers);
    expect(out.missing).toEqual([]);
    expect(out.bundled).toEqual(['fineliner', 'micron-03', 'Letter']);
    expect(out.source).not.toContain("from '@user/");
    expect(out.source).toContain("import { sketch, circle, penModel, paperModel } from 'occlude';");
    expect(out.source).toContain('// ---- @user/pens bundled: micron-03 ----\nconst thin = penModel({');
    expect(scanBundled(out.source).map((b) => [b.kind, b.name, b.local])).toEqual([['pens', 'fineliner', 'fineliner'], ['pens', 'micron-03', 'thin'], ['papers', 'Letter', 'Letter']]);
    expectBundledDefinitions(out.source);
    // the original, unbundled, resolves the recipient's definitions instead
    expect(execute(named).pens.get('blue')!.width).toBe(9);
  });

  it('a trailing comment on the import line does not hide the import', () => {
    const src = named.replace("import { fineliner, micron_03 as thin } from '@user/pens';", "import { fineliner, micron_03 as thin } from \"@user/pens\" // my pens");
    const out = bundleUserImports(src, pens, papers);
    expect(out.missing).toEqual([]);
    expect(out.bundled).toEqual(['fineliner', 'micron-03', 'Letter']);
    expect(out.source).not.toContain('my pens');
    expectBundledDefinitions(out.source);
  });

  it('a namespace import of occlude reaches the factories through it', () => {
    const src = `import * as o from 'occlude';
import { fineliner, micron_03 as thin } from '@user/pens';
import { Letter } from '@user/papers';
export default o.sketch({ paper: Letter({ color: '#F5F0E6' }), pens: { blue: fineliner({ color: '#2457D6' }), thin: thin() } }, (t) => [
  o.circle(50, 50, 20, { stroke: 'blue' }), o.circle(50, 50, 10, { stroke: 'thin' }),
]);
`;
    const out = bundleUserImports(src, pens, papers);
    expect(out.source).toContain('const fineliner = o.penModel({');
    expect(out.source).toContain('const Letter = o.paperModel({');
    expect(out.source.match(/from 'occlude'/g)!.length).toBe(1);
    expectBundledDefinitions(out.source);
  });

  it('a sketch with no occlude import gets one; a sketch using the helper names itself gets a suffixed binding', () => {
    const bare = `import { fineliner, micron_03 as thin } from '@user/pens';
import { Letter } from '@user/papers';
const { sketch, circle } = require('occlude');
${body.replace('export default', 'module.exports.default =')}`;
    const out = bundleUserImports(bare, pens, papers);
    expect(out.source.startsWith("import { penModel, paperModel } from 'occlude';\n")).toBe(true);
    expectBundledDefinitions(out.source);
    const clash = named.replace('export default sketch(', 'const penModel = 1; const paperModel = () => 2;\nexport default sketch(');
    const out2 = bundleUserImports(clash, pens, papers);
    expect(out2.source).toContain("import { sketch, circle, penModel as penModel$1, paperModel as paperModel$1 } from 'occlude';");
    expect(out2.source).toContain('const fineliner = penModel$1({');
    expectBundledDefinitions(out2.source);
    expect(scanBundled(out2.source)).toHaveLength(3);
  });

  it('relink restores the imports when the local libraries have every name, and refuses otherwise', () => {
    const bundled = bundleUserImports(named, pens, papers).source;
    const back = relinkUserImports(bundled, pens, papers);
    expect(back.missing).toEqual([]);
    expect(back.relinked).toEqual(['fineliner', 'micron-03', 'Letter']);
    expect(back.source).toBe(named);
    expect(execute(back.source).pens.get('blue')!.width).toBe(9); // the recipient's again
    const partial = relinkUserImports(bundled, [pens[0]], papers);
    expect(partial.missing).toEqual(['@user/pens:micron-03']);
    expect(partial.source).toBe(bundled);
  });

  it('an import the library lacks is left in place and reported', () => {
    const out = bundleUserImports(named, [pens[0]], papers);
    expect(out.missing).toEqual(['@user/pens:micron_03']);
    expect(out.source).toContain("import { micron_03 as thin } from '@user/pens';");
    expect(out.source).toContain('const fineliner = penModel(');
  });

  it('a sketch that already imports the helper under an alias bundles through it, and Relink finds the bundle', () => {
    const aliased = named.replace("import { sketch, circle } from 'occlude';", "import { sketch, circle, penModel as makePen } from 'occlude';\nconst spare = makePen({ name: 'x', width: 0.1, color: '#000', feed: 1, penDown: 0, penUp: 1, penDelay: 1 });");
    const out = bundleUserImports(aliased, pens, papers);
    expect(out.source).toContain('const fineliner = makePen({');
    expect(out.source).toContain("import { sketch, circle, penModel as makePen, paperModel } from 'occlude';");
    expectBundledDefinitions(out.source);
    expect(scanBundled(out.source)).toHaveLength(3);
    const back = relinkUserImports(out.source, pens, papers);
    expect(back.relinked).toEqual(['fineliner', 'micron-03', 'Letter']);
    expect(back.source).toBe(aliased); // makePen stays: the sketch's own `spare` uses it; paperModel goes
  });
});
