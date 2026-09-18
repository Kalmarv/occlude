/**
 * Sketch to graph: read an existing sketch as a graph document.
 *
 * Parsing only — `ts.createSourceFile`, no program and no checker — so the
 * studio can turn the sketch in its editor into a canvas without a build.
 *
 * The walk is deliberately literal. One node per top-level `const`, with the
 * name the sketch gave it as the id. The initializer is a built-in node when
 * it is one call of a catalogue word whose arguments map cleanly onto that
 * word's inputs; it is a code node otherwise.
 *
 * A statement that is not a declaration is code the graph must keep, never
 * drop. The graph has no wire for order, so the two cases are told apart by
 * what the rest of the sketch reads: a statement that gives a name a new
 * value is a node of its own, because that value has to flow; anything else —
 * a `for` that grows an array, `t.plan` — joins the body of the next node, and
 * runs where it ran.
 *
 * The code-node contract is what makes this cheap (see `compile.ts`). A code
 * node's body is the source's own text, and its inputs are the free names
 * that refer to earlier nodes. The compiler passes those in as parameters
 * named exactly as the sketch named them, so the body runs unchanged.
 *
 * Two shapes the JSON document cannot spell keep their own source text as
 * `{ __raw }` (`RawValue` in `compile.ts`): a config value that is a call
 * (`pen({ width: mm(0.3) })`) and an option value that is not a literal.
 */

import ts from 'typescript';

import { estimateBox, layoutGraph } from './layout.js';
import {
  accepts, wordInputs,
  type Catalogue, type CatalogueInput, type CatalogueParam, type CatalogueWord,
  type Graph, type GraphInput, type GraphNode, type Takes, type ValueType, type ZoneKind,
} from './model.js';

/** What the output node takes: what a sketch may return (`model.ts`). */
const OUTPUT_TAKES: Takes = { socket: 'Geometry', kinds: ['shape', 'drawing'] };

/** The operators that make a number out of numbers. */
const ARITHMETIC: ts.SyntaxKind[] = [
  ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
];

/** The namespaces a sketch imports as an object (`connect.chain`). */
const NAMESPACES = ['connect', 'force', 'query', 'ease', 'sdf'];

/** A name's current value: the node and output that produce it. */
interface Binding {
  node: GraphNode;
  output: string;
  type: ValueType;
}

/** Why one statement could not be a built-in node. The coverage report reads
 * these: a word that is in the palette and still became code is a gap worth
 * closing, and the reason names which one. */
export interface ImportRefusal {
  /** The node id the statement became. */
  node: string;
  /** The word the call names, when it names one the catalogue carries. */
  word?: string;
  reason: string;
}

/** Read a sketch source as a graph. Throws an Error naming what it cannot
 * read. `refusals`, when given, collects why each statement that could have
 * been a built-in node is a code node instead. */
