/**
 * Sketch to graph: every live docs example opens as a graph, and the graph
 * compiles back to a sketch.
 *
 * `DOC_PAGES` is the list the site and the docs checker share, so "every
 * example opens" is read from the pages themselves, never hand-listed. A
 * fence that cannot be read is named with its page and its error; the
 * assertion stays over all of them.
 *
 * Three properties, over every live fence: the import does not throw, the
 * graph compiles, and the compiled sketch binds every library name it reads —
 * the oracle that catches a body spelling a word the compiler cannot import.
 *
 * For bloom and delta the compiled graph must also render the page's own ink,
 * fragment for fragment — the strongest thing an import can say.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import * as occlude from 'occlude';
import { DEFAULT_PENS, initOcclude, liveExampleToJs, renderAsync, type RenderResult, type SketchDef } from 'occlude';
import { DOC_PAGES } from '../../../occlude/src/docsExamples.js';

import { CATALOGUE } from './catalogue.js';
import { compileGraph } from './compile.js';
import { applyLayout, importSketch, layoutBlock } from './import.js';
import { graphToJson, parseGraph, type Catalogue } from './model.js';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** The fence pattern bloom.test.ts uses: `ts live` and anything after it. */
const FENCE = /```ts live[^\n]*\n([\s\S]*?)```/g;

/** The `ts live` fences of a docs page, in the order the page writes them. */
function fencesOf(file: string): string[] {
  return [...read(`../../../../docs/${file}`).matchAll(FENCE)].map((match) => match[1]!);
}

/** Every name a source declares: a parameter, a local, a class. */
function declaredNames(node: ts.Node, out: Set<string>): void {
  if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
    const add = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) out.add(name.text);
      else for (const element of name.elements) if (ts.isBindingElement(element)) add(element.name);
    };
    add(node.name);
  } else if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node)) && node.name) {
    out.add(node.name.text);
  }
  ts.forEachChild(node, (child) => declaredNames(child, out));
}

/** Whether an identifier is read where it stands, rather than being the name
 * of a property, a binding key, a label or an import. */
function isRead(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isQualifiedName(parent) && parent.right === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isEnumMember(parent)) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isLabeledStatement(parent) && parent.label === id) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === id) return false;
  return true;
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile('sketch.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
}

/** The local name each import binds, and the module it came from. */
function importsOf(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of parse(source).statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const spec of named.elements) out.set(spec.name.text, st.moduleSpecifier.text);
  }
  return out;
}

/** The modules the catalogue binds each local name in, and every name the
 * page itself imports. A name only the page imports is one the compiled
 * sketch cannot get from the library at all, so a body that still reads it is
 * a body the normalisation missed. */
function library(catalogue: Catalogue, page: string): { modules: Map<string, string[]>; names: Set<string> } {
  const modules = new Map<string, string[]>();
  const names = new Set<string>();
  for (const entry of catalogue.importable) {
    for (const { name, spec } of entry.names) {
      names.add(name);
      names.add(spec.split(' as ')[0]!);
      modules.set(name, [...(modules.get(name) ?? []), entry.module]);
    }
  }
  for (const [local] of importsOf(page)) names.add(local);
  return { modules, names };
}

/**
 * The names a compiled sketch reads and cannot resolve: it neither declares
 * nor imports them, and they are library words — a catalogue name, or a name
 * the page itself imported — so nothing but an import could supply them. A
 * catalogue name bound in one module must come from that module: `circle3` is
 * the 3D circle, not the 2D one. A global (`Math`) is neither, and needs no
 * binding. This is the oracle that caught a body whose alias the compiler
 * could not import, and a spread call whose name the import scan did not see.
 */
