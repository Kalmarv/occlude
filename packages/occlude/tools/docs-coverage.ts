/**
 * The affected oracle's machinery: which source lines each docs fence runs,
 * and which fences a working-tree change can reach. `docs-hashes.ts` drives
 * it (`--map`, `--check --affected`); it lives apart so the selection is a
 * pure function the suite can test without rendering, and so nothing here
 * loads the library — the coverage session must start before `src` does.
 *
 * The map. One full oracle run under V8 precise block coverage
 * (`node:inspector`, binary counts, detailed ranges), taken between fences.
 * A take resets the counters and reports only the functions that ran, so a
 * fence's executed text is: each function that ran, minus its blocks that
 * did not, minus every function nested inside it (a nested function that
 * also ran adds its own text back). The nested ones come from a registry of
 * every function range ever reported; the first take, at import, reports
 * every function of every loaded script, compiled or not.
 *
 * Offsets are in the text tsx hands V8, not the source. tsx appends an
 * inline source map to every module it transpiles; the script's text comes
 * back through `Debugger.getScriptSource`, and `node:module`'s `SourceMap`
 * maps each executed piece's first and last character to source lines. The
 * suite pins one function body to its true lines.
 *
 * Module bodies run once, at import, before any fence. Their top-level code
 * is therefore not a fence's: functions the import itself ran are kept as
 * `init` (a change there reaches every fence), and top-level statements are
 * compared by `moduleLevelChange` — the runtime skeleton of the old and the
 * new file, types and function bodies set aside.
 *
 * Worker threads have their own isolate, which this session does not see.
 * Instead of instrumenting them, a fence that posted anything to a worker
 * gets every file the classifier worker loads marked whole; the worker
 * entry itself is a global trigger, because a fast run at one worker never
 * enters it while the full gate may.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { SourceMap, type SourceMapPayload } from 'node:module';
import { join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import ts from 'typescript';

/** Inclusive, 1-based source line ranges. */
export type Lines = [number, number][];

export interface CoverageMap {
  readonly commit: string;
  /** Hash of the tracked trees that can move ink (`INK_PATHS`); a map built
   * at another commit with the same tree still answers for this one. */
  readonly tree: string;
  /** Hash of the oracle's own code as it ran (`harnessFiles`, working copy):
   * the harness is part of what a map was built with, not part of a diff. */
  readonly harness: string;
  readonly builtMs: number;
  /** Every library module the run loaded, repo-relative. */
  readonly modules: string[];
  /** Fences that posted to a classifier worker (their worker files are whole). */
  readonly workerFences: string[];
  /** Lines of functions that ran at import: every fence depends on them. */
  readonly init: Record<string, Lines>;
  readonly fences: Record<string, Record<string, Lines>>;
}

/** One `@@ -a,n +c,m @@` of `git diff -U0`. `oldCount` 0 is an insertion
 * after old line `oldStart`. */
export interface Hunk { readonly oldStart: number; readonly oldCount: number; readonly newStart: number; readonly newCount: number }
export interface Change {
  readonly path: string;
  /** Added, deleted, untracked or binary: every old line counts. */
  readonly whole?: boolean;
  readonly hunks: readonly Hunk[];
  /** Why the file's module-level code changed, when it did. */
  readonly moduleLevel?: string | null;
}

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
const SRC = 'packages/occlude/src/';
export const WORKER_ENTRY = `${SRC}three/visibility/classify.worker.ts`;
/** Where the maps live: gitignored, keyed by commit. */
export const cacheDir = join(repoRoot, 'packages/occlude/node_modules/.cache/docs-coverage');
/** The tracked paths whose content can move ink, hashed into `tree`. The
 * harness is hashed apart, from the working copy. */
const INK_PATHS = ['crates', 'packages/occlude/src', 'packages/occlude/package.json',
  'packages/occlude/test/fixtures/docs-ink.json', 'packages/occlude-studio/assets',
  'docs', 'README.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

const git = (...args: string[]): string => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 });

// ─── selection (pure) ────────────────────────────────────────────────────

/** A change to one of these reaches ink outside anything the map can
 * attribute, so it asks for the full check. The oracle's own code is not
 * here: a map is keyed by its hash, so a changed harness finds no map. The
 * rest of `tools/` draws nothing. */
