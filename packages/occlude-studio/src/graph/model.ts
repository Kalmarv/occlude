/**
 * The graph document: its socket vocabulary, its file shape, its
 * topological order. Pure data and pure functions — no DOM, no Rete.
 *
 * Sockets follow a geometry node's model rather than the library's class
 * list. One `Geometry` socket carries every geometric value, so the artist
 * wires one kind of dot and the node says what it makes of it. The
 * concrete kinds stay on the *inputs* (`takes`), which is where a wire can
 * be wrong, and on the file, where a code node declares what it returns.
 *
 * A graph is JSON saved beside sketches. A node is a built-in word, a code
 * node, a viewer or the output. Every input is a literal (`{ value }`), an
 * edge (`{ from: [nodeId, output] }`), or a control the node edits.
 */

/** The concrete kinds of geometry, in the library's own words. */
export const GEOMETRY_KINDS = ['shape', 'material', 'points', 'faces', 'mesh', 'curves', 'surface', 'drawing'] as const;
export type GeometryKind = (typeof GEOMETRY_KINDS)[number];

/** The socket classes: what a connection carries, at the granularity the
 * artist wires. */
export const SOCKET_CLASSES = ['Geometry', 'Number', 'Vector', 'Field', 'Fill', 'Camera', 'Modifier'] as const;
export type SocketClass = (typeof SOCKET_CLASSES)[number];

/** A value a code node declares, an input takes or a word returns. */
export type ValueType = GeometryKind | SocketClass;

export const isGeometryKind = (v: string): v is GeometryKind => (GEOMETRY_KINDS as readonly string[]).includes(v);
export const isSocketClass = (v: string): v is SocketClass => (SOCKET_CLASSES as readonly string[]).includes(v);
export const isValueType = (v: string): v is ValueType => isGeometryKind(v) || isSocketClass(v);

/** The socket a value travels on. */
export function socketOf(type: ValueType): SocketClass {
  return isGeometryKind(type) ? 'Geometry' : type;
}

/** The kind a value has, when it is geometry. */
export function kindOf(type: ValueType): GeometryKind | undefined {
  return isGeometryKind(type) ? type : undefined;
}

/** What an input takes: a socket class, and for geometry the kinds it
 * makes something of. `kinds` absent means any geometry. */
export interface Takes {
  socket: SocketClass;
  kinds?: GeometryKind[];
  /** Anything at all fits here. A list's places do: a list is a JavaScript
   * array, and the socket class is only what colours its dot. */
  any?: boolean;
}

/** A literal-only input: the node edits it, and nothing wires into it. */
export type ControlKind = 'number' | 'text' | 'check' | 'menu';

/** Whether an output may feed an input. A Field takes a Number as a
 * constant field. A geometry input takes the kinds it names. */
export function accepts(output: ValueType, takes: Takes): boolean {
  // A list is a JavaScript array: it holds whatever it is given, and the
  // library judges what that means when it is drawn.
  if (takes.any) return true;
  if (takes.socket === 'Field') return output === 'Field' || output === 'Number';
  if (socketOf(output) !== takes.socket) return false;
  if (takes.socket !== 'Geometry' || !takes.kinds) return true;
  // `Geometry` with no kind is geometry whose kind the graph does not know —
  // what a code node's output is when the importer could not tell. It fits
  // any geometry socket, and the library judges it at render, which is the
  // best-effort rule the rest of the engine follows. A named kind is still
  // checked against the socket.
  if (output === 'Geometry') return true;
  const kind = kindOf(output);
  if (kind === undefined) return false;
  if (takes.kinds.includes(kind)) return true;
  // A shape *is* a drawing. An input that takes what a sketch may draw takes
  // a shape too — `clip(region, children)` declares `children` a drawing
  // because its type is the whole tree, and `clip(sheet, ellipse(…))` is the
  // ordinary way to write it. The reverse is not true: a group is not a
  // shape, and a material is not ink at all.
  return kind === 'shape' && takes.kinds.includes('drawing');
}

/** One option of an options record. */
export interface CatalogueOption {
  /** The control holds source text, written into the sketch as it stands: a
   * parameter no socket and no control can say. */
  raw?: boolean;
  name: string;
  takes?: Takes;
  control?: ControlKind;
  /** A menu's choices, in the order the type writes them. */
  choices?: string[];
  optional: boolean;
}

/** A parameter of a built-in word, in call order. A plain parameter
 * carries one input; an options record carries one input per option. */