export function importSketch(source: string, catalogue: Catalogue, refusals?: ImportRefusal[]): Graph {
  const file = ts.createSourceFile('sketch.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const graph = new Reader(file, catalogue, refusals).read();
  layout(graph, catalogue);
  return graph;
}

class Reader {
  private readonly nodes: GraphNode[] = [];
  private readonly byId = new Map<string, GraphNode>();
  private readonly taken = new Set<string>();
  private readonly bindings = new Map<string, Binding>();
  /** The word a local import name stands for. A sketch that imports `circle`
   * from `occlude/3d` means the 3D circle, which the catalogue keys
   * `3d.circle`. */
  private readonly imported = new Map<string, CatalogueWord>();
  /** The namespace object a local name stands for (`import { connect }`). */
  private readonly namespaces = new Map<string, string>();
  /** The name the catalogue binds an imported word to, where the sketch
   * spells it differently: `disc` (imported as `circle`) → `circle`, a 3D
   * `circle` → `circle3`. A body keeps the sketch's words; the compiled
   * sketch imports the library's. */
  private readonly aliases = new Map<string, string>();
  /** Every name the sketch function declares anywhere: a name that is both an
   * alias and a local is the local, and is left alone. */
  private readonly shadowed = new Set<string>();
  /** The declaration the sketch's config came from, when it came from one:
   * it is the document's config, so it is not read as a node too. */
  private configDecl: ts.VariableDeclaration | undefined;
  /** The word a call text names: `t.sample`, `connect.chain`, `box`. */
  private readonly byCall = new Map<string, CatalogueWord>();
  private readonly byWord = new Map<string, CatalogueWord>();

  constructor(private readonly file: ts.SourceFile, private readonly catalogue: Catalogue, private readonly refusals?: ImportRefusal[]) {
    for (const word of catalogue.words) {
      this.byWord.set(word.word, word);
      if (!this.byCall.has(word.call)) this.byCall.set(word.call, word);
    }
    // A node id is a `const` beside the sketch's imports and its toolkit, so
    // it may not be a name any of them bind. The compiler refuses one, and a
    // sketch with `const circle = …` is ordinary. Reserving every importable
    // name up front — not only the ones this graph happens to import — keeps
    // an id from moving when a later edit adds an import.
    this.taken.add('t');
    this.taken.add('sketch');
    for (const name of NAMESPACES) this.taken.add(name);
    for (const entry of catalogue.importable) {
      for (const { name, spec } of entry.names) {
        this.taken.add(name);
        this.taken.add(spec.split(' as ')[0]!);
      }
    }
  }

  read(): Graph {
    this.readImports();
    const call = this.sketchCall();
    const [config, fn] = this.argumentsOf(call);
    bindNames(fn, this.shadowed);
    const body = fn.body;
    const returned = ts.isBlock(body) ? this.returnOf(body) : body;
    const statements = ts.isBlock(body) ? [...body.statements] : [];
    // A helper declared beside the sketch (`const ART = \`<svg …>\``) is a
    // node too: the body reads it.
    for (const st of this.file.statements) {
      if (ts.isImportDeclaration(st) || ts.isExportAssignment(st)) continue;
      if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) {
          // The config's own `const` is the document's config, not a node.
          if (decl === this.configDecl) continue;
          this.readDeclaration(decl, []);
        }
        continue;
      }
      throw new Error(`cannot read ${describe(st)} at line ${this.line(st)}`);
    }
    // What each statement still needs: the statements after it, and the
    // return.
    const needed = statements.map((_, i) => {
      const names = new Set<string>();
      for (const later of statements.slice(i + 1)) for (const id of reads(later)) names.add(id.text);
      for (const id of reads(returned)) names.add(id.text);
      return names;
    });
    // A statement that only *does* something — a `for` that grows an array,
    // `t.plan` — has no value to hand on, and the graph has no wire for
    // order. It joins the body of the next node instead: the code keeps
    // running where it ran. A statement that gives a name a new value the
    // rest of the sketch reads is a node of its own, because that value has
    // to flow.
    let pending: ts.Statement[] = [];
    const flush = (): ts.Statement[] => {
      const held = pending;
      pending = [];
      return held;
    };
    statements.forEach((st, i) => {
      if (ts.isReturnStatement(st)) return; // the output node
      if (ts.isVariableStatement(st)) {
        const before = flush();
        for (const decl of st.declarationList.declarations) this.readDeclaration(decl, before);
        return;
      }
      const assigned = [...assignedNames(st)].filter((name) => this.bindings.has(name) && needed[i]!.has(name));
      if (assigned.length > 0) {
        this.readStatement(st, flush(), assigned);
        return;
      }
      pending.push(st);
    });
    this.readOutput(returned, flush());
    return { version: 1, name: '', config, nodes: this.nodes };
  }

  // ---- the sketch call ----

  /** `export default sketch(config, (t) => …)` or `sketchAsync`. */
  private sketchCall(): ts.CallExpression {
    for (const st of this.file.statements) {
      if (!ts.isExportAssignment(st) || st.isExportEquals) continue;
      if (!ts.isCallExpression(st.expression)) {
        throw new Error(`cannot read ${describe(st.expression)} at line ${this.line(st)} (a sketch exports sketch(...) or sketchAsync(...))`);
      }
      const callee = st.expression.expression;
      const name = ts.isIdentifier(callee) ? callee.text : this.text(callee);
      if (name !== 'sketch' && name !== 'sketchAsync') {
        throw new Error(`cannot read ${this.text(callee)} at line ${this.line(st)} (a sketch exports sketch(...) or sketchAsync(...))`);
      }
      return st.expression;
    }
    throw new Error('cannot read the sketch: the source has no default export');
  }

  private argumentsOf(call: ts.CallExpression): [Record<string, unknown>, ts.ArrowFunction | ts.FunctionExpression] {
    const [first, second] = call.arguments;
    if (!first) throw new Error(`cannot read the sketch call at line ${this.line(call)} (it has no arguments)`);
    const firstObject = first && this.objectOf(first);
    if (firstObject) {
      if (!second) throw new Error(`cannot read the sketch call at line ${this.line(call)} (it has no function)`);
      return [this.configOf(firstObject), this.functionOf(second)];
    }
    const secondObject = second && this.objectOf(second);
    return [secondObject ? this.configOf(secondObject) : {}, this.functionOf(first)];
  }

  /** The object a config argument is: written out, or held in a `const`
   * above the call (`const sketchConfig = { … }`). The name is the sketch's
   * own, and the config belongs to the document, not to a node. */
  private objectOf(expr: ts.Expression): ts.ObjectLiteralExpression | undefined {
    if (ts.isObjectLiteralExpression(expr)) return expr;
    if (!ts.isIdentifier(expr)) return undefined;
    for (const st of this.file.statements) {
      if (!ts.isVariableStatement(st)) continue;
      for (const decl of st.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== expr.text) continue;
        if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) return undefined;
        this.configDecl = decl;
        return decl.initializer;
      }
    }
    return undefined;
  }

  private functionOf(node: ts.Expression): ts.ArrowFunction | ts.FunctionExpression {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
    throw new Error(`cannot read ${describe(node)} at line ${this.line(node)} (the sketch's function)`);
  }

  private returnOf(block: ts.Block): ts.Expression {
    for (const st of block.statements) {
      if (!ts.isReturnStatement(st)) continue;
      if (!st.expression) throw new Error(`cannot read the sketch's return at line ${this.line(st)} (it returns nothing)`);
      return st.expression;
    }
    throw new Error(`cannot read the sketch at line ${this.line(block)} (it returns nothing)`);
  }

  // ---- the imports: which word a name in this source means ----

  private readImports(): void {
    for (const st of this.file.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const module = st.moduleSpecifier.text;
      const named = st.importClause?.namedBindings;
      if (!named || !ts.isNamedImports(named)) continue;
      for (const spec of named.elements) {
        const exported = spec.propertyName?.text ?? spec.name.text;
        const local = spec.name.text;
        const word = this.catalogue.words.find(
          (w) => w.receiver === null && w.import !== null && w.module === module && w.import.split(' as ')[0] === exported,
        );
        // The name the catalogue binds the word to: `circle3` for the 3D
        // circle, whose own word the catalogue does not carry.
        const catalogue = word?.call
          ?? this.catalogue.importable.find((i) => i.module === module)?.names.find((n) => n.spec.split(' as ')[0] === exported)?.name;
        if (catalogue && catalogue !== local) this.aliases.set(local, catalogue);
        if (word) {
          this.imported.set(local, word);
          continue;
        }
        if (module === 'occlude' && NAMESPACES.includes(exported)) this.namespaces.set(local, exported);
      }
    }
  }

  /** The catalogue word a callee names, when it names one. Only a name the
   * sketch imported, a toolkit member (`t.sample`) or a namespace member
   * (`connect.chain`) is a word: anything else is a function the sketch
   * holds, and its call stays a code node. */
  private wordFor(expr: ts.Expression): CatalogueWord | undefined {
    if (ts.isIdentifier(expr)) return this.imported.get(expr.text);
    if (!ts.isPropertyAccessExpression(expr)) return undefined;
    const owner = expr.expression;
    if (!ts.isIdentifier(owner) || this.bindings.has(owner.text)) return undefined;
    const ns = this.namespaces.get(owner.text);
    // The call's own text, with the source's line breaks taken out: a chain
    // written down the page (`t\n  .material(...)`) names the same word as
    // one written along it.
    return this.byCall.get(ns ? `${ns}.${expr.name.text}` : `${owner.text}.${expr.name.text}`);
  }

  // ---- the config ----

  /** The sketch config, verbatim: a JSON literal where the source is one,
   * `{ __raw }` where it is not. A spread or a computed key leaves the whole
   * object to the compiler's own text. */
  private configOf(obj: ts.ObjectLiteralExpression): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const prop of obj.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        out[prop.name.text] = { __raw: this.code(prop.name) };
        continue;
      }
      if (!ts.isPropertyAssignment(prop)) return { __raw: this.code(obj) };
      const key = this.propertyName(prop.name);
      if (key === undefined) return { __raw: this.code(obj) };
      out[key] = this.value(prop.initializer);
    }
    return out;
  }

  private propertyName(name: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    return undefined;
  }

  /** A value the document can hold: JSON when the source is one, the source's
   * own text when it is not (`{ __raw }`, written back verbatim). A nested
   * member is decided on its own, so a pen keeps its name and a call in it
   * keeps its text. */
  private value(expr: ts.Expression): unknown {
    if (ts.isArrayLiteralExpression(expr)) return expr.elements.map((element) => this.value(element));
    if (ts.isObjectLiteralExpression(expr)) {
      const out: Record<string, unknown> = {};
      for (const prop of expr.properties) {
        if (!ts.isPropertyAssignment(prop)) return { __raw: this.code(expr) };
        const key = this.propertyName(prop.name);
        if (key === undefined) return { __raw: this.code(expr) };
        out[key] = this.value(prop.initializer);
      }
      return out;
    }
    const literal = this.literal(expr);
    return literal === undefined ? { __raw: this.code(expr) } : literal;
  }

  /** A JSON literal, or undefined when the expression is anything else. No
   * literal is `undefined`, so the two never meet. */
  private literal(expr: ts.Expression): unknown {
    if (ts.isNumericLiteral(expr)) return Number(expr.text);
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (expr.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isPrefixUnaryExpression(expr) && ts.isNumericLiteral(expr.operand)) {
      if (expr.operator === ts.SyntaxKind.MinusToken) return -Number(expr.operand.text);
      if (expr.operator === ts.SyntaxKind.PlusToken) return Number(expr.operand.text);
    }
    if (ts.isArrayLiteralExpression(expr)) {
      const out: unknown[] = [];
      for (const element of expr.elements) {
        const value = this.literal(element);
        if (value === undefined) return undefined;
        out.push(value);
      }
      return out;
    }
    if (ts.isObjectLiteralExpression(expr)) {
      const out: Record<string, unknown> = {};
      for (const prop of expr.properties) {
        if (!ts.isPropertyAssignment(prop)) return undefined;
        const key = this.propertyName(prop.name);
        if (key === undefined) return undefined;
        const value = this.literal(prop.initializer);
        if (value === undefined) return undefined;
        out[key] = value;
      }
      return out;
    }
    return undefined;
  }

  // ---- the body ----

  /** One `const NAME = …` (or a destructuring declaration): a built-in node
   * when the initializer is one call of a catalogue word that maps cleanly,
   * a code node otherwise. Statements that ran before it — and that nothing
   * reads — join its body, so the built-in call gives way to code when they
   * do. */
  private readDeclaration(decl: ts.VariableDeclaration, before: ts.Statement[]): void {
    const expr = decl.initializer;
    if (!expr) throw new Error(`cannot read a declaration with no value at line ${this.line(decl)}`);
    if (ts.isIdentifier(decl.name)) {
      const name = decl.name.text;
      const id = this.uniqueId(name);
      let builtin: { node: GraphNode; word: CatalogueWord } | undefined;
      if (before.length > 0) this.refuse(id, undefined, 'a statement before it joined this node');
      else if (!ts.isCallExpression(expr) && this.valueWordOf(expr)) {
        const word = this.valueWordOf(expr)!;
        const node = this.add({ id, kind: 'builtin', word: word.word, x: 0, y: 0, inputs: {} });
        this.bindings.set(name, { node, output: 'out', type: word.returns });
        return;
      } else if (!ts.isCallExpression(expr)) {
        // A literal is a value the graph holds, not a body that computes
        // one: `const boxSpread = 30;` was a code node whose whole text was
        // `return { out: 30 }` — a function call to say thirty.
        const value = this.valueNode(expr, id);
        if (value) {
          this.add(value.node);
          this.bindings.set(name, { node: value.node, output: 'out', type: value.type });
          return;
        }
        if (ts.isArrayLiteralExpression(expr)) {
          const list = this.listNode(expr, id);
          if (list) {
            this.add(list);
            this.bindings.set(name, { node: list, output: 'out', type: 'drawing' });
            return;
          }
        }
        this.refuse(id, undefined, `the value is ${describe(expr)}, not a call`);
      } else {
        // A body that runs many times is a zone, not a code node.
        const zone = this.zoneNode(expr, id);
        if (zone) {
          this.add(zone);
          this.bindings.set(name, { node: zone, output: 'out', type: 'Geometry' });
          return;
        }
        builtin = this.tryBuiltin(expr, id);
      }
      if (builtin) {
        this.add(builtin.node);
        this.bindings.set(name, { node: builtin.node, output: 'out', type: builtin.word.returns });
        return;
      }
      const type = this.typeOf(expr);
      const node = this.add({
        id,
        kind: 'code',
        x: 0,
        y: 0,
        inputs: this.inputsOf([...before, expr]),
        outputs: { out: type },
        body: `${this.codeBefore(before)}return { out: ${this.code(expr)} };`,
      });
      this.bindings.set(name, { node, output: 'out', type });
      return;
    }
    // `const [low, mid, high] = …`: one node, one output per bound name.
    const names = boundNames(decl.name);
    if (names.length === 0) throw new Error(`cannot read the declaration at line ${this.line(decl)}`);
    const outputs: Record<string, ValueType> = {};
    for (const name of names) outputs[name] = 'drawing';
    const node = this.add({
      id: this.uniqueId(names[0]!),
      kind: 'code',
      x: 0,
      y: 0,
      inputs: this.inputsOf([...before, expr]),
      outputs,
      body: `${this.codeBefore(before)}const ${this.text(decl.name)} = ${this.code(expr)};\nreturn { ${names.map((n) => `${n}: ${n}`).join(', ')} };`,
    });
    for (const name of names) this.bindings.set(name, { node, output: name, type: 'drawing' });
  }

  /** A statement that gives names the rest of the sketch reads a new value:
   * a code node holding the statement and any that ran before it, with one
   * output per name. */
  private readStatement(st: ts.Statement, before: ts.Statement[], assigned: string[]): void {
    const outputs: Record<string, ValueType> = {};
    for (const name of assigned) {
      const binding = this.bindings.get(name)!;
      outputs[name] = binding.type;
    }
    const keys = Object.keys(outputs);
    const node = this.add({
      id: this.uniqueId('stmt'),
      kind: 'code',
      x: 0,
      y: 0,
      inputs: this.inputsOf([...before, st]),
      outputs: keys.length > 0 ? outputs : { out: 'drawing' },
      body: `${this.codeBefore(before)}${this.code(st)}\nreturn { ${keys.length > 0 ? keys.map((k) => `${k}: ${k}`).join(', ') : 'out: undefined'} };`,
    });
    for (const key of keys) this.bindings.set(key, { node, output: key, type: outputs[key]! });
  }

  /** The `return`: the node it names when it names exactly one, otherwise a
   * code node that holds the expression, wired to the output node. Code that
   * ran before the return and that nothing reads joins that node too. */
  private readOutput(expr: ts.Expression, before: ts.Statement[]): void {
    const id = this.uniqueId('output');
    const wired = before.length === 0 ? this.reference(expr) : undefined;
    if (wired) {
      this.add({ id, kind: 'output', x: 0, y: 0, inputs: { in: { from: wired } } });
      return;
    }
    // What a sketch returns is very often a list of the things it drew.
    if (before.length === 0 && ts.isArrayLiteralExpression(expr)) {
      const listId = this.uniqueId('ink');
      const list = this.listNode(expr, listId);
      if (list) {
        this.add(list);
        this.add({ id, kind: 'output', x: 0, y: 0, inputs: { in: { from: [list.id, 'out'] } } });
        return;
      }
      this.taken.delete(listId);
    }
    const type = this.typeOf(expr);
    const ink = this.add({
      id: this.uniqueId('ink'),
      kind: 'code',
      x: 0,
      y: 0,
      inputs: this.inputsOf([...before, expr]),
      outputs: { out: accepts(type, OUTPUT_TAKES) ? type : 'drawing' },
      body: `${this.codeBefore(before)}return { out: ${this.code(expr)} };`,
    });
    this.add({ id, kind: 'output', x: 0, y: 0, inputs: { in: { from: [ink.id, 'out'] } } });
  }

  /** The node output the return expression names, when it names one that may
   * feed the output node. */
  private reference(expr: ts.Expression): [string, string] | undefined {
    let binding: Binding | undefined;
    let output: string | undefined;
    if (ts.isIdentifier(expr)) {
      binding = this.bindings.get(expr.text);
      output = binding?.output;
    } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
      binding = this.bindings.get(expr.expression.text);
      output = binding && this.outputTypeOf(binding.node.id, expr.name.text) ? expr.name.text : undefined;
    }
    if (!binding || output === undefined) return undefined;
    const type = this.outputTypeOf(binding.node.id, output);
    return type && accepts(type, OUTPUT_TAKES) ? [binding.node.id, output] : undefined;
  }

  // ---- built-in nodes ----

  /** The initializer as one call of a catalogue word, when every argument
   * maps cleanly onto that word's inputs. A spread, a computed key, a rest
   * parameter with more than one value, an argument that is not a literal
   * and not an earlier node, or an edge that does not fit its socket leaves
   * the call to a code node — the same call, the same ink. */
  /**
   * A call as a built-in node, and every node lifted out of its arguments.
   * The attempt either stands whole or leaves nothing behind: an argument
   * that will not fit makes the *outer* call a code node, and the nodes its
   * earlier arguments produced must go with it.
   */
  private tryBuiltin(expr: ts.CallExpression, id: string): { node: GraphNode; word: CatalogueWord } | undefined {
    const mark = this.nodes.length;
    const built = this.builtinOf(expr, id);
    if (!built) this.rollback(mark);
    return built;
  }

  /** Undo every node added since a mark, and release the names they took. */
  private rollback(mark: number): void {
    for (const node of this.nodes.splice(mark)) {
      this.byId.delete(node.id);
      this.taken.delete(node.id);
    }
  }

  /**
   * An argument that is itself a call of a catalogue word becomes its own
   * node, wired into the one that reads it.
   *
   * The importer takes one node per top-level `const`, which left
   * `t.within(t.ridges(height, { step: 2.6 }), coast)` a code node although
   * both of its words are nodes — the largest single reason a statement was
   * code rather than a node. Hoisting the inner call to its own `const` is
   * the same program: arguments are read left to right, and the lift keeps
   * that order, so the seeded stream draws in the order it drew before.
   */
  private liftCall(call: ts.CallExpression): GraphNode | undefined {
    const mark = this.nodes.length;
    // Resolving can itself lift — the receiver of a method is a node too —
    // so the mark is taken first and covers everything the attempt made.
    const resolved = this.resolve(call, '(lifted)');
    if (!resolved) {
      this.rollback(mark);
      return undefined;
    }
    // The node is named for the word it calls, not for anything in the
    // source: the source gave this value no name at all.
    const id = this.uniqueId(resolved.word.word.split('.').pop() ?? 'value');
    const built = this.buildFrom(call, id, resolved.word, resolved.self);
    if (!built) {
      this.rollback(mark);
      this.taken.delete(id);
      return undefined;
    }
    return this.add(built.node);
  }

  /**
   * The word a call names, and — for a method on a value — the receiver it
   * is called on, as an input.
   *
   * `t.material(art).planarize().faces()` is three words the palette already
   * carries, written as a chain. The catalogue keys a method by its owner
   * (`Material.planarize`, call `{self}.planarize`) and puts the receiver on
   * a socket, so a chain is a chain of nodes — the receiver of each is the
   * one before it. Two owners can share a method name (`Material.edges` and
   * `Faces.edges`); the receiver's own type is what tells them apart, and a
   * receiver whose type the graph does not know leaves the call as code
   * rather than guess.
   */
  private resolve(expr: ts.CallExpression, id: string): { word: CatalogueWord; self?: GraphInput } | undefined {
    const direct = this.wordFor(expr.expression);
    if (direct) return { word: direct };
    const callee = expr.expression;
    if (!ts.isPropertyAccessExpression(callee)) {
      this.refuse(id, undefined, ts.isIdentifier(callee)
        ? `${callee.text} is not a catalogue word`
        : `${describe(callee)} is not a name the catalogue knows`);
      return undefined;
    }
    const method = callee.name.text;
    const owners = this.catalogue.words.filter((w) => w.self && w.call === `{self}.${method}`);
    if (owners.length === 0) {
      this.refuse(id, undefined, `${this.text(callee)} is not a catalogue word`);
      return undefined;
    }
    const self = this.argument(callee.expression, false);
    if (!self?.from) {
      this.refuse(id, undefined, `.${method} is called on ${ts.isCallExpression(callee.expression) ? 'a call the graph cannot hold' : 'a value the graph does not have'}`);
      return undefined;
    }
    const type = this.outputTypeOf(self.from[0], self.from[1]);
    const word = type === undefined ? undefined : owners.find((w) => accepts(type, w.self!.takes));
    if (!word) {
      this.refuse(id, owners[0]!.word, type === undefined
        ? `.${method} is called on a value whose type the graph does not know`
        : `.${method} is not a word of ${type}`);
      return undefined;
    }
    return { word, self };
  }

  private builtinOf(expr: ts.CallExpression, id: string): { node: GraphNode; word: CatalogueWord } | undefined {
    const resolved = this.resolve(expr, id);
    if (!resolved) return undefined;
    return this.buildFrom(expr, id, resolved.word, resolved.self);
  }

  private buildFrom(expr: ts.CallExpression, id: string, word: CatalogueWord, self?: GraphInput): { node: GraphNode; word: CatalogueWord } | undefined {
    const no = (reason: string): undefined => {
      this.refuse(id, word.word, reason);
      return undefined;
    };
    const args = expr.arguments;
    const flat = wordInputs(word);
    const inputs: Record<string, GraphInput> = {};
    // The receiver is the word's first input, and the compiler writes it
    // back into `{self}`.
    if (word.self && self) inputs[word.self.param] = self;

    // A variadic word takes its arguments on one socket, and several
    // arguments are a list: `t.material(a, b, c)` is the list `[a, b, c]`
    // spread into that socket, which is the same call. The leading
    // parameters are read first, because the source reads them first and the
    // seeded stream draws in the order it is read.
    const rest = word.params.findIndex((param) => param.name === 'args');
    if (args.length > word.params.length && rest >= 0 && rest === word.params.length - 1) {
      for (let i = 0; i < rest; i++) {
        const param = word.params[i]!;
        const input = this.argument(args[i]!, false);
        if (input === undefined) return no(`${param.name} is not a literal or an earlier node`);
        inputs[param.name] = input;
      }
      const gathered = this.gather(args.slice(rest), id);
      if (!gathered) return no('an argument is not a value the graph holds');
      inputs['args'] = { from: [gathered.id, 'out'], spread: true };
      const node: GraphNode = { id, kind: 'builtin', word: word.word, x: 0, y: 0, inputs };
      return this.fits(word, inputs) ? { node, word } : no('an argument does not fit its socket');
    }
    if (args.length > word.params.length) return no('more arguments than the word has parameters');
    for (let i = 0; i < args.length; i++) {
      const param = word.params[i]!;
      const arg = args[i]!;
      // A parameter the catalogue could only keep as source text takes the
      // argument exactly as the sketch wrote it. The one rule: the text must
      // name nothing the graph has renamed — a node id is not always the
      // name the sketch used, and the text keeps the sketch's.
      if (param.raw) {
        if (reads(arg).some((id) => this.bindings.has(id.text))) {
          return no(`${param.name} is source text that reads a value the graph holds`);
        }
        inputs[param.name] = { value: { __raw: this.code(arg) } };
        continue;
      }
      if (param.options) {
        if (!ts.isObjectLiteralExpression(arg)) return no(`the options of ${param.name} are not written out`);
        if (!this.optionsInto(param, flat, arg, inputs)) return no(`an option of ${param.name} is not a literal or an earlier node`);
        continue;
      }
      const input = this.argument(arg, param.name === 'args');
      if (input === undefined) {
        return no(ts.isCallExpression(arg)
          ? `${param.name} is a call, not a value the graph holds`
          : `${param.name} is not a literal or an earlier node`);
      }
      inputs[param.name] = input;
    }
    for (const param of word.params) {
      if (!param.options) {
        if (!param.optional && inputs[param.name] === undefined) return no(`${param.name} is required and was not given`);
        continue;
      }
      // A record the library insists on (an option of it has no default) must
      // arrive with something set: the compiler refuses an empty one, so the
      // call is a code node instead.
      const set = flat.filter((input) => input.param === param.name && inputs[input.name] !== undefined);
      if (set.length === 0 && !param.optional && param.options.some((option) => !option.optional)) {
        return no(`${param.name} is required and was not given`);
      }
    }
    if (!this.fits(word, inputs)) return no('an argument does not fit its socket');
    return { node: { id, kind: 'builtin', word: word.word, x: 0, y: 0, inputs }, word };
  }

  /** Record why a statement is a code node. Free when nothing is listening. */
  private refuse(node: string, word: string | undefined, reason: string): void {
    this.refusals?.push({ node, word, reason });
  }

  /**
   * A literal the graph can hold on a node of its own: a number, or a pair
   * of them. Anything else the sketch wrote as a constant — a string, an
   * options object — has no socket to leave on, and stays a code node.
   */
  /**
   * An array of values the graph already holds: `[insets, filledRender,
   * accent]`, which is what a sketch returns when it draws more than one
   * thing. Each element is a place — an earlier node, a call lifted into
   * one, or a spread of a collection.
   */
  private listNode(expr: ts.ArrayLiteralExpression, id: string): GraphNode | undefined {
    if (expr.elements.length === 0) return undefined;
    const mark = this.nodes.length;
    const inputs: Record<string, GraphInput> = {};
    for (let i = 0; i < expr.elements.length; i++) {
      const element = expr.elements[i]!;
      const spread = ts.isSpreadElement(element);
      const input = this.argument(spread ? element.expression : element, false);
      if (!input?.from) {
        this.rollback(mark);
        this.refuse(id, undefined, `place ${i} of the list is not a value the graph holds`);
        return undefined;
      }
      inputs[String(i)] = spread ? { from: input.from, spread: true } : input;
    }
    return { id, kind: 'list', x: 0, y: 0, inputs, outputs: { out: 'drawing' } };
  }

  /**
   * The catalogue word an expression *is*, rather than calls: `t.cx` is the
   * middle of the drawable, written with no parentheses.
   */
  private valueWordOf(expr: ts.Expression): CatalogueWord | undefined {
    if (!ts.isPropertyAccessExpression(expr)) return undefined;
    const owner = expr.expression;
    if (!ts.isIdentifier(owner) || this.bindings.has(owner.text)) return undefined;
    const ns = this.namespaces.get(owner.text);
    const word = this.byCall.get(ns ? `${ns}.${expr.name.text}` : `${owner.text}.${expr.name.text}`);
    return word?.value ? word : undefined;
  }

  /**
   * A word whose parameter is a body that runs many times: `t.times(n, (i, u)
   * => …)` is a zone, not a code node. The count is a wire, the callback's
   * own parameters are what the inside is handed each run, and every name the
   * body reaches for from outside crosses the boundary under its own name.
   *
   * The inside starts as one code node holding the body the sketch wrote —
   * the compiler writes that back as the callback, unwrapped — and the artist
   * can take it apart into nodes from there.
   */
  private zoneNode(expr: ts.CallExpression, id: string): GraphNode | undefined {
    // Neither `t.times` nor `.map` is a catalogue word, and neither can be:
    // the parameter that matters is a function, and no socket carries one.
    // That is exactly why they are zones, so the zone recognises the calls.
    const callee = expr.expression;
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const isTimes = callee.name.text === 'times'
      && ts.isIdentifier(callee.expression) && callee.expression.text === 't' && !this.bindings.has('t');
    const isMap = callee.name.text === 'map' || callee.name.text === 'filter';
    const isSteps = callee.name.text === 'steps';
    if (!isTimes && !isMap && !isSteps) return undefined;
    const kind: ZoneKind = isTimes ? 'times' : isSteps ? 'steps' : callee.name.text === 'filter' ? 'filter' : 'map';
    const named = isTimes ? 't.times' : isSteps ? '.steps' : `.${callee.name.text}`;
    const [first, second] = expr.arguments;
    // `t.times(count, body)` takes the count first; `rows.map(body)` and
    // `m.steps(count, body)` take their collection as the receiver.
    const over = isTimes ? first : callee.expression;
    const callback = isTimes ? second : isSteps ? second : first;
    if (!over || !callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
      this.refuse(id, named, 'the body is not written out where the zone can hold it');
      return undefined;
    }
    if (isMap && expr.arguments.length !== 1) return undefined; // `.map(fn, thisArg)` is not this
    if (isSteps && (expr.arguments.length < 2 || expr.arguments.length > 3)) return undefined;
    const mark = this.nodes.length;
    const counted = this.argument(over, false);
    if (counted === undefined || (!isTimes && !counted.from)) {
      this.rollback(mark);
      this.refuse(id, named, isTimes ? 'the count is not a literal or an earlier node' : 'the collection is not a value the graph holds');
      return undefined;
    }
    // `steps` runs its rule a given number of times, beside its receiver.
    let counts: GraphInput | undefined;
    if (isSteps) {
      counts = this.argument(first!, false);
      if (counts === undefined) {
        this.rollback(mark);
        this.refuse(id, named, 'the number of steps is not a literal or an earlier node');
        return undefined;
      }
    }
    const binds: string[] = [];
    for (const parameter of callback.parameters) {
      if (!ts.isIdentifier(parameter.name)) {
        this.rollback(mark);
        this.refuse(id, named, 'the body takes a pattern, not a name');
        return undefined;
      }
      binds.push(parameter.name.text);
    }
    // What the body reads from outside: each becomes a boundary output, and
    // the zone node takes it under the same name.
    const body = callback.body;
    const captured = this.inputsOf([body]);
    const over_ = isTimes ? 'count' : isSteps ? 'material' : 'rows';
    const inputs: Record<string, GraphInput> = { [over_]: counted };
    if (counts) inputs['count'] = counts;
    // `m.steps(n, rule, { every: 40 })`: the rule's own options ride on the
    // node as source text, and the compiler writes them back after the body.
    const trailing = isSteps ? expr.arguments[2] : undefined;
    if (trailing) {
      if (reads(trailing).some((r) => this.bindings.has(r.text))) {
        this.rollback(mark);
        this.refuse(id, named, 'the options read a value the graph holds');
        return undefined;
      }
      inputs['opts'] = { value: { __raw: this.code(trailing) } };
    }
    const boundary: Record<string, ValueType> = {};
    // `times` hands the body two numbers; `map` hands it a row and `steps`
    // the two states, whose kinds the graph does not name — what they hold is
    // read inside the body, the way the sketch reads it.
    for (const name of binds) boundary[name] = isTimes ? 'Number' : 'Geometry';
    for (const [name, input] of Object.entries(captured)) {
      if (binds.includes(name)) continue;
      inputs[name] = input;
      boundary[name] = input.type ?? 'Geometry';
    }
    const inner: GraphNode = {
      id: 'body', kind: 'code', x: 0, y: 0,
      inputs: Object.fromEntries(Object.keys(boundary).map((name) => [name, { type: boundary[name]!, from: ['each', name] as [string, string] }])),
      outputs: { out: 'Geometry' },
      body: this.bodyOf(body, !isSteps),
    };
    const inside: Graph = {
      version: 1, name: '', config: {},
      nodes: [
        { id: 'each', kind: 'input', x: 0, y: 0, inputs: {}, outputs: boundary },
        inner,
        // A rule answers with nothing, so its result reads nothing.
        { id: 'result', kind: 'output', x: 0, y: 0, inputs: isSteps ? {} : { in: { from: ['body', 'out'] } } },
      ],
    };
    return { id, kind: 'zone', zone: kind, x: 0, y: 0, inputs, outputs: { out: 'Geometry' }, binds, graph: inside };
  }

  /**
   * A callback's body as a code node's body. A code node answers with
   * `{ out: … }`, and the zone's compiler unwraps that again, so the callback
   * the sketch wrote comes back out unchanged:
   *
   * - an expression body is the answer;
   * - a block whose only `return` is its last statement has that one rewritten;
   * - a block with an early return keeps every one of them, inside a function
   *   of its own, because rewriting them all is not something to guess at.
   */
  private bodyOf(body: ts.ConciseBody, answers = true): string {
    // A rule's body is kept as it stands, including a bare expression body:
    // `(cur, next) => next` answers with `next`, and whether the word reads
    // that answer is the word's business, not the graph's.
    if (!ts.isBlock(body)) return answers ? `return { out: ${this.code(body)} };` : `return ${this.code(body)};`;
    if (!answers) return body.statements.map((st) => this.code(st)).join('\n');
    const statements = [...body.statements];
    const returns = (node: ts.Node): ts.ReturnStatement[] => {
      const out: ts.ReturnStatement[] = [];
      const walk = (n: ts.Node): void => {
        if (ts.isFunctionLike(n)) return; // a nested function's returns are its own
        if (ts.isReturnStatement(n)) out.push(n);
        ts.forEachChild(n, walk);
      };
      for (const st of statements) walk(st);
      return out;
    };
    const found = returns(body);
    const last = statements[statements.length - 1];
    if (found.length === 1 && last !== undefined && found[0] === last && found[0]!.expression) {
      const head = statements.slice(0, -1).map((st) => this.code(st)).join('\n');
      return `${head === '' ? '' : `${head}\n`}return { out: ${this.code(found[0]!.expression!)} };`;
    }
    const text = statements.map((st) => this.code(st)).join('\n');
    return `return { out: (() => {\n${text.split('\n').map((line) => (line === '' ? '' : `  ${line}`)).join('\n')}\n})() };`;
  }

  /** Several expressions as one list node. Used where a word is variadic. */
  private gather(items: readonly ts.Expression[], forId: string): GraphNode | undefined {
    const mark = this.nodes.length;
    const listId = this.uniqueId('list');
    const inputs: Record<string, GraphInput> = {};
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const spread = ts.isSpreadElement(item);
      const input = this.argument(spread ? item.expression : item, false);
      if (!input?.from) {
        this.rollback(mark);
        this.taken.delete(listId);
        this.refuse(forId, undefined, `argument ${i} is not a value the graph holds`);
        return undefined;
      }
      inputs[String(i)] = spread ? { from: input.from, spread: true } : input;
    }
    return this.add({ id: listId, kind: 'list', x: 0, y: 0, inputs, outputs: { out: 'drawing' } });
  }

  private valueNode(expr: ts.Expression, id: string): { node: GraphNode; type: ValueType } | undefined {
    const value = this.literal(expr);
    if (value === undefined) return undefined;
    const type: ValueType | undefined = typeof value === 'number'
      ? 'Number'
      : Array.isArray(value) && value.length === 2 && value.every((v) => typeof v === 'number')
        ? 'Vector'
        : undefined;
    if (!type) return undefined;
    return { node: { id, kind: 'value', x: 0, y: 0, inputs: { v: { value } }, outputs: { out: type } }, type };
  }

  /** One argument as an input, or undefined when it cannot be one. */
  private argument(arg: ts.Expression, restLike: boolean): GraphInput | undefined {
    if (ts.isIdentifier(arg)) {
      const binding = this.bindings.get(arg.text);
      if (binding) return { from: [binding.node.id, binding.output] };
    }
    if (ts.isCallExpression(arg)) {
      const lifted = this.liftCall(arg);
      if (lifted) return { from: [lifted.id, 'out'] };
    }
    const asValue = this.valueWordOf(arg);
    if (asValue) {
      const node = this.add({ id: this.uniqueId(asValue.word.split('.').pop() ?? 'value'), kind: 'builtin', word: asValue.word, x: 0, y: 0, inputs: {} });
      return { from: [node.id, 'out'] };
    }
    // `t.material(...shapes)`: the collection IS the arguments. The rest
    // parameter takes one socket, and the wire remembers it was spread —
    // the library judges a bare array as one shape, so the two calls are
    // not the same call.
    if (restLike && ts.isSpreadElement(arg)) {
      const inner = this.argument(arg.expression, false);
      return inner?.from ? { from: inner.from, spread: true } : undefined;
    }
    // A rest parameter takes one socket. The catalogue flattens `...args`
    // into one parameter named `args`, and an array of more than one entry
    // is more values than that socket has room for.
    if (restLike && ts.isArrayLiteralExpression(arg) && arg.elements.length > 1) return undefined;
    const value = this.literal(arg);
    return value === undefined ? undefined : { value };
  }

  /** An options record: one input per option the source sets. An option
   * whose value is neither a literal nor an earlier node keeps its text. */
  private optionsInto(param: CatalogueParam, flat: CatalogueInput[], obj: ts.ObjectLiteralExpression, inputs: Record<string, GraphInput>): boolean {
    for (const prop of obj.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        const input = flat.find((i) => i.param === param.name && i.option === prop.name.text);
        const binding = this.bindings.get(prop.name.text);
        if (!input || !binding) return false;
        inputs[input.name] = { from: [binding.node.id, binding.output] };
        continue;
      }
      if (!ts.isPropertyAssignment(prop)) return false; // a spread, a method, a computed key
      const key = this.propertyName(prop.name);
      if (key === undefined) return false;
      const input = flat.find((i) => i.param === param.name && i.option === key);
      if (!input) return false; // not an option of this word
      if (ts.isIdentifier(prop.initializer)) {
        const binding = this.bindings.get(prop.initializer.text);
        if (binding) {
          inputs[input.name] = { from: [binding.node.id, binding.output] };
          continue;
        }
      }
      if (ts.isCallExpression(prop.initializer)) {
        const lifted = this.liftCall(prop.initializer);
        if (lifted) {
          inputs[input.name] = { from: [lifted.id, 'out'] };
          continue;
        }
      }
      // Text the node keeps is only safe while it reads nothing the sketch
      // body names: a node's value is not the node's own `const`. An option
      // that reaches one makes the whole word a code node, whose body gets
      // those names as parameters.
      if (reads(prop.initializer).some((id) => this.bindings.has(id.text))) return false;
      inputs[input.name] = { value: this.value(prop.initializer) };
    }
    return true;
  }

  /** Whether every edge lands on a socket that takes it, and every control
   * holds a literal. */
  private fits(word: CatalogueWord, inputs: Record<string, GraphInput>): boolean {
    const byName = new Map(wordInputs(word).map((input) => [input.name, input]));
    for (const [key, input] of Object.entries(inputs)) {
      const spec = byName.get(key);
      if (!spec) return false;
      if (!input.from) continue;
      if (!spec.takes) return false; // a control holds a literal; nothing wires into it
      // A spread carries a collection; what it holds is not what it is.
      if (input.spread) continue;
      const type = this.outputTypeOf(input.from[0], input.from[1]);
      if (!type || !accepts(type, spec.takes)) return false;
    }
    return true;
  }

  // ---- the value model ----

  /** Every free name of the code that an earlier node produces, in the order
   * it first appears. */
  private inputsOf(nodes: ts.Node[]): Record<string, GraphInput> {
    const inputs: Record<string, GraphInput> = {};
    for (const node of nodes) {
      for (const id of reads(node)) {
        if (id.text in inputs) continue;
        const binding = this.bindings.get(id.text);
        if (!binding) continue;
        inputs[id.text] = { type: binding.type, from: [binding.node.id, binding.output] };
      }
    }
    return inputs;
  }

  /** The value type of an expression, as far as a name can say: the word it
   * calls, a number, a function, or the catch-all a drawing is. */
  private typeOf(expr: ts.Expression): ValueType {
    if (ts.isCallExpression(expr)) {
      const word = this.wordFor(expr.expression);
      if (word) return word.returns;
      // JavaScript's own `Math` answers with a number. That is not a claim
      // about the vocabulary, only about the type: without it
      // `Math.round(t.rnd(5, 10))` was a value of unknown kind, and a Number
      // socket would not take it.
      const callee = expr.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && callee.expression.text === 'Math' && !this.bindings.has('Math')) {
        return 'Number';
      }
    }
    // A field takes a point: `(x, y) => number`. `() => t.rnd(15, 35)` is a
    // generator the sketch calls, and typing it `Field` made the node that
    // reads it red — `Expected 2 arguments, but got 0` on code that runs.
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
      return expr.parameters.length === 2 ? 'Field' : 'Geometry';
    }
    if (ts.isNumericLiteral(expr)) return 'Number';
    if (ts.isPrefixUnaryExpression(expr) && ts.isNumericLiteral(expr.operand)) return 'Number';
    if (ts.isBinaryExpression(expr) && ARITHMETIC.includes(expr.operatorToken.kind)) return 'Number';
    // Not `drawing`: the graph does not know what this is, and saying
    // "drawing" is a claim it cannot back — it turned a body that runs into
    // a red node, and refused a wire the library would have taken.
    // `Geometry` is the honest answer, and it fits any geometry socket.
    return 'Geometry';
  }

  private outputTypeOf(id: string, output: string): ValueType | undefined {
    const node = this.byId.get(id);
    if (!node) return undefined;
    if (node.kind === 'builtin') return output === 'out' ? this.byWord.get(node.word!)?.returns : undefined;
    return node.outputs?.[output];
  }

  // ---- bookkeeping ----

  private add(node: GraphNode): GraphNode {
    this.nodes.push(node);
    this.byId.set(node.id, node);
    return node;
  }

  /** The source's own name where it is free, a numbered one where it is
   * not. */
  private uniqueId(preferred: string): string {
    let id = preferred;
    for (let n = 2; this.taken.has(id); n++) id = `${preferred}${n}`;
    this.taken.add(id);
    return id;
  }

  private text(node: ts.Node): string {
    return node.getText(this.file);
  }

  /** The source text of a node with every imported name spelled the way the
   * catalogue spells it: `disc` (imported as `circle`) reads `circle`, and a
   * `circle` imported from `occlude/3d` reads `circle3`. The body keeps the
   * sketch's words; the compiled sketch imports the library's. The rewrite is
   * by position, right to left, and only where the name is read: a string, a
   * property name, a declaration and a name the sketch declares itself are
   * left as they are. */
  private code(node: ts.Node): string {
    if (this.aliases.size === 0) return this.text(node);
    const start = node.getStart(this.file);
    let text = this.text(node);
    const edits = reads(node)
      .filter((id) => !this.shadowed.has(id.text) && this.aliases.has(id.text))
      .sort((a, b) => b.getStart(this.file) - a.getStart(this.file));
    for (const id of edits) {
      const at = id.getStart(this.file) - start;
      text = `${text.slice(0, at)}${this.aliases.get(id.text)!}${text.slice(id.getEnd() - start)}`;
    }
    return text;
  }

  /** The text of the statements that ran before a node's own code, as lines. */
  private codeBefore(before: ts.Statement[]): string {
    return before.map((st) => `${this.code(st)}\n`).join('');
  }

  private line(node: ts.Node): number {
    return this.file.getLineAndCharacterOfPosition(node.getStart(this.file)).line + 1;
  }
}

