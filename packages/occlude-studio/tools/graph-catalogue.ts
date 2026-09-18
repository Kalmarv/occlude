/**
 * The built-in node catalogue, read from the types.
 *
 *   pnpm --filter occlude-studio graph:catalogue
 *
 * Uses the same TypeScript program as the docs signatures
 * (`packages/occlude/tools/signatures.ts`): the exports of `occlude`, the
 * exports of `occlude/3d`, the toolkit's members and the members of the
 * `connect`/`force`/`query`/`ease`/`sdf` namespaces. The word list is never
 * hand-written. The reference page a word links to comes from the
 * `<include>/_sig/…` lines of the pages themselves, so the palette groups
 * exactly as the reference does.
 *
 * A word becomes a node when its return type maps to a socket and every
 * required parameter does. Parameters named `opts`/`options` are option
 * records: one socket per option whose type maps. Words that cannot map are
 * printed as a report and left out.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const root = resolve(pkg, '../..');
const docs = join(root, 'docs');
const out = join(pkg, 'src/graph/catalogue.ts');

const NAMESPACES = ['connect', 'force', 'query', 'ease', 'sdf'];

const entry = join(root, 'packages/occlude/src/index.ts');
const entry3d = join(root, 'packages/occlude/src/three/api/index.ts');
const program = ts.createProgram([entry, entry3d], {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true, skipLibCheck: true, noEmit: true,
});
const checker = program.getTypeChecker();

// ---- the reference pages: order, titles, and which words they document ----

interface Page { slug: string; title: string; group: string; words: Set<string> }

/** `Toolkit.sample.2` → `t.sample`; `3d.view.1` → `3d.view`; `circle` → `circle`. */
function keyToWord(key: string): string {
  const parts = key.split('.').filter((p) => !/^\d+$/.test(p));
  if (parts.length === 1) return parts[0];
  const [owner, ...rest] = parts;
  const member = rest.join('.');
  if (owner === 'Toolkit') return `t.${member}`;
  return parts.join('.');
}

function readPageMeta(file: string): string[] | null {
  const text = readFileSync(file, 'utf8');
  const match = text.match(/pages:\s*\[([^\]]*)\]/);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function readPages(): Page[] {
  const pages: Page[] = [];
  const add = (dir: string, names: string[], prefix: string): void => {
    for (const name of names) {
      const file = join(dir, `${name}.mdx`);
      // A name with no page of its own is a section (`3d`); its own meta
      // lists the pages inside it.
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      const title = text.match(/^title:\s*(.+)$/m)?.[1].trim() ?? name;
      const words = new Set<string>();
      for (const m of text.matchAll(/<include>\/_sig\/([^<\s]+)\.mdx<\/include>/g)) {
        const word = keyToWord(m[1]);
        words.add(word);
        // The 3D section keys its partials `3d.box`; a graph calls it `box`.
        if (word.startsWith('3d.')) words.add(word.slice(3));
      }
      pages.push({ slug: `${prefix}${name}`, title, group: title, words });
    }
  };
  add(join(docs, 'reference'), readPageMeta(join(docs, 'reference/meta.ts')) ?? [], '');
  add(join(docs, 'reference/3d'), readPageMeta(join(docs, 'reference/3d/meta.ts')) ?? [], '3d/');
  return pages;
}

const PAGES = readPages();
const pageOfWord = new Map<string, Page>();
for (const page of PAGES) for (const word of page.words) if (!pageOfWord.has(word)) pageOfWord.set(word, page);

// ---- the type → socket map ----

const SOCKET_CLASSES = ['Geometry', 'Number', 'Vector', 'Field', 'Fill', 'Camera'] as const;
type SocketClass = (typeof SOCKET_CLASSES)[number];
const GEOMETRY_KINDS = ['shape', 'material', 'points', 'faces', 'mesh', 'curves', 'drawing'] as const;
type GeometryKind = (typeof GEOMETRY_KINDS)[number];
type ValueType = GeometryKind | SocketClass;

/** The value a type carries, by type name. A name absent here carries no
 * value, and a word that needs it is left out. */