export function globalTrigger(path: string): string | null {
  if (path.startsWith('crates/')) return 'the engine crate';
  if (path === 'pnpm-lock.yaml' || path === 'package.json' || path === 'pnpm-workspace.yaml' || path === 'packages/occlude/package.json') return 'the dependency set';
  if (/(^|\/)tsconfig[^/]*\.json$/.test(path)) return 'a tsconfig';
  if (path === 'packages/occlude/test/fixtures/docs-ink.json') return 'the ink baseline';
  if (path === `${SRC}docsExamples.ts`) return 'the fence transform and page list';
  if (path === `${SRC}index.ts`) return 'the library surface';
  if (path === 'README.md') return 'the README fence';
  if (path === WORKER_ENTRY) return 'the classifier worker entry (the fast run never enters it)';
  if (path.startsWith('packages/occlude-studio/assets/')) return 'a fence asset';
  return null;
}

/** Does a hunk touch a range the fence ran? A changed or deleted line must
 * lie in the range; an insertion must fall strictly inside it. */
export function hunkHits(hunk: Hunk | 'whole', ranges: Lines): boolean {
  for (const [a, b] of ranges) {
    if (hunk === 'whole') return true;
    if (hunk.oldCount > 0 ? a <= hunk.oldStart + hunk.oldCount - 1 && b >= hunk.oldStart : a <= hunk.oldStart && b >= hunk.oldStart + 1) return true;
  }
  return false;
}

export interface SelectInput {
  readonly map: Pick<CoverageMap, 'modules' | 'init' | 'fences'>;
  readonly changes: readonly Change[];
  /** The fences as they are now, in run order. */
  readonly fences: readonly { readonly key: string; readonly page: string }[];
  /** Live pages, `file` relative to docs/. */
  readonly pages: readonly { readonly slug: string; readonly file: string }[];
  /** Paths some library file imports or spawns. */
  readonly importedBySrc: ReadonlySet<string>;
}
export interface Selection {
  /** Set when the change asks for every fence: the reason, named. */
  readonly full: string | null;
  readonly keys: string[];
  readonly reasons: { readonly label: string; readonly keys: string[] }[];
  /** Pages whose fences were taken whole (a positional key may have moved). */
  readonly pages: string[];
  /** Changed paths nothing in the ink reads. */
  readonly ignored: string[];
}

const short = (path: string): string => path.startsWith(SRC) ? path.slice(SRC.length) : path;
const hunkLabel = (path: string, h: Hunk | 'whole'): string =>
  h === 'whole' ? short(path)
    : h.oldCount === 0 ? `${short(path)}:${h.oldStart}+` : `${short(path)}:${h.oldStart}${h.oldCount > 1 ? `-${h.oldStart + h.oldCount - 1}` : ''}`;

export function selectAffected(input: SelectInput): Selection {
  const { map, changes, fences, pages, importedBySrc } = input;
  const modules = new Set(map.modules);
  const picked = new Set<string>();
  const reasons: { label: string; keys: string[] }[] = [];
  const pageHits: string[] = [];
  const ignored: string[] = [];
  const full = (reason: string): Selection => ({ full: reason, keys: fences.map((f) => f.key), reasons: [], pages: [], ignored: [] });
  const add = (label: string, keys: string[]): void => {
    if (!keys.length) return;
    for (const k of keys) picked.add(k);
    reasons.push({ label, keys });
  };
  for (const change of changes) {
    const { path } = change;
    const trigger = globalTrigger(path);
    if (trigger) return full(`${path}: ${trigger}`);
    const page = pages.find((p) => `docs/${p.file}` === path);
    if (page) {
      pageHits.push(page.slug);
      add(path, fences.filter((f) => f.page === page.slug).map((f) => f.key));
      continue;
    }
    if (modules.has(path)) {
      if (change.moduleLevel) return full(`${short(path)}: ${change.moduleLevel}`);
      for (const hunk of change.whole ? ['whole' as const] : change.hunks) {
        const label = hunkLabel(path, hunk);
        if (hunkHits(hunk, map.init[path] ?? [])) return full(`${label} runs at import, before every fence`);
        add(label, Object.entries(map.fences).filter(([, files]) => hunkHits(hunk, files[path] ?? [])).map(([k]) => k));
      }
      continue;
    }
    if (path.startsWith(SRC) && importedBySrc.has(path)) return full(`${short(path)}: a module the map has never seen`);
    ignored.push(path);
  }
  const fresh = fences.filter((f) => !(f.key in map.fences) && !picked.has(f.key)).map((f) => f.key);
  add('new since the map', fresh);
  const order = new Map(fences.map((f, i) => [f.key, i]));
  const keys = [...picked].filter((k) => order.has(k)).sort((a, b) => order.get(a)! - order.get(b)!);
  return { full: null, keys, reasons, pages: pageHits, ignored };
}

