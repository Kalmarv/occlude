/**
 * Signatures for the docs, read from the types so a page cannot drift.
 *
 *   pnpm --filter occlude docs:signatures
 *
 * Walks the public surface (`src/index.ts` exports, the members of the
 * value classes and row views, the toolkit, and the `connect`/`force`
 * namespaces) and writes one MDX partial per word under `docs/_sig/`,
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
  Material: 'm', Faces: 'cells', FaceSelection: 'sel', Face: 'face', Edge: 'edge', Vertex: 'p',
  PointSelection: 'points', EdgeSelection: 'edges', Station: 'station', Next: 'next', Toolkit: 't', '3d.Mesh': 'mesh',
  connect: 'connect', force: 'force', query: 'query', ease: 'ease',
};
/** Reference page per type name; a link is emitted only when the page exists. */
const PAGE: Record<string, string> = {
  Material: 'material', Curve: 'material', Snapshot: 'material', IsoContour: 'material',
  Vertex: 'selections', Edge: 'selections', PointSelection: 'selections', EdgeSelection: 'selections', Station: 'selections',
  Faces: 'faces', FaceSelection: 'faces', Face: 'faces', FaceMeasurements: 'faces', MeasureOpts: 'faces', PlanarizeOpts: 'faces',
  Next: 'steps', StepRule: 'steps', StepShorthand: 'steps', StepsOptions: 'steps', Vec: 'material', XY: 'material',
  ShapeValue: 'shapes', ShapeOpts: 'shapes', GroupValue: 'shapes', GroupOpts: 'shapes', FillSpec: 'fills', ModifierValue: 'shapes',
  FieldFn2: 'fields', FieldFn: 'fields', VectorFieldFn: 'fields', Boundary: 'material', L: 'shapes', Toolkit: 'shapes',
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

// MDX reads `{ … }` as an expression even inside HTML, so braces are entities too.
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
function link(sig: string): string {
  // Type names are identifiers; only those with an existing page get an anchor.
  return escape(sig.replace(/<undefined>/g, '')).replace(/\b([A-Z][A-Za-z0-9]*)\b/g, (name) => {
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

const OWNERS = ['Material', 'Faces', 'FaceSelection', 'Face', 'Edge', 'Vertex', 'PointSelection', 'EdgeSelection', 'Station', 'Next', 'Toolkit'];
const NAMESPACES = ['connect', 'force', 'query', 'ease'];
// occlude/3d: every exported function, keyed `3d.<name>`, spelled bare (it is imported by name).
const sf3 = program.getSourceFile(entry3d);
const mod3 = sf3 && checker.getSymbolAtLocation(sf3);
if (mod3) {
  for (let sym of checker.getExportsOfModule(mod3)) {
    const name = sym.getName();
    if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym.valueDeclaration ?? sym.declarations?.[0];
    if (sym.flags & (ts.SymbolFlags.Function | ts.SymbolFlags.Variable) && decl) callable(checker.getTypeOfSymbolAtLocation(sym, decl), name, `3d.${name}`, decl);
    if (name === 'Mesh') {
      const t = checker.getDeclaredTypeOfSymbol(sym);
      for (const m of checker.getPropertiesOfType(t)) member('3d.Mesh', m, t);
    }
  }
}
for (let sym of checker.getExportsOfModule(moduleSymbol)) {
  const name = sym.getName();
  if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym.valueDeclaration ?? sym.declarations?.[0];
  if (OWNERS.includes(name)) {
    const t = sym.flags & ts.SymbolFlags.Class ? checker.getDeclaredTypeOfSymbol(sym) : checker.getDeclaredTypeOfSymbol(sym);
    for (const m of checker.getPropertiesOfType(t)) member(name, m, t);
    continue;
  }
  if (NAMESPACES.includes(name) && decl) {
    const t = checker.getTypeOfSymbolAtLocation(sym, decl);
    for (const m of checker.getPropertiesOfType(t)) member(name, m, t);
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
