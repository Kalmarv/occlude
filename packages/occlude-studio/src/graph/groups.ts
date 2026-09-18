/**
 * Sub-graphs: a group is a graph with a boundary, and a group node is a
 * reference to it.
 *
 * Inside a group, one `input` node declares the boundary — its outputs are
 * the group's inputs — and the `output` node is the group's result, one
 * named input per output socket. Neither may appear in a graph that is
 * compiled directly: they only mean something once the group is expanded.
 *
 * `expand` inlines a group where it is used, so the compiler never learns
 * that groups exist: the compiled sketch stays one plain program, which is
 * what renders, what Evolve sees and what exports. `collapse` is the other
 * direction, and the two must be exact inverses in ink.
 */

import {
  inputTakes, outputType, topoOrder,
  type Catalogue, type Graph, type GraphNode, type Takes, type ValueType,
} from './model.js';

/** A saved group: a graph whose boundary is its `input` node and whose
 * result is its `output` node. */
export interface Group {
  version: 1;
  name: string;
  graph: Graph;
}

export interface GroupLibrary {
  /** The group of that name, or undefined. */
  get(name: string): Group | undefined;
}

const isBoundary = (node: GraphNode): boolean => node.kind === 'input';
const isResult = (node: GraphNode): boolean => node.kind === 'output';

/** The node id a group's inside gets in the outer graph. */
const insideId = (group: string, id: string): string => `${group}_${id}`;

/** Refuse a group that holds itself, directly or through another group. */
function checkAcyclic(graph: Graph, groups: GroupLibrary, seen: Set<string>): void {
  for (const node of graph.nodes) {
    if (node.kind !== 'group') continue;
    const name = node.word!;
    if (seen.has(name)) throw new Error(`graph: group ${name} contains itself`);
    const group = groups.get(name);
    if (!group) throw new Error(`graph: node ${node.id} names unknown group ${name}`);
    checkAcyclic(group.graph, groups, new Set([...seen, name]));
  }
}

function graphOf(name: string, groups: GroupLibrary, seen: Set<string>): Graph {
  if (seen.has(name)) throw new Error(`graph: group ${name} contains itself`);
  const group = groups.get(name);
  if (!group) throw new Error(`graph: unknown group ${name}`);
  return group.graph;
}

/**
 * Inline every group node, to whatever depth the library holds. The result
 * holds no `group`, `input` or `output` node but the graph's own output.
 */
export function expand(graph: Graph, groups: GroupLibrary): Graph {
  checkAcyclic(graph, groups, new Set());
  const inlined = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    if (node.kind === 'group') inlined.set(node.id, inline(node, groups, new Set()));
    else if (isBoundary(node)) throw new Error(`graph: node ${node.id} is a group input; it belongs inside a group`);
  }
  const resultOf = (id: string, output: string): [string, string] => {
    const parts = inlined.get(id);
    if (!parts) return [id, output];
    return [parts[parts.length - 1].id, output];
  };
  const nodes = graph.nodes.flatMap((node) => {
    const own = inlined.get(node.id);
    if (own) return own;
    if (node.kind === 'input') return [];
    return [{
      ...node,
      inputs: Object.fromEntries(Object.entries(node.inputs).map(([key, input]) => [
        key,
        input.from ? { ...input, from: resultOf(input.from[0], input.from[1]) } : input,
      ])),
    }];
  });
  return { ...graph, nodes };
}

/** One group node, inlined: its inside under prefixed ids, its boundary
 * wired to the group node's own inputs, and its result re-stated as a code
 * node so the outer edges keep meaning something. */