export interface CatalogueParam {
  /** The control holds source text, written into the sketch as it stands. */
  raw?: boolean;
  name: string;
  takes?: Takes;
  control?: ControlKind;
  choices?: string[];
  optional: boolean;
  options?: CatalogueOption[];
}

/** One input of a built-in word: a plain parameter, one option, or the
 * receiver a method hangs off. */
export interface CatalogueInput {
  /** The control holds source text, written into the sketch as it stands. */
  raw?: boolean;
  /** The key inside a node's `inputs`. */
  name: string;
  /** The parameter it belongs to. */
  param: string;
  /** The option name, when it is an option of an options record. */
  option?: string;
  takes?: Takes;
  control?: ControlKind;
  choices?: string[];
  optional: boolean;
  /** True for the receiver of a value method: `m.steps` takes a material. */
  self?: boolean;
}

/** One exported word, as the catalogue carries it. */
export interface CatalogueWord {
  /** The word is a value, not a call: `t.cx` is the middle of the drawable,
   * and the compiled sketch writes it with no parentheses. */
  value?: boolean;
  /** As the reference writes it: `circle`, `t.sample`, `connect.dots`,
   * `3d.box`. Unique across the catalogue. */
  word: string;
  module: 'occlude' | 'occlude/3d';
  /** null imports the word by name; `t` is the toolkit; else a namespace
   * object imported by name (`connect`, `force`, `query`, `ease`, `sdf`). */
  receiver: string | null;
  /** The import specifier, exactly as it goes between the braces:
   * `circle`, `connect`, or `circle as circle3` when both modules export
   * the name. Null for a toolkit word, which is a member of `t`. */
  import: string | null;
  /** How a compiled sketch calls it: `circle`, `t.sample` (a host that
   * already has its own `circle` imports the 3D one as `circle3`). A value
   * method carries `{self}` where its receiver goes: `{self}.steps`. */
  call: string;
  /** The receiver a value method hangs off (`m.steps` takes a material).
   * It is the node's first input, and it is not a call argument. */
  self?: { param: string; takes: Takes };
  params: CatalogueParam[];
  returns: ValueType;
  /** The reference page it links to, `/docs/reference/<page>`. */
  page: string;
  /** The page's title, for the palette grouping. */
  group: string;
}

export interface Catalogue {
  words: CatalogueWord[];
  /** Every name a sketch may import from each module: the name a body must
   * spell, and the specifier that binds it (`circle3` ← `circle as
   * circle3`). A code node body is TypeScript the compiler does not parse,
   * so the names it reaches for are read from here. A host adds its own
   * module here — the pen and paper libraries are `@user/pens` and
   * `@user/papers`, and a body may name one of their pens. */
  importable: { module: string; names: { name: string; spec: string }[] }[];
  /** Every type name a sketch may import from each module. A code node body
   * is ordinary TypeScript: it may say `as Vec3` or annotate a parameter,
   * and the compiled sketch has to declare that name or it does not
   * typecheck — in the node's own editor, and in the studio after "Open as
   * sketch". A class is in `importable` already; these are the aliases and
   * interfaces, which carry no value. */
  importableTypes?: { module: string; names: string[] }[];
}

const lookups = new WeakMap<Catalogue, Map<string, CatalogueWord>>();

/** The catalogue's entry for a word, or undefined. */
export function wordOf(catalogue: Catalogue, word: string): CatalogueWord | undefined {
  let byWord = lookups.get(catalogue);
  if (!byWord) {
    byWord = new Map(catalogue.words.map((w) => [w.word, w]));
    lookups.set(catalogue, byWord);
  }
  return byWord.get(word);
}

/** A word's inputs in the order its call takes them. An option whose name
 * is already taken is qualified with its record, so a key is unique. */
export function wordInputs(word: CatalogueWord): CatalogueInput[] {
  const out: CatalogueInput[] = [];
  const seen = new Set<string>();
  if (word.self) {
    seen.add(word.self.param);
    out.push({ name: word.self.param, param: word.self.param, takes: word.self.takes, optional: false, self: true });
  }
  for (const p of word.params) {
    if (!p.options) {
      seen.add(p.name);
      out.push({ name: p.name, param: p.name, takes: p.takes, control: p.control, choices: p.choices, raw: p.raw, optional: p.optional });
      continue;
    }
    for (const o of p.options) {
      const name = seen.has(o.name) ? `${p.name}.${o.name}` : o.name;
      seen.add(name);
      out.push({ name, param: p.name, option: o.name, takes: o.takes, control: o.control, choices: o.choices, raw: o.raw, optional: o.optional });
    }
  }
  return out;
}