/** `page#3,#4,#14; other#0` */
export function keyList(keys: readonly string[]): string {
  const byPage = new Map<string, string[]>();
  for (const k of keys) {
    const [page, i] = k.split('#');
    byPage.set(page, [...(byPage.get(page) ?? []), `#${i}`]);
  }
  return [...byPage].map(([page, is]) => `${page}${is.join(',')}`).join('; ');
}

// ─── the working tree ────────────────────────────────────────────────────

/** `git diff -U0 HEAD` hunks, plus every untracked file not ignored.
 * Untracked symlinks are the checkout's environment (a worktree links its
 * node_modules, the wasm package and scratch tools in), not a change. */
export function workingChanges(): { changes: Change[]; symlinks: string[] } {
  const changes: Change[] = [];
  let cur: { path: string; whole: boolean; hunks: Hunk[] } | null = null;
  let from = '';
  for (const line of git('diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', 'HEAD').split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (cur) changes.push(cur);
      cur = { path: line.replace(/^diff --git a\/.* b\//, ''), whole: false, hunks: [] };
    } else if (!cur) continue;
    else if (line.startsWith('--- ')) from = line.slice(4);
    else if (line.startsWith('+++ ')) {
      if (from === '/dev/null' || line === '+++ /dev/null') cur.whole = true;
      if (line === '+++ /dev/null') cur.path = from.replace(/^a\//, '');
    } else if (line.startsWith('Binary files ')) cur.whole = true;
    else {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m) cur.hunks.push({ oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4] });
    }
  }
  if (cur) changes.push(cur);
  const symlinks: string[] = [];
  for (const path of git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean)) {
    if (lstatSync(join(repoRoot, path)).isSymbolicLink()) symlinks.push(path);
    else changes.push({ path, whole: true, hunks: [] });
  }
  return { changes, symlinks };
}

/** A tree is clean enough to map when nothing that can move ink differs
 * from HEAD. */
export function inkDirty(changes: readonly Change[], pages: readonly { readonly file: string }[]): string[] {
  const docs = new Set(pages.map((p) => `docs/${p.file}`));
  return changes.map((c) => c.path).filter((p) => globalTrigger(p) || docs.has(p) || p.startsWith(SRC));
}

export function headCommit(): string { return git('rev-parse', 'HEAD').trim(); }
export function inkTree(): string {
  return createHash('sha256').update(git('ls-tree', '-r', 'HEAD', '--', ...INK_PATHS)).digest('hex').slice(0, 16);
}

export function harnessHash(files: ReadonlySet<string>): string {
  const h = createHash('sha256');
  for (const p of [...files].sort()) h.update(`${p}\0`).update(readFileSync(join(repoRoot, p))).update('\0');
  return h.digest('hex').slice(0, 16);
}

/** The map for HEAD and this harness: by commit, else any map of the same
 * ink tree. */
export function findMap(commit: string, tree: string, harness: string): { map: CoverageMap; path: string } | null {
  const own = join(cacheDir, `${commit}.json`);
  const candidates = existsSync(own) ? [own] : [];
  if (existsSync(cacheDir)) candidates.push(...readdirSync(cacheDir).filter((f) => f.endsWith('.json')).map((f) => join(cacheDir, f)));
  for (const path of candidates) {
    try {
      const map = JSON.parse(readFileSync(path, 'utf8')) as CoverageMap;
      if (map.tree === tree && map.harness === harness) return { map, path };
    } catch {
      // a torn write is no map
    }
  }
  return null;
}

export function saveMap(map: CoverageMap): string {
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, `${map.commit}.json`);
  writeFileSync(path, JSON.stringify(map));
  return path;
}