function inline(node: GraphNode, groups: GroupLibrary, seen: Set<string>): GraphNode[] {
  const name = node.word!;
  const inside = graphOf(name, groups, seen);
  const nested = new Set([...seen, name]);
  const prefix = node.id;
  const boundary = inside.nodes.find(isBoundary);
  const result = inside.nodes.find(isResult);
  if (!boundary || !result) throw new Error(`graph: group ${name} has no boundary or no result`);

  /** The expression a name inside the group stands for, in the outer graph. */
  const source = (id: string, output: string): [string, string] => {
    if (id === boundary.id) {
      const wire = node.inputs[output]?.from;
      if (!wire) throw new Error(`graph: group ${name} needs input ${output}`);
      return wire;
    }
    return [insideId(prefix, id), output];
  };

  const nodes: GraphNode[] = [];
  for (const inner of inside.nodes) {
    if (inner === boundary) continue;
    if (inner === result) continue;
    const own: GraphNode = { ...inner, id: insideId(prefix, inner.id) };
    // A nested group is inlined into this one's ids, so expand it first.
    if (own.kind === 'group') {
      const deeper = inline(own, groups, nested).map((n) => ({ ...n, id: insideId(prefix, n.id) }));
      nodes.push(...deeper);
      continue;
    }
    own.inputs = Object.fromEntries(Object.entries(inner.inputs).map(([key, input]) => [
      key,
      input.from ? (() => { const [id, output] = source(input.from![0], input.from![1]); return { ...input, from: [id, output] as [string, string] }; })() : input,
    ]));
    nodes.push(own);
  }

  // The group's result: one named output per edge that leaves the group.
  const keys = Object.keys(result.inputs);
  const bound: Record<string, { from: [string, string]; type?: ValueType }> = {};
  const parts: string[] = [];
  for (const key of keys) {
    const [id, output] = source(result.inputs[key].from![0], result.inputs[key].from![1]);
    // A code node declares what each input carries; the group node already
    // says what this value is.
    const type = node.outputs?.[key];
    bound[key] = type ? { from: [id, output], type } : { from: [id, output] };
    parts.push(`${key}: ${output === 'out' ? id : `${id}.${output}`}`);
  }
  nodes.push({
    id: insideId(prefix, result.id), kind: 'code', x: node.x, y: node.y,
    inputs: bound, outputs: { ...node.outputs }, body: `return { ${parts.join(', ')} };`,
  });
  return nodes;
}

/** The wires that cross a selection's boundary, and the group they make. */
export interface Collapsed {
  group: Group;
  /** The node that stands for the group in the outer graph. */
  node: GraphNode;
  /** The outer graph, with the selection replaced. */
  graph: Graph;
}

/**
 * Replace the selected nodes by one group node. Every wire that entered the
 * selection becomes a group input, and every wire that left it a group
 * output — the boundary the brief asks for.
 */
