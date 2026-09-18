/**
 * Where the nodes go: a layered layout for a directed acyclic graph.
 *
 * One layout, two callers. The importer has no DOM, so it estimates each
 * node's size from the document; the page measures the real bodies and hands
 * those in. Sizes are an input, never something this file guesses on its own.
 *
 * Three steps, the standard ones:
 *
 * 1. **Layers.** A node sits one column to the right of the furthest node
 *    that feeds it — the longest path, so a wire only ever runs forward.
 * 2. **Order.** Four sweeps over the layers, each one sorting a layer by the
 *    median position of its neighbours in the layer before (going right) or
 *    after (going left). This is the median heuristic, and it is what stops
 *    wires crossing for no reason.
 * 3. **Places.** Each node wants to sit level with the middle of what feeds
 *    it, and no two nodes in a column may overlap. Those two wants are one
 *    problem — the closest set of places, in the order step 2 fixed, that
 *    keeps every gap — and isotonic regression solves it exactly. A node is
 *    never nudged; the whole column is placed at once.
 *
 * A cycle has no layering. `layoutGraph` refuses one, because the compiler
 * refuses one too: a graph that cannot be drawn in order cannot run.
 */

import { listPlaces, topoOrder, wordInputs, wordOf, type Catalogue, type Graph, type GraphNode } from './model.js';

/** A node's size, in area units. */
export interface NodeBox {
  width: number;
  height: number;
}

export interface LayoutOptions {
  /** The gap between one column and the next. */
  gapX?: number;
  /** The least gap between two nodes of one column. */
  gapY?: number;
  originX?: number;
  originY?: number;
}

const DEFAULTS = { gapX: 70, gapY: 26, originX: 40, originY: 40 };

/** What the body's CSS makes of each piece, near enough for a first place. */
const HEAD_H = 28;
const ROW_H = 24;
const VIEWER_H = 146;
const CODE_LINE_H = 18;
const CODE_MIN_H = 48;
const CODE_MAX_H = 460;
/** The strip a code node and a viewer keep for the size handle. */
const HANDLE_H = 14;

/**
 * A node's size, read from the document. The page hands in what it measured
 * instead; this is what the importer has before anything is painted.
 */
export function estimateBox(node: GraphNode, catalogue: Catalogue): NodeBox {
  if (node.width !== undefined && node.height !== undefined) return { width: node.width, height: node.height };
  if (node.kind === 'code') {
    const lines = (node.body ?? '').split('\n').length;
    const code = Math.min(CODE_MAX_H, Math.max(CODE_MIN_H, lines * CODE_LINE_H + 4));
    const rows = Object.keys(node.inputs).length + Object.keys(node.outputs ?? {}).length;
    return { width: node.width ?? 260, height: node.height ?? HEAD_H + rows * ROW_H + code + HANDLE_H };
  }
  if (node.kind === 'viewer') {
    return { width: node.width ?? 232, height: node.height ?? HEAD_H + ROW_H + VIEWER_H + HANDLE_H };
  }
  if (node.kind === 'builtin') {
    const word = node.word ? wordOf(catalogue, node.word) : undefined;
    if (!word) return { width: 208, height: HEAD_H + ROW_H };
    // One row per plain parameter, one summary row per options record, and
    // the output row.
    const records = new Set(word.params.filter((param) => param.options).map((param) => param.name));
    const plain = wordInputs(word).filter((input) => input.option === undefined).length;
    return { width: 208, height: HEAD_H + (plain + records.size + 1) * ROW_H };
  }
  // A value node is its literal and its output; a list is its places and its
  // output; the output node, a group node and a group's input node are a
  // title and a row.
  if (node.kind === 'value') return { width: 176, height: HEAD_H + 2 * ROW_H };
  if (node.kind === 'list') return { width: 176, height: HEAD_H + (listPlaces(node).length + 1) * ROW_H };
  return { width: 208, height: HEAD_H + ROW_H };
}

/**
 * The closest set of positions, in the given order, that keeps every gap.
 *
 * `want[i]` is where node `i` would like its top edge; `least[i]` is the
 * least distance from `i`'s top to `i+1`'s. Subtracting the running least
 * distance turns "keep the gaps" into "be non-decreasing", which is isotonic
 * regression: pool adjacent violators, in one pass.
 */
function packed(want: readonly number[], least: readonly number[]): number[] {
  const offset: number[] = [0];
  for (let i = 0; i < least.length; i++) offset.push(offset[i]! + least[i]!);
  // Each block is a run of pooled points: its mean is where the run sits.
  const blocks: { sum: number; count: number; value: number }[] = [];
  for (let i = 0; i < want.length; i++) {
    blocks.push({ sum: want[i]! - offset[i]!, count: 1, value: want[i]! - offset[i]! });
    while (blocks.length > 1 && blocks[blocks.length - 2]!.value > blocks[blocks.length - 1]!.value) {
      const last = blocks.pop()!;
      const previous = blocks[blocks.length - 1]!;
      previous.sum += last.sum;
      previous.count += last.count;
      previous.value = previous.sum / previous.count;
    }
  }
  const out: number[] = [];
  for (const block of blocks) for (let k = 0; k < block.count; k++) out.push(block.value);
  return out.map((value, i) => value + offset[i]!);
}