const BY_NAME: Record<string, ValueType> = {
  Len: 'Number',
  L: 'Number',
  Coord: 'Number',
  Vec: 'Vector',
  Vec3: 'Vector',
  XY: 'Vector',
  XYLike: 'Vector',
  PointRecord: 'Vector',
  Material: 'material',
  PointSelection: 'points',
  Faces: 'faces',
  FaceSelection: 'faces',
  Face: 'faces',
  Mesh: 'mesh',
  Instances: 'mesh',
  SurfaceCurves: 'curves',
  CurveSamples: 'curves',
  Drawing3: 'drawing',
  LineArtScene3: 'drawing',
  ProjectedStrokes: 'drawing',
  ShapeValue: 'shape',
  GroupValue: 'shape',
  ClipValue: 'shape',
  Contour: 'shape',
  Loop: 'shape',
  LoopPoints: 'shape',
  IsoContour: 'shape',
  Boundary: 'shape',
  FaceLike: 'faces',
  FaceSource: 'faces',
  ChainSource: 'material',
  PointSource: 'points',
  FieldFn: 'Field',
  FieldFn2: 'Field',
  DistanceField: 'Field',
  LengthField: 'Field',
  LengthFn: 'Field',
  FillSpec: 'Fill',
  Camera3: 'Camera',
  Tree: 'drawing',
};
/** A value tagged by a marker property, rather than by its type name. */
const BY_MARKER: Record<string, GeometryKind> = {
  __occludeShape: 'shape',
  __occludeGroup: 'shape',
  __occludeClip: 'shape',
  __occludeDrawing3: 'drawing',
  __occludeLineArt3: 'drawing',
  __occludeProjectedStrokes: 'drawing',
};
/** The shapes the library duck-types instead of importing the classes:
 * `strokes({ curves(): IsoContour[] })` takes a material or a selection. */
const BY_MEMBER: Record<string, GeometryKind> = {
  curves: 'material',
  inducedEdges: 'points',
  area: 'faces',
};
/** A control the node edits, for a type no socket carries. */
const BY_CONTROL: Record<string, 'number' | 'text' | 'check'> = {
  len: 'number',
  string: 'text',
  boolean: 'check',
};

/** A value the library discriminates by a `type` string. A union of such
 * variants loses its alias when it joins another union (`FillSpec |
 * CustomFillFn` flattens into its four variants), so the discriminant names
 * the family. */
const BY_DISCRIMINANT: Record<string, ValueType> = {
  use: 'Fill', asset: 'Fill', custom: 'Fill', mask: 'Fill',
  orthographic: 'Camera', perspective: 'Camera',
};

/** The value a discriminated object carries, by its `type` literal. */
function byDiscriminant(type: ts.Type): ValueType | undefined {
  for (const property of ['type', 'kind']) {
    const disc = checker.getPropertyOfType(type, property);
    const at = disc?.valueDeclaration ?? disc?.declarations?.[0];
    if (!disc || !at) continue;
    const discType = checker.getTypeOfSymbolAtLocation(disc, at);
    const literals = (discType.isUnion() ? discType.types : [discType]).filter((t) => (t.flags & ts.TypeFlags.StringLiteral) !== 0);
    for (const literal of literals) {
      const value = BY_DISCRIMINANT[(literal as ts.StringLiteralType).value];
      if (value) return value;
    }
  }
  return undefined;
}

function isNumberish(type: ts.Type): boolean {
  return (type.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) !== 0;
}

/** A `(x, y) => number` field function, and nothing else. */
function isScalarField(type: ts.Type): boolean {
  const sig = type.getCallSignatures()[0];
  if (!sig) return false;
  const params = sig.getParameters();
  if (params.length < 2) return false;
  const types = params.map((p) => (p.valueDeclaration ? checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration) : undefined));
  if (types.some((t) => t === undefined)) return false;
  return types.every(isNumberish) && isNumberish(checker.getReturnTypeOfSignature(sig));
}

function typeName(type: ts.Type): string | undefined {
  return type.aliasSymbol?.getName() ?? type.getSymbol()?.getName();
}

