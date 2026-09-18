/**
 * The graph compiler: a graph document becomes an ordinary sketch, as
 * source text. Pure functions, no DOM.
 *
 * The compiled source is what renders, what Evolve sees and what exports.
 * Nodes come out in topological order, one `const` per node named by its
 * id: a built-in word is a call with its inputs in parameter order, a code
 * node is an immediately-invoked arrow with one parameter per input, a
 * viewer compiles to nothing, and the output node's input is the `return`.
 *
 * Each emitted node carries a hash of its own source and its inputs'
 * hashes. A viewer compiles the sub-graph it reads, so its source is
 * byte-identical while nothing upstream changed — the page re-renders only
 * the viewers a change reaches.
 */

import {
  accepts, inputTakes, outputType, topoOrder, wordInputs, wordOf,
  type Catalogue, type CatalogueWord, type Graph, type GraphNode, type NodeKind, type Takes, type ValueType,
} from './model.js';

/** One emitted node: its `const` line(s), and the hash of it and its
 * inputs. */
export interface CompiledNode {
  id: string;
  kind: NodeKind;
  source: string;
  outputs: Record<string, ValueType>;
  /** Changes when this node's definition or any input's hash changes. */
  hash: string;
}

export interface CompiledSketch {
  /** The whole sketch, formatted like a docs example. */
  source: string;
  /** Every node of the sub-graph, in topological order, each with the hash
   * that decides whether it must be recomputed. A viewer's source is empty
   * — it renders, and draws nothing. */
  nodes: CompiledNode[];
}

/** A 32-bit FNV-1a hash, as hex. Stable across runs and machines. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A JSON value as a JavaScript literal, written the way a docs example
 * writes it: unquoted keys where they are identifiers, `, ` separators. */
