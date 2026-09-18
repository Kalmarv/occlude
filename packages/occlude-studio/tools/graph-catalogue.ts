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

const SOCKET_CLASSES = ['Geometry', 'Number', 'Vector', 'Field', 'Fill', 'Camera', 'Modifier', 'VectorField', 'Tone', 'Pen'] as const;
type SocketClass = (typeof SOCKET_CLASSES)[number];
const GEOMETRY_KINDS = ['shape', 'material', 'points', 'faces', 'mesh', 'curves', 'surface', 'drawing'] as const;
type GeometryKind = (typeof GEOMETRY_KINDS)[number];
type ValueType = GeometryKind | SocketClass;

/** The value a type carries, by type name. A name absent here carries no
 * value, and a word that needs it is left out. */
/**
 * A named type that is one value, decided by its name before its members.
 *
 * `Boundary` is deliberately absent. It is the library's own spelling of
 * "an area is an input" — a loop, a contour record, one face, a chain
 * material, a point source — and naming it `shape` here threw the other
 * three kinds away, so `distanceTo(aMaterial)` was refused by a socket that
 * the library itself accepts. Left unnamed, the union is walked and the
 * socket takes every kind it really holds.
 */
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
  Surface3: 'surface',
  ModifierValue: 'Modifier',
  VectorFieldFn: 'VectorField',
  DirectionField: 'VectorField',
  ToneField: 'Tone',
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
  // A Field socket already takes a Number and reads it as a constant field,
  // so `number | FieldFn` is a Field. That is the wire rule the page has
  // always had; the generator was throwing the word away instead of using
  // it, which is why `decimate`, `wobble` and `roughen` had no node.
  if (classes.length === 2 && classes.includes('Field') && classes.includes('Number')) {
    return { socket: 'Field' };
  }
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
interface Control { control: 'number' | 'text' | 'check' | 'menu'; choices?: string[]; raw?: boolean }
interface Option extends Partial<Takes>, Partial<Control> { name: string; optional: boolean }
interface Param extends Partial<Takes>, Partial<Control> {
  name: string;
  optional: boolean;
  options?: Option[];
}

interface Word {
  /** A value, not a call: written with no parentheses. */
  value?: boolean;
  /** An expression rather than a call, with `{name}` per input. */
  template?: string;
  word: string;
  module: 'occlude' | 'occlude/3d';
  receiver: string | null;
  import: string | null;
  call: string;
  self?: { param: string; takes: { socket: SocketClass; kinds: GeometryKind[] } };
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
/**
 * The names that mean a pen. A pen is a plain string in the types — the name
 * of one of the sketch's own pens — so the type cannot say it is a pen and
 * the name has to. Making it a socket is what lets one pen node feed every
 * shape that draws with it, instead of the same word typed on each.
 */
const PEN_NAMES = new Set(['pen', 'fillPen']);

function inputOf(type: ts.Type, what: string, required: boolean, name?: string): { input?: Partial<Takes> & Partial<Control>; problem?: string } {
  if (name !== undefined && PEN_NAMES.has(name) && isStringish(type)) return { input: { socket: 'Pen' } };
  const takes = takesOf(type);
  if (takes) return { input: takes };
  const control = controlOf(type);
  if (control) return { input: control };
  if (!required) return {};
  return { problem: `${what} is ${checker.typeToString(nonNullish(type), undefined, ts.TypeFormatFlags.NoTruncation)}` };
}

/** A type that is a string, or a string and nothing else beside null. */
function isStringish(type: ts.Type): boolean {
  const inner = nonNullish(type);
  if ((inner.flags & ts.TypeFlags.String) !== 0) return true;
  return inner.isUnion() && inner.types.every((t) => (t.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) !== 0);
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
        const { input, problem: bad } = inputOf(checker.getTypeOfSymbolAtLocation(prop, propDecl), `option ${name}`, !propOptional, name);
        if (bad) {
          if (!optional) problem ??= bad;
          else dropped.push(`${word}.${param.getName()}.${name}`);
          continue;
        }
        if (input) options.push({ name, optional: propOptional, ...input });
        else dropped.push(`${word}.${param.getName()}.${name}`);
      }
      if (problem && !isCallable(record)) {
        // The record holds something no option can say (a per-fill parameter
        // list, a cost function beside plain options): the whole record is
        // source text the node carries.
        params.push({ name: param.getName(), optional, control: 'text', raw: true });
        continue;
      }
      if (problem) return { params, problem, dropped };
      if (options.length === 0) {
        if (optional) continue;
        return { params, problem: `options record ${param.getName()} carries nothing a node can set`, dropped };
      }
      params.push({ name: param.getName(), optional, options });
      continue;
    }
    const { input, problem } = inputOf(type, `parameter ${param.getName()}`, !optional, param.getName());
    if (input && !problem) {
      params.push({ name: param.getName(), optional, ...input });
      continue;
    }
    // A parameter no socket and no control can say is still the artist's to
    // write: it becomes source text the node carries and the compiler writes
    // back verbatim, the way a `mm(0.3)` literal already does. Without this
    // the parameter was dropped and the whole word went with it —
    // `material(points, { active: 1 })` and `fill('hatch', { angle: 45 })`
    // are ordinary, and neither had a node. A callable is the exception: a
    // rule body belongs in the graph, not in a text box.
    if (!isCallable(type)) {
      params.push({ name: param.getName(), optional, control: 'text', raw: true });
      continue;
    }
    if (problem) return { params, problem, dropped };
    dropped.push(`${word}.${param.getName()}`);
  }
  return { params, dropped };
}