function nonNullish(type: ts.Type): ts.Type {
  if (!type.isUnion()) return type;
  const inner = type.types.filter((t) => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
  return inner.length === 1 ? inner[0] : type;
}

/** The geometry kinds a type covers, when it covers geometry at all. A
 * union covers what all of its members cover. */
function kindsOf(type: ts.Type, seen = new Set<ts.Type>()): GeometryKind[] | undefined {
  const alias = type.aliasSymbol?.getName();
  if (alias && BY_NAME[alias]) {
    const named = BY_NAME[alias];
    return (GEOMETRY_KINDS as readonly string[]).includes(named) ? [named as GeometryKind] : undefined;
  }
  if (seen.has(type)) return undefined;
  seen.add(type);
  if (type.isUnion()) {
    const inner = type.types.filter((t) => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.BooleanLiteral)) === 0);
    if (inner.length === 0) return undefined;
    const out: GeometryKind[] = [];
    for (const member of inner) {
      // Each branch gets its own path, so a type that appears twice in one
      // union (`Contour` and `Contour[]`) is not mistaken for a cycle.
      const kinds = kindsOf(member, new Set(seen));
      if (!kinds) return undefined;
      for (const kind of kinds) if (!out.includes(kind)) out.push(kind);
    }
    return out;
  }
  const name = typeName(type);
  if (name && BY_NAME[name] && (GEOMETRY_KINDS as readonly string[]).includes(BY_NAME[name])) return [BY_NAME[name] as GeometryKind];
  for (const marker of Object.keys(BY_MARKER)) {
    if (checker.getPropertyOfType(type, marker)) return [BY_MARKER[marker]];
  }
  for (const member of Object.keys(BY_MEMBER)) {
    if (checker.getPropertyOfType(type, member)) return [BY_MEMBER[member]];
  }
  const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
  if (element) return kindsOf(element, new Set(seen));
  return undefined;
}

/** The value a type carries, when it carries one value a socket can say.
 * A union of several geometry kinds is a drawing when they are shapes and
 * drawings — a tree the renderer accepts — and otherwise none. */
function valueOf(raw: ts.Type, seen = new Set<ts.Type>()): ValueType | undefined {
  const type = nonNullish(raw);
  // A named type is decided by its name, before its members: `Camera3` is a
  // union of two camera classes, and `XY` a union of point spellings.
  const alias = type.aliasSymbol?.getName();
  if (alias && BY_NAME[alias]) return BY_NAME[alias];
  if (isNumberish(type)) return 'Number';
  const discriminated = byDiscriminant(type);
  if (discriminated) return discriminated;
  const kinds = kindsOf(type);
  if (kinds) {
    if (kinds.length === 1) return kinds[0];
    return kinds.every((k) => k === 'shape' || k === 'drawing') && kinds.includes('drawing') ? 'drawing' : undefined;
  }
  if (seen.has(type)) return undefined;
  seen.add(type);
  if (type.isUnion()) {
    // `number | Len` (the `L` alias) is one Number; a union of one class is
    // that class.
    const inner = type.types.filter((t) => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.BooleanLiteral)) === 0);
    if (inner.length === 0) return undefined;
    const mapped = inner.map((t) => valueOf(t, new Set(seen)));
    if (mapped.some((m) => m === undefined)) return undefined;
    const unique = [...new Set(mapped)];
    return unique.length === 1 ? unique[0] : undefined;
  }
  const name = typeName(type);
  if (name && BY_NAME[name] && !(GEOMETRY_KINDS as readonly string[]).includes(BY_NAME[name])) return BY_NAME[name];
  if (isScalarField(type)) return 'Field';
  return undefined;
}

/** What an input takes: the geometry kinds, or the one class. A union with
 * a member no socket carries still takes what its other members carry —
 * `fill?: FillSpec | CustomFillFn` takes a Fill. */
