import { describe, expect, it } from 'vitest';

import { compileFor, compileGraph, literal } from './compile.js';
import { accepts, parseGraph, wordInputs, type Catalogue } from './model.js';

/** The words these tests need, shaped exactly as the generator emits them. */
const CATALOGUE: Catalogue = {
  words: [
    {
      word: 'circle', module: 'occlude', receiver: null, import: 'circle', call: 'circle',
      returns: 'shape', page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'x', takes: { socket: 'Number' }, optional: false },
        { name: 'y', takes: { socket: 'Number' }, optional: false },
        { name: 'r', takes: { socket: 'Number' }, optional: false },
      ],
    },
    {
      word: 't.sample', module: 'occlude', receiver: 't', import: null, call: 't.sample',
      returns: 'material', page: '/docs/reference/material', group: 'Material',
      params: [
        { name: 'shape', takes: { socket: 'Geometry', kinds: ['shape'] }, optional: false },
        {
          name: 'options', optional: true,
          options: [
            { name: 'count', takes: { socket: 'Number' }, optional: true },
            { name: 'spacing', takes: { socket: 'Number' }, optional: true },
          ],
        },
      ],
    },
    {
      word: 't.material', module: 'occlude', receiver: 't', import: null, call: 't.material',
      returns: 'material', page: '/docs/reference/material', group: 'Material',
      params: [{ name: 'shape', takes: { socket: 'Geometry', kinds: ['shape'] }, optional: false }],
    },
    {
      word: 'strokes', module: 'occlude', receiver: null, import: 'strokes', call: 'strokes',
      returns: 'drawing', page: '/docs/reference/shapes', group: 'Shapes',
      params: [
        { name: 'source', takes: { socket: 'Geometry', kinds: ['shape', 'material', 'points'] }, optional: false },
        {
          name: 'opts', optional: true,
          options: [{ name: 'pen', control: 'text', optional: true }],
        },
      ],
    },
  ],
  importable: [
    { module: 'occlude', names: ['circle', 'strokes', 'polygon', 'force', 'mul'] },
  ],
};

const doc = (nodes: unknown[], config: Record<string, unknown> = { aspect: [1, 1], seed: 8 }) => parseGraph({
  version: 1, name: 'fixture', config, nodes,
});

const NODES = [
  { id: 'n1', kind: 'builtin', word: 'circle', x: 40, y: 80, inputs: { x: { value: 50 }, y: { value: 50 }, r: { value: 18 } } },
  { id: 'n2', kind: 'builtin', word: 't.sample', x: 300, y: 80, inputs: { shape: { from: ['n1', 'out'] }, count: { value: 48 } } },
  {
    // The brief's schematic declares `grown: 'Material'`. The output socket
    // takes what a sketch may return, and a Material is not ink — a graph
    // that ends in one wraps it in `strokes()`. The compiled source is the
    // brief's either way.
    id: 'n3', kind: 'code', x: 560, y: 80,
    inputs: { ring: { type: 'material', from: ['n2', 'out'] } },
    outputs: { grown: 'drawing' },
    body: 'return { grown: ring.steps(240, (cur, next) => { /* ... */ }) };',
  },
  { id: 'n4', kind: 'viewer', x: 560, y: 300, inputs: { in: { from: ['n3', 'grown'] } } },
  { id: 'n5', kind: 'output', x: 820, y: 80, inputs: { in: { from: ['n3', 'grown'] } } },
];

describe('the socket table', () => {
  it('takes a Number where a Field is wanted, a shape where the output wants a drawing, and refuses the rest', () => {
    expect(accepts('Number', { socket: 'Field' })).toBe(true);
    expect(accepts('shape', { socket: 'Geometry', kinds: ['shape', 'drawing'] })).toBe(true);
    expect(accepts('material', { socket: 'Geometry', kinds: ['shape', 'drawing'] })).toBe(false);
    expect(accepts('Field', { socket: 'Number' })).toBe(false);
    expect(accepts('shape', { socket: 'Number' })).toBe(false);
  });

  it('keeps a geometry wire honest about its kinds', () => {
    expect(accepts('shape', { socket: 'Geometry', kinds: ['shape', 'mesh'] })).toBe(true);
    expect(accepts('material', { socket: 'Geometry', kinds: ['shape'] })).toBe(false);
    expect(accepts('material', { socket: 'Geometry' })).toBe(true);
  });
});