/**
 * Whether a type is a function the artist would have to write. A parameter
 * like that stays out of the node: a rule body or a cost function belongs in
 * the graph, not squeezed into a text box on a node's face.
 */
function isCallable(type: ts.Type): boolean {
  return nonNullish(type).getCallSignatures().length > 0
    || (nonNullish(type).isUnion() && nonNullish(type).types.some((t) => t.getCallSignatures().length > 0));
}

/** The signature of a callable type that becomes the node: one that maps
 * whole, and among those the most capable (most parameters), then the last
 * — the overload a docs example reaches for. */
function planOf(type: ts.Type, at: ts.Node, word: string): { params: Param[]; returns: ValueType } | { problem: string } {
  let firstProblem = '';
  let best: { params: Param[]; returns: ValueType } | undefined;
  /** The parameter names each usable overload takes. A parameter one
   * overload leaves out is optional, whatever the widest one says:
   * `rnd()`, `rnd(n)` and `rnd(a, b)` are one word, and a node built from
   * the widest signature alone would call `t.rnd(2)` an error. */
  const perSignature: Set<string>[] = [];
  /** Every usable overload's parameters, by position, so a parameter's socket
   * can be the union of what all of them take. Overloads name the same place
   * differently — `t.within(points, area)` and `t.within(faces, area)` — so
   * the place is what they share, not the name. */
  const perPosition: Param[][] = [];
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
    perSignature.push(new Set(sig.getParameters().map((p) => p.getName())));
    params.forEach((param, i) => {
      (perPosition[i] ??= []).push(param);
    });
    if (!best || params.length >= best.params.length) best = { params, returns };
  }
  if (best && perSignature.length > 1) {
    for (const param of best.params) {
      if (perSignature.some((names) => !names.has(param.name))) param.optional = true;
      // A parameter one overload takes as a material and another as points
      // takes both: `t.within(points, area)` and `t.within(faces, area)` are
      // one word, and a node built from the widest signature alone would
      // refuse the others' geometry.
      const everywhere = perPosition[best!.params.indexOf(param)] ?? [];
      if (param.socket === 'Geometry' && param.kinds) {
        const kinds = new Set(param.kinds);
        let allGeometry = true;
        for (const other of everywhere) {
          if (other.socket !== 'Geometry' || !other.kinds) {
            // One overload takes something else entirely at this place; the
            // socket cannot be widened without lying about what fits.
            if (other.socket !== undefined || other.control !== undefined) allGeometry = false;
            continue;
          }
          for (const kind of other.kinds) kinds.add(kind);
        }
        if (allGeometry) param.kinds = [...kinds];
      }
    }
  }
  return best ?? { problem: firstProblem || 'no call signature' };
}