/** Lay the nodes out left to right in topological depth: a node sits at the
 * depth of its deepest input, one row per node in a column. */
function layout(graph: Graph, catalogue: Catalogue): void {
  const places = layoutGraph(graph, (node) => estimateBox(node, catalogue));
  for (const node of graph.nodes) {
    const at = places.get(node.id);
    if (!at) continue;
    node.x = Math.round(at.x);
    node.y = Math.round(at.y);
  }
}

/** The names a statement gives a new value to: `x = …`, `x += …`, `x++`, and
 * the assignment form of a destructuring. An assignment inside a nested
 * function runs when that function is called, not where the statement stands,
 * so it is left out. */
function assignedNames(node: ts.Node): Set<string> {
  const out = new Set<string>();
  const target = (expr: ts.Expression): void => {
    if (ts.isIdentifier(expr)) {
      out.add(expr.text);
      return;
    }
    if (ts.isArrayLiteralExpression(expr)) {
      for (const element of expr.elements) target(element);
      return;
    }
    if (!ts.isObjectLiteralExpression(expr)) return;
    for (const prop of expr.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) out.add(prop.name.text);
      else if (ts.isPropertyAssignment(prop)) target(prop.initializer);
    }
  };
  const walk = (child: ts.Node): void => {
    if (ts.isArrowFunction(child) || ts.isFunctionExpression(child) || ts.isFunctionDeclaration(child)) return;
    if (ts.isBinaryExpression(child) && child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && child.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      target(child.left);
    }
    if ((ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child))
      && (child.operator === ts.SyntaxKind.PlusPlusToken || child.operator === ts.SyntaxKind.MinusMinusToken)
      && ts.isIdentifier(child.operand)) {
      out.add(child.operand.text);
    }
    ts.forEachChild(child, walk);
  };
  walk(node);
  return out;
}