// ---- the document ----

/**
 * `value` is a literal the graph holds: a number the artist drags, a vector.
 * The sketch's own `const boxSpread = 30;` is one, and without it the
 * importer had to make a code node whose whole body was `return { out: 30 }`
 * — a function call to say thirty.
 *
 * `list` is several values as one: `[insets, filledRender, accent]`, which is
 * what a sketch returns when it draws more than one thing, and what a word
 * takes when it takes a collection. Its inputs are numbered, and one of them
 * may carry a whole collection (`...boxes`) rather than one value.
 */
export type NodeKind = 'builtin' | 'code' | 'viewer' | 'output' | 'group' | 'input' | 'value' | 'list';

/** An input: a literal, an edge, or (for code nodes) the edge's type. */
export interface GraphInput {
  value?: unknown;
  from?: [string, string];
  /** Code nodes declare the value type of each input. */
  type?: ValueType;
  /** The wire carries the call's arguments, not one of them:
   * `t.material(...shapes)`. A variadic word takes one socket, and this is
   * what says whether the collection on it is the arguments or a single
   * value — `t.material(shape)` and `t.material(...shapes)` are different
   * calls, and the library judges a bare array as one shape. */
  spread?: boolean;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  /** The size the artist dragged the node to, in area units. Absent means
   * the body sizes itself to its content, as every node did before. */
  width?: number;
  height?: number;
  inputs: Record<string, GraphInput>;
  /** Built-in nodes: the catalogue word. A group node: the group's name. */
  word?: string;
  /** Code nodes: declared outputs, and the body. */
  outputs?: Record<string, ValueType>;
  body?: string;
}

export interface Graph {
  version: 1;
  name: string;
  /** The sketch config object, verbatim. */
  config: Record<string, unknown>;
  nodes: GraphNode[];
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const KINDS: readonly NodeKind[] = ['builtin', 'code', 'viewer', 'output', 'group', 'input', 'value', 'list'];
/** Words a compiled sketch cannot bind: a node id becomes a `const`, and a
 * code node's keys become parameters. */
const RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof',
  'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

/** A name a compiled sketch may bind. */
function isUsableName(name: string): boolean {
  return IDENT.test(name) && !RESERVED.has(name);
}

/** The JSON boundary. `what` names the field for the message. */
function expectObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`graph: ${what} is not an object`);
  return raw as Record<string, unknown>;
}

function parseValueType(raw: unknown, what: string): ValueType {
  if (typeof raw !== 'string' || !isValueType(raw)) throw new Error(`graph: ${what} has unknown type ${JSON.stringify(raw)}`);
  return raw;
}

function parseInput(node: string, key: string, raw: unknown): GraphInput {
  const r = expectObject(raw, `node ${node} input ${key}`);
  const out: GraphInput = {};
  if (r.value !== undefined) out.value = r.value;
  if (r.from !== undefined) {
    const from = r.from;
    if (!Array.isArray(from) || from.length !== 2 || typeof from[0] !== 'string' || typeof from[1] !== 'string') {
      throw new Error(`graph: node ${node} input ${key} has a bad edge (expected ["nodeId", "output"])`);
    }
    out.from = [from[0], from[1]];
  }
  if (r.type !== undefined) out.type = parseValueType(r.type, `node ${node} input ${key}`);
  if (r.spread === true) {
    if (out.from === undefined) throw new Error(`graph: node ${node} input ${key} spreads a value that is not an edge`);
    out.spread = true;
  }
  if (out.value === undefined && out.from === undefined) throw new Error(`graph: node ${node} input ${key} is neither a value nor an edge`);
  return out;
}

