import { describe, expect, it } from 'vitest';

import { compileFor, compileGraph, literal, type CompiledSketch } from './compile.js';
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
    { module: 'occlude', names: [
      { name: 'circle', spec: 'circle' },
      { name: 'strokes', spec: 'strokes' },
      { name: 'polygon', spec: 'polygon' },
      { name: 'force', spec: 'force' },
      { name: 'mul', spec: 'mul' },
    ] },
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

  it('writes a raw value as the source it carries, and imports what it reaches for', () => {
    const graph = parseGraph({
      version: 1, name: 'raw', config: { aspect: [1, 1], seed: 8, pens: { ink: { __raw: 'pen({ width: mm(0.3) })' } } },
      nodes: [
        { id: 'n1', kind: 'builtin', word: 'circle', inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: 4 } } },
        { id: 'n2', kind: 'builtin', word: 'strokes', inputs: { source: { from: ['n1', 'out'] }, pen: { value: { __raw: "'pigma-005-black'" } } } },
        { id: 'n5', kind: 'output', inputs: { in: { from: ['n2', 'out'] } } },
      ],
    });
    const { source } = compileGraph(graph, CATALOGUE);
    expect(source).toContain(`sketch({ aspect: [1, 1], seed: 8, pens: { ink: pen({ width: mm(0.3) }) } }, (t) => {`);
    expect(source).toContain(`{ pen: 'pigma-005-black' }`);
    expect(source).toContain('import { sketch, circle, strokes } from');
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

  it('does not read a name inside a string or a comment as a use', () => {
    const graph = doc([
      { id: 'n2', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 1 }, y: { value: 1 }, r: { value: 1 } } },
      {
        // The id is the word `cross`, which a pen name in the body would
        // otherwise turn into an import — and then into a refusal.
        id: 'cross', kind: 'code', x: 0, y: 0,
        inputs: { shape: { type: 'shape', from: ['n2', 'out'] } },
        outputs: { out: 'drawing' },
        body: "// polygons cross here\nreturn { out: strokes(shape, { pen: 'cross' }) };",
      },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['cross', 'out'] } } },
    ]);
    const { source } = compileGraph(graph, CATALOGUE);
    expect(source).toContain('const cross = ((shape) => {');
    expect(source).toContain(`{ pen: 'cross' }`);
    expect(source).toContain("import { sketch, circle, strokes } from 'occlude';");
  });

  it('imports from the module the catalogue names, not only from occlude', () => {
    const withPens: Catalogue = {
      ...CATALOGUE,
      importable: [
        ...CATALOGUE.importable,
        { module: '@user/pens', names: [{ name: 'azure', spec: 'azure' }, { name: 'ink', spec: 'ink' }] },
      ],
    };
    const graph = doc([
      { id: 'n2', kind: 'code', x: 0, y: 0, inputs: {}, outputs: { out: 'drawing' }, body: "return { out: strokes(m, { pen: azure }) };" },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n2', 'out'] } } },
    ]);
    const { source } = compileGraph(graph, withPens);
    expect(source).toContain("import { azure } from '@user/pens';");
    expect(source).toContain("import { sketch, strokes } from 'occlude';");
  });

  it('imports a name a spread call reaches for', () => {
    const graph = doc([
      { id: 'n1', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: 4 } } },
      {
        id: 'n2', kind: 'code', x: 0, y: 0,
        inputs: { shape: { type: 'shape', from: ['n1', 'out'] } },
        outputs: { out: 'shape' },
        body: 'return { out: polygon([...mul(shape, 2)]) };',
      },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n2', 'out'] } } },
    ]);
    const { source } = compileGraph(graph, CATALOGUE);
    // `mul` is read after a spread, and the lookbehind must not take the dots
    // for a property access.
    const imports = /^import \{[^}]*\} from 'occlude';$/m.exec(source)?.[0] ?? '';
    expect(imports).toContain('mul');
    expect(imports).toContain('polygon');
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

  it('wraps a viewer’s own picture in the word it names', () => {
    const compiled = compileFor(doc(NODES), CATALOGUE, 'n4', 'in', {
      wrap: (expression) => `strokes(${expression})`,
      prelude: (expression) => [`t.probe('frames', ${expression}.history.length);`],
    });
    expect(compiled.source).toContain("import { sketch, circle, strokes } from 'occlude';");
    expect(compiled.source).toContain(`  t.probe('frames', n3.grown.history.length);`);
    expect(compiled.source).toContain('  return strokes(n3.grown);');
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
  it('escapes a string that holds a line terminator, and keeps a comment body off the close', () => {
    const graph = doc([
      { id: 'n1', kind: 'builtin', word: 'strokes', x: 0, y: 0, inputs: { source: { from: ['n2', 'out'] }, pen: { value: 'a\nb\rc\u2028d' } } },
      { id: 'n2', kind: 'code', x: 0, y: 0, inputs: {}, outputs: { out: 'shape' }, body: 'return { out: circle(1, 1, 1) }; // one ring' },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n1', 'out'] } } },
    ]);
    const { source } = compileGraph(graph, CATALOGUE);
    expect(source).toContain(`{ pen: 'a\\nb\\rc\\u2028d' }`);
    // The body's comment must not comment out the call's closing tokens.
    expect(source).toContain(`const n2 = (() => {\n    return { out: circle(1, 1, 1) }; // one ring\n  })();`);
    // And the whole thing is a program: the fragment parses.
    expect(() => new Function('return ' + source.replace(/^import .*$/m, '').replace('export default', ''))).not.toThrow();
  });

  it('refuses a wire into a control, and an input the word does not have', () => {
    const control = doc([
      { id: 'n1', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: 4 } } },
      { id: 'n2', kind: 'builtin', word: 't.sample', x: 0, y: 0, inputs: { shape: { from: ['n1', 'out'] } } },
      { id: 'n3', kind: 'builtin', word: 'strokes', x: 0, y: 0, inputs: { source: { from: ['n2', 'out'] }, pen: { from: ['n1', 'out'] } } },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n3', 'out'] } } },
    ]);
    expect(() => compileGraph(control, CATALOGUE)).toThrow('graph: n3.pen is a control; nothing wires into it');

    const typo = doc([
      { id: 'n1', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: 4 }, raduis: { value: 2 } } },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n1', 'out'] } } },
    ]);
    expect(() => compileGraph(typo, CATALOGUE)).toThrow('graph: node n1 has no input raduis for circle');
  });

  it('refuses a node id the compiled sketch already uses', () => {
    const graph = doc([
      { id: 'circle', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: 4 } } },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['circle', 'out'] } } },
    ]);
    expect(() => compileGraph(graph, CATALOGUE)).toThrow('graph: node id circle is a name the compiled sketch already uses');
  });

  it('refuses a required option nobody set, rather than emitting a call that throws', () => {
    const required: Catalogue = {
      words: [{
        word: 't.scatter', module: 'occlude', receiver: 't', import: null, call: 't.scatter', returns: 'drawing',
        page: '/docs/reference/points', group: 'Points',
        params: [{ name: 'opts', optional: false, options: [{ name: 'spacing', takes: { socket: 'Number' }, optional: false }] }],
      }],
      importable: [],
    };
    const graph = doc([
      { id: 'n1', kind: 'builtin', word: 't.scatter', x: 0, y: 0, inputs: {} },
      { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n1', 'out'] } } },
    ]);
    expect(() => compileGraph(graph, required)).toThrow('graph: node n1 has no input spacing for t.scatter');
  });

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

describe('a change reaches only what depends on it', () => {
  /** Two branches: circle → sample → code, and a circle of its own. */
  const branch = (r: number) => doc([
    { id: 'n1', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 10 }, y: { value: 10 }, r: { value: r } } },
    { id: 'n2', kind: 'builtin', word: 't.sample', x: 0, y: 0, inputs: { shape: { from: ['n1', 'out'] }, count: { value: 12 } } },
    { id: 'n3', kind: 'code', x: 0, y: 0, inputs: { ring: { type: 'material', from: ['n2', 'out'] } }, outputs: { grown: 'drawing' }, body: 'return { grown: strokes(ring) };' },
    { id: 'n6', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 90 }, y: { value: 90 }, r: { value: 5 } } },
    { id: 'v1', kind: 'viewer', x: 0, y: 0, inputs: { in: { from: ['n2', 'out'] } } },
    { id: 'v2', kind: 'viewer', x: 0, y: 0, inputs: { in: { from: ['n6', 'out'] } } },
    { id: 'n5', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['n3', 'grown'] } } },
  ]);

  it('leaves an untouched viewer byte-identical, and moves the ones below', () => {
    const before = branch(4);
    const after = branch(9);
    const v1Before = compileFor(before, CATALOGUE, 'v1', 'in');
    const v1After = compileFor(after, CATALOGUE, 'v1', 'in');
    const v2Before = compileFor(before, CATALOGUE, 'v2', 'in');
    const v2After = compileFor(after, CATALOGUE, 'v2', 'in');

    // The viewer that reads the changed branch compiles to new source...
    expect(v1After.source).not.toBe(v1Before.source);
    // ...and the one on the other branch does not: its canvas keeps its picture.
    expect(v2After.source).toBe(v2Before.source);

    const hashes = (c: CompiledSketch): Record<string, string> => Object.fromEntries(c.nodes.map((n) => [n.id, n.hash]));
    const was = hashes(compileGraph(before, CATALOGUE));
    const now = hashes(compileGraph(after, CATALOGUE));
    // The changed node's hash moves, and so does everything below it.
    expect(now.n1).not.toBe(was.n1);
    expect(now.n2).not.toBe(was.n2);
    expect(now.n3).not.toBe(was.n3);
    // The branch nothing changed on keeps its hash.
    expect(now.n6).toBe(was.n6);
    expect(hashes(v2After).n6).toBe(hashes(v2Before).n6);
  });
});