describe('the compiled sketch', () => {
  it('writes the brief’s graph as the brief’s source', () => {
    expect(compileGraph(doc(NODES), CATALOGUE).source).toBe(
      `import { sketch, circle } from 'occlude';\n` +
      `\n` +
      `export default sketch({ aspect: [1, 1], seed: 8 }, (t) => {\n` +
      `  const n1 = circle(50, 50, 18);\n` +
      `  const n2 = t.sample(n1, { count: 48 });\n` +
      `  const n3 = ((ring) => { return { grown: ring.steps(240, (cur, next) => { /* ... */ }) }; })(n2);\n` +
      `  return n3.grown;\n` +
      `});\n`,
    );
  });

  it('drops an option nobody set, and the trailing argument with it', () => {
    const graph = doc([
      { id: 'n1', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: 4 } } },
      { id: 'n2', kind: 'builtin', word: 't.sample', x: 0, y: 0, inputs: { shape: { from: ['n1', 'out'] } } },
      { id: 'n3', kind: 'builtin', word: 'strokes', x: 0, y: 0, inputs: { source: { from: ['n2', 'out'] } } },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n3', 'out'] } } },
    ]);
    const { source } = compileGraph(graph, CATALOGUE);
    expect(source).toContain('const n2 = t.sample(n1);');
    expect(source).toContain('const n3 = strokes(n2);');
  });

  it('writes a control as a plain literal', () => {
    const graph = doc([
      { id: 'n1', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: 4 } } },
      { id: 'n2', kind: 'builtin', word: 't.sample', x: 0, y: 0, inputs: { shape: { from: ['n1', 'out'] } } },
      { id: 'n3', kind: 'builtin', word: 'strokes', x: 0, y: 0, inputs: { source: { from: ['n2', 'out'] }, pen: { value: 'pigma-005-black' } } },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n3', 'out'] } } },
    ]);
    expect(compileGraph(graph, CATALOGUE).source).toContain(`const n3 = strokes(n2, { pen: 'pigma-005-black' });`);
  });

  it('imports the words a code body reaches for, and not the ones it declares', () => {
    const graph = doc([
      { id: 'n1', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: 4 } } },
      {
        id: 'n2', kind: 'code', x: 0, y: 0,
        inputs: { shape: { type: 'shape', from: ['n1', 'out'] } },
        outputs: { out: 'drawing' },
        body: 'const mul = 2;\nconst push = force.sum();\nreturn { out: strokes(shape, { pen: mul > 0 ? \'a\' : \'b\' }) };',
      },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n2', 'out'] } } },
    ]);
    const { source } = compileGraph(graph, CATALOGUE);
    expect(source).toContain(`import { sketch, circle, force, strokes } from 'occlude';`);
    expect(source).not.toContain('mul,');
  });

  it('keeps a multi-line code body at two-space indent', () => {
    const graph = doc([
      { id: 'n1', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: 4 } } },
      {
        id: 'n2', kind: 'code', x: 0, y: 0,
        inputs: { shape: { type: 'shape', from: ['n1', 'out'] } },
        outputs: { disk: 'material' },
        body: 'const m = t.material(shape);\nreturn { disk: m };',
      },
      { id: 'n3', kind: 'builtin', word: 'strokes', x: 0, y: 0, inputs: { source: { from: ['n2', 'disk'] } } },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n3', 'out'] } } },
    ]);
    expect(compileGraph(graph, CATALOGUE).source).toContain(
      `  const n2 = ((shape) => {\n    const m = t.material(shape);\n    return { disk: m };\n  })(n1);`,
    );
  });

  it('compiles a viewer to the sub-graph it reads, and nothing else', () => {
    const compiled = compileFor(doc(NODES), CATALOGUE, 'n4', 'in');
    expect(compiled.source).toBe(
      `import { sketch, circle } from 'occlude';\n` +
      `\n` +
      `export default sketch({ aspect: [1, 1], seed: 8 }, (t) => {\n` +
      `  const n1 = circle(50, 50, 18);\n` +
      `  const n2 = t.sample(n1, { count: 48 });\n` +
      `  const n3 = ((ring) => { return { grown: ring.steps(240, (cur, next) => { /* ... */ }) }; })(n2);\n` +
      `  return n3.grown;\n` +
      `});\n`,
    );
    expect(compiled.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(compiled.nodes[3]).toMatchObject({ kind: 'viewer', source: '' });
  });
});