export function collapse(graph: Graph, ids: readonly string[], name: string, catalogue: Catalogue): Collapsed {
  const selected = new Set(ids);
  for (const id of ids) if (!graph.nodes.some((n) => n.id === id)) throw new Error(`graph: no node ${id}`);
  if (selected.size === 0) throw new Error('graph: a group needs at least one node');
  const inside = graph.nodes.filter((n) => selected.has(n.id));
  const rest = graph.nodes.filter((n) => !selected.has(n.id));

  const boundary: GraphNode = { id: 'in', kind: 'input', x: 0, y: 0, inputs: {}, outputs: {} };
  const result: GraphNode = { id: 'out', kind: 'output', x: 0, y: 0, inputs: {} };
  const taken = new Set(inside.map((n) => n.id));
  const unique = (preferred: string): string => {
    let id = preferred;
    for (let n = 2; taken.has(id); n++) id = `${preferred}${n}`;
    taken.add(id);
    return id;
  };
  /** The name a boundary socket takes: the key it feeds, deduped. */
  const named = (used: Set<string>, preferred: string): string => {
    let id = preferred;
    for (let n = 2; used.has(id); n++) id = `${preferred}${n}`;
    used.add(id);
    return id;
  };

  const groupNode: GraphNode = { id: unique(name), kind: 'group', word: name, x: 0, y: 0, inputs: {}, outputs: {} };
  const innerNames = new Set<string>();
  const outerNames = new Set<string>();
  const rewired = new Map<string, GraphNode>();

  const rewrite = (node: GraphNode, take: (input: NonNullable<GraphNode['inputs'][string]>, key: string) => NonNullable<GraphNode['inputs'][string]>): void => {
    const next: GraphNode = { ...node, inputs: {} };
    for (const [key, input] of Object.entries(node.inputs)) next.inputs[key] = take(input, key);
    rewired.set(node.id, next);
  };

  // Into the selection: an input of the group for each wire that enters.
  for (const node of inside) {
    rewrite(node, (input, key) => {
      if (!input.from || selected.has(input.from[0])) return input;
      const takes = inputTakes(node, catalogue)[key];
      if (!takes) throw new Error(`graph: ${node.id}.${key} cannot take a group's input`);
      const socket = named(innerNames, key);
      boundary.outputs![socket] = takes.socket === 'Geometry' && takes.kinds ? takes.kinds[0] : takes.socket;
      groupNode.inputs[socket] = input;
      return { ...input, from: ['in', socket] };
    });
  }

  // Out of the selection: an output of the group for each wire that leaves.
  const consumers = rest.filter((n) => Object.values(n.inputs).some((i) => i.from && selected.has(i.from[0])));
  const byValue = new Map<string, string>();
  for (const node of consumers) {
    rewrite(node, (input, key) => {
      if (!input.from || !selected.has(input.from[0])) return input;
      const [from, output] = input.from;
      const carries = outputType(inside.find((n) => n.id === from)!, output, catalogue);
      if (!carries) throw new Error(`graph: ${from} has no output ${output}`);
      // The boundary socket is named after the value inside, not after the
      // key a consumer happens to read it as: every consumer of one value
      // shares one socket.
      const value = `${from}.${output}`;
      let socket = byValue.get(value);
      if (!socket) {
        socket = named(outerNames, output === 'out' ? from : output);
        byValue.set(value, socket);
        groupNode.outputs![socket] = carries;
        result.inputs[socket] = { from: [from, output] };
      }
      return { ...input, from: [groupNode.id, socket] };
    });
  }
  if (Object.keys(groupNode.outputs!).length === 0) {
    throw new Error('graph: the selection feeds nothing outside it, so the group would have no result');
  }
  const nodes = [
    ...rest.map((node) => rewired.get(node.id) ?? node),
    groupNode,
  ];
  const groupGraph: Graph = { version: 1, name, config: {}, nodes: [...inside.map((n) => rewired.get(n.id) ?? n), boundary, result] };
  topoOrder(groupGraph);
  return { group: { version: 1, name, graph: groupGraph }, node: groupNode, graph: { ...graph, nodes } };
}

/** The value type each output of a group node carries, from the group. */
export function groupOutputs(group: Group, catalogue: Catalogue): Record<string, ValueType> {
  const result = group.graph.nodes.find(isResult);
  if (!result) return {};
  const byId = new Map(group.graph.nodes.map((n) => [n.id, n]));
  return Object.fromEntries(Object.entries(result.inputs).map(([key, input]) => {
    const source = input.from && byId.get(input.from[0]);
    return [key, (source && outputType(source, input.from![1], catalogue)) ?? 'drawing'];
  }));
}

/** The sockets a group node takes, from the group's boundary. */
export function groupInputs(group: Group): Record<string, Takes> {
  const boundary = group.graph.nodes.find(isBoundary);
  const out: Record<string, Takes> = {};
  for (const [key, type] of Object.entries(boundary?.outputs ?? {})) out[key] = takesOfType(type);
  return out;
}

/** A declared value type as the socket that carries it. */
function takesOfType(type: ValueType): Takes {
  return (['Number', 'Vector', 'Field', 'Fill', 'Camera'] as const).includes(type as 'Number')
    ? { socket: type as 'Number' }
    : { socket: 'Geometry', kinds: [type as NonNullable<Takes['kinds']>[number]] };
}