function takesOf(raw: ts.Type): { socket: SocketClass; kinds?: GeometryKind[] } | undefined {
  const type = nonNullish(raw);
  const strict = strictTakesOf(type);
  if (strict) return strict;
  if (!type.isUnion()) return undefined;
  const mapped = type.types.map((t) => strictTakesOf(t)).filter((t) => t !== undefined);
  if (mapped.length === 0) return undefined;
  const classes = [...new Set(mapped.map((t) => t.socket))];
  if (classes.length !== 1) return undefined;
  const kinds = [...new Set(mapped.flatMap((t) => t.kinds ?? []))];
  if (kinds.length === 0) return { socket: classes[0] };
  return { socket: 'Geometry', kinds };
}

function strictTakesOf(type: ts.Type): { socket: SocketClass; kinds?: GeometryKind[] } | undefined {
  const kinds = kindsOf(type);
  if (kinds) return { socket: 'Geometry', kinds };
  const value = valueOf(type);
  if (!value) return undefined;
  return { socket: (GEOMETRY_KINDS as readonly string[]).includes(value) ? 'Geometry' : (value as SocketClass) };
}

/** A control for a type no socket carries: a checkbox, a text field, or a
 * menu of the literal strings a union names. */
function controlOf(type: ts.Type): { control: 'number' | 'text' | 'check' | 'menu'; choices?: string[] } | undefined {
  const inner = nonNullish(type);
  if (inner.isUnion()) {
    const members = inner.types.filter((t) => (t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0);
    // `boolean` is the union `true | false`.
    if (members.length > 0 && members.every((t) => (t.flags & ts.TypeFlags.BooleanLiteral) !== 0)) return { control: 'check' };
    const choices = members.filter((t) => (t.flags & ts.TypeFlags.StringLiteral) !== 0).map((t) => (t as ts.StringLiteralType).value);
    if (choices.length === members.length && choices.length > 0) return { control: 'menu', choices };
    return undefined;
  }
  if (inner.flags & ts.TypeFlags.StringLiteral) return { control: 'menu', choices: [(inner as ts.StringLiteralType).value] };
  const control = BY_CONTROL[inner.flags & ts.TypeFlags.Number ? 'len' : inner.flags & ts.TypeFlags.String ? 'string' : inner.flags & ts.TypeFlags.Boolean ? 'boolean' : ''];
  return control ? { control } : undefined;
}

// ---- the words ----

type Takes = { socket: SocketClass; kinds?: GeometryKind[] };
interface Control { control: 'number' | 'text' | 'check' | 'menu'; choices?: string[] }
interface Option extends Partial<Takes>, Partial<Control> { name: string; optional: boolean }
interface Param extends Partial<Takes>, Partial<Control> {
  name: string;
  optional: boolean;
  options?: Option[];
}

interface Word {
  word: string;
  module: 'occlude' | 'occlude/3d';
  receiver: string | null;
  import: string | null;
  call: string;
  params: Param[];
  returns: ValueType;
  page: string;
  group: string;
}

const skipped: { word: string; reason: string }[] = [];
/** Options and parameters a node leaves out because their type carries no
 * socket and no control: the run reports them, so the palette's gaps are
 * never silent. */
const dropped: string[] = [];

/** A parameter's input: the socket it takes, or the control it edits, or a
 * reason the word cannot be a node. */
function inputOf(type: ts.Type, what: string, required: boolean): { input?: Partial<Takes> & Partial<Control>; problem?: string } {
  const takes = takesOf(type);
  if (takes) return { input: takes };
  const control = controlOf(type);
  if (control) return { input: control };
  if (!required) return {};
  return { problem: `${what} is ${checker.typeToString(nonNullish(type), undefined, ts.TypeFormatFlags.NoTruncation)}` };
}

/** The parameters of one signature, or a reason it cannot be a node. */
function paramsOf(sig: ts.Signature, at: ts.Node, word: string): { params: Param[]; problem?: string; dropped: string[] } {
  const params: Param[] = [];
  const dropped: string[] = [];
  for (const param of sig.getParameters()) {
    const decl = param.valueDeclaration;
    if (!decl || !ts.isParameter(decl)) return { params, problem: `parameter ${param.getName()} has no declaration`, dropped };
    // A rest parameter carries the same socket as its element type; a rest
    // tuple (`...args: [...ShapeValue[], { tolerance }]`) carries its first.
    const declared = checker.getTypeOfSymbolAtLocation(param, decl);
    const type = decl.dotDotDotToken
      ? (checker.isTupleType(declared) ? checker.getTypeArguments(declared as ts.TypeReference)[0] : checker.getIndexTypeOfType(declared, ts.IndexKind.Number) ?? declared)
      : declared;
    const optional = decl.questionToken !== undefined || decl.initializer !== undefined || decl.dotDotDotToken !== undefined;
    if (param.getName() === 'opts' || param.getName() === 'options') {
      const record = nonNullish(type);
      const options: Option[] = [];
      let problem: string | undefined;
      for (const prop of checker.getPropertiesOfType(record)) {
        const name = prop.getName();
        if (name.startsWith('_')) continue;
        const propDecl = prop.valueDeclaration ?? prop.declarations?.[0] ?? at;
        const propOptional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
        const { input, problem: bad } = inputOf(checker.getTypeOfSymbolAtLocation(prop, propDecl), `option ${name}`, !propOptional);
        if (bad) {
          if (!optional) problem ??= bad;
          else dropped.push(`${word}.${param.getName()}.${name}`);
          continue;
        }
        if (input) options.push({ name, optional: propOptional, ...input });
        else dropped.push(`${word}.${param.getName()}.${name}`);
      }
      if (problem) return { params, problem, dropped };
      if (options.length === 0) {
        if (optional) continue;
        return { params, problem: `options record ${param.getName()} carries nothing a node can set`, dropped };
      }
      params.push({ name: param.getName(), optional, options });
      continue;
    }
    const { input, problem } = inputOf(type, `parameter ${param.getName()}`, !optional);
    if (problem) return { params, problem, dropped };
    if (!input) {
      dropped.push(`${word}.${param.getName()}`);
      continue;
    }
    params.push({ name: param.getName(), optional, ...input });
  }
  return { params, dropped };
}

/** The signature of a callable type that becomes the node: one that maps
 * whole, and among those the most capable (most parameters), then the last
 * — the overload a docs example reaches for. */
function planOf(type: ts.Type, at: ts.Node, word: string): { params: Param[]; returns: ValueType } | { problem: string } {
  let firstProblem = '';
  let best: { params: Param[]; returns: ValueType } | undefined;
  for (const sig of type.getCallSignatures()) {
    const returns = valueOf(checker.getReturnTypeOfSignature(sig));
    if (!returns) {
      firstProblem ||= `returns ${checker.typeToString(checker.getReturnTypeOfSignature(sig), at, ts.TypeFormatFlags.NoTruncation)}`;
      continue;
    }
    const { params, problem, dropped: left } = paramsOf(sig, at, word);
    if (problem) {
      firstProblem ||= problem;
      continue;
    }
    dropped.push(...left);
    if (!best || params.length >= best.params.length) best = { params, returns };
  }
  return best ?? { problem: firstProblem || 'no call signature' };
}

const words: Word[] = [];

function addWord(word: string, module: 'occlude' | 'occlude/3d', receiver: string | null, importSpec: string | null, call: string, plan: { params: Param[]; returns: ValueType }, at: ts.Node): void {
  const page = pageOfWord.get(word);
  if (!page) {
    skipped.push({ word, reason: 'no reference page documents it' });
    return;
  }
  words.push({
    word, module, receiver, import: importSpec, call, params: plan.params, returns: plan.returns,
    page: `/docs/reference/${page.slug}`, group: page.group,
  });
}

/** The 3D module's own names, so a name it shares with `occlude` (both have
 * a `circle`) is imported under a distinct name. */
const twoDNames = new Set<string>();
/** Every name a sketch may import, per module, mapped to the specifier that
 * binds it (`circle3` → `circle as circle3`): a code node body reaches for
 * these, and the compiler imports what it finds. */
const importable: Record<'occlude' | 'occlude/3d', Map<string, string>> = { occlude: new Map(), 'occlude/3d': new Map() };

function walk(symbols: ts.Symbol[], module: 'occlude' | 'occlude/3d'): void {
  for (let sym of symbols) {
    const name = sym.getName();
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (!decl) continue;
    if (module === 'occlude' && (sym.flags & ts.SymbolFlags.Variable) && NAMESPACES.includes(name)) {
      importable.occlude.set(name, name);
      const type = checker.getTypeOfSymbolAtLocation(sym, decl);
      for (const prop of checker.getPropertiesOfType(type)) {
        const memberDecl = prop.valueDeclaration ?? prop.declarations?.[0] ?? decl;
        const plan = planOf(checker.getTypeOfSymbolAtLocation(prop, memberDecl), memberDecl, `${name}.${prop.getName()}`);
        if ('problem' in plan) {
          skipped.push({ word: `${name}.${prop.getName()}`, reason: plan.problem });
          continue;
        }
        addWord(`${name}.${prop.getName()}`, 'occlude', name, name, `${name}.${prop.getName()}`, plan, memberDecl);
      }
      continue;
    }
    if (!(sym.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable))) continue;
    const type = checker.getTypeOfSymbolAtLocation(sym, decl);
    // An object a sketch may reach into (`v3.add`, the 3D `force`) is
    // importable too, and so is any other exported value.
    const clash = module === 'occlude/3d' && twoDNames.has(name);
    importable[module].set(clash ? `${name}3` : name, clash ? `${name} as ${name}3` : name);
    if (type.getCallSignatures().length === 0) continue;
    const key = clash ? `3d.${name}` : name;
    const plan = planOf(type, decl, key);
    if ('problem' in plan) {
      skipped.push({ word: key, reason: plan.problem });
      continue;
    }
    addWord(key, module, null, clash ? `${name} as ${name}3` : name, clash ? `${name}3` : name, plan, decl);
  }
}

