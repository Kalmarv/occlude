/**
 * The layout: columns that follow the wires, and a column nothing overlaps
 * in.
 *
 * The properties are what an artist would check by eye — a wire runs left to
 * right, two nodes never sit on top of each other, a node sits level with
 * what feeds it — so they are checked as properties, over the fixture graph
 * and over every live docs fence once it is imported.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DOC_PAGES } from '../../../occlude/src/docsExamples.js';
import { CATALOGUE } from './catalogue.js';
import { importSketch } from './import.js';
import { estimateBox, layoutGraph } from './layout.js';
import { parseGraph, type Graph } from './model.js';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const bloom = (): Graph => parseGraph(JSON.parse(read('./fixtures/bloom.json')));

const box = (graph: Graph) => (node: { id: string }) => estimateBox(graph.nodes.find((n) => n.id === node.id)!, CATALOGUE);

/** Every pair of nodes whose boxes overlap. */
function overlaps(graph: Graph, places: Map<string, { x: number; y: number }>): string[] {
  const out: string[] = [];
  const boxes = graph.nodes.map((node) => ({ id: node.id, at: places.get(node.id)!, size: estimateBox(node, CATALOGUE) }));
  for (let i = 0; i < boxes.length; i++) {
    for (let k = i + 1; k < boxes.length; k++) {
      const a = boxes[i]!;
      const b = boxes[k]!;
      const apart = a.at.x + a.size.width <= b.at.x || b.at.x + b.size.width <= a.at.x
        || a.at.y + a.size.height <= b.at.y || b.at.y + b.size.height <= a.at.y;
      if (!apart) out.push(`${a.id} over ${b.id}`);
    }
  }
  return out;
}

/** Every wire that runs backwards or straight down: a node must sit to the
 * right of everything that feeds it. */
function backwards(graph: Graph, places: Map<string, { x: number; y: number }>): string[] {
  const out: string[] = [];
  for (const node of graph.nodes) {
    for (const input of Object.values(node.inputs)) {
      if (!input.from) continue;
      const source = places.get(input.from[0]);
      const target = places.get(node.id);
      if (source && target && source.x >= target.x) out.push(`${input.from[0]} → ${node.id}`);
    }
  }
  return out;
}

const FENCE = /```ts live[^\n]*\n([\s\S]*?)```/g;
const fencesOf = (file: string): string[] =>
  [...read(`../../../../docs/${file}`).matchAll(FENCE)].map((match) => match[1]!);

describe('layout', () => {
  it('lays the bloom fixture out with no overlap and no backward wire', () => {
    const graph = bloom();
    const places = layoutGraph(graph, box(graph));
    expect(places.size).toBe(graph.nodes.length);
    expect(overlaps(graph, places)).toEqual([]);
    expect(backwards(graph, places)).toEqual([]);
  });

  it('gives a node the same place twice', () => {
    const graph = bloom();
    const first = layoutGraph(graph, box(graph));
    const second = layoutGraph(graph, box(graph));
    for (const [id, at] of first) expect(second.get(id)).toEqual(at);
  });

  it('sits a node level with the one thing that feeds it', () => {
    // A chain: each node reads the one before it, so every centre must line
    // up — the settling step's whole job.
    const graph: Graph = {
      version: 1,
      name: 'chain',
      config: {},
      nodes: [
        { id: 'a', kind: 'builtin', word: 'circle', x: 0, y: 0, inputs: { x: { value: 1 }, y: { value: 1 }, r: { value: 1 } } },
        { id: 'b', kind: 'builtin', word: 'strokes', x: 0, y: 0, inputs: { source: { from: ['a', 'out'] } } },
        { id: 'c', kind: 'output', x: 0, y: 0, inputs: { in: { from: ['b', 'out'] } } },
      ],
    };
    const places = layoutGraph(graph, box(graph));
    const centre = (id: string): number => places.get(id)!.y + estimateBox(graph.nodes.find((n) => n.id === id)!, CATALOGUE).height / 2;
    expect(centre('b')).toBeCloseTo(centre('a'), 6);
    expect(centre('c')).toBeCloseTo(centre('b'), 6);
  });

  it('never overlaps a node, over every live docs example', () => {
    const bad: string[] = [];
    let graphs = 0;
    for (const page of DOC_PAGES.filter((p) => p.live)) {
      fencesOf(page.file).forEach((source, i) => {
        let graph: Graph;
        try {
          graph = importSketch(source, CATALOGUE);
        } catch {
          return; // the import's own test owns that failure
        }
        graphs++;
        const places = layoutGraph(graph, box(graph));
        for (const pair of overlaps(graph, places)) bad.push(`${page.slug}#${i}: ${pair}`);
        for (const wire of backwards(graph, places)) bad.push(`${page.slug}#${i}: ${wire} runs backwards`);
      });
    }
    expect(graphs).toBeGreaterThan(400);
    expect(bad).toEqual([]);
  });
});