function parseNode(raw: unknown): GraphNode {
  const r = expectObject(raw, 'a node');
  const id = r.id;
  if (typeof id !== 'string' || !isUsableName(id)) throw new Error(`graph: bad node id ${JSON.stringify(id)} (letters, digits, _ and $ only, and not a reserved word)`);
  if (!KINDS.includes(r.kind as NodeKind)) throw new Error(`graph: node ${id} has unknown kind ${String(r.kind)}`);
  const kind = r.kind as NodeKind;
  const x = typeof r.x === 'number' && Number.isFinite(r.x) ? r.x : 0;
  const y = typeof r.y === 'number' && Number.isFinite(r.y) ? r.y : 0;
  const rawInputs = expectObject(r.inputs ?? {}, `node ${id} inputs`);
  const inputs: Record<string, GraphInput> = {};
  for (const [key, value] of Object.entries(rawInputs)) inputs[key] = parseInput(id, key, value);
  const node: GraphNode = { id, kind, x, y, inputs };
  if (typeof r.width === 'number' && Number.isFinite(r.width) && r.width > 0) node.width = r.width;
  if (typeof r.height === 'number' && Number.isFinite(r.height) && r.height > 0) node.height = r.height;
  if (kind === 'builtin') {
    if (typeof r.word !== 'string' || r.word === '') throw new Error(`graph: node ${id} is a built-in with no word`);
    node.word = r.word;
  }
  if (kind === 'group') {
    if (typeof r.word !== 'string' || r.word === '') throw new Error(`graph: node ${id} is a group with no name`);
    node.word = r.word;
  }
  // A value node declares what its literal is: the socket the wire out of it
  // travels on.
  if (kind === 'value') {
    const type = r.outputs === undefined ? 'Number' : parseValueType(expectObject(r.outputs, `value node ${id} outputs`).out, `value node ${id} output`);
    node.outputs = { out: type };
    if (node.inputs['v'] === undefined) throw new Error(`graph: value node ${id} holds no value`);
  }
  // A list is what it collects: numbered inputs, and one drawing out.
  if (kind === 'list') {
    node.outputs = { out: 'drawing' };
    for (const key of Object.keys(node.inputs)) {
      if (!/^\d+$/.test(key)) throw new Error(`graph: list node ${id} input ${key} is not a place in the list`);
    }
  }
  // A group node's boundary and a group's own `input` node declare outputs
  // without a body, the way a code node does.
  if ((kind === 'group' || kind === 'input') && r.outputs !== undefined) {
    const rawOutputs = expectObject(r.outputs, `${kind === 'group' ? 'group' : 'input'} node ${id} outputs`);
    const outputs: Record<string, ValueType> = {};
    for (const [key, value] of Object.entries(rawOutputs)) {
      if (!isUsableName(key)) throw new Error(`graph: node ${id} output name ${JSON.stringify(key)} is not a usable identifier`);
      outputs[key] = parseValueType(value, `node ${id} output ${key}`);
    }
    node.outputs = outputs;
  }
  if (kind === 'code') {
    if (typeof r.body !== 'string') throw new Error(`graph: code node ${id} has no body`);
    node.body = r.body;
    for (const key of Object.keys(inputs)) {
      if (!isUsableName(key) || key === 't') throw new Error(`graph: code node ${id} input name ${JSON.stringify(key)} is not a usable identifier`);
    }
    const rawOutputs = expectObject(r.outputs ?? {}, `code node ${id} outputs`);
    const outputs: Record<string, ValueType> = {};
    for (const [key, value] of Object.entries(rawOutputs)) {
      if (!isUsableName(key)) throw new Error(`graph: code node ${id} output name ${JSON.stringify(key)} is not a usable identifier`);
      outputs[key] = parseValueType(value, `code node ${id} output ${key}`);
    }
    if (Object.keys(outputs).length === 0) throw new Error(`graph: code node ${id} declares no outputs`);
    node.outputs = outputs;
  }
  return node;
}

/** Validate a parsed JSON document as a graph. Throws a message that names
 * the offending node or field. */
export function parseGraph(raw: unknown): Graph {
  const doc = expectObject(raw, 'the document');
  if (doc.version !== 1) throw new Error(`graph: unsupported version ${String(doc.version)} (this build reads version 1)`);
  if (!Array.isArray(doc.nodes)) throw new Error('graph: nodes is not an array');
  const nodes = doc.nodes.map(parseNode);
  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) throw new Error(`graph: duplicate node id ${n.id}`);
    ids.add(n.id);
  }
  for (const n of nodes) {
    for (const [key, input] of Object.entries(n.inputs)) {
      if (input.from && !ids.has(input.from[0])) throw new Error(`graph: node ${n.id} input ${key} reads missing node ${input.from[0]}`);
    }
  }
  return {
    version: 1,
    name: typeof doc.name === 'string' && doc.name !== '' ? doc.name : 'untitled',
    config: doc.config === undefined ? {} : expectObject(doc.config, 'config'),
    nodes,
  };
}

