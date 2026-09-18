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

import { freeNames, typeNames } from './names.js';
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

/** A value JSON cannot hold: the source text of an expression, written
 * verbatim. A sketch config carries `pen({ width: mm(0.3) })` and `mm(6)`,
 * and a graph document is JSON, so the one thing JSON cannot spell keeps its
 * own text. Import stores that text; the compiler writes it back. */
export interface RawValue {
  __raw: string;
}

export function isRaw(value: unknown): value is RawValue {
  return typeof value === 'object' && value !== null && Object.keys(value).length === 1 && typeof (value as RawValue).__raw === 'string';
}

/** Every raw value in a JSON tree, in order. */
function rawTexts(value: unknown): string[] {
  if (isRaw(value)) return [value.__raw];
  if (Array.isArray(value)) return value.flatMap(rawTexts);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(rawTexts);
  return [];
}

/** A JSON value as a JavaScript literal, written the way a docs example
 * writes it: unquoted keys where they are identifiers, `, ` separators. */
export function literal(value: unknown): string {
  if (value === null) return 'null';
  if (isRaw(value)) return value.__raw;
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

/** One name a code body or a raw value reaches for, and the module that
 * binds it. */
interface Imported {
  module: string;
  name: string;
  spec: string;
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
  const expression = source.kind === 'code' ? `${fromId}.${out}` : fromId;
  // A variadic word takes one socket; the wire says whether the collection
  // on it is the arguments or one of them.
  return input.spread ? `...${expression}` : expression;
}

/** Every built-in node checked against the catalogue, and every edge against
 * the socket table. Throws a message that names the word, the node or both
 * sockets. Returns each built-in node's word. */
function validate(graph: Graph, catalogue: Catalogue): Map<string, CatalogueWord> {
  const words = new Map<string, CatalogueWord>();
  for (const node of graph.nodes) {
    if (node.kind === 'group') throw new Error(`graph: node ${node.id} is a group; expand it before compiling`);
    if (node.kind === 'input') throw new Error(`graph: node ${node.id} is a group input; it belongs inside a group`);
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
    if (node.kind === 'code') {
      for (const name of usedImports(node.body!, catalogue, Object.keys(node.inputs))) reserved.add(name.name);
    }
  }
  for (const node of graph.nodes) {
    for (const inp of Object.values(node.inputs)) if (isRaw(inp.value)) for (const name of usedImports(inp.value.__raw, catalogue)) reserved.add(name.name);
  }
  for (const name of usedImports(rawTexts(graph.config).join('\n'), catalogue)) reserved.add(name.name);
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
    // A value method hangs off its receiver: `m.steps(...)`. The receiver is
    // an input, not an argument, and it must be wired.
    const call = word.self ? word.call.replace('{self}', inputExpression(node, word.self.param, graph, catalogue)) : word.call;
    return `const ${node.id} = ${call}(${args.join(', ')});`;
  }
  return node.kind === 'code' ? codeSource(node, graph, catalogue) : '';
}

/** The library names a stretch of source reaches for: every name it reads
 * and does not itself bind (`names.ts`), minus `params` — the node's own
 * input keys, which arrive as parameters and shadow the import. An unused
 * import is harmless; a missing one would not run. */
export function usedImports(body: string, catalogue: Catalogue, params: Iterable<string> = []): Imported[] {
  const declared = new Set(params);
  const free = freeNames(body);
  const out: Imported[] = [];
  for (const { module, names } of catalogue.importable) {
    for (const { name, spec } of names) {
      if (declared.has(name) || !free.has(name)) continue;
      out.push({ module, name, spec });
    }
  }
  return out;
}

/** The library types a stretch of source names. A type carries no value, so
 * it is imported with `import type` and never reaches the runtime. */
export function usedTypes(body: string, catalogue: Catalogue): { module: string; name: string }[] {
  const named = typeNames(body);
  const out: { module: string; name: string }[] = [];
  // A name two modules both export (`occlude` re-exports the 3D types) is
  // imported once, from the first that has it: importing it twice would not
  // compile.
  const seen = new Set<string>();
  for (const { module, names } of catalogue.importableTypes ?? []) {
    for (const name of names) {
      if (!named.has(name) || seen.has(name)) continue;
      seen.add(name);
      out.push({ module, name });
    }
  }
  return out;
}

/** The import lines for the emitted words and the code bodies' names.
 * `sketch` always comes first from `occlude`; a toolkit word is a member of
 * `t`, so it is never imported. */
