/**
 * Signatures for the docs, read from the types so a page cannot drift.
 *
 *   pnpm --filter occlude docs:signatures
 *
 * Walks the public surface (`src/index.ts` and `src/host.ts` exports, the members of the
 * value classes and row views, the toolkit, and the `connect`/`force`/
 * `field` namespaces) and writes one MDX partial per word under `docs/_sig/`,
 * e.g. `_sig/Material.planarize.mdx` holding
 *
 *   <p class="sig"><code>m.planarize(opts?: PlanarizeOpts): Material</code></p>
 *
 * with every type that has a reference page linked to it. A page splices
 * a signature with `<include>/_sig/Material.planarize.mdx</include>`; a
 * word that leaves the library leaves the folder, and the docs build
 * fails on the dangling include instead of showing a stale line.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const docs = resolve(pkg, '../../docs');
const out = join(docs, '_sig');
const entry = join(pkg, 'src/index.ts');
/** The 3D vocabulary is its own module, `occlude/3d`; its words are keyed `3d.<name>`. */
const entry3d = join(pkg, 'src/three/api/index.ts');
/** The host words, `occlude/host`, keyed bare like the root's: the two
 * entry points never share a name. */
const entryHost = join(pkg, 'src/host.ts');

/** Receiver spelling per owner: what a sketch calls the value. */
const RECEIVER: Record<string, string> = {
  Material: 'm', Tiling: 'tiles', Face: 'face', Edge: 'edge', Vertex: 'p',
  Selection: 'sel', Curve: 'c', Placement: 'placement', Lattice: 'l', Toolkit: 't', '3d.Honeycomb': 'h',
  connect: 'connect', force: 'force', ease: 'ease', sdf: 'sdf', '3d.sdf3': 'sdf3',
  ImageSampler: 'img',
};
/** Reference page per type name; a link is emitted only when the page exists. */
const PAGE: Record<string, string> = {
  Material: 'material', Curve: 'material',
  Vertex: 'selections', Edge: 'selections', Selection: 'selections', NearestHit: 'selections', FirstHit: 'selections',
  Face: 'faces', MeasureOpts: 'faces', PlanarizeOpts: 'faces',
  PointValue: 'steps', EdgeValue: 'steps', GraphForce: 'steps', ReplaceOpts: 'steps',
  Lattice: 'steps', LatticeFace: 'steps', Vec: 'material', XY: 'material',
  ShapeValue: 'shapes', ShapeOpts: 'shapes', GroupValue: 'shapes', GroupOpts: 'shapes', FillSpec: 'fills', ModifierValue: 'shapes',
  HatchParams: 'fills', CrosshatchParams: 'fills', SolidParams: 'fills', StippleParams: 'fills', ContourParams: 'fills', BuiltinFillName: 'fills', FillParams: 'fills',
  FieldFn2: 'fields', FieldFn: 'fields', VectorFieldFn: 'fields', DistanceField: 'fields', Geometry: 'material', L: 'shapes', Toolkit: 'sketch',
  Placement: 'geometry', ModelDoor: 'geometry', Space: 'geometry', Tiling: 'geometry', TransformOp: 'transforms',
  Honeycomb: 'geometry', HoneycombFace: 'geometry',
  ViewObjectOptions: '3d/view', ViewOptions: '3d/view', Vec3: '3d/primitives', DistanceField3: '3d/primitives', Instances: '3d/instances', SurfaceCurves: '3d/surface',
  ImageSampler: 'images', PaletteEntry: 'images', ImageRegion: 'images', RegionOpts: 'images', ImageChannel: 'images',
};

const program = ts.createProgram([entry, entry3d, entryHost], {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true, skipLibCheck: true, noEmit: true,
});
const checker = program.getTypeChecker();
const sf = program.getSourceFile(entry);
if (!sf) throw new Error(`no source file at ${entry}`);
const moduleSymbol = checker.getSymbolAtLocation(sf);
if (!moduleSymbol) throw new Error('index.ts has no module symbol');
const FLAGS = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;