describe('a graph it must refuse', () => {
  it('names the nodes of a cycle', () => {
    const graph = doc([
      { id: 'n1', kind: 'builtin', word: 't.material', x: 0, y: 0, inputs: { shape: { from: ['n2', 'out'] } } },
      { id: 'n2', kind: 'code', x: 0, y: 0, inputs: { m: { type: 'material', from: ['n1', 'out'] } }, outputs: { out: 'shape' }, body: 'return { out: m };' },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n1', 'out'] } } },
    ]);
    expect(() => compileGraph(graph, CATALOGUE)).toThrow(/cycle between n1, n2/);
  });

  it('names both sockets of a type mismatch', () => {
    const graph = doc([
      { id: 'n1', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: 4 } } },
      { id: 'n2', kind: 'builtin', word: 't.sample', x: 0, y: 0, inputs: { shape: { from: ['n1', 'out'] }, count: { from: ['n1', 'out'] } } },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n2', 'out'] } } },
    ]);
    expect(() => compileGraph(graph, CATALOGUE)).toThrow('graph: n2.count takes Number; n1.out is shape');
  });

  it('names the kinds when a geometry wire is wrong', () => {
    const graph = doc([
      { id: 'n1', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: 4 } } },
      { id: 'n2', kind: 'builtin', word: 't.sample', x: 0, y: 0, inputs: { shape: { from: ['n1', 'out'] } } },
      { id: 'n3', kind: 'builtin', word: 't.material', x: 0, y: 0, inputs: { shape: { from: ['n2', 'out'] } } },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n1', 'out'] } } },
    ]);
    expect(() => compileGraph(graph, CATALOGUE)).toThrow('graph: n3.shape takes shape; n2.out is material');
  });

  it('refuses an unknown word, a missing required input, a missing output and an unset required control', () => {
    expect(() => compileGraph(doc([
      { id: 'n1', kind: 'builtin', word: 'metaball', x: 0, y: 0, inputs: {} },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n1', 'out'] } } },
    ]), CATALOGUE)).toThrow('graph: node n1 names unknown word metaball');

    expect(() => compileGraph(doc([
      { id: 'n1', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 } } },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n1', 'out'] } } },
    ]), CATALOGUE)).toThrow('graph: node n1 has no input r for circle');

    expect(() => compileGraph(doc([
      { id: 'n1', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: 4 } } },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n1', 'outline'] } } },
    ]), CATALOGUE)).toThrow('graph: n1 has no output outline');
  });

  it('refuses a document that is not a graph', () => {
    expect(() => parseGraph({ version: 2, nodes: [] })).toThrow(/unsupported version 2/);
    expect(() => parseGraph({ version: 1, nodes: [{ id: 'n 1', kind: 'builtin', word: 'circle', inputs: {} }] })).toThrow(/bad node id "n 1"/);
    expect(() => parseGraph({ version: 1, nodes: [{ id: 'n1', kind: 'wat', inputs: {} }] })).toThrow(/unknown kind wat/);
    expect(() => parseGraph({ version: 1, nodes: [
      { id: 'n1', kind: 'builtin', word: 'circle', inputs: {} },
      { id: 'n1', kind: 'builtin', word: 'circle', inputs: {} },
    ] })).toThrow(/duplicate node id n1/);
    expect(() => parseGraph({ version: 1, nodes: [{ id: 'n1', kind: 'builtin', word: 'circle', inputs: { x: { from: ['n9', 'out'] } } }] })).toThrow(/reads missing node n9/);
    expect(() => parseGraph({ version: 1, nodes: [
      { id: 'n1', kind: 'code', inputs: {}, outputs: { out: 'Stuff' }, body: 'return { out: 1 };' },
    ] })).toThrow(/unknown type "Stuff"/);
  });
});

describe('the catalogue', () => {
  it('gives an option input its option name, qualified only on a clash', () => {
    expect(wordInputs(CATALOGUE.words[1]).map((i) => i.name)).toEqual(['shape', 'count', 'spacing']);
    const clash = wordInputs({
      word: 'f', module: 'occlude', receiver: null, import: 'f', call: 'f', returns: 'shape', page: '', group: '',
      params: [
        { name: 'r', takes: { socket: 'Number' }, optional: false },
        { name: 'opts', optional: true, options: [{ name: 'r', takes: { socket: 'Number' }, optional: true }] },
      ],
    });
    expect(clash.map((i) => i.name)).toEqual(['r', 'opts.r']);
  });

  it('writes a value the way a docs example does', () => {
    expect(literal({ aspect: [1, 1], seed: 8, note: "it's" })).toBe(`{ aspect: [1, 1], seed: 8, note: 'it\\'s' }`);
  });
});
