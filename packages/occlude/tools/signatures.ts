/**
 * Signatures for the docs, read from the types so a page cannot drift.
 *
 *   pnpm --filter occlude docs:signatures
 *
 * Walks the public surface (`src/index.ts` exports, the members of the
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

/** Receiver spelling per owner: what a sketch calls the value. */
const RECEIVER: Record<string, string> = {
  Material: 'm', Tiling: 'tiles', Faces: 'cells', FaceSelection: 'sel', Face: 'face', Edge: 'edge', Vertex: 'p',
  PointSelection: 'points', EdgeSelection: 'edges', Station: 'station', Next: 'next', Toolkit: 't', '3d.Mesh': 'mesh',
  '3d.CurveGeometry': 'curve', '3d.Honeycomb': 'h', '3d.Placement3': 'place',
  connect: 'connect', force: 'force', query: 'query', ease: 'ease', sdf: 'sdf', '3d.sdf3': 'sdf3',
  ImageSampler: 'img',
};
/** Reference page per type name; a link is emitted only when the page exists. */
const PAGE: Record<string, string> = {
  Material: 'material', Curve: 'material', Snapshot: 'material', IsoContour: 'material',
  Vertex: 'selections', Edge: 'selections', PointSelection: 'selections', EdgeSelection: 'selections', Station: 'material',
  Faces: 'faces', FaceSelection: 'faces', Face: 'faces', FaceMeasurements: 'faces', MeasureOpts: 'faces', PlanarizeOpts: 'faces',
  Next: 'steps', StepRule: 'steps', StepShorthand: 'steps', StepsOptions: 'steps', FaceRow: 'steps', Rewrite: 'steps',
  ReplaceOpts: 'steps', ChildSpec: 'steps', SplitOpts: 'steps', Vec: 'material', XY: 'material',
  ShapeValue: 'shapes', ShapeOpts: 'shapes', GroupValue: 'shapes', GroupOpts: 'shapes', FillSpec: 'fills', ModifierValue: 'shapes',
  FieldFn2: 'fields', FieldFn: 'fields', VectorFieldFn: 'fields', DistanceField: 'fields', Geometry: 'material', L: 'shapes', Toolkit: 'sketch',
  Placement: 'geometry', ModelDoor: 'geometry', Space: 'geometry', Tiling: 'geometry',
  Placement3: 'geometry', Honeycomb: 'geometry', HoneycombFace: 'geometry', HoneycombPoint: 'geometry',
  Mesh: '3d/primitives', Vec3: '3d/primitives', DistanceField3: '3d/primitives', Instances: '3d/instances', SurfaceCurves: '3d/surface',
  ImageSampler: 'images', PaletteEntry: 'images', ImageRegion: 'images', RegionOpts: 'images', ImageChannel: 'images',
};

const program = ts.createProgram([entry, entry3d], {
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
  for (const sig of sigs) add(key, `${prefix}${checker.signatureToString(sig, decl, FLAGS, ts.SignatureKind.Call)}`);
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

const OWNERS = ['ImageSampler', 'Material', 'Tiling', 'Faces', 'FaceSelection', 'Face', 'Edge', 'Vertex', 'PointSelection', 'EdgeSelection', 'Station', 'Next', 'Toolkit'];

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
const NAMESPACES = ['connect', 'force', 'query', 'ease', 'sdf'];
/** A namespace that holds one of its own: its words are its members, keyed
 * `parent.child.word`. Without this the parent would print the whole
 * object type on one line. */
const SUBNAMESPACES: string[] = [];
/** The 3D values whose members a page documents, keyed `3d.<Owner>.<word>`. */
const OWNERS3 = ['Mesh', 'CurveGeometry', 'Honeycomb', 'Placement3'];
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
  if (OWNERS.includes(name)) {
    const t = sym.flags & ts.SymbolFlags.Class ? checker.getDeclaredTypeOfSymbol(sym) : checker.getDeclaredTypeOfSymbol(sym);
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

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [key, sigs] of lines) {
  const body = sigs.map((s) => `<code>${link(s)}</code>`).join('<br />');
  writeFileSync(join(out, `${key}.mdx`), `<p class="sig">${body}</p>\n`);
  // Overloads one by one too (`Toolkit.sample.2.mdx`), for a page that documents one form.
  if (sigs.length > 1) sigs.forEach((s, i) => writeFileSync(join(out, `${key}.${i + 1}.mdx`), `<p class="sig"><code>${link(s)}</code></p>\n`));
}
console.log(`${lines.size} signatures → ${out} (${readdirSync(out).length} files)`);