function importLines(words: CatalogueWord[], extra: Imported[], types: { module: string; name: string }[] = []): string {
  const byModule = new Map<string, Set<string>>([['occlude', new Set<string>()]]);
  const add = (module: string, spec: string): void => {
    const set = byModule.get(module) ?? new Set<string>();
    set.add(spec);
    byModule.set(module, set);
  };
  for (const word of words) if (word.import !== null) add(word.module, word.import);
  for (const { module, spec } of extra) add(module, spec);
  // `sketch` always leads the `occlude` line, and that line always exists.
  const occlude = [...(byModule.get('occlude') ?? [])].sort();
  const lines = [`import { ${['sketch', ...occlude].join(', ')} } from 'occlude';`];
  for (const [module, specs] of byModule) {
    if (module === 'occlude' || specs.size === 0) continue;
    lines.push(`import { ${[...specs].sort().join(', ')} } from '${module}';`);
  }
  // The types the bodies name, after the values, one line per module.
  const byType = new Map<string, Set<string>>();
  for (const { module, name } of types) {
    const set = byType.get(module) ?? new Set<string>();
    set.add(name);
    byType.set(module, set);
  }
  for (const [module, names] of byType) {
    lines.push(`import type { ${[...names].sort().join(', ')} } from '${module}';`);
  }
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

/** How a viewer's own sketch is shaped: the expression it returns, and what
 * runs before it. A viewer on a material shows ink only through
 * `strokes(...)`, and one on a stepped material shows a frame of its
 * history; a probe in the prelude is how it reads the frame count back from
 * the run. Neither reaches the graph's compiled sketch, and the words either
 * one uses are imported for it. */
export interface Preview {
  wrap?: (expression: string) => string;
  prelude?: (expression: string) => string[];
}

/**
 * Compile the sub-graph that feeds one node's input into a whole sketch.
 * The target's input is the `return`, so a viewer renders what it reads.
 * A viewer and the output node both take their one input as `in`.
 */
export function compileFor(graph: Graph, catalogue: Catalogue, target: string, input: string, preview: Preview = {}): CompiledSketch {
  const order = topoOrder(graph);
  const wordsById = validate(graph, catalogue);
  const targetNode = nodeById(graph, target);
  const wanted = reachable(graph, target);
  const emitted = order.filter((id) => wanted.has(id));
  const nodes: CompiledNode[] = [];
  const words: CatalogueWord[] = [];
  const extra: Imported[] = [];
  /** The library types the bodies name: `import type`, never a value. */
  const types: { module: string; name: string }[] = [];
  const raw: string[] = [];
  const hashes = new Map<string, string>();
  for (const id of emitted) {
    const node = nodeById(graph, id);
    const word = wordsById.get(id);
    const source = nodeSource(node, word, graph, catalogue);
    if (word) words.push(word);
    if (node.kind === 'code') {
      extra.push(...usedImports(node.body!, catalogue, Object.keys(node.inputs)));
      types.push(...usedTypes(node.body!, catalogue));
    }
    for (const inp of Object.values(node.inputs)) if (isRaw(inp.value)) raw.push(inp.value.__raw);
    const upstream = Object.values(node.inputs)
      .map((inp) => (inp.from ? hashes.get(inp.from[0]) ?? '' : literal(inp.value)))
      .join(',');
    const nodeHash = hash(`${literal(graph.config)}\u0000${source}\u0000${upstream}`);
    hashes.set(id, nodeHash);
    nodes.push({ id, kind: node.kind, source, outputs: outputsOf(node, catalogue), hash: nodeHash });
  }
  raw.push(...rawTexts(graph.config));
  if (raw.length > 0) extra.push(...usedImports(raw.join('\n'), catalogue));
  const returned = inputExpression(targetNode, input, graph, catalogue);
  const expression = preview.wrap ? preview.wrap(returned) : returned;
  const prelude = preview.prelude ? preview.prelude(returned) : [];
  for (const line of prelude) extra.push(...usedImports(line, catalogue));
  if (preview.wrap) extra.push(...usedImports(preview.wrap(''), catalogue));
  const body = nodes.filter((n) => n.source !== '').map((n) => `  ${n.source.replace(/\n/g, '\n  ')}`);
  for (const line of prelude) body.push(`  ${line}`);
  const source = `${importLines(words, extra, types)}\n\nexport default sketch(${literal(graph.config)}, (t) => {\n${body.join('\n')}\n  return ${expression};\n});\n`;
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