const words: Word[] = [];

/**
 * A word the toolkit binds that a module already exports under the same name
 * — `t.circle` beside `circle`. Both spellings work, and the law is that a
 * pure factory is a module import, so the palette carries the module's one
 * and not a second entry for the same idea.
 */
function isToolkitAlias(word: string, receiver: string | null): boolean {
  return receiver === 't' && words.some((w) => w.receiver === null && w.word === word.slice(2));
}

/**
 * A word joins the palette when its types map, whether or not a reference
 * page documents it. The page is a link, not a licence: 144 words that map
 * cleanly — every easing, the unit words, a material's own accessors — were
 * left out because the reference has no entry for them, which is a gap in
 * the docs and not a reason the artist cannot have the node. An undocumented
 * word is grouped by its owner (or `Other`) and carries no page link.
 */
function addWord(word: string, module: 'occlude' | 'occlude/3d', receiver: string | null, importSpec: string | null, call: string, plan: { params: Param[]; returns: ValueType }, at: ts.Node, isValue = false): void {
  const page = pageOfWord.get(word);
  if (!page && isToolkitAlias(word, receiver)) {
    skipped.push({ word, reason: 'the module exports the same word; the toolkit spelling is a second door' });
    return;
  }
  if (!page) undocumented.push(word);
  const owner = word.includes('.') ? word.slice(0, word.indexOf('.')) : '';
  words.push({
    word, module, receiver, import: importSpec, call, params: plan.params, returns: plan.returns,
    page: page ? `/docs/reference/${page.slug}` : '',
    group: page ? page.group : owner === '' || owner === 't' ? 'Other' : owner,
    ...(isValue ? { value: true } : {}),
  });
}

/** Every word the palette carries that the reference does not document. */
const undocumented: string[] = [];

/** The 3D module's own names, so a name it shares with `occlude` (both have
 * a `circle`) is imported under a distinct name. */
const twoDNames = new Set<string>();
/** Every name a sketch may import, per module, mapped to the specifier that
 * binds it (`circle3` → `circle as circle3`): a code node body reaches for
 * these, and the compiler imports what it finds. */
const importable: Record<'occlude' | 'occlude/3d', Map<string, string>> = { occlude: new Map(), 'occlude/3d': new Map() };
/** Every type name a sketch may import, per module. A class is a value and
 * is in `importable`; these are the aliases and interfaces, which a body can
 * only name in a type position. */
const importableTypes: Record<'occlude' | 'occlude/3d', Set<string>> = { occlude: new Set(), 'occlude/3d': new Set() };

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
    if (sym.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface)) importableTypes[module].add(name);
    if (!(sym.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable | ts.SymbolFlags.Class))) continue;
    const type = sym.flags & ts.SymbolFlags.Class ? checker.getDeclaredTypeOfSymbol(sym) : checker.getTypeOfSymbolAtLocation(sym, decl);
    // An object a sketch may reach into (`v3.add`, the 3D `force`) is
    // importable too, and so is any other exported value, a class included
    // (`FaceSelection3`, a type a sketch may name).
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

/** The value classes a node may hang a method off, with the socket the
 * receiver travels on. A row view (`Edge`, `Vertex`, `Station`, `Next`) is
 * reached by indexing a material, not by a wire, so it has no kind and no
 * node. */
const OWNERS: Record<string, { kind: GeometryKind; param: string }> = {
  Material: { kind: 'material', param: 'material' },
  PointSelection: { kind: 'points', param: 'points' },
  Faces: { kind: 'faces', param: 'faces' },
  FaceSelection: { kind: 'faces', param: 'faces' },
  '3d.Mesh': { kind: 'mesh', param: 'mesh' },
};

/** Every method and value a receiver class offers, as a word that takes the
 * receiver on a socket: `Material.steps` → `{self}.steps(...)`. */