// A short type alias with no page of its own (`IntersectionInput`,
// `PointsLike`) tells a reader nothing; its definition does. Each such name
// is spelled out once, one level deep, with type arguments dropped.
const ALIAS = new Map<string, string>();
function aliasText(sym: ts.Symbol): string | undefined {
  const decl = sym.declarations?.find(ts.isTypeAliasDeclaration);
  if (!decl || decl.typeParameters) return undefined;
  let text = decl.type.getText();
  // `Mesh<any, any, any, any>` is `Mesh`; `Iterable<XY>` keeps its argument.
  text = text.replace(/<\s*(?:any|unknown)(?:\s*,\s*(?:any|unknown))*\s*>/g, '');
  text = text.replace(/\s*\|\s*/g, ' | ').replace(/\s+/g, ' ').replace(/^\| /, '').trim();
  return text.length <= 80 && !text.includes('{') ? text : undefined;
}
function collectAliases(mod: ts.Symbol): void {
  for (let sym of checker.getExportsOfModule(mod)) {
    const name = sym.getName();
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    if (PAGE[name] || ALIAS.has(name)) continue;
    const text = aliasText(sym);
    if (text && text !== name) ALIAS.set(name, text);
  }
}
const expand = (sig: string) => sig.replace(/\b([A-Z][A-Za-z0-9]*)\b(<[^<>]*>)?(\[\])?/g, (m, name: string, _args: string | undefined, array: string | undefined) => {
  const text = ALIAS.get(name);
  if (!text) return m;
  // A union or a function type needs parentheses before `[]`, or the array
  // reads as part of the union, or as the function's return type.
  const needsParens = text.includes(' | ') || text.includes('=>');
  return array ? (needsParens ? `(${text})[]` : `${text}[]`) : text;
});

// MDX reads `{ … }` as an expression even inside HTML, so braces are entities too.
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
function link(sig: string): string {
  // Type names are identifiers; only those with an existing page get an anchor.
  return escape(expand(sig.replace(/<undefined>/g, ''))).replace(/\b([A-Z][A-Za-z0-9]*)\b/g, (name) => {
    const page = PAGE[name];
    return page && existsSync(join(docs, 'reference', `${page}.mdx`)) ? `<a href="/docs/reference/${page}">${name}</a>` : name;
  });
}

const lines = new Map<string, string[]>();
function add(key: string, line: string): void {
  const arr = lines.get(key) ?? [];
  if (!arr.includes(line)) arr.push(line);
  lines.set(key, arr);
}
function callable(type: ts.Type, prefix: string, key: string, decl?: ts.Node): boolean {
  const sigs = type.getCallSignatures();
  if (sigs.length === 0) return false;
  const lines = sigs.map((sig) => `${prefix}${checker.signatureToString(sig, decl, FLAGS, ts.SignatureKind.Call)}`);
  // A word the core declares loosely (`unknown`, `object`) and the 3D layer
  // types by declaration merging reads as its typed forms only.
  const loose = (line: string): boolean => /: (unknown|object)[,)]/.test(line);
  const names = (line: string): string => (line.slice(prefix.length).match(/(?:^\(|, )(\w+)\??:/g) ?? []).join('');
  const kept = lines.filter((line) => !loose(line) || !lines.some((other) => other !== line && !loose(other) && names(other) === names(line)));
  for (const line of kept) add(key, line);
  return true;
}
function member(owner: string, sym: ts.Symbol, ownerType: ts.Type): void {
  const name = sym.getName();
  if (name.startsWith('_') || name.startsWith('[') || name === 'constructor') return;
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (decl && ts.getCombinedModifierFlags(decl as ts.Declaration) & ts.ModifierFlags.Private) return;
  if (decl && ts.getJSDocTags(decl).some((t) => t.tagName.text === 'internal')) return;
  const recv = RECEIVER[owner] ?? owner;
  const type = checker.getTypeOfSymbolAtLocation(sym, decl ?? sf!);
  const key = `${owner}.${name}`;
  if (!callable(type, `${recv}.${name}`, key, decl)) add(key, `${recv}.${name}: ${checker.typeToString(type, decl, FLAGS)}`);
  void ownerType;
}

/** An owner whose exported name is a type over kinds: the interface of the
 * kind its page documents. */
const OWNER_KINDS: Record<string, string> = { Placement: 'PlanePlacement' };
const OWNERS = ['ImageSampler', 'Material', 'Tiling', 'Face', 'Edge', 'Vertex', 'Curve', 'Placement', 'Lattice', 'Toolkit'];

/**
 * A subclass owns only what it adds. `Tiling` is a `Material`, so every
 * word it inherits is already written under `Material.*` on the material
 * page; writing them again under `Tiling.*` would say the same line twice
 * and invite a page to include the wrong one.
 */