/** Every name a node reads and does not bind itself, in the order it first
 * appears. A declaration inside the node — a parameter, a local `const` — is
 * left out: the body keeps it, and it shadows an outer name. */
function reads(node: ts.Node): ts.Identifier[] {
  const bound = new Set<string>();
  bindNames(node, bound);
  const out: ts.Identifier[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) {
      if (!bound.has(child.text) && isRead(child)) out.push(child);
      return;
    }
    if (ts.isTypeNode(child) || ts.isTypeAliasDeclaration(child) || ts.isInterfaceDeclaration(child)) return;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return out;
}

/** Every name the subtree declares. */
function bindNames(node: ts.Node, out: Set<string>): void {
  if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
    addPattern(node.name, out);
  } else if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) {
    if (node.name) out.add(node.name.text);
  } else if (ts.isCatchClause(node) && node.variableDeclaration) {
    addPattern(node.variableDeclaration.name, out);
  } else if (ts.isTypeParameterDeclaration(node)) {
    out.add(node.name.text);
  }
  ts.forEachChild(node, (child) => bindNames(child, out));
}

function addPattern(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) addPattern(element.name, out);
  }
}

/** The names a binding pattern declares, in order. */
function boundNames(name: ts.BindingName): string[] {
  const out: string[] = [];
  const walk = (pattern: ts.BindingName): void => {
    if (ts.isIdentifier(pattern)) {
      out.push(pattern.text);
      return;
    }
    for (const element of pattern.elements) if (ts.isBindingElement(element)) walk(element.name);
  };
  walk(name);
  return out;
}