/** The toolkit type: `Toolkit`, the object `bindToolkit` returns. */
function toolkitType(): ts.Type | undefined {
  const sf = program.getSourceFile(entry);
  if (!sf) throw new Error(`no source file at ${entry}`);
  const moduleSymbol = checker.getSymbolAtLocation(sf);
  if (!moduleSymbol) throw new Error('index.ts has no module symbol');
  for (let sym of checker.getExportsOfModule(moduleSymbol)) {
    if (sym.getName() !== 'Toolkit') continue;
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym.declarations?.find(ts.isTypeAliasDeclaration);
    if (!decl) throw new Error('index.ts has no Toolkit type alias');
    return checker.getTypeFromTypeNode(decl.type);
  }
  return undefined;
}

/** The toolkit: every member of `Toolkit`. */
function walkToolkit(): void {
  const type = toolkitType();
  if (!type) throw new Error('index.ts has no Toolkit type');
  for (const prop of checker.getPropertiesOfType(type)) {
    const name = prop.getName();
    if (name.startsWith('_')) continue;
    const propDecl = prop.valueDeclaration ?? prop.declarations?.[0] ?? entry;
    const plan = planOf(checker.getTypeOfSymbolAtLocation(prop, propDecl), propDecl, `t.${name}`);
    if ('problem' in plan) {
      skipped.push({ word: `t.${name}`, reason: plan.problem });
      continue;
    }
    addWord(`t.${name}`, 'occlude', 't', null, `t.${name}`, plan, propDecl);
  }
}

