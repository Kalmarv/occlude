/**
 * Sketch to graph: every live docs example opens as a graph, and the graph
 * compiles back to a sketch.
 *
 * `DOC_PAGES` is the list the site and the docs checker share, so "every
 * example opens" is read from the pages themselves, never hand-listed. A
 * fence that cannot be read is named with its page and its error; the
 * assertion stays over all of them.
 *
 * For bloom and delta the compiled graph must also render the page's own
 * ink, fragment for fragment — the strongest thing an import can say.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import * as occlude from 'occlude';
import { DEFAULT_PENS, initOcclude, liveExampleToJs, renderAsync, type RenderResult, type SketchDef } from 'occlude';
import { DOC_PAGES } from '../../../occlude/src/docsExamples.js';

import { CATALOGUE } from './catalogue.js';
import { compileGraph } from './compile.js';
import { importSketch } from './import.js';
import { graphToJson, parseGraph } from './model.js';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** The fence pattern bloom.test.ts uses: `ts live` and anything after it. */
const FENCE = /```ts live[^\n]*\n([\s\S]*?)```/g;

/** The `ts live` fences of a docs page, in the order the page writes them. */
function fencesOf(file: string): string[] {
  return [...read(`../../../../docs/${file}`).matchAll(FENCE)].map((match) => match[1]!);
}

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