function walkOwners(moduleSymbol: ts.Symbol): void {
  for (let sym of checker.getExportsOfModule(moduleSymbol)) {
    const name = sym.getName();
    const owner = OWNERS[name];
    if (!owner) continue;
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const type = checker.getDeclaredTypeOfSymbol(sym);
    for (const prop of checker.getPropertiesOfType(type)) {
      const member = prop.getName();
      if (member.startsWith('_') || member === 'constructor') continue;
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      if (!decl) continue;
      if (ts.getCombinedModifierFlags(decl as ts.Declaration) & ts.ModifierFlags.Private) continue;
      if (ts.getJSDocTags(decl).some((t) => t.tagName.text === 'internal')) continue;
      const word = `${name}.${member}`;
      // A method the reference does not document is still a method: the page
      // is a link, not a licence. It is grouped by its owner.
      const page = pageOfWord.get(word);
      if (!page) undocumented.push(word);
      const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
      let plan: { params: Param[]; returns: ValueType } | { problem: string };
      if (propType.getCallSignatures().length > 0) {
        plan = planOf(propType, decl, word);
      } else {
        const returns = valueOf(propType);
        plan = returns ? { params: [], returns } : { problem: `holds ${checker.typeToString(propType, decl, ts.TypeFormatFlags.NoTruncation)}` };
      }
      if ('problem' in plan) {
        skipped.push({ word, reason: plan.problem });
        continue;
      }
      words.push({
        word, module: name.startsWith('3d.') ? 'occlude/3d' : 'occlude', receiver: null, import: null,
        call: `{self}.${member}`, self: { param: owner.param, takes: { socket: 'Geometry', kinds: [owner.kind] } },
        params: plan.params, returns: plan.returns,
        page: page ? `/docs/reference/${page.slug}` : '',
        group: page ? page.group : name,
      });
    }
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
    const propType = checker.getTypeOfSymbolAtLocation(prop, propDecl);
    // A toolkit member that is a value and not a function is a node with no
    // inputs: `t.cx` is the middle of the drawable, and a sketch writes it
    // with no parentheses.
    if (propType.getCallSignatures().length === 0) {
      const returns = valueOf(propType);
      if (!returns) {
        skipped.push({ word: `t.${name}`, reason: `holds ${checker.typeToString(propType, propDecl, ts.TypeFormatFlags.NoTruncation)}` });
        continue;
      }
      addWord(`t.${name}`, 'occlude', 't', null, `t.${name}`, { params: [], returns }, propDecl, true);
      continue;
    }
    const plan = planOf(propType, propDecl, `t.${name}`);
    if ('problem' in plan) {
      skipped.push({ word: `t.${name}`, reason: plan.problem });
      continue;
    }
    addWord(`t.${name}`, 'occlude', 't', null, `t.${name}`, plan, propDecl);
  }
}

/**
 * The graph's own arithmetic.
 *
 * A wire cannot carry `+`, and the library exports no arithmetic for numbers
 * on purpose: a sketch is code, and code has operators. A graph is not code,
 * so it needs the words — one per operation, because that is what the project
 * asks for ("if signatures diverge, split the function"), rather than one node
 * with a menu whose second input is meaningless in half its settings.
 *
 * These are the only words in the catalogue the library does not export. They
 * are named under `math.` so none of them can collide with a library word
 * (`add` is the vector one), and each writes its expression rather than a
 * call to something that does not exist.
 */