/** Relative imports, re-exports and `new URL('./…', import.meta.url)`
 * spawns of one file, resolved repo-relative (`.js` to its `.ts`). */
function specifiersOf(path: string): string[] {
  let text: string;
  try { text = readFileSync(join(repoRoot, path), 'utf8'); } catch { return []; }
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*|new URL\(\s*)['"`](\.{1,2}\/[^'"`$]+)['"`]/g;
  for (const m of text.matchAll(re)) {
    let target = posix.normalize(posix.join(posix.dirname(path), m[1]));
    if (target.endsWith('.js') && existsSync(join(repoRoot, `${target.slice(0, -3)}.ts`))) target = `${target.slice(0, -3)}.ts`;
    // a directory read by path (assets, fills) is data, not a module
    if (m[1].endsWith('/') || (existsSync(join(repoRoot, target)) && !statSync(join(repoRoot, target)).isFile())) continue;
    out.push(target);
  }
  return out;
}

/** Files reachable from `entry` by relative import; `stop` files are
 * listed but not followed. */
export function staticClosure(entry: string, stop: (path: string) => boolean = () => false): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    for (const next of specifiersOf(queue.pop()!)) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (!stop(next)) queue.push(next);
    }
  }
  return seen;
}

/** The oracle's own code outside the library, and the wasm it loads: what
 * draws the fences besides `src`. Data it reads by path is a global trigger
 * or the checkout's own (the pen and paper stores). */
export function harnessFiles(): Set<string> {
  const closure = staticClosure('packages/occlude/tools/docs-hashes.ts', (p) => p.startsWith(SRC));
  const code = [...closure].filter((p) => !p.startsWith(SRC) && /\.[cm]?[jt]s$/.test(p) && existsSync(join(repoRoot, p)));
  return new Set([...code, 'crates/occlude-core/pkg/occlude_core_bg.wasm']);
}

/** A package.json whose change is its `scripts` alone installs and resolves
 * nothing new: not a change the ink can see. */
export function withoutScriptEdits(changes: readonly Change[]): Change[] {
  return changes.filter((c) => {
    if (!/(^|\/)package\.json$/.test(c.path) || c.whole) return true;
    try {
      const strip = (text: string): string => { const j = JSON.parse(text) as Record<string, unknown>; delete j.scripts; return JSON.stringify(j); };
      return strip(git('show', `HEAD:${c.path}`)) !== strip(readFileSync(join(repoRoot, c.path), 'utf8'));
    } catch {
      return true;
    }
  });
}

export function importedBySrc(): Set<string> {
  const out = new Set<string>();
  for (const file of git('ls-files', '-co', '--exclude-standard', '--', SRC).split('\n').filter(Boolean)) {
    for (const t of specifiersOf(file)) out.add(t);
  }
  return out;
}

// ─── module-level code ───────────────────────────────────────────────────

interface Skeleton { bindings: Map<string, string>; bare: Set<string>; decls: Map<string, string>; stmts: string[] }

const isFunctionLike = (n: ts.Node): boolean => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)
  || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);

/** A statement's JavaScript with every function set aside (coverage owns
 * what runs inside one), comments and spacing dropped. */
function runtimeText(node: ts.Node, sf: ts.SourceFile): string {
  let out = '';
  let at = node.getStart(sf);
  const visit = (n: ts.Node): void => {
    if (isFunctionLike(n)) {
      out += sf.text.slice(at, n.getStart(sf)) + 'ƒ';
      at = n.end;
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  out += sf.text.slice(at, node.end);
  return out.replace(/^export\s+(default\s+)?/, '').replace(/\s+/g, ' ').trim();
}

function skeleton(text: string, fileName: string): Skeleton {
  const bindings = new Map<string, string>();
  const bare = new Set<string>();
  // Imports come from the TypeScript, where type-only is still visible.
  const tsf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  for (const st of tsf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      const c = st.importClause;
      if (!c) { bare.add(`import ${spec}`); continue; }
      if (c.isTypeOnly) continue;
      if (c.name) bindings.set(c.name.text, `${spec}#default`);
      const nb = c.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.set(nb.name.text, `${spec}#*`);
      else if (nb) for (const el of nb.elements) if (!el.isTypeOnly) bindings.set(el.name.text, `${spec}#${(el.propertyName ?? el.name).text}`);
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && !st.isTypeOnly) {
      const spec = st.moduleSpecifier.text;
      const ec = st.exportClause;
      if (!ec) bare.add(`export * ${spec}`);
      else if (ts.isNamespaceExport(ec)) bindings.set(`export ${ec.name.text}`, `${spec}#*`);
      else for (const el of ec.elements) if (!el.isTypeOnly) bindings.set(`export ${el.name.text}`, `${spec}#${(el.propertyName ?? el.name).text}`);
    }
  }
  // The rest from the JavaScript, where types are gone.
  const js = ts.transpileModule(text, {
    fileName,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true, isolatedModules: true },
  }).outputText;
  const sf = ts.createSourceFile(`${fileName}.js`, js, ts.ScriptTarget.Latest, true);
  const decls = new Map<string, string>();
  const stmts: string[] = [];
  for (const st of sf.statements) {
    // Hoisted and inert until called; what it does is coverage's to see.
    if (ts.isImportDeclaration(st) || ts.isExportDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isEmptyStatement(st)) continue;
    const body = runtimeText(st, sf);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) decls.set(d.name.getText(sf), body);
    else if (ts.isClassDeclaration(st) && st.name) decls.set(st.name.text, body);
    else if (ts.isExportAssignment(st)) decls.set('default', body);
    else stmts.push(body);
  }
  return { bindings, bare, decls, stmts };
}