describe('sketch to graph', () => {
  it('reads every live docs example as a graph that compiles', () => {
    const failures: string[] = [];
    let fences = 0;
    for (const page of DOC_PAGES.filter((p) => p.live)) {
      const sources = fencesOf(page.file);
      expect(sources.length, `${page.file} has a live fence`).toBeGreaterThan(0);
      sources.forEach((source, i) => {
        fences++;
        try {
          const graph = importSketch(source, CATALOGUE);
          compileGraph(graph, CATALOGUE);
          // The canvas saves and loads a graph as JSON.
          parseGraph(JSON.parse(graphToJson(graph)));
        } catch (error) {
          failures.push(`${page.slug}#${i}: ${(error as Error).message}`);
        }
      });
    }
    // A broken fence regex would make every page pass by finding nothing.
    expect(fences).toBeGreaterThan(400);
    expect(failures).toEqual([]);
  });

  it('reads the words the sketch calls, with the sketch’s own names', () => {
    const graph = importSketch(
      `import { sketch, circle } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 3 }, (t) => {
  const ring = circle(50, 50, 18);
  const dots = t.sample(ring, { count: 48 });
  const grown = dots.steps(4, (cur, next) => next);
  return grown;
});
`,
      CATALOGUE,
    );
    expect(graph.version).toBe(1);
    expect(graph.name).toBe('');
    expect(graph.config).toEqual({ aspect: [1, 1], seed: 3 });
    expect(graph.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['ring', 'builtin'], ['dots', 'builtin'], ['grown', 'code'], ['output', 'output'],
    ]);
    expect(graph.nodes[0]!.word).toBe('circle');
    expect(graph.nodes[0]!.inputs).toEqual({ x: { value: 50 }, y: { value: 50 }, r: { value: 18 } });
    expect(graph.nodes[1]!.inputs).toEqual({ shape: { from: ['ring', 'out'] }, count: { value: 48 } });
    expect(graph.nodes[2]!.inputs).toEqual({ dots: { type: 'material', from: ['dots', 'out'] } });
    expect(graph.nodes[2]!.body).toBe('return { out: dots.steps(4, (cur, next) => next) };');
    expect(graph.nodes[3]!.inputs).toEqual({ in: { from: ['grown', 'out'] } });
    // A column per topological depth, a row per node in it.
    expect(graph.nodes.map((n) => [n.x, n.y])).toEqual([[40, 60], [300, 60], [560, 60], [820, 60]]);
  });

  it('keeps a call in the config as its own text, and reads the rest', () => {
    const graph = importSketch(
      `import { sketch, circle, mm, pen } from 'occlude';

export default sketch({ seed: 4, pens: { ink: pen({ width: mm(0.3) }) }, margin: 6 }, (t) => {
  const disc = circle(50, 50, 20, { pen: 'stabilo-88-blue' });
  return disc;
});
`,
      CATALOGUE,
    );
    expect(graph.config).toEqual({ seed: 4, pens: { ink: { __raw: 'pen({ width: mm(0.3) })' } }, margin: 6 });
    expect(graph.nodes[0]!.inputs).toEqual({ x: { value: 50 }, y: { value: 50 }, r: { value: 20 }, pen: { value: 'stabilo-88-blue' } });
  });

  it('keeps a statement nothing reads in the next node’s body', () => {
    const graph = importSketch(
      `import { sketch, path, strokes } from 'occlude';

export default sketch({}, (t) => {
  const ridge = path().moveTo(0, 100);
  for (let x = 0; x <= 200; x += 5) ridge.lineTo(x, 100 - x / 4);
  ridge.lineTo(200, 100).close();
  return strokes(ridge.build());
});
`,
      CATALOGUE,
    );
    expect(graph.nodes.map((n) => [n.id, n.kind])).toEqual([['ridge', 'code'], ['ink', 'code'], ['output', 'output']]);
    const ink = graph.nodes[1]!;
    expect(ink.body).toBe('for (let x = 0; x <= 200; x += 5) ridge.lineTo(x, 100 - x / 4);\nridge.lineTo(200, 100).close();\nreturn { out: strokes(ridge.build()) };');
    expect(ink.inputs).toEqual({ ridge: { type: 'drawing', from: ['ridge', 'out'] } });
  });

  it('gives a name a new value through a node of its own', () => {
    const graph = importSketch(
      `import { sketch, append, strokes, material } from 'occlude';

export default sketch({}, (t) => {
  let all = material([[0, 0], [10, 10]]);
  all = append(all, material([[20, 20], [30, 30]]));
  return strokes(all);
});
`,
      CATALOGUE,
    );
    expect(graph.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['all', 'builtin'], ['stmt', 'code'], ['ink', 'code'], ['output', 'output'],
    ]);
    const statement = graph.nodes[1]!;
    expect(statement.body).toBe('all = append(all, material([[20, 20], [30, 30]]));\nreturn { all: all };');
    expect(statement.outputs).toEqual({ all: 'material' });
    expect(statement.inputs).toEqual({ all: { type: 'material', from: ['all', 'out'] } });
    // The return reads the loop's `all`, not the node it started from.
    expect(graph.nodes[2]!.inputs).toEqual({ all: { type: 'material', from: ['stmt', 'all'] } });
  });

  it('names what it cannot read', () => {
    expect(() => importSketch(`import { sketch } from 'occlude';\nexport default 1;\n`, CATALOGUE))
      .toThrow('cannot read a number at line 2');
    expect(() => importSketch(`import { sketch } from 'occlude';\nfor (let i = 0; i < 2; i++) {}\nexport default sketch({}, (t) => 1);\n`, CATALOGUE))
      .toThrow('cannot read a loop at line 2');
    expect(() => importSketch(`export default sketch({}, (t) => { const a = 1; });\n`, CATALOGUE))
      .toThrow('returns nothing');
    expect(() => importSketch(`const a = 1;\n`, CATALOGUE))
      .toThrow('no default export');
  });

  it('renders the ink of the hand-written bloom', async () => {
    const page = fencesOf('examples/bloom.mdx')[0]!;
    const compiled = compileGraph(importSketch(page, CATALOGUE), CATALOGUE);
    const [hand, fromGraph] = await Promise.all([inkOf(page), inkOf(compiled.source)]);
    expect(fromGraph.stats.fragments).toBeGreaterThan(0);
    expect(fromGraph.frags.length).toBe(hand.frags.length);
    expect(fromGraph.frags).toEqual(hand.frags);
  }, 120_000);

  it('renders the ink of the hand-written delta', async () => {
    const page = fencesOf('examples/delta.mdx')[0]!;
    const compiled = compileGraph(importSketch(page, CATALOGUE), CATALOGUE);
    const [hand, fromGraph] = await Promise.all([inkOf(page), inkOf(compiled.source)]);
    expect(fromGraph.stats.fragments).toBeGreaterThan(0);
    expect(fromGraph.frags.length).toBe(hand.frags.length);
    expect(fromGraph.frags).toEqual(hand.frags);
  }, 120_000);
});