const MATH: { word: string; inputs: string[]; template: string; hint: string }[] = [
  { word: 'math.add', inputs: ['a', 'b'], template: '({a} + {b})', hint: 'a plus b' },
  { word: 'math.subtract', inputs: ['a', 'b'], template: '({a} - {b})', hint: 'a less b' },
  { word: 'math.multiply', inputs: ['a', 'b'], template: '({a} * {b})', hint: 'a times b' },
  { word: 'math.divide', inputs: ['a', 'b'], template: '({a} / {b})', hint: 'a over b' },
  { word: 'math.remainder', inputs: ['a', 'b'], template: '({a} % {b})', hint: 'what is left of a after b' },
  { word: 'math.power', inputs: ['a', 'b'], template: '({a} ** {b})', hint: 'a to the power b' },
  { word: 'math.min', inputs: ['a', 'b'], template: 'Math.min({a}, {b})', hint: 'the smaller of the two' },
  { word: 'math.max', inputs: ['a', 'b'], template: 'Math.max({a}, {b})', hint: 'the larger of the two' },
  { word: 'math.hypot', inputs: ['a', 'b'], template: 'Math.hypot({a}, {b})', hint: 'the distance from the origin' },
  { word: 'math.atan2', inputs: ['y', 'x'], template: 'Math.atan2({y}, {x})', hint: 'the angle to a point, in radians' },
  { word: 'math.abs', inputs: ['a'], template: 'Math.abs({a})', hint: 'without its sign' },
  { word: 'math.round', inputs: ['a'], template: 'Math.round({a})', hint: 'to the nearest whole number' },
  { word: 'math.floor', inputs: ['a'], template: 'Math.floor({a})', hint: 'down to a whole number' },
  { word: 'math.ceil', inputs: ['a'], template: 'Math.ceil({a})', hint: 'up to a whole number' },
  { word: 'math.sqrt', inputs: ['a'], template: 'Math.sqrt({a})', hint: 'the square root' },
  { word: 'math.sign', inputs: ['a'], template: 'Math.sign({a})', hint: 'which way it points' },
  { word: 'math.sin', inputs: ['a'], template: 'Math.sin({a})', hint: 'the sine, in radians' },
  { word: 'math.cos', inputs: ['a'], template: 'Math.cos({a})', hint: 'the cosine, in radians' },
  { word: 'math.tan', inputs: ['a'], template: 'Math.tan({a})', hint: 'the tangent, in radians' },
  { word: 'math.log', inputs: ['a'], template: 'Math.log({a})', hint: 'the natural logarithm' },
];

function addMath(): void {
  for (const one of MATH) {
    words.push({
      word: one.word, module: 'occlude', receiver: null, import: null, call: one.word,
      template: one.template, returns: 'Number', page: '', group: 'Math',
      params: one.inputs.map((name) => ({ name, socket: 'Number' as SocketClass, optional: false })),
    });
  }
  // `math.pi` is a value, not a call.
  words.push({
    word: 'math.pi', module: 'occlude', receiver: null, import: null, call: 'Math.PI',
    value: true, returns: 'Number', page: '', group: 'Math', params: [],
  });
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
walkOwners(mod);
walkOwners(mod3);
walkToolkit();
addMath();

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
  if (i.raw) parts.push('raw: true');
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
  lines.push(`      word: ${q(w.word)}, module: ${q(w.module)}, receiver: ${w.receiver ? q(w.receiver) : 'null'},${w.value ? ' value: true,' : ''}${w.template ? ` template: ${q(w.template)},` : ''}`);
  lines.push(`      import: ${w.import ? q(w.import) : 'null'}, call: ${q(w.call)}, returns: ${q(w.returns)},`);
  if (w.self) lines.push(`      self: { param: ${q(w.self.param)}, takes: { socket: ${q(w.self.takes.socket)}, kinds: [${w.self.takes.kinds.map(q).join(', ')}] } },`);
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
lines.push('  importableTypes: [');
for (const module of ['occlude', 'occlude/3d'] as const) {
  const names = [...importableTypes[module]].sort();
  lines.push(`    { module: ${q(module)}, names: [`);
  for (let i = 0; i < names.length; i += 6) lines.push(`      ${names.slice(i, i + 6).map(q).join(', ')},`);
  lines.push('    ] },');
}
lines.push('  ],');
lines.push('};');
lines.push('');
writeFileSync(out, lines.join('\n'));

// ---- report ----

if (undocumented.length > 0) {
  console.log(`\n${undocumented.length} words in the palette that no reference page documents (they carry no page link):`);
  console.log(`  ${undocumented.join(', ')}\n`);
}

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