function declaredHere(owner: string, sym: ts.Symbol): boolean {
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  const parent = decl?.parent;
  if (!parent || !(ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent))) return true;
  const from = parent.name?.text;
  return from === undefined || from === owner || !OWNERS.includes(from);
}
const NAMESPACES = ['connect', 'force', 'ease', 'sdf'];
/** A namespace that holds one of its own: its words are its members, keyed
 * `parent.child.word`. Without this the parent would print the whole
 * object type on one line. */
const SUBNAMESPACES: string[] = [];
/** The 3D values whose members a page documents, keyed `3d.<Owner>.<word>`. */
const OWNERS3 = ['Honeycomb'];
/**
 * The one selection (selection.ts). Its shared words are written once,
 * spelled over `Row`, as `sel.<word>`. The words a kind brings — the writes,
 * `extract`, the protocol words, the faces' and edges' own — are typed by
 * the row, so each is written once per kind that has it, read off the
 * collection that holds that kind (`m.points`, `m.edges`, `m.faces`,
 * `l.cells`) and spelled with that receiver: `points.set(…)`, `faces.measure(…)`.
 */
const KIND_WORDS = ['source', 'points', 'edges', 'faces', 'corners', 'contours', 'curves', 'set', 'add', 'remove', 'extract', 'boundaryEdges', 'measure', 'thicken', 'resample', 'trim', 'spline', 'oscillate', 'along'];
/** Words the class declares for every kind but only edges answer. */
const EDGE_WORDS = ['nearest', 'firstHit', 'crossing'];
function exportedType(mod: ts.Symbol, name: string): ts.Type | undefined {
  for (let sym of checker.getExportsOfModule(mod)) {
    if (sym.getName() !== name) continue;
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    return checker.getDeclaredTypeOfSymbol(sym);
  }
  return undefined;
}
function propertyType(t: ts.Type, name: string, call = false): ts.Type | undefined {
  const p = t.getProperty(name);
  if (!p) return undefined;
  const pt = checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? p.declarations?.[0] ?? sf!);
  if (!call) return pt;
  const sig = pt.getCallSignatures()[0];
  return sig && checker.getReturnTypeOfSignature(sig);
}
/** `sel.filter<S extends Selection<Row>>(this: S, fn: …): S` reads as
 * `sel.filter(fn: …): Selection<Row>`: the `this` form is how the type keeps
 * a group's key, not a word a sketch says. */
const plainThis = (line: string): string =>
  line.replace(/<S extends Selection<Row>>\(this: S(, )?/, '(').replace(/\): S$/, '): Selection<Row>');
/** One kind's word, written under every key given: `Selection.set` holds
 * every kind's forms, `points.set` one kind's. */
function kindWord(kt: ts.Type, name: string, recv: string, keys: string[], decl?: ts.Node): void {
  const p = kt.getProperty(name);
  if (!p) return;
  const pt = checker.getTypeOfSymbolAtLocation(p, decl ?? sf!);
  if (pt.flags & (ts.TypeFlags.Never | ts.TypeFlags.Undefined)) return;
  for (const key of keys) {
    if (callable(pt, `${recv}.${name}`, key, decl)) continue;
    const text = checker.typeToString(pt, decl, FLAGS);
    // A word left unresolved over type parameters says nothing: skip it.
    if (!text.includes('RowTypes<')) add(key, `${recv}.${name}: ${text}`);
  }
}
function selectionWords(sym: ts.Symbol): void {
  const t = checker.getDeclaredTypeOfSymbol(sym);
  const material = exportedType(moduleSymbol!, 'Material');
  const lattice = exportedType(moduleSymbol!, 'Lattice');
  const kinds: [string, ts.Type | undefined][] = [
    ['points', material && propertyType(material, 'points')],
    ['edges', material && propertyType(material, 'edges')],
    ['faces', material && propertyType(material, 'faces')],
    ['l.faces', lattice && propertyType(lattice, 'faces')],
  ];
  for (const m of checker.getPropertiesOfType(t)) {
    const name = m.getName();
    if (name.startsWith('_') || name.startsWith('[') || name === 'constructor') continue;
    const decl = m.valueDeclaration ?? m.declarations?.[0];
    if (decl && ts.getCombinedModifierFlags(decl as ts.Declaration) & ts.ModifierFlags.Private) continue;
    if (decl && ts.getJSDocTags(decl).some((tag) => tag.tagName.text === 'internal')) continue;
    const key = `Selection.${name}`;
    if (KIND_WORDS.includes(name) || EDGE_WORDS.includes(name)) {
      for (const [recv, kt] of kinds) {
        if (!kt || (EDGE_WORDS.includes(name) && recv !== 'edges')) continue;
        kindWord(kt, name, recv, [key, `${recv}.${name}`], decl);
      }
      continue;
    }
    const type = checker.getTypeOfSymbolAtLocation(m, decl ?? sf!);
    const sigs = type.getCallSignatures();
    if (sigs.length === 0) add(key, `sel.${name}: ${checker.typeToString(type, decl, FLAGS)}`);
    for (const sig of sigs) add(key, plainThis(`sel.${name}${checker.signatureToString(sig, decl, FLAGS, ts.SignatureKind.Call)}`));
  }
}

