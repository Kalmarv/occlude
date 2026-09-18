/**
 * Lifting a nested call must not change the drawing.
 *
 * The importer hoists an argument that is itself a call of a catalogue word
 * into its own node, so `t.within(t.ridges(height, { step: 2.6 }), coast)`
 * becomes two nodes rather than one code node. That rewrites the compiled
 * source: two `const`s where the page has one expression. Arguments are read
 * left to right and the lift keeps that order, so the seeded stream must draw
 * exactly what it drew before — and this test is the only thing that can say
 * so.
 *
 * It renders both the page's own fence and the graph the importer made of
 * it, and compares the fragments. Only the fences the lift actually changed
 * are rendered: a fence with no lifted node is already covered by the import
 * test.
 *
 * `GRAPH_LIFT_LIMIT` caps how many are rendered (default: all of them).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import * as occlude from 'occlude';
import { DEFAULT_PENS, initOcclude, isSketch, liveExampleToJs, renderAsync, type RenderResult, type SketchDef } from 'occlude';
import { DOC_PAGES } from '../../../occlude/src/docsExamples.js';

import { CATALOGUE } from './catalogue.js';
import { compileGraph } from './compile.js';
import { importSketch } from './import.js';
import type { Graph } from './model.js';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const FENCE = /```ts live[^\n]*\n([\s\S]*?)```/g;
const fencesOf = (file: string): string[] =>
  [...read(`../../../../docs/${file}`).matchAll(FENCE)].map((match) => match[1]!);

/** Every name the source itself declares. A built-in node whose id is not one
 * of them was lifted out of an argument: the source gave that value no name. */
function declared(source: string): Set<string> {
  const out = new Set<string>();
  const file = ts.createSourceFile('sketch.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) out.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

const lifted = (graph: Graph, source: string): boolean => {
  const names = declared(source);
  return graph.nodes.some((node) => node.kind === 'builtin' && !names.has(node.id));
};

function definition(source: string): SketchDef {
  const module = { exports: {} as Record<string, unknown> };
  const require = (name: string): unknown => {
    if (name === 'occlude') return occlude;
    throw new Error(`this test's sketches may only import 'occlude' (tried '${name}')`);
  };
  new Function('require', 'exports', 'module', liveExampleToJs(source))(require, module.exports, module);
  const def = module.exports.default;
  if (!isSketch(def)) throw new Error('the source exported no sketch');
  return def;
}

const inkOf = (source: string): Promise<RenderResult> => renderAsync(definition(source), {
  paper: { paper: 'Square20', landscape: false },
  coarsen: 1,
  marginPct: 5,
  library: structuredClone(DEFAULT_PENS),
});

beforeAll(async () => {
  await initOcclude(readFileSync(fileURLToPath(new URL('../../../../crates/occlude-core/pkg/occlude_core_bg.wasm', import.meta.url))));
});

describe('lifting a nested call', () => {
  it('draws the same ink as the page it came from', async () => {
    const limit = Number(process.env.GRAPH_LIFT_LIMIT) || Number.POSITIVE_INFINITY;
    const cases: { name: string; source: string; graph: Graph }[] = [];
    for (const page of DOC_PAGES.filter((p) => p.live)) {
      fencesOf(page.file).forEach((source, i) => {
        let graph: Graph;
        try {
          graph = importSketch(source, CATALOGUE);
        } catch {
          return; // the import test owns that failure
        }
        if (lifted(graph, source)) cases.push({ name: `${page.slug}#${i}`, source, graph });
      });
    }
    // The lift has to be doing something, or this test proves nothing.
    expect(cases.length).toBeGreaterThan(40);

    const differ: string[] = [];
    let compared = 0;
    for (const one of cases.slice(0, limit)) {
      let wanted: RenderResult;
      try {
        wanted = await inkOf(one.source);
      } catch {
        continue; // a fence this harness cannot run (3D, an asset, a user pen)
      }
      compared++;
      let got: RenderResult;
      try {
        got = await inkOf(compileGraph(one.graph, CATALOGUE).source);
      } catch (error) {
        differ.push(`${one.name}: the graph would not run — ${(error as Error).message.split('\n')[0]}`);
        continue;
      }
      if (got.frags.length !== wanted.frags.length) {
        differ.push(`${one.name}: ${got.frags.length} fragments, the page draws ${wanted.frags.length}`);
        continue;
      }
      for (let k = 0; k < wanted.frags.length; k++) {
        if (JSON.stringify(got.frags[k]) !== JSON.stringify(wanted.frags[k])) {
          differ.push(`${one.name}: fragment ${k} differs`);
          break;
        }
      }
    }
    expect(differ).toEqual([]);
    // A silent skip would make this test pass by doing nothing: the fences
    // this harness can actually run have to be most of them.
    console.log(`lift: ${compared} of ${cases.length} lifted fences rendered both ways`);
    expect(compared).toBeGreaterThan(cases.length / 2);
  }, 900_000);
});