/** The graph as the file holds it: stable key order, two-space indent. */
export function graphToJson(graph: Graph): string {
  return JSON.stringify(
    {
      version: 1,
      name: graph.name,
      config: graph.config,
      nodes: graph.nodes.map((n) => {
        const out: Record<string, unknown> = { id: n.id, kind: n.kind };
        if (n.word !== undefined) out.word = n.word;
        out.x = n.x;
        out.y = n.y;
        if (n.width !== undefined) out.width = n.width;
        if (n.height !== undefined) out.height = n.height;
        out.inputs = n.inputs;
        if (n.outputs !== undefined) out.outputs = n.outputs;
        if (n.body !== undefined) out.body = n.body;
        return out;
      }),
    },
    null,
    2,
  ) + '\n';
}

/** The graph in topological order: a node comes after everything it reads.
 * Nodes keep their file order among equals, so the order is stable. A cycle
 * throws with the nodes it found. */
export function topoOrder(graph: Graph): string[] {
  const index = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  const consumers = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const node of graph.nodes) {
    for (const input of Object.values(node.inputs)) {
      if (!input.from) continue;
      if (!consumers.has(input.from[0])) throw new Error(`graph: node ${node.id} reads missing node ${input.from[0]}`);
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      consumers.get(input.from[0])!.push(node.id);
    }
  }
  const ready = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
    const id = ready.shift()!;
    order.push(id);
    for (const next of consumers.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) ready.push(next);
    }
  }
  if (order.length !== graph.nodes.length) {
    // Only the nodes of the cycle: drop the stuck nodes that merely read a
    // cycle member, or the message sends the artist to an innocent node.
    const stuck = new Set(graph.nodes.filter((n) => !order.includes(n.id)).map((n) => n.id));
    const readsStuck = (id: string): boolean => {
      const node = graph.nodes.find((n) => n.id === id);
      return node !== undefined && Object.values(node.inputs).some((input) => input.from !== undefined && stuck.has(input.from[0]));
    };
    for (let pass = 0; pass < graph.nodes.length; pass++) {
      const innocent = [...stuck].filter((id) => !readsStuck(id));
      if (innocent.length === 0) break;
      for (const id of innocent) stuck.delete(id);
    }
    throw new Error(`graph: cycle between ${[...stuck].join(', ')}`);
  }
  return order;
}

/** What each input of a node takes. Built-in nodes read the catalogue; code
 * nodes declare their own; a viewer takes anything. */
export function inputTakes(node: GraphNode, catalogue: Catalogue): Record<string, Takes | undefined> {
  if (node.kind === 'builtin') {
    const word = wordOf(catalogue, node.word!);
    if (!word) return {};
    return Object.fromEntries(wordInputs(word).map((i) => [i.name, i.takes]));
  }
  if (node.kind === 'code') {
    return Object.fromEntries(Object.entries(node.inputs).map(([key, input]) => {
      const type = input.type ?? 'drawing';
      return [key, { socket: socketOf(type), kinds: kindOf(type) ? [kindOf(type)!] : undefined }];
    }));
  }
  // The output node takes what a sketch may return: shapes and drawings.
  if (node.kind === 'output') return { in: { socket: 'Geometry', kinds: ['shape', 'drawing'] } };
  // A list takes any geometry in every place it holds, and in one more: a
  // list with nowhere left to wire is a list you cannot add to.
  if (node.kind === 'list') {
    return Object.fromEntries(listPlaces(node).map((key) => [key, { socket: 'Geometry' as const, any: true }]));
  }
  return {};
}

/**
 * A list's places, in order, plus the free one at the end. The document holds
 * only the places something is wired to; the free place is where the next
 * thing goes, and it becomes real the moment a wire lands on it.
 */
export function listPlaces(node: GraphNode): string[] {
  const held = Object.keys(node.inputs).map(Number).filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
  const next = held.length === 0 ? 0 : held[held.length - 1]! + 1;
  return [...held.map(String), String(next)];
}

/** The value type of one output of a node, or undefined when the node has
 * no such output. */
export function outputType(node: GraphNode, name: string, catalogue: Catalogue): ValueType | undefined {
  if (node.kind === 'builtin') {
    const word = wordOf(catalogue, node.word!);
    return name === 'out' ? word?.returns : undefined;
  }
  if (node.kind === 'code' || node.kind === 'value' || node.kind === 'list') return node.outputs?.[name];
  return undefined;
}