export function literal(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return `'${value
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')}'`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(literal).join(', ')}]`;
  if (typeof value === 'object') {
    const parts = Object.entries(value as Record<string, unknown>).map(([k, v]) => `${KEY.test(k) ? k : literal(k)}: ${literal(v)}`);
    return `{ ${parts.join(', ')} }`;
  }
  throw new Error(`graph: cannot write ${String(value)} as a value`);
}

function nodeById(graph: Graph, id: string): GraphNode {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`graph: no node ${id}`);
  return node;
}

/** How an input reads in a message: its kinds, or its class. */
function takesText(takes: Takes): string {
  if (takes.socket === 'Geometry' && takes.kinds) return takes.kinds.join(' or ');
  return takes.socket;
}

/** The expression an input reads: a literal, or the upstream node's output. */
function inputExpression(node: GraphNode, key: string, graph: Graph, catalogue: Catalogue): string {
  const input = node.inputs[key];
  if (!input) throw new Error(`graph: node ${node.id} has no input ${key}`);
  if (!input.from) return literal(input.value);
  const [fromId, out] = input.from;
  const source = nodeById(graph, fromId);
  if (!outputType(source, out, catalogue)) {
    throw new Error(source.kind === 'output'
      ? `graph: node ${node.id} input ${key} reads the output node, which has no outputs`
      : `graph: ${fromId} has no output ${out}`);
  }
  return source.kind === 'code' ? `${fromId}.${out}` : fromId;
}

/** Every built-in node checked against the catalogue, and every edge against
 * the socket table. Throws a message that names the word, the node or both
 * sockets. Returns each built-in node's word. */
function validate(graph: Graph, catalogue: Catalogue): Map<string, CatalogueWord> {
  const words = new Map<string, CatalogueWord>();
  for (const node of graph.nodes) {
    if (node.kind !== 'builtin') continue;
    const word = wordOf(catalogue, node.word!);
    if (!word) throw new Error(`graph: node ${node.id} names unknown word ${node.word}`);
    words.set(node.id, word);
  }
  // A node id is emitted as a `const` beside the imports and the toolkit, so
  // it must not be one of their names.
  const reserved = new Set(['t', 'sketch']);
  for (const word of words.values()) {
    if (word.receiver === null && word.import) reserved.add(word.call);
    else if (word.receiver && word.receiver !== 't') reserved.add(word.receiver);
  }
  for (const node of graph.nodes) {
    if (node.kind === 'code') for (const name of bodyImports(node.body!, catalogue)) reserved.add(name.name);
  }
  for (const node of graph.nodes) {
    if (reserved.has(node.id)) throw new Error(`graph: node id ${node.id} is a name the compiled sketch already uses`);
  }
  for (const node of graph.nodes) {
    const word = words.get(node.id);
    if (word) {
      const byName = new Map(wordInputs(word).map((input) => [input.name, input]));
      for (const [key, input] of Object.entries(node.inputs)) {
        const spec = byName.get(key);
        if (!spec) throw new Error(`graph: node ${node.id} has no input ${key} for ${word.word}`);
        if (!input.from) continue;
        if (!spec.takes) throw new Error(`graph: ${node.id}.${key} is a control; nothing wires into it`);
        const output = outputType(nodeById(graph, input.from[0]), input.from[1], catalogue);
        if (!output) throw new Error(`graph: ${input.from[0]} has no output ${input.from[1]}`);
        if (!accepts(output, spec.takes)) {
          throw new Error(`graph: ${node.id}.${key} takes ${takesText(spec.takes)}; ${input.from[0]}.${input.from[1]} is ${output}`);
        }
      }
      continue;
    }
    const takes = inputTakes(node, catalogue);
    for (const [key, input] of Object.entries(node.inputs)) {
      if (node.kind === 'viewer' || node.kind === 'output') {
        if (key !== 'in') throw new Error(`graph: node ${node.id} has no input ${key}`);
      }
      if (!input.from) continue;
      const output = outputType(nodeById(graph, input.from[0]), input.from[1], catalogue);
      if (!output) throw new Error(`graph: ${input.from[0]} has no output ${input.from[1]}`);
      const wanted = takes[key];
      if (wanted && !accepts(output, wanted)) {
        throw new Error(`graph: ${node.id}.${key} takes ${takesText(wanted)}; ${input.from[0]}.${input.from[1]} is ${output}`);
      }
    }
  }
  return words;
}

/** The arguments of a built-in call, in parameter order: one per plain
 * parameter, one options record per record parameter. A `null` marks an
 * argument the node leaves to the library; trailing ones are dropped. */
function builtinArgs(word: CatalogueWord, node: GraphNode, graph: Graph, catalogue: Catalogue): (string | null)[] {
  const inputs = wordInputs(word);
  const args: (string | null)[] = [];
  for (const param of word.params) {
    if (!param.options) {
      if (node.inputs[param.name] === undefined) {
        if (!param.optional) throw new Error(`graph: node ${node.id} has no input ${param.name} for ${word.word}`);
        args.push(null);
        continue;
      }
      args.push(inputExpression(node, param.name, graph, catalogue));
      continue;
    }
    const parts: string[] = [];
    for (const input of inputs) {
      if (input.param !== param.name) continue;
      if (node.inputs[input.name] === undefined) continue;
      parts.push(`${input.option}: ${inputExpression(node, input.name, graph, catalogue)}`);
    }
    if (parts.length > 0) {
      args.push(`{ ${parts.join(', ')} }`);
      continue;
    }
    // Nothing is set. A record the library insists on (an option of it has
    // no default) is an error the artist must see here, not a call that
    // throws mid-render.
    const required = param.options.filter((option) => !option.optional);
    if (required.length > 0) throw new Error(`graph: node ${node.id} has no input ${required[0].name} for ${word.word}`);
    // An optional record never reaches the call; a required one arrives
    // empty, which every options record accepts.
    args.push(param.optional ? null : '{}');
  }
  while (args.length > 0 && args[args.length - 1] === null) args.pop();
  return args;
}

/** A code node: an immediately-invoked arrow with one parameter per input.
 * `t` comes from the enclosing sketch. A one-line body stays on the `const`
 * line, unless it holds a line comment — that would comment out the call's
 * closing tokens. */
function codeSource(node: GraphNode, graph: Graph, catalogue: Catalogue): string {
  const keys = Object.keys(node.inputs);
  const body = node.body!.trim();
  const lines = body.split('\n');
  const params = keys.join(', ');
  const args = keys.map((key) => inputExpression(node, key, graph, catalogue)).join(', ');
  if (lines.length === 1 && !body.includes('//')) return `const ${node.id} = ((${params}) => { ${body} })(${args});`;
  const inner = lines.map((line) => (line === '' ? '' : `  ${line}`)).join('\n');
  return `const ${node.id} = ((${params}) => {\n${inner}\n})(${args});`;
}

/** The `const` line(s) of one node. A viewer compiles to nothing; the
 * output node is the `return`. */
function nodeSource(node: GraphNode, word: CatalogueWord | undefined, graph: Graph, catalogue: Catalogue): string {
  if (word) {
    const args = builtinArgs(word, node, graph, catalogue).map((arg) => arg ?? 'undefined');
    return `const ${node.id} = ${word.call}(${args.join(', ')});`;
  }
  return node.kind === 'code' ? codeSource(node, graph, catalogue) : '';
}

/** The names a code node body reaches for. The body is TypeScript the
 * compiler does not parse, so a name a module exports is imported when the
 * body uses it as something other than a property key or a parameter — an
 * unused import is harmless, a missing one would not run. */
function bodyImports(body: string, catalogue: Catalogue): { module: 'occlude' | 'occlude/3d'; name: string }[] {
  const out: { module: 'occlude' | 'occlude/3d'; name: string }[] = [];
  const count = (pattern: string): number => body.match(new RegExp(pattern, 'g'))?.length ?? 0;
  for (const { module, names } of catalogue.importable) {
    for (const name of names) {
      const uses = count(`(?<![\\w$.])${name}(?![\\w$])`);
      if (uses === 0) continue;
      // A name the body declares shadows the import for the whole body.
      if (count(`(?:const|let|var|function|class)\\s+${name}\\b`) > 0) continue;
      const other = count(`(?<![\\w$.])${name}\\s*:`)
        + count(`[(,]\\s*${name}\\s*[,)=]`)
        + count(`[(,]\\s*${name}\\s*\\)\\s*=>`);
      if (uses <= other) continue;
      out.push({ module, name });
    }
  }
  return out;
}

/** The import lines for the emitted words and the code bodies' names.
 * `sketch` always comes first from `occlude`; a toolkit word is a member of
 * `t`, so it is never imported. */
function importLines(words: CatalogueWord[], extra: { module: 'occlude' | 'occlude/3d'; name: string }[]): string {
  const occlude = new Set<string>();
  const three = new Set<string>();
  for (const word of words) {
    if (word.import === null) continue;
    (word.module === 'occlude' ? occlude : three).add(word.import);
  }
  for (const { module, name } of extra) (module === 'occlude' ? occlude : three).add(name);
  const lines = [`import { ${['sketch', ...[...occlude].sort()].join(', ')} } from 'occlude';`];
  if (three.size > 0) lines.push(`import { ${[...three].sort().join(', ')} } from 'occlude/3d';`);
  return lines.join('\n');
}

/** The nodes a target reads, transitively, plus the target itself. */
function reachable(graph: Graph, target: string): Set<string> {
  const seen = new Set<string>([target]);
  const walk = (id: string): void => {
    for (const input of Object.values(nodeById(graph, id).inputs)) {
      if (!input.from || seen.has(input.from[0])) continue;
      seen.add(input.from[0]);
      walk(input.from[0]);
    }
  };
  walk(target);
  return seen;
}

/**
 * Compile the sub-graph that feeds one node's input into a whole sketch.
 * The target's input is the `return`, so a viewer renders what it reads.
 * A viewer and the output node both take their one input as `in`.
 *
 * `wrap` names a word to call around the returned expression: a viewer on a
 * material shows ink only through `strokes(...)`. It is the viewer's own
 * picture and never reaches the graph's compiled sketch.
 */
export function compileFor(graph: Graph, catalogue: Catalogue, target: string, input: string, wrap?: string): CompiledSketch {
  const order = topoOrder(graph);
  const wordsById = validate(graph, catalogue);
  const targetNode = nodeById(graph, target);
  const wanted = reachable(graph, target);
  const emitted = order.filter((id) => wanted.has(id));
  const nodes: CompiledNode[] = [];
  const words: CatalogueWord[] = [];
  const extra: { module: 'occlude' | 'occlude/3d'; name: string }[] = [];
  const hashes = new Map<string, string>();
  for (const id of emitted) {
    const node = nodeById(graph, id);
    const word = wordsById.get(id);
    const source = nodeSource(node, word, graph, catalogue);
    if (word) words.push(word);
    if (node.kind === 'code') extra.push(...bodyImports(node.body!, catalogue));
    const upstream = Object.values(node.inputs)
      .map((inp) => (inp.from ? hashes.get(inp.from[0]) ?? '' : literal(inp.value)))
      .join(',');
    const nodeHash = hash(`${literal(graph.config)}\u0000${source}\u0000${upstream}`);
    hashes.set(id, nodeHash);
    nodes.push({ id, kind: node.kind, source, outputs: outputsOf(node, catalogue), hash: nodeHash });
  }
  if (wrap) extra.push({ module: 'occlude', name: wrap });
  const body = nodes.filter((n) => n.source !== '').map((n) => `  ${n.source.replace(/\n/g, '\n  ')}`);
  const returned = inputExpression(targetNode, input, graph, catalogue);
  const expression = wrap ? `${wrap}(${returned})` : returned;
  const source = `${importLines(words, extra)}\n\nexport default sketch(${literal(graph.config)}, (t) => {\n${body.join('\n')}\n  return ${expression};\n});\n`;
  return { source, nodes };
}

function outputsOf(node: GraphNode, catalogue: Catalogue): Record<string, ValueType> {
  if (node.kind === 'code') return node.outputs!;
  if (node.kind === 'builtin') {
    const word = wordOf(catalogue, node.word!);
    return word ? { out: word.returns } : {};
  }
  return {};
}

/** Compile the whole graph: the output node's input is the `return`. */
export function compileGraph(graph: Graph, catalogue: Catalogue): CompiledSketch {
  const outputs = graph.nodes.filter((n) => n.kind === 'output');
  if (outputs.length === 0) throw new Error('graph: no output node — add one and wire it');
  if (outputs.length > 1) throw new Error(`graph: ${outputs.length} output nodes; a graph has one`);
  return compileFor(graph, catalogue, outputs[0].id, 'in');
}