/** Whether an identifier is read where it stands, rather than being the name
 * of a property or a label. */
function isRead(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isQualifiedName(parent) && parent.right === id) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  // `const { circle: r } = …`: the key is a property name, not a read.
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isEnumMember(parent)) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
  if (ts.isLabeledStatement(parent) && parent.label === id) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === id) return false;
  return true;
}

/** What an error calls a node it cannot read. */
function describe(node: ts.Node): string {
  switch (node.kind) {
    case ts.SyntaxKind.CallExpression: return 'a call';
    case ts.SyntaxKind.NewExpression: return 'a new expression';
    case ts.SyntaxKind.Identifier: return `the name ${(node as ts.Identifier).text}`;
    case ts.SyntaxKind.NumericLiteral: return 'a number';
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral: return 'a string';
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.ForInStatement: return 'a loop';
    case ts.SyntaxKind.IfStatement: return 'an if statement';
    case ts.SyntaxKind.ExpressionStatement: return 'an expression statement';
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.FunctionDeclaration: return 'a function';
    case ts.SyntaxKind.ClassDeclaration: return 'a class';
    case ts.SyntaxKind.TemplateExpression: return 'a template with values';
    case ts.SyntaxKind.SpreadElement:
    case ts.SyntaxKind.SpreadAssignment: return 'a spread';
    case ts.SyntaxKind.ComputedPropertyName: return 'a computed key';
    case ts.SyntaxKind.PropertyAccessExpression: return 'a property read';
    case ts.SyntaxKind.ObjectLiteralExpression: return 'an object';
    case ts.SyntaxKind.ArrayLiteralExpression: return 'an array';
    case ts.SyntaxKind.VariableStatement: return 'a declaration';
    case ts.SyntaxKind.TypeAliasDeclaration:
    case ts.SyntaxKind.InterfaceDeclaration: return 'a type';
    default: return `the ${ts.SyntaxKind[node.kind]}`;
  }
}