/** Did the code a module runs at import change? Types, comments, function
 * bodies and brand-new declarations do not count — a new name reaches ink
 * only through a changed line that uses it. A declaration whose runtime
 * text changed, a top-level statement, a bare import, or an existing
 * binding pointed at another module does. */
export function moduleLevelChange(oldText: string, newText: string, fileName: string): string | null {
  const a = skeleton(oldText, fileName), b = skeleton(newText, fileName);
  for (const [name, target] of a.bindings) {
    const now = b.bindings.get(name);
    if (now !== undefined && now !== target) return `\`${name}\` now binds ${now}`;
  }
  const bare = [...a.bare].filter((x) => !b.bare.has(x)).concat([...b.bare].filter((x) => !a.bare.has(x)));
  if (bare.length) return `\`${bare[0]}\` changed`;
  for (const [name, body] of a.decls) {
    const now = b.decls.get(name);
    if (now !== undefined && now !== body) return `module-level \`${name}\` changed`;
  }
  if (a.stmts.join('\n') !== b.stmts.join('\n')) return 'a module-level statement changed';
  return null;
}

/** Fill in `moduleLevel` for every changed library file the map knows. */
export function withModuleLevel(changes: readonly Change[], modules: ReadonlySet<string>): Change[] {
  return changes.map((c) => {
    if (c.whole || !modules.has(c.path) || !/\.[cm]?[jt]sx?$/.test(c.path)) return c;
    const before = git('show', `HEAD:${c.path}`);
    const after = readFileSync(join(repoRoot, c.path), 'utf8');
    return { ...c, moduleLevel: moduleLevelChange(before, after, c.path) };
  });
}

// ─── the recorder ────────────────────────────────────────────────────────

interface Range { startOffset: number; endOffset: number; count: number }
interface FunctionCoverage { functionName: string; ranges: Range[] }
interface ScriptCoverage { scriptId: string; url: string; functions: FunctionCoverage[] }

interface Script {
  id: string;
  /** Function extents ever reported, sorted by start. */
  known: [number, number][];
  knownKeys: Set<string>;
  sorted: boolean;
  text?: { lineStarts: number[]; map: SourceMap | null; source: string; lines: string[] };
}

/** Records, per fence, the source lines it ran. Start it before the
 * library is imported: block counters exist only in code compiled after. */
export class CoverageRecorder {
  private readonly scripts = new Map<string, Script>();
  private readonly raw = new Map<string, Map<string, FunctionCoverage[]>>();
  private initRaw = new Map<string, FunctionCoverage[]>();
  private touched = false;
  readonly workerFences: string[] = [];
  private constructor(private readonly session: Session, private readonly under: string) {}