const median = (values: number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/**
 * Where every node of the graph goes. `boxOf` gives each node's size — the
 * page measures, the importer estimates.
 */
export function layoutGraph(
  graph: Graph,
  boxOf: (node: GraphNode) => NodeBox,
  options: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const { gapX, gapY, originX, originY } = { ...DEFAULTS, ...options };
  const order = topoOrder(graph); // throws on a cycle, by name
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const box = new Map(graph.nodes.map((node) => [node.id, boxOf(node)]));

  // 1. layers
  const layerOf = new Map<string, number>();
  for (const id of order) {
    let at = 0;
    for (const input of Object.values(byId.get(id)!.inputs)) {
      if (input.from && layerOf.has(input.from[0])) at = Math.max(at, layerOf.get(input.from[0])! + 1);
    }
    layerOf.set(id, at);
  }
  const layers: string[][] = [];
  for (const node of graph.nodes) {
    const at = layerOf.get(node.id)!;
    (layers[at] ??= []).push(node.id);
  }
  for (let i = 0; i < layers.length; i++) layers[i] ??= [];

  // The wires, both ways, so a sweep can read either side.
  const feeds = new Map<string, string[]>(); // id -> the nodes it reads
  const reads = new Map<string, string[]>(); // id -> the nodes that read it
  const link = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };
  for (const node of graph.nodes) {
    for (const input of Object.values(node.inputs)) {
      if (!input.from || !byId.has(input.from[0])) continue;
      link(feeds, node.id, input.from[0]);
      link(reads, input.from[0], node.id);
    }
  }

  // 2. order, by the median of the neighbours in the layer the sweep came
  // from. A node with no neighbour there keeps where it was.
  const rank = new Map<string, number>();
  const setRanks = (): void => {
    for (const layer of layers) layer.forEach((id, i) => rank.set(id, i));
  };
  setRanks();
  const sweep = (forward: boolean): void => {
    const indexes = layers.map((_, i) => i);
    for (const i of forward ? indexes : [...indexes].reverse()) {
      const side = forward ? feeds : reads;
      const layer = layers[i]!;
      const keep = new Map(layer.map((id, k) => [id, k]));
      const want = new Map(layer.map((id) => {
        const neighbours = (side.get(id) ?? []).map((other) => rank.get(other)!).filter((v) => v !== undefined);
        const m = median(neighbours);
        return [id, Number.isNaN(m) ? keep.get(id)! : m];
      }));
      layer.sort((a, b) => want.get(a)! - want.get(b)! || keep.get(a)! - keep.get(b)!);
      layer.forEach((id, k) => rank.set(id, k));
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    sweep(true);
    sweep(false);
  }

  // 3. places. x is the column; y is what every node wants, packed.
  const at = new Map<string, { x: number; y: number }>();
  let x = originX;
  const columnX: number[] = [];
  for (const layer of layers) {
    columnX.push(x);
    x += Math.max(0, ...layer.map((id) => box.get(id)!.width)) + gapX;
  }
  // A first pass gives every node a place; the sweeps then pull each one
  // level with what feeds it, and pack the column again.
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i]!;
    const want = layer.map(() => originY);
    const least = layer.slice(0, -1).map((id) => box.get(id)!.height + gapY);
    packed(want, least).forEach((y, k) => at.set(layer[k]!, { x: columnX[i]!, y }));
  }
  const centre = (id: string): number => at.get(id)!.y + box.get(id)!.height / 2;
  const settle = (forward: boolean): void => {
    const indexes = layers.map((_, i) => i);
    for (const i of forward ? indexes : [...indexes].reverse()) {
      const layer = layers[i]!;
      const side = forward ? feeds : reads;
      const want = layer.map((id) => {
        const neighbours = (side.get(id) ?? []).filter((other) => at.has(other)).map(centre);
        const m = median(neighbours);
        return (Number.isNaN(m) ? centre(id) : m) - box.get(id)!.height / 2;
      });
      const least = layer.slice(0, -1).map((id) => box.get(id)!.height + gapY);
      packed(want, least).forEach((y, k) => at.set(layer[k]!, { x: columnX[i]!, y }));
    }
  };
  for (let pass = 0; pass < 4; pass++) {
    settle(true);
    settle(false);
  }

  // The whole drawing starts at the origin, whatever the sweeps did to it.
  const top = Math.min(...[...at.values()].map((p) => p.y));
  if (Number.isFinite(top)) for (const place of at.values()) place.y += originY - top;
  return at;
}