// occlude/3d: every exported function, keyed `3d.<name>`, spelled bare (it is imported by name).
const sf3 = program.getSourceFile(entry3d);
const mod3 = sf3 && checker.getSymbolAtLocation(sf3);
collectAliases(moduleSymbol);
if (mod3) collectAliases(mod3);
// An alias of an alias (`Sources = PointsLike`) spells out the same definition.
for (const [name, text] of ALIAS) ALIAS.set(name, expand(text));
if (mod3) {
  for (let sym of checker.getExportsOfModule(mod3)) {
    const name = sym.getName();
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (sym.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable) && decl) callable(checker.getTypeOfSymbolAtLocation(sym, decl), name, `3d.${name}`, decl);
    if (OWNERS3.includes(name)) {
      const t = checker.getDeclaredTypeOfSymbol(sym);
      for (const m of checker.getPropertiesOfType(t)) member(`3d.${name}`, m, t);
    }
    // `sdf3` is a namespace of fields, as the 2D `sdf` is: its words are its members.
    if (name === 'sdf3' && decl) {
      const t = checker.getTypeOfSymbolAtLocation(sym, decl);
      for (const m of checker.getPropertiesOfType(t)) member('3d.sdf3', m, t);
    }
  }
}
for (let sym of checker.getExportsOfModule(moduleSymbol)) {
  const name = sym.getName();
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (name === 'Selection') {
    selectionWords(sym);
    continue;
  }
  if (OWNERS.includes(name)) {
    let t = checker.getDeclaredTypeOfSymbol(sym);
    // `Placement` is one name over two kinds (`Placement<XY | Vec3>`); the
    // page documents its default, the plane kind, whose interface holds the
    // frame and walk words.
    const kinds = OWNER_KINDS[name];
    if (kinds) {
      const file = (sym.declarations?.[0] as ts.Node | undefined)?.getSourceFile();
      const kind = file && checker.getSymbolAtLocation(file)?.exports?.get(kinds as ts.__String);
      if (kind) t = checker.getDeclaredTypeOfSymbol(kind);
    }
    for (const m of checker.getPropertiesOfType(t)) if (declaredHere(name, m)) member(name, m, t);
    continue;
  }
  if (NAMESPACES.includes(name) && decl) {
    const t = checker.getTypeOfSymbolAtLocation(sym, decl);
    for (const m of checker.getPropertiesOfType(t)) {
      const key = `${name}.${m.getName()}`;
      if (SUBNAMESPACES.includes(key)) {
        const sub = checker.getTypeOfSymbolAtLocation(m, m.valueDeclaration ?? decl);
        for (const g of checker.getPropertiesOfType(sub)) member(key, g, sub);
        continue;
      }
      member(name, m, t);
    }
    continue;
  }
  if (sym.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable) && decl) {
    callable(checker.getTypeOfSymbolAtLocation(sym, decl), name, name, decl);
  }
}

const sfHost = program.getSourceFile(entryHost);
const modHost = sfHost && checker.getSymbolAtLocation(sfHost);
if (modHost) {
  for (let sym of checker.getExportsOfModule(modHost)) {
    const name = sym.getName();
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (sym.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable) && decl) {
      callable(checker.getTypeOfSymbolAtLocation(sym, decl), name, name, decl);
    }
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [key, sigs] of lines) {
  const body = sigs.map((s) => `<code>${link(s)}</code>`).join('<br />');
  writeFileSync(join(out, `${key}.mdx`), `<p class="sig">${body}</p>\n`);
  // Overloads one by one too (`Toolkit.sample.2.mdx`), for a page that documents one form.
  if (sigs.length > 1) sigs.forEach((s, i) => writeFileSync(join(out, `${key}.${i + 1}.mdx`), `<p class="sig"><code>${link(s)}</code></p>\n`));
}
console.log(`${lines.size} signatures → ${out} (${readdirSync(out).length} files)`);