const sf = program.getSourceFile(entry);
const sf3 = program.getSourceFile(entry3d);
const mod = sf && checker.getSymbolAtLocation(sf);
const mod3 = sf3 && checker.getSymbolAtLocation(sf3);
if (!mod) throw new Error(`no source file at ${entry}`);
if (!mod3) throw new Error(`no source file at ${entry3d}`);
for (let sym of checker.getExportsOfModule(mod)) {
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  if (sym.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable)) twoDNames.add(sym.getName());
}
walk(checker.getExportsOfModule(mod), 'occlude');
walk(checker.getExportsOfModule(mod3), 'occlude/3d');
walkToolkit();

/** `--debug <word>` prints why one word maps, or does not: every overload,
 * its return socket, and every parameter's socket. */
function debug(word: string): void {
  const show = (label: string, type: ts.Type, at: ts.Node): void => {
    const takes = takesOf(type);
    const value = takes ? `takes ${takes.socket}${takes.kinds ? ` ${takes.kinds.join('|')}` : ''}` : valueOf(type) ? `carries ${valueOf(type)}` : controlOf(type) ? `control ${controlOf(type)!.control}` : 'carries nothing';
    console.log(`  ${label}: ${checker.typeToString(type, at, ts.TypeFormatFlags.NoTruncation)} → ${value}`);
    if (!type.isUnion()) return;
    for (const member of type.types) {
      const name = member.aliasSymbol?.getName() ?? member.getSymbol()?.getName() ?? '';
      const k = kindsOf(member);
      console.log(`      · ${checker.typeToString(member, at, ts.TypeFormatFlags.NoTruncation)} → ${k ? k.join('|') : valueOf(member) ?? '—'}${name ? `  [${name}]` : ''}`);
    }
  };
  const explain = (key: string, type: ts.Type, at: ts.Node): void => {
    console.log(key);
    const sigs = type.getCallSignatures();
    if (sigs.length === 0) console.log('  not a function');
    sigs.forEach((sig, i) => {
      show(`  [${i}] returns`, checker.getReturnTypeOfSignature(sig), at);
      for (const p of sig.getParameters()) {
        const decl = p.valueDeclaration ?? at;
        const paramType = checker.getTypeOfSymbolAtLocation(p, decl);
        show(`  [${i}] ${p.getName()}`, paramType, decl);
        if (!/^opts|options$/.test(p.getName())) continue;
        for (const prop of checker.getPropertiesOfType(nonNullish(paramType))) {
          const propDecl = prop.valueDeclaration ?? prop.declarations?.[0] ?? decl;
          const propType = checker.getTypeOfSymbolAtLocation(prop, propDecl);
          const takes = takesOf(propType);
          const control = controlOf(propType);
          console.log(`        ${prop.getName()}: ${checker.typeToString(propType, propDecl, ts.TypeFormatFlags.NoTruncation)} → ${takes ? `${takes.socket}${takes.kinds ? ` ${takes.kinds.join('|')}` : ''}` : control ? `control ${control.control}` : '—'}`);
        }
      }
    });
  };
  const found = words.find((w) => w.word === word);
  if (found) console.log(`→ included, from ${found.page}`);
  const bare = word.replace(/^3d\./, '').split('.').pop();
  const lookup = (moduleSymbol: ts.Symbol): void => {
    for (let sym of checker.getExportsOfModule(moduleSymbol)) {
      const name = sym.getName();
      if (name !== bare) continue;
      if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      const decl = sym.valueDeclaration ?? sym.declarations?.[0];
      if (decl) explain(name, checker.getTypeOfSymbolAtLocation(sym, decl), decl);
    }
  };
  lookup(mod);
  lookup(mod3);
  if (word.startsWith('t.')) {
    const name = word.slice(2);
    const toolkit = toolkitType();
    const prop = toolkit && checker.getPropertyOfType(toolkit, name);
    if (prop) explain(`t.${name}`, checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration ?? entry), prop.valueDeclaration ?? entry);
  }
}

