/**
 * The affected oracle's selection (tools/docs-coverage.ts) over a synthetic
 * map and synthetic hunks — no rendering — and one recording through the
 * real tsx loader, which proves transpiled offsets come back as the source's
 * own lines.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  globalTrigger, hunkHits, keyList, moduleLevelChange, selectAffected,
  type Change, type CoverageMap, type Hunk, type SelectInput,
} from '../tools/docs-coverage.js';

const REC = 'packages/occlude/src/record.ts';
const SPACE = 'packages/occlude/src/space.ts';
const map: Pick<CoverageMap, 'modules' | 'init' | 'fences'> = {
  modules: [REC, SPACE, 'packages/occlude/src/api.ts'],
  init: { 'packages/occlude/src/api.ts': [[400, 410]] },
  fences: {
    'shapes#0': { [REC]: [[10, 40], [100, 120]] },
    'shapes#1': { [REC]: [[10, 40]], [SPACE]: [[50, 60]] },
    'reference-geometry#3': { [REC]: [[10, 40], [731, 748]], [SPACE]: [[50, 60], [200, 230]] },
    'reference-geometry#4': { [REC]: [[731, 740]] },
  },
};
const fences = [
  { key: 'shapes#0', page: 'shapes' }, { key: 'shapes#1', page: 'shapes' },
  { key: 'reference-geometry#3', page: 'reference-geometry' }, { key: 'reference-geometry#4', page: 'reference-geometry' },
];
const pages = [{ slug: 'shapes', file: 'shapes.md' }, { slug: 'reference-geometry', file: 'reference/geometry.mdx' }];
const hunk = (oldStart: number, oldCount: number): Hunk => ({ oldStart, oldCount, newStart: oldStart, newCount: oldCount });
const select = (changes: Change[], over: Partial<SelectInput> = {}) =>
  selectAffected({ map, changes, fences, pages, importedBySrc: new Set(), ...over });

describe('hunkHits', () => {
  it('a changed line must lie in a range; an insertion strictly inside one', () => {
    expect(hunkHits(hunk(40, 1), [[10, 40]])).toBe(true);
    expect(hunkHits(hunk(41, 3), [[10, 40]])).toBe(false);
    expect(hunkHits(hunk(5, 10), [[10, 40]])).toBe(true); // a deleted range that overlaps counts
    expect(hunkHits(hunk(20, 0), [[10, 40]])).toBe(true); // new code between two lines the fence ran
    expect(hunkHits(hunk(40, 0), [[10, 40]])).toBe(false); // new code after the function ends
    expect(hunkHits(hunk(9, 0), [[10, 40]])).toBe(false);
    expect(hunkHits('whole', [[10, 40]])).toBe(true);
    expect(hunkHits('whole', [])).toBe(false);
  });
});

describe('selectAffected', () => {
  it('selects exactly the fences whose ranges a hunk intersects, in run order', () => {
    const s = select([{ path: REC, hunks: [hunk(735, 4)] }]);
    expect(s.full).toBeNull();
    expect(s.keys).toEqual(['reference-geometry#3', 'reference-geometry#4']);
    expect(s.reasons).toEqual([{ label: 'record.ts:735-738', keys: ['reference-geometry#3', 'reference-geometry#4'] }]);
  });

  it('a hunk no fence ran selects nothing; several hunks union', () => {
    expect(select([{ path: REC, hunks: [hunk(500, 2)] }]).keys).toEqual([]);
    expect(select([{ path: SPACE, hunks: [hunk(55, 1), hunk(210, 0)] }]).keys).toEqual(['shapes#1', 'reference-geometry#3']);
  });

  it('a whole-file change (deleted, binary) reaches every fence that ran the file', () => {
    expect(select([{ path: SPACE, whole: true, hunks: [] }]).keys).toEqual(['shapes#1', 'reference-geometry#3']);
  });

  it('code the import ran, and changed module-level code, reach every fence', () => {
    expect(select([{ path: 'packages/occlude/src/api.ts', hunks: [hunk(405, 1)] }]).full).toMatch(/api\.ts:405 runs at import/);
    expect(select([{ path: 'packages/occlude/src/api.ts', whole: true, hunks: [] }]).full).toMatch(/runs at import/);
    expect(select([{ path: REC, hunks: [hunk(3, 1)], moduleLevel: 'module-level `LIMIT` changed' }]).full).toMatch(/record\.ts: module-level `LIMIT`/);
  });

  it('names the global trigger and selects everything', () => {
    for (const path of ['crates/occlude-core/src/scene.rs', 'packages/occlude/package.json', 'pnpm-lock.yaml', 'packages/occlude/tsconfig.check.json',
      'packages/occlude/test/fixtures/docs-ink.json', 'packages/occlude/src/docsExamples.ts',
      'packages/occlude/src/index.ts', 'README.md', 'packages/occlude/src/three/visibility/classify.worker.ts']) {
      const s = select([{ path, hunks: [hunk(1, 1)] }]);
      expect(s.full, path).toContain(path);
      expect(s.keys).toHaveLength(fences.length);
    }
    // the harness is keyed by hash, not diffed; the rest of tools draws nothing
    expect(globalTrigger('packages/occlude/tools/inputs.ts')).toBeNull();
    expect(select([{ path: 'packages/occlude/tools/plotstats.ts', whole: true, hunks: [] }]).ignored).toEqual(['packages/occlude/tools/plotstats.ts']);
  });

  it('a changed docs page takes every fence of the page, including ones the map never saw', () => {
    const s = select([{ path: 'docs/shapes.md', hunks: [hunk(12, 3)] }], {
      fences: [...fences, { key: 'shapes#2', page: 'shapes' }],
    });
    expect(s.keys).toEqual(['shapes#0', 'shapes#1', 'shapes#2']);
    expect(s.pages).toEqual(['shapes']);
  });

  it('a fence added since the map is affected even when no page changed', () => {
    const s = select([], { fences: [...fences, { key: 'shapes#2', page: 'shapes' }] });
    expect(s.keys).toEqual(['shapes#2']);
    expect(s.reasons[0].label).toBe('new since the map');
  });

  it('a library module the map never saw is conservative when src imports it, and ignored when nothing does', () => {
    const fresh = 'packages/occlude/src/brand-new.ts';
    expect(select([{ path: fresh, whole: true, hunks: [] }], { importedBySrc: new Set([fresh]) }).full).toMatch(/brand-new\.ts: a module the map has never seen/);
    expect(select([{ path: fresh, whole: true, hunks: [] }]).ignored).toEqual([fresh]);
    expect(select([{ path: 'packages/occlude-studio/src/app.ts', hunks: [hunk(1, 1)] }]).ignored).toEqual(['packages/occlude-studio/src/app.ts']);
  });

  it('prints keys grouped by page', () => {
    expect(keyList(['reference-geometry#3', 'reference-geometry#4', 'shapes#1'])).toBe('reference-geometry#3,#4; shapes#1');
  });
});

describe('moduleLevelChange', () => {
  const base = [
    "import { a, b } from './a.js';",
    "import type { T } from './t.js';",
    'interface Shape { w: number }',
    'const LIMIT = 5;',
    'export const f = (x: number): number => x * LIMIT;',
    'export function g(s: Shape) { return s.w + a(b); }',
    '',
  ].join('\n');
  it('types, comments, function bodies, new declarations and new bindings do not count', () => {
    expect(moduleLevelChange(base, base.replace('w: number', 'w: number; h?: number'), 'm.ts')).toBeNull();
    expect(moduleLevelChange(base, base.replace('const LIMIT', '// the cap\nconst LIMIT'), 'm.ts')).toBeNull();
    expect(moduleLevelChange(base, base.replace('x * LIMIT', 'x * LIMIT + 1'), 'm.ts')).toBeNull();
    expect(moduleLevelChange(base, base.replace('return s.w', 'return s.w * 2'), 'm.ts')).toBeNull();
    expect(moduleLevelChange(base, `${base}const EXTRA = 3;\nexport function h() { return EXTRA; }\n`, 'm.ts')).toBeNull();
    expect(moduleLevelChange(base, base.replace('{ a, b }', '{ a, b, c }'), 'm.ts')).toBeNull();
  });
  it('a changed initializer, a top-level statement or a retargeted binding does', () => {
    expect(moduleLevelChange(base, base.replace('LIMIT = 5', 'LIMIT = 6'), 'm.ts')).toMatch(/`LIMIT`/);
    expect(moduleLevelChange(base, `${base}register(f);\n`, 'm.ts')).toMatch(/statement/);
    expect(moduleLevelChange(base, base.replace("import { a, b } from './a.js';", "import { a } from './a.js';\nimport { b } from './b.js';"), 'm.ts')).toMatch(/`b` now binds/);
  });
});

describe('the recorder', () => {
  it('maps a function body run through tsx back to its own source lines, holes and all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'affected-oracle-'));
    try {
      // Types and comments shift the transpiled text away from the source;
      // the lines below are the source's.
      writeFileSync(join(dir, 'fixture.ts'), [
        /*  1 */ 'export interface Opts { twice: boolean }',
        /*  2 */ '// a comment the transpiler drops',
        /*  3 */ 'export function run(o: Opts): number {',
        /*  4 */ '  let n: number = 1;',
        /*  5 */ '  if (o.twice) {',
        /*  6 */ '    n *= 2;',
        /*  7 */ '  }',
        /*  8 */ '  const unused = (k: number): number => {',
        /*  9 */ '    return k + n;',
        /* 10 */ '  };',
        /* 11 */ '  return n + 3;',
        /* 12 */ '}',
        /* 13 */ 'export function never(): number {',
        /* 14 */ '  return 7;',
        /* 15 */ '}',
        '',
      ].join('\n'));
      const tool = fileURLToPath(new URL('../tools/docs-coverage.ts', import.meta.url));
      writeFileSync(join(dir, 'probe.mts'), [
        `import { CoverageRecorder } from ${JSON.stringify(tool)};`,
        `const recorder = await CoverageRecorder.start(${JSON.stringify(`${dir}/`)});`,
        "const { run } = await import('./fixture.ts');",
        'await recorder.init();',
        'run({ twice: false });',
        "await recorder.fence('a');",
        'const out = await recorder.finish();',
        'console.log(JSON.stringify(Object.values(out.fences.a)));',
      ].join('\n'));
      const cwd = fileURLToPath(new URL('..', import.meta.url));
      const stdout = execFileSync(process.execPath, ['--import', 'tsx', join(dir, 'probe.mts')], { cwd, encoding: 'utf8', timeout: 60_000 });
      // `run` ran from its signature to its closing brace, except the inside
      // of the branch it did not take (6) and of the arrow it never called
      // (9). The lines that close each (7, 10) stay: new code written after
      // them is code `run` runs. `never` did not run at all.
      expect(JSON.parse(stdout.trim())).toEqual([[[3, 5], [7, 8], [10, 12]]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
