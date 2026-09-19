/**
 * Sub-graphs: a group is a rewrite, so the test that matters is ink.
 *
 * `collapse` takes a selection out of the bloom graph, `expand` puts it
 * back, and the two graphs must compile to sketches that draw the same
 * fragments. Anything else — a boundary socket that drops a wire, an id
 * that collides, a result that loses a name — shows up as different ink.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import * as occlude from 'occlude';
import { DEFAULT_PENS, initOcclude, liveExampleToJs, renderAsync, type RenderResult, type SketchDef } from 'occlude';

import { CATALOGUE } from './catalogue.js';
import { compileGraph } from './compile.js';
import { collapse, expand, groupInputs, groupOutputs, type Group, type GroupLibrary } from './groups.js';
import { graphToJson, parseGraph, topoOrder, type Graph } from './model.js';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const bloom = (): Graph => parseGraph(JSON.parse(read('./fixtures/bloom.json')));

const library = (groups: Group[]): GroupLibrary => {
  const byName = new Map(groups.map((g) => [g.name, g]));
  return { get: (name) => byName.get(name) };
};

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

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

it('takes a selection out as a group and puts it back as the same ink', async () => {
  const before = bloom();
  // The growth rule: two wires in (the ring and the dish), one out.
  const made = collapse(before, ['n5'], 'grow', CATALOGUE);
  expect(made.node).toMatchObject({ kind: 'group', word: 'grow' });
  expect(Object.keys(made.node.inputs).sort()).toEqual(['dish', 'ring']);
  expect(Object.keys(made.node.outputs!)).toEqual(['grown']);
  expect(made.graph.nodes.some((n) => n.id === 'n5')).toBe(false);
  expect(made.graph.nodes.some((n) => n.id === made.node.id)).toBe(true);
  // Every wire that entered or left the selection now points at the group.
  const grow = made.graph.nodes.find((n) => n.id === made.node.id)!;
  expect(made.graph.nodes.find((n) => n.id === 'n6')?.inputs.grown?.from).toEqual([grow.id, 'grown']);
  expect(before.nodes.some((n) => n.id === 'n5')).toBe(true);

  const back = expand(made.graph, library([made.group]));
  expect(back.nodes.some((n) => n.kind === 'group' || n.kind === 'input')).toBe(false);
  expect(topoOrder(back)).toHaveLength(back.nodes.length);

  const [was, now] = await Promise.all([inkOf(compileGraph(bloom(), CATALOGUE).source), inkOf(compileGraph(back, CATALOGUE).source)]);
  expect(now.stats.fragments).toBeGreaterThan(0);
  expect(now.frags).toEqual(was.frags);
}, 120_000);

it('gives the group node the boundary the group declares', () => {
  const made = collapse(bloom(), ['n1', 'n2'], 'sample', CATALOGUE);
  const library1 = library([made.group]);
  const group = library1.get('sample')!;
  expect(Object.keys(groupInputs(group))).toEqual([]);
  // Two values leave the selection: the ring's material and, for the viewer
  // that reads it directly, the circle's own shape.
  expect(Object.keys(groupOutputs(group, CATALOGUE)).sort()).toEqual(['n1', 'n2']);
  expect(made.node.outputs).toEqual({ n2: 'material', n1: 'shape' });
});

it('makes a group that is a document the page can open', () => {
  // A group is edited as a graph of its own, so `parseGraph` has to accept
  // it: `in` and `out` are reserved words, and a node cannot be called one.
  const made = collapse(bloom(), ['n5'], 'grow', CATALOGUE);
  const again = parseGraph(JSON.parse(graphToJson(made.group.graph)));
  expect(again.nodes.some((node) => node.kind === 'input')).toBe(true);
  expect(again.nodes.some((node) => node.kind === 'output')).toBe(true);
  // And the outer graph it left behind is a document too.
  expect(() => parseGraph(JSON.parse(graphToJson(made.graph)))).not.toThrow();
});

it('refuses a name a sketch could not bind', () => {
  const graph = bloom();
  // The name becomes part of every inlined node's id: "ring bits_n2" is not
  // a program, and the compiler's message would say so about the wrong thing.
  expect(() => collapse(graph, ['n5'], 'ring bits', CATALOGUE)).toThrow(/is not a name a group can have/);
  expect(() => collapse(graph, ['n5'], '2rings', CATALOGUE)).toThrow(/is not a name a group can have/);
  expect(() => collapse(graph, ['n5'], 'return', CATALOGUE)).toThrow(/is not a name a group can have/);
  expect(collapse(graph, ['n5'], 'ring_bits', CATALOGUE).group.name).toBe('ring_bits');
});

it('refuses a group that contains itself', () => {
  const made = collapse(bloom(), ['n5'], 'grow', CATALOGUE);
  // The group's own graph holds a group node of the same name: the cycle the
  // library must refuse rather than expand forever.
  const selfGroup: Group = {
    ...made.group,
    graph: {
      ...made.group.graph,
      nodes: [...made.group.graph.nodes, { id: 'again', kind: 'group', word: 'grow', x: 0, y: 0, inputs: {}, outputs: { grown: 'material' } }],
    },
  };
  const host: Graph = { ...made.graph, nodes: [...made.graph.nodes, { id: 'again', kind: 'group', word: 'grow', x: 0, y: 0, inputs: {}, outputs: { grown: 'material' } }] };
  expect(() => expand(host, library([selfGroup]))).toThrow(/contains itself/);
});

it('refuses to compile a group node, or a group input, on its own', () => {
  const made = collapse(bloom(), ['n5'], 'grow', CATALOGUE);
  expect(() => compileGraph(made.graph, CATALOGUE)).toThrow(/is a group; expand it before compiling/);
  expect(() => compileGraph(made.group.graph, CATALOGUE)).toThrow(/expand it before compiling|is a group input/);
});