const debugArg = process.argv.indexOf('--debug');
if (debugArg >= 0) {
  debug(process.argv[debugArg + 1] ?? '');
  process.exit(0);
}

// ---- write ----

const pageOrder = new Map(PAGES.map((p, i) => [p.slug, i]));
words.sort((a, b) => {
  const pa = pageOrder.get(a.page.replace('/docs/reference/', '')) ?? 1e9;
  const pb = pageOrder.get(b.page.replace('/docs/reference/', '')) ?? 1e9;
  return pa - pb || a.word.localeCompare(b.word);
});
const dupes = words.map((w) => w.word).filter((w, i, all) => all.indexOf(w) !== i);
if (dupes.length > 0) throw new Error(`duplicate words: ${[...new Set(dupes)].join(', ')}`);

const q = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
/** The fields of one input: what it takes, or the control it edits. */
const inputFields = (i: Partial<Takes> & Partial<Control>): string => {
  const parts: string[] = [];
  if (i.socket) parts.push(`takes: { socket: ${q(i.socket)}${i.kinds ? `, kinds: [${i.kinds.map(q).join(', ')}]` : ''} }`);
  if (i.control) parts.push(`control: ${q(i.control)}`);
  if (i.choices) parts.push(`choices: [${i.choices.map(q).join(', ')}]`);
  return parts.join(', ');
};
const lines: string[] = [];
lines.push('/**');
lines.push(' * The built-in node catalogue: one entry per occlude word a graph may');
lines.push(' * use, generated from the public types.');
lines.push(' *');
lines.push(' *   pnpm --filter occlude-studio graph:catalogue');
lines.push(' *');
lines.push(' * Do not edit by hand. `tools/graph-catalogue.ts` reads the same program');
lines.push(' * the docs signatures read, and the reference pages decide where a word');
lines.push(' * belongs. A word whose types carry no socket is absent; the run lists');
lines.push(' * those words and the reason.');
lines.push(' */');
lines.push("import type { Catalogue } from './model.js';");
lines.push('');
lines.push('export const CATALOGUE: Catalogue = {');
lines.push('  words: [');
for (const w of words) {
  lines.push('    {');
  lines.push(`      word: ${q(w.word)}, module: ${q(w.module)}, receiver: ${w.receiver ? q(w.receiver) : 'null'},`);
  lines.push(`      import: ${w.import ? q(w.import) : 'null'}, call: ${q(w.call)}, returns: ${q(w.returns)},`);
  lines.push(`      page: ${q(w.page)}, group: ${q(w.group)},`);
  lines.push('      params: [');
  for (const p of w.params) {
    if (p.options) {
      lines.push(`        { name: ${q(p.name)}, optional: ${p.optional}, options: [`);
      for (const o of p.options) lines.push(`          { name: ${q(o.name)}, ${inputFields(o)}, optional: ${o.optional} },`);
      lines.push('        ] },');
    } else {
      lines.push(`        { name: ${q(p.name)}, ${inputFields(p)}, optional: ${p.optional} },`);
    }
  }
  lines.push('      ],');
  lines.push('    },');
}
lines.push('  ],');
lines.push('  importable: [');
for (const module of ['occlude', 'occlude/3d'] as const) {
  const entries = [...importable[module]].sort((a, b) => a[0].localeCompare(b[0]));
  lines.push(`    { module: ${q(module)}, names: [`);
  for (let i = 0; i < entries.length; i += 4) {
    lines.push(`      ${entries.slice(i, i + 4).map(([local, spec]) => `{ name: ${q(local)}, spec: ${q(spec)} }`).join(', ')},`);
  }
  lines.push('    ] },');
}
lines.push('  ],');
lines.push('};');
lines.push('');
writeFileSync(out, lines.join('\n'));

