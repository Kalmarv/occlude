/**
 * The bloom graph renders the ink of the hand-written bloom.
 *
 * `docs/examples/bloom.mdx` is the source of truth: this test reads its
 * `ts live` fence, renders it, then compiles `fixtures/bloom.json` and
 * renders that, and compares the fragments. The graph is a different
 * program text — the same calls, some of them named and wired — so the
 * only thing that may differ is nothing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import * as occlude from 'occlude';
import { DEFAULT_PENS, initOcclude, liveExampleToJs, renderAsync, type RenderResult, type SketchDef } from 'occlude';

import { CATALOGUE } from './catalogue.js';
import { compileFor, compileGraph } from './compile.js';
import { parseGraph } from './model.js';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

/** Run a sketch source the way the docs checker does: ESM → CJS, then a
 * module whose only import is `occlude`. */
function definition(source: string): SketchDef {
  const mod = { exports: {} as Record<string, unknown> };
  const require = (name: string): unknown => {
    if (name === 'occlude') return occlude;
    throw new Error(`this test's sketches may only import 'occlude' (tried '${name}')`);
  };
  new Function('require', 'exports', 'module', liveExampleToJs(source))(require, mod.exports, mod);
  const def = mod.exports.default;
  if (!occlude.isSketch(def)) throw new Error('the source exported no sketch');
  return def;
}

async function inkOf(source: string): Promise<RenderResult> {
  return renderAsync(definition(source), {
    paper: { paper: 'Square20', landscape: false },
    coarsen: 1,
    marginPct: 5,
    library: structuredClone(DEFAULT_PENS),
  });
}

/** The bloom fence's body, from the page itself. */
function bloomPage(): string {
  const page = read('../../../../docs/examples/bloom.mdx');
  const fence = /```ts live[^\n]*\n([\s\S]*?)```/.exec(page);
  if (!fence) throw new Error('docs/examples/bloom.mdx has no `ts live` fence');
  return fence[1];
}

it('compiles the graph to a sketch of its own', () => {
  const graph = parseGraph(JSON.parse(read('./fixtures/bloom.json')));
  const { source, nodes } = compileGraph(graph, CATALOGUE);
  const at = (id: string): number => nodes.findIndex((n) => n.id === id);
  // A node comes after everything it reads, and the output node is last.
  for (const [before, after] of [['n2', 'n5'], ['n4', 'n5'], ['n5', 'n6'], ['n5', 'n8'], ['n6', 'n8'], ['n7', 'n8'], ['n8', 'n9']]) {
    expect(at(before), `${before} before ${after}`).toBeLessThan(at(after));
  }
  expect(nodes.at(-1)?.id).toBe('n9');
  // The graph's ink is the output's sub-graph: the viewers draw nothing.
  expect(nodes).toHaveLength(9);
  // A viewer compiles exactly what it reads, and nothing else.
  expect(compileFor(graph, CATALOGUE, 'v4', 'in').nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'v4']);
  // The words the code bodies reach for are imported, not only the ones the
  // built-in nodes call.
  const imports = /^import \{[^}]*\} from 'occlude';$/m.exec(source)?.[0] ?? '';
  for (const name of ['sketch', 'add', 'circle', 'fill', 'force', 'mm', 'mul', 'polygon', 'strokes']) {
    expect(imports, name).toContain(name);
  }
  expect(source).toContain('const n5 = ((ring, dish) => {');
  expect(source).toContain('return n8.ink;');
});

it('renders the ink of the hand-written bloom', async () => {
  const graph = parseGraph(JSON.parse(read('./fixtures/bloom.json')));
  const compiled = compileGraph(graph, CATALOGUE);
  const [hand, fromGraph] = await Promise.all([inkOf(bloomPage()), inkOf(compiled.source)]);
  expect(fromGraph.stats.fragments).toBeGreaterThan(0);
  expect(fromGraph.frags.length).toBe(hand.frags.length);
  expect(fromGraph.frags).toEqual(hand.frags);
}, 120_000);