  /** `under` is the directory whose scripts are recorded: the library. */
  static async start(under = join(repoRoot, SRC)): Promise<CoverageRecorder> {
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Debugger.enable');
    await session.post('Profiler.startPreciseCoverage', { callCount: false, detailed: true });
    const recorder = new CoverageRecorder(session, pathToFileURL(under).href);
    // A fence that talks to a worker ran code this isolate cannot see.
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker['postMessage']>) {
      recorder.touched = true;
      return post.apply(this, args);
    };
    return recorder;
  }

  private async take(): Promise<Map<string, FunctionCoverage[]>> {
    const { result } = await this.session.post('Profiler.takePreciseCoverage') as unknown as { result: ScriptCoverage[] };
    const out = new Map<string, FunctionCoverage[]>();
    for (const s of result) {
      if (!s.url.startsWith(this.under)) continue;
      const path = relative(repoRoot, fileURLToPath(s.url));
      let script = this.scripts.get(path);
      if (!script) this.scripts.set(path, script = { id: s.scriptId, known: [], knownKeys: new Set(), sorted: true });
      script.id = s.scriptId;
      for (const f of s.functions) {
        const r = f.ranges[0];
        const key = `${r.startOffset}:${r.endOffset}`;
        if (!script.knownKeys.has(key)) { script.knownKeys.add(key); script.known.push([r.startOffset, r.endOffset]); script.sorted = false; }
      }
      out.set(path, s.functions.filter((f) => f.ranges[0].count > 0));
    }
    return out;
  }

  /** After the imports, before the first fence: what the import ran. */
  async init(): Promise<void> { this.initRaw = await this.take(); this.touched = false; }

  /** After a fence: its report, kept raw until the registry is complete. */
  async fence(key: string): Promise<void> {
    this.raw.set(key, await this.take());
    if (this.touched) this.workerFences.push(key);
    this.touched = false;
  }

  private async textOf(path: string, script: Script): Promise<NonNullable<Script['text']>> {
    if (script.text) return script.text;
    const { scriptSource } = await this.session.post('Debugger.getScriptSource', { scriptId: script.id }) as { scriptSource: string };
    const lineStarts = [0];
    for (let i = 0; i < scriptSource.length; i++) if (scriptSource.charCodeAt(i) === 10) lineStarts.push(i + 1);
    const inline = /\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/.exec(scriptSource);
    const map = inline ? new SourceMap(JSON.parse(Buffer.from(inline[1], 'base64').toString('utf8')) as SourceMapPayload) : null;
    const source = join(repoRoot, path);
    // The source as it ran: a map is only recorded from a tree that is HEAD.
    return script.text = { lineStarts, map, source, lines: map ? readFileSync(source, 'utf8').split('\n') : scriptSource.split('\n') };
  }

  /** The executed lines of one report of one script. */
  private async linesOf(path: string, functions: FunctionCoverage[]): Promise<Lines> {
    const script = this.scripts.get(path)!;
    if (!script.sorted) { script.known.sort((a, b) => a[0] - b[0] || b[1] - a[1]); script.sorted = true; }
    const text = await this.textOf(path, script);
    /** The mapping at or before a transpiled offset: where it begins in
     * the transpiled text, and its source line and column, 0-based. */
    const entry = (offset: number): { gen: number; src: [number, number] } | undefined => {
      let lo = 0, hi = text.lineStarts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (text.lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
      if (!text.map) return { gen: offset, src: [lo, offset - text.lineStarts[lo]] }; // no map: the text is the source
      const e = text.map.findEntry(lo, offset - text.lineStarts[lo]) as { generatedLine?: number; generatedColumn?: number; originalLine?: number; originalColumn?: number; originalSource?: string };
      if (e.originalLine === undefined || e.generatedLine === undefined) return undefined;
      if (e.originalSource && e.originalSource !== text.source && !e.originalSource.endsWith(path)) return undefined;
      // esbuild places code it synthesizes (a keep-names `static`) at 0:0
      if (e.originalLine === 0 && e.originalColumn === 0) return undefined;
      return { gen: text.lineStarts[e.generatedLine] + (e.generatedColumn ?? 0), src: [e.originalLine, e.originalColumn ?? 0] };
    };
    /** A piece's lines come from the mappings that begin inside it. The one
     * at or before its start may belong to what precedes it — a hole, or the
     * helper code tsx writes round a function (`__name(…)`, a keep-names
     * `static {}`), which maps back to wherever the function began. After a
     * hole the first token must also lie past the hole's own end. */
    const first = (s: number, e: number, past: [number, number] | undefined): [number, number] | undefined => {
      for (let o = s; o < e; o++) {
        const m = entry(o);
        if (!m || m.gen < s) continue;
        if (!past || m.src[0] > past[0] || (m.src[0] === past[0] && m.src[1] > past[1])) return m.src;
      }
      return undefined;
    };
    const last = (s: number, e: number): [number, number] | undefined => {
      const m = entry(e - 1);
      return m && m.gen >= s ? m.src : undefined;
    };
    /** The line an untaken block or function ends on, seen from the first
     * token after it: the last line before that token with code on it. Its
     * closing brace has no mapping of its own, and new code written just
     * after that brace is code the fence runs. */
    const closing = ([line, col]: [number, number]): number => {
      const src = text.lines;
      if (/\S/.test(src[line]?.slice(0, col) ?? '')) return line;
      for (let l = line - 1; l >= 0; l--) {
        const t = src[l].trim();
        if (t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')) return l;
      }
      return line;
    };
    const out: Lines = [];
    for (const f of functions) {
      const [whole] = f.ranges;
      if (whole.startOffset === 0 && f.functionName === '') continue; // the module body: `init` and the skeleton own it
      const holes: [number, number][] = f.ranges.slice(1).filter((r) => r.count === 0).map((r) => [r.startOffset, r.endOffset]);
      // every function nested inside this one is a hole; the ones that ran add their own text
      let lo = 0, hi = script.known.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (script.known[mid][0] <= whole.startOffset) lo = mid + 1; else hi = mid; }
      for (let i = lo; i < script.known.length && script.known[i][0] < whole.endOffset; i++) {
        if (script.known[i][1] <= whole.endOffset) holes.push(script.known[i]);
      }
      holes.sort((a, b) => a[0] - b[0]);
      let from = whole.startOffset;
      let past: [number, number] | undefined;
      let afterHole = false;
      const piece = (s: number, e: number): void => {
        if (e <= s) return;
        const a = first(s, e, afterHole ? past : undefined);
        if (!a) return; // helper code only: nothing the source wrote
        const b = last(s, e) ?? a;
        const x = afterHole ? closing(a) : a[0];
        out.push([Math.min(x, b[0]) + 1, Math.max(x, b[0]) + 1]);
      };
      for (const [s, e] of holes) {
        if (e <= from) continue;
        piece(from, s);
        from = Math.max(from, e);
        past = entry(e - 1)?.src;
        afterHole = true;
      }
      piece(from, whole.endOffset);
    }
    return mergeLines(out);
  }

  /** The map's per-fence and import-time lines, once every fence ran. */
  async finish(): Promise<Pick<CoverageMap, 'modules' | 'init' | 'fences' | 'workerFences'>> {
    await this.session.post('Profiler.stopPreciseCoverage');
    const convert = async (report: Map<string, FunctionCoverage[]>): Promise<Record<string, Lines>> => {
      const files: Record<string, Lines> = {};
      for (const [path, functions] of report) {
        const lines = await this.linesOf(path, functions);
        if (lines.length) files[path] = lines;
      }
      return files;
    };
    const init = await convert(this.initRaw);
    const fences: Record<string, Record<string, Lines>> = {};
    // Code in a worker is not in any report: its whole closure stands in.
    const workerFiles = this.workerFences.length ? [...staticClosure(WORKER_ENTRY)].filter((p) => p.startsWith(SRC) && /\.[cm]?[jt]s$/.test(p) && existsSync(join(repoRoot, p))) : [];
    const whole = (p: string): Lines => [[1, readFileSync(join(repoRoot, p), 'utf8').split('\n').length]];
    for (const [key, report] of this.raw) {
      fences[key] = await convert(report);
      if (this.workerFences.includes(key)) for (const p of workerFiles) fences[key][p] = whole(p);
    }
    this.session.disconnect();
    const modules = new Set([...this.scripts.keys(), ...workerFiles]);
    return { modules: [...modules].sort(), init, fences, workerFences: this.workerFences };
  }
}

export function mergeLines(lines: Lines): Lines {
  lines.sort((a, b) => a[0] - b[0]);
  const out: Lines = [];
  for (const [a, b] of lines) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