// ---- report ----

console.log(`${words.length} words → ${out}`);
const byGroup = new Map<string, number>();
for (const w of words) byGroup.set(w.group, (byGroup.get(w.group) ?? 0) + 1);
for (const [group, n] of byGroup) console.log(`  ${String(n).padStart(3)}  ${group}`);
console.log(`\n${dropped.length} inputs are not on a node (no socket, no control):`);
const byWord = new Map<string, number>();
for (const entry of dropped) {
  const word = entry.split('.')[0];
  byWord.set(word, (byWord.get(word) ?? 0) + 1);
}
console.log(`  ${[...byWord].map(([word, n]) => `${word}(${n})`).join(', ')}`);
console.log(`\n${skipped.length} words have no node:`);
const byReason = new Map<string, string[]>();
for (const s of skipped) {
  const key = s.reason.startsWith('no reference page') ? 'no reference page' : s.reason.startsWith('returns') ? 'return type carries no socket' : s.reason.split(' ')[0];
  byReason.set(key, [...(byReason.get(key) ?? []), s.word]);
}
for (const [reason, list] of byReason) {
  console.log(`  ${String(list.length).padStart(3)}  ${reason}: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ' …' : ''}`);
}
if (process.argv.includes('--full')) {
  console.log('');
  for (const entry of [...new Set(dropped)].sort()) console.log(`  dropped: ${entry}`);
  for (const s of skipped.sort((a, b) => a.word.localeCompare(b.word))) console.log(`  ${s.word}: ${s.reason}`);
}