function unboundNames(compiled: string, page: string, catalogue: Catalogue): string[] {
  const file = parse(compiled);
  const imported = importsOf(compiled);
  const declared = new Set<string>();
  declaredNames(file, declared);
  const { modules, names } = library(catalogue, page);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (isRead(node) && names.has(name) && !declared.has(name)) {
        const module = imported.get(name);
        const wanted = modules.get(name);
        if (module === undefined) out.push(name);
        else if (wanted && !wanted.includes(module)) out.push(`${name} from ${module}, not ${wanted.join(' or ')}`);
      }
      return;
    }
    if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(out)];
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
      // A step rule is a zone: a body that runs many times, carrying state.
      // `dots` is a word of the library now, so a local of that name is
      // given one of its own rather than shadowing it.
      ['ring', 'builtin'], ['dots2', 'builtin'], ['grown', 'zone'], ['output', 'output'],
    ]);
    expect(graph.nodes[0]!.word).toBe('circle');
    expect(graph.nodes[0]!.inputs).toEqual({ x: { value: 50 }, y: { value: 50 }, r: { value: 18 } });
    expect(graph.nodes[1]!.inputs).toEqual({ shape: { from: ['ring', 'out'] }, count: { value: 48 } });
    expect(graph.nodes[2]!.zone).toBe('steps');
    expect(graph.nodes[2]!.inputs).toEqual({ material: { from: ['dots2', 'out'] }, count: { value: 4 } });
    expect(graph.nodes[2]!.binds).toEqual(['cur', 'next']);
    expect(graph.nodes[3]!.inputs).toEqual({ in: { from: ['grown', 'out'] } });
    // A column per topological depth. The places themselves are the
    // layout's (`layout.test.ts` owns what they must satisfy); what the
    // import owes is that a chain reads left to right.
    const xs = graph.nodes.map((n) => n.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(4);
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
    // `Geometry` is the honest type for a value the importer cannot name:
    // `path()` is not a catalogue word, so the graph knows only that it is
    // geometry of some kind.
    expect(ink.inputs).toEqual({ ridge: { type: 'Geometry', from: ['ridge', 'out'] } });
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
      ['all', 'builtin'], ['stmt', 'code'], ['strokes2', 'builtin'], ['output', 'output'],
    ]);
    const statement = graph.nodes[1]!;
    expect(statement.body).toBe('all = append(all, material([[20, 20], [30, 30]]));\nreturn { all: all };');
    expect(statement.outputs).toEqual({ all: 'material' });
    expect(statement.inputs).toEqual({ all: { type: 'material', from: ['all', 'out'] } });
    // The return is the word it calls, and it reads the loop's `all` rather
    // than the node it started from.
    expect(graph.nodes[2]!.word).toBe('strokes');
    expect(graph.nodes[2]!.inputs).toEqual({ source: { from: ['stmt', 'all'] } });
  });

  it('compiles to a sketch that binds every name it reads', () => {
    const failures: string[] = [];
    for (const page of DOC_PAGES.filter((p) => p.live)) {
      fencesOf(page.file).forEach((source, i) => {
        const compiled = compileGraph(importSketch(source, CATALOGUE), CATALOGUE).source;
        for (const name of unboundNames(compiled, source, CATALOGUE)) failures.push(`${page.slug}#${i}: ${name}`);
      });
    }
    expect(failures).toEqual([]);
  });

  it('spells a body’s imported names the way the catalogue does', () => {
    const page = `import { sketch, circle as disc } from 'occlude';
import { circle } from 'occlude/3d';

export default sketch({}, (t) => {
  const flat = t.scatter({ spacing: 4, within: disc(50, 50, 20) });
  const solid = circle(1.2, { segments: 64 });
  return [flat, solid];
});
`;
    const graph = importSketch(page, CATALOGUE);
    // The page's `disc` is the 2D circle; its `circle` is the 3D one.
    expect(graph.nodes.map((n) => n.id)).toEqual(['flat', 'solid', 'ink', 'output']);
    expect(graph.nodes[0]!.body).toBe('return { out: t.scatter({ spacing: 4, within: circle(50, 50, 20) }) };');
    expect(graph.nodes[1]!.body).toBe('return { out: circle3(1.2, { segments: 64 }) };');
    const compiled = compileGraph(graph, CATALOGUE).source;
    expect(compiled).toContain("import { sketch, circle } from 'occlude';");
    expect(compiled).toContain("import { circle as circle3 } from 'occlude/3d';");
    expect(unboundNames(compiled, page, CATALOGUE)).toEqual([]);
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

  it('lands the nodes where the sketch says they stood', () => {
    const source = `import { sketch, circle } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 3 }, (t) => {
  const ring = circle(50, 50, 18);
  const dots = t.sample(ring, { count: 48 });
  return dots;
});
`;
    const graph = importSketch(source, CATALOGUE);
    const moved = graph.nodes[0]!;
    moved.x = 1234;
    moved.y = 567;
    moved.width = 260;
    moved.collapsed = true;
    const again = importSketch(`${source}\n${layoutBlock(graph)}`, CATALOGUE);
    const back = again.nodes.find((node) => node.id === moved.id);
    expect(back).toMatchObject({ x: 1234, y: 567, width: 260, collapsed: true });
    // Every other node keeps the layout's own answer, and no two nodes stack.
    expect(new Set(again.nodes.map((node) => `${node.x},${node.y}`)).size).toBe(again.nodes.length);
  });

  it('leaves a sketch with no block where the layout put it', () => {
    const source = `import { sketch, circle } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 3 }, (t) => {
  const ring = circle(50, 50, 18);
  return ring;
});
`;
    const graph = importSketch(source, CATALOGUE);
    expect(applyLayout(graph, source)).toBe(false);
    expect(applyLayout(graph, `${source}\n/* occlude-graph layout v1\nnot json\n*/\n`)).toBe(false);
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