describe('the nodes that are not words', () => {
  const graph = (nodes: unknown[]): ReturnType<typeof parseGraph> =>
    parseGraph({ version: 1, name: 'v', config: { seed: 1 }, nodes });

  it('writes a value node as the const a sketch would write', () => {
    const compiled = compileGraph(graph([
      { id: 'size', kind: 'value', x: 0, y: 0, inputs: { v: { value: 30 } }, outputs: { out: 'Number' } },
      { id: 'mid', kind: 'value', x: 0, y: 0, inputs: { v: { value: 50 } }, outputs: { out: 'Number' } },
      { id: 'ring', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { from: ['mid', 'out'] }, y: { from: ['mid', 'out'] }, r: { from: ['size', 'out'] } } },
      { id: 'out', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['ring', 'out'] } } },
    ]), CATALOGUE);
    expect(compiled.source).toContain('const size = 30;');
    expect(compiled.source).toContain('const mid = 50;');
    expect(compiled.source).toContain('const ring = circle(mid, mid, size);');
    expect(compiled.source).toContain('return ring;');
  });

  it('writes a list node as the array a sketch would write, spread and all', () => {
    const compiled = compileGraph(graph([
      { id: 'a', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 1 }, y: { value: 2 }, r: { value: 3 } } },
      { id: 'b', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 4 }, y: { value: 5 }, r: { value: 6 } } },
      { id: 'both', kind: 'list', x: 0, y: 0, inputs: { 0: { from: ['a', 'out'] }, 1: { from: ['b', 'out'], spread: true } } },
      { id: 'out', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['both', 'out'] } } },
    ]), CATALOGUE);
    expect(compiled.source).toContain('const both = [a, ...b];');
  });

  it('leaves a place nothing reaches out of the array', () => {
    const compiled = compileGraph(graph([
      { id: 'a', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 1 }, y: { value: 2 }, r: { value: 3 } } },
      { id: 'some', kind: 'list', x: 0, y: 0, inputs: { 0: { from: ['a', 'out'] } } },
      { id: 'out', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['some', 'out'] } } },
    ]), CATALOGUE);
    expect(compiled.source).toContain('const some = [a];');
  });

  it('keeps a list in the order of its places, whatever order they were wired in', () => {
    const compiled = compileGraph(graph([
      { id: 'a', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 1 }, y: { value: 1 }, r: { value: 1 } } },
      { id: 'b', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 2 }, y: { value: 2 }, r: { value: 2 } } },
      // The document lists place 2 before place 0.
      { id: 'both', kind: 'list', x: 0, y: 0, inputs: { 2: { from: ['b', 'out'] }, 0: { from: ['a', 'out'] } } },
      { id: 'out', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['both', 'out'] } } },
    ]), CATALOGUE);
    expect(compiled.source).toContain('const both = [a, b];');
  });
});

describe('a zone', () => {
  it('writes the callback the sketch would have written', () => {
    const graph = parseGraph({
      version: 1, name: 'z', config: { seed: 1 },
      nodes: [
        { id: 'many', kind: 'value', x: 0, y: 0, inputs: { v: { value: 12 } }, outputs: { out: 'Number' } },
        {
          id: 'rows', kind: 'zone', zone: 'times', x: 0, y: 0,
          inputs: { count: { from: ['many', 'out'] } },
          outputs: { out: 'drawing' },
          graph: {
            version: 1, name: '', config: {},
            nodes: [
              { id: 'each', kind: 'input', x: 0, y: 0, inputs: {}, outputs: { i: 'Number', u: 'Number', count: 'Number' } },
              { id: 'ring', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { from: ['each', 'i'] }, y: { from: ['each', 'u'] }, r: { from: ['each', 'count'] } } },
              { id: 'done', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['ring', 'out'] } } },
            ],
          },
        },
        { id: 'out', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['rows', 'out'] } } },
      ],
    });
    const compiled = compileGraph(graph, CATALOGUE);
    expect(compiled.source).toContain('const many = 12;');
    // The count is read where the sketch reads it; `i` and `u` are the
    // callback's own, and a boundary name the recipe does not bind is the
    // outer value the zone takes — the callback closes over it.
    expect(compiled.source).toContain('const rows = t.times(many, (i, u) => {');
    expect(compiled.source).toContain('const ring = circle(i, u, many);');
    expect(compiled.source).toContain('return ring;');
    expect(compiled.source).toContain('return rows;');
  });

  it('refuses a zone whose body has no result', () => {
    expect(() => parseGraph({
      version: 1, name: 'z', config: {},
      nodes: [{
        id: 'rows', kind: 'zone', zone: 'times', x: 0, y: 0, inputs: {},
        graph: { version: 1, name: '', config: {}, nodes: [{ id: 'each', kind: 'input', x: 0, y: 0, inputs: {}, outputs: { i: 'Number' } }] },
      }],
    })).toThrow(/has no result/);
  });

  it('refuses a zone that names no recipe', () => {
    expect(() => parseGraph({
      version: 1, name: 'z', config: {},
      nodes: [{ id: 'rows', kind: 'zone', zone: 'forever', x: 0, y: 0, inputs: {}, graph: { version: 1, name: '', config: {}, nodes: [] } }],
    })).toThrow(/unknown zone/);
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
