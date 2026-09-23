/**
 * What both affected runs share: the working tree's change against HEAD,
 * the tree and harness hashes a map is keyed by, the runtime skeleton that
 * says whether a module's import-time code changed, and the V8 coverage
 * session that turns "what ran" into source lines. The docs oracle
 * (docs-coverage.ts) records per fence, the test map (test-coverage.ts) per
 * test file; each keeps its own selection and its own global triggers.
 * Nothing here loads the library — a coverage session has to start before
 * `src` does.
 *
 * The session. V8 precise block coverage (`node:inspector`, binary counts,
 * detailed ranges). A take resets the counters and reports only the
 * functions that ran, so a report's executed text is: each function that
 * ran, minus its blocks that did not, minus every function nested inside it
 * (a nested function that also ran adds its own text back). The nested ones
 * come from a registry of every function range ever reported; the first
 * take after a script loads reports every function of it, compiled or not.
 *
 * Offsets are in the text the loader hands V8, not the source. tsx and
 * vite-node both append an inline source map to every module they
 * transpile; the script's text comes back through `Debugger.getScriptSource`,
 * and the map, decoded once per script, takes each executed piece's first
 * and last character to source lines. vite-node also wraps the module in an async
 * arrow on its first line, which the map does not know about: that line's
 * columns are shifted back by the wrapper's length. The module body — the
 * script itself under tsx, the wrapper's arrow under vite-node — is left
 * to `moduleLevelChange`: its pieces between functions are declarations,
 * and a deleted function's closing brace is not code a caller runs.
 *
 * Worker threads have their own isolate, which this session does not see.
 * `touched` says a worker was posted to since the caller last cleared it;
 * the caller marks the worker's files whole (`workerClosure`).
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type TS from 'typescript';

/** Inclusive, 1-based source line ranges. */
export type Lines = [number, number][];

/** One `@@ -a,n +c,m @@` of `git diff -U0`. `oldCount` 0 is an insertion
 * after old line `oldStart`. */
export interface Hunk { readonly oldStart: number; readonly oldCount: number; readonly newStart: number; readonly newCount: number }
export interface Change {
  readonly path: string;
  /** Added, deleted, untracked or binary: every old line counts. */
  readonly whole?: boolean;
  /** Not in HEAD: added or untracked. */
  readonly added?: boolean;
  readonly hunks: readonly Hunk[];
  /** Why the file's module-level code changed, when it did. */
  readonly moduleLevel?: string | null;
}

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');
export const SRC = 'packages/occlude/src/';
export const WORKER_ENTRY = `${SRC}three/visibility/classify.worker.ts`;

export const git = (...args: string[]): string => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 });

/** Does a hunk touch a range that ran? A changed or deleted line must lie in
 * the range; an insertion must fall strictly inside it. */
export function hunkHits(hunk: Hunk | 'whole', ranges: Lines): boolean {
  for (const [a, b] of ranges) {
    if (hunk === 'whole') return true;
    if (hunk.oldCount > 0 ? a <= hunk.oldStart + hunk.oldCount - 1 && b >= hunk.oldStart : a <= hunk.oldStart && b >= hunk.oldStart + 1) return true;
  }
  return false;
}

export const short = (path: string): string => path.startsWith(SRC) ? path.slice(SRC.length) : path;
export const hunkLabel = (path: string, h: Hunk | 'whole'): string =>
  h === 'whole' ? short(path)
    : h.oldCount === 0 ? `${short(path)}:${h.oldStart}+` : `${short(path)}:${h.oldStart}${h.oldCount > 1 ? `-${h.oldStart + h.oldCount - 1}` : ''}`;

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

// ─── the working tree ────────────────────────────────────────────────────

/** `git diff -U0 HEAD` hunks, plus every untracked file not ignored.
 * Untracked symlinks are the checkout's environment (a worktree links its
 * node_modules, the wasm package and scratch tools in), not a change. */
export function workingChanges(): { changes: Change[]; symlinks: string[] } {
  const changes: Change[] = [];
  let cur: { path: string; whole: boolean; added: boolean; hunks: Hunk[] } | null = null;
  let from = '';
  for (const line of git('diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', 'HEAD').split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (cur) changes.push(cur);
      cur = { path: line.replace(/^diff --git a\/.* b\//, ''), whole: false, added: false, hunks: [] };
    } else if (!cur) continue;
    else if (line.startsWith('--- ')) from = line.slice(4);
    else if (line.startsWith('+++ ')) {
      if (from === '/dev/null' || line === '+++ /dev/null') cur.whole = true;
      if (from === '/dev/null') cur.added = true;
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
    else changes.push({ path, whole: true, added: true, hunks: [] });
  }
  return { changes, symlinks };
}

export function headCommit(): string { return git('rev-parse', 'HEAD').trim(); }

/** Hash of HEAD's tracked trees at `paths`: a map built at another commit
 * with the same tree still answers for this one. */
export function treeHash(paths: readonly string[]): string {
  return createHash('sha256').update(git('ls-tree', '-r', 'HEAD', '--', ...paths)).digest('hex').slice(0, 16);
}

/** Hash of the code a map was built with, from the working copy: the
 * harness is part of what a map is, not part of a diff. */
export function harnessHash(files: ReadonlySet<string>): string {
  const h = createHash('sha256');
  for (const p of [...files].sort()) h.update(`${p}\0`).update(readFileSync(join(repoRoot, p))).update('\0');
  return h.digest('hex').slice(0, 16);
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

export function importedBySrc(): Set<string> {
  const out = new Set<string>();
  for (const file of git('ls-files', '-co', '--exclude-standard', '--', SRC).split('\n').filter(Boolean)) {
    for (const t of specifiersOf(file)) out.add(t);
  }
  return out;
}

/** The library files a worker thread runs, which no session sees. */
export function workerClosure(): string[] {
  return [...staticClosure(WORKER_ENTRY)].filter((p) => p.startsWith(SRC) && /\.[cm]?[jt]s$/.test(p) && existsSync(join(repoRoot, p)));
}

/** Every line of a file, as one range. */
export function wholeFile(path: string): Lines {
  return [[1, readFileSync(join(repoRoot, path), 'utf8').split('\n').length]];
}

// ─── module-level code ───────────────────────────────────────────────────

/** The compiler, loaded on first use: only the skeleton needs it, and a
 * recorder in every test worker does not. */
let tsModule: typeof TS | undefined;
const typescript = (): typeof TS => tsModule ??= createRequire(import.meta.url)('typescript') as typeof TS;

interface Skeleton { bindings: Map<string, string>; bare: Set<string>; decls: Map<string, string>; stmts: string[] }

const isFunctionLike = (n: TS.Node): boolean => { const ts = typescript(); return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)
  || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n); };

/** A statement's JavaScript with every function set aside (coverage owns
 * what runs inside one), comments and spacing dropped. */
function runtimeText(node: TS.Node, sf: TS.SourceFile): string {
  const ts = typescript();
  let out = '';
  let at = node.getStart(sf);
  const visit = (n: TS.Node): void => {
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
  const ts = typescript();
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

/** Fill in `moduleLevel` for every changed file in `modules`. */
export function withModuleLevel(changes: readonly Change[], modules: ReadonlySet<string>): Change[] {
  return changes.map((c) => {
    if (c.whole || !modules.has(c.path) || !/\.[cm]?[jt]sx?$/.test(c.path)) return c;
    const before = git('show', `HEAD:${c.path}`);
    const after = readFileSync(join(repoRoot, c.path), 'utf8');
    return { ...c, moduleLevel: moduleLevelChange(before, after, c.path) };
  });
}

// ─── the session ─────────────────────────────────────────────────────────

interface Range { startOffset: number; endOffset: number; count: number }
interface FunctionCoverage { functionName: string; ranges: Range[] }
interface ScriptCoverage { scriptId: string; url: string; functions: FunctionCoverage[] }

/** One take: the functions that ran, by script id. */
export type Report = Map<string, FunctionCoverage[]>;

interface Script {
  /** Repo-relative. One path may have several scripts (a module evaluated
   * again); each keeps its own offsets. */
  path: string;
  /** Function extents ever reported, sorted by start. */
  known: [number, number][];
  knownKeys: Set<string>;
  sorted: boolean;
  text?: { lineStarts: number[]; shift: number; segments: Segments | null; source: string; lines: string[] };
}

/** A source map's mappings as flat arrays in generated order: where each
 * segment begins in the script text, its source line and column (0-based),
 * and whether it is one of ours — from this file's own source, and not the
 * 0:0 esbuild gives code it synthesizes (a keep-names `static`). Decoded
 * once per script, so walking a piece costs its segments, not its
 * characters. */
interface Segments { n: number; gen: Int32Array; line: Int32Array; col: Int32Array; ours: Uint8Array }

const BASE64 = (() => {
  const t = new Int8Array(128).fill(-1);
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < 64; i++) t[a.charCodeAt(i)] = i;
  return t;
})();

function decodeSegments(mappings: string, lineStarts: readonly number[], shift: number, own: readonly boolean[]): Segments {
  const cap = mappings.length + 1;
  const gen = new Int32Array(cap), line = new Int32Array(cap), col = new Int32Array(cap), ours = new Uint8Array(cap);
  const field = [0, 0, 0, 0, 0];
  let n = 0, genLine = 0, genCol = 0, source = 0, srcLine = 0, srcCol = 0, i = 0, sorted = true;
  while (i < mappings.length) {
    const c = mappings.charCodeAt(i);
    if (c === 59) { genLine++; genCol = 0; i++; continue; } // ;
    if (c === 44) { i++; continue; } // ,
    let k = 0;
    while (i < mappings.length) {
      const d = mappings.charCodeAt(i);
      if (d === 44 || d === 59) break;
      let value = 0, bits = 0, digit: number;
      do { digit = BASE64[mappings.charCodeAt(i++)]; value += (digit & 31) * 2 ** bits; bits += 5; } while (digit & 32);
      field[k++] = value % 2 ? -Math.floor(value / 2) : value / 2;
    }
    genCol += field[0];
    if (k >= 4) { source += field[1]; srcLine += field[2]; srcCol += field[3]; }
    if (genLine >= lineStarts.length) continue;
    gen[n] = lineStarts[genLine] + genCol + (genLine === 0 ? shift : 0);
    line[n] = srcLine;
    col[n] = srcCol;
    ours[n] = k >= 4 && own[source] && !(srcLine === 0 && srcCol === 0) ? 1 : 0;
    if (n && gen[n] < gen[n - 1]) sorted = false;
    n++;
  }
  if (!sorted) {
    const order = Array.from({ length: n }, (_, j) => j).sort((a, b) => gen[a] - gen[b]);
    const pick = <T extends Int32Array | Uint8Array>(xs: T): T => { const out = xs.slice() as T; order.forEach((j, to) => { out[to] = xs[j]; }); return out; };
    return { n, gen: pick(gen), line: pick(line), col: pick(col), ours: pick(ours) };
  }
  return { n, gen, line, col, ours };
}

/** A script's url as a file path: tsx reports `file://` urls, vite-node the
 * bare path it evaluated. */
function scriptPath(url: string): string | null {
  if (url.startsWith('file://')) return fileURLToPath(url);
  return url.startsWith('/') ? url : null;
}

/** The inline map tsx (`data:application/json;base64,`) and vite-node
 * (`…;charset=utf-8;base64,`, then the wrapper's closing braces) append. */
const INLINE_MAP = /\/\/# sourceMappingURL=data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=]+)/g;
/** vite-node's wrapper, all on the module's first line. */
const VITE_NODE_WRAPPER = /^'use strict';async \([^)]*\)=>\{\{/;

export class CoverageSession {
  private readonly scripts = new Map<string, Script>();
  /** A worker was posted to since the caller last cleared this. */
  touched = false;
  private constructor(private readonly session: Session, private readonly accept: (path: string) => boolean) {}

  /** Records scripts whose file path `accept` takes (a directory string
   * means every script under it). Start it before the code to record is
   * imported: block counters exist only in code compiled after. */
  static async start(accept: string | ((path: string) => boolean)): Promise<CoverageSession> {
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Debugger.enable');
    await session.post('Profiler.startPreciseCoverage', { callCount: false, detailed: true });
    const recorder = new CoverageSession(session, typeof accept === 'string' ? (p) => p.startsWith(accept) : accept);
    // Code that talks to a worker ran code this isolate cannot see.
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker['postMessage']>) {
      recorder.touched = true;
      return post.apply(this, args);
    };
    return recorder;
  }

  /** The functions that ran since the last take; counters reset. */
  async take(): Promise<Report> {
    const { result } = await this.session.post('Profiler.takePreciseCoverage') as unknown as { result: ScriptCoverage[] };
    const out: Report = new Map();
    for (const s of result) {
      const abs = scriptPath(s.url);
      if (!abs || !this.accept(abs)) continue;
      let script = this.scripts.get(s.scriptId);
      if (!script) this.scripts.set(s.scriptId, script = { path: relative(repoRoot, abs), known: [], knownKeys: new Set(), sorted: true });
      for (const f of s.functions) {
        const r = f.ranges[0];
        const key = `${r.startOffset}:${r.endOffset}`;
        if (!script.knownKeys.has(key)) { script.knownKeys.add(key); script.known.push([r.startOffset, r.endOffset]); script.sorted = false; }
      }
      out.set(s.scriptId, s.functions.filter((f) => f.ranges[0].count > 0));
    }
    return out;
  }

  /** Every file a script was loaded from. */
  paths(): Set<string> { return new Set([...this.scripts.values()].map((s) => s.path)); }

  /** A report's executed source lines, by repo-relative path. */
  async lines(report: Report): Promise<Record<string, Lines>> {
    const byPath = new Map<string, Lines>();
    for (const [id, functions] of report) {
      const script = this.scripts.get(id)!;
      const lines = await this.linesOf(id, script, functions);
      if (lines.length) byPath.set(script.path, [...(byPath.get(script.path) ?? []), ...lines]);
    }
    const out: Record<string, Lines> = {};
    for (const [path, lines] of byPath) out[path] = mergeLines(lines);
    return out;
  }

  async stop(): Promise<void> {
    await this.session.post('Profiler.stopPreciseCoverage');
    this.session.disconnect();
  }

  private async textOf(id: string, script: Script): Promise<NonNullable<Script['text']>> {
    if (script.text) return script.text;
    const { scriptSource } = await this.session.post('Debugger.getScriptSource', { scriptId: id }) as { scriptSource: string };
    const lineStarts = [0];
    for (let i = 0; i < scriptSource.length; i++) if (scriptSource.charCodeAt(i) === 10) lineStarts.push(i + 1);
    const inline = [...scriptSource.matchAll(INLINE_MAP)].pop();
    const shift = VITE_NODE_WRAPPER.exec(scriptSource)?.[0].length ?? 0;
    const source = join(repoRoot, script.path);
    let segments: Segments | null = null;
    if (inline) {
      const map = JSON.parse(Buffer.from(inline[1], 'base64').toString('utf8')) as { sources?: string[]; sourceRoot?: string; mappings: string };
      const resolveSource = (s: string): string => s.startsWith('file://') ? fileURLToPath(s) : isAbsolute(s) ? s : resolve(dirname(source), s);
      const own = (map.sources ?? []).map((s) => { const full = `${map.sourceRoot ?? ''}${s}`; return resolveSource(full) === source || full.endsWith(script.path); });
      segments = decodeSegments(map.mappings, lineStarts, shift, own);
    }
    // The source as it ran: a map is only recorded from a tree that is HEAD.
    return script.text = { lineStarts, shift, segments, source, lines: segments ? readFileSync(source, 'utf8').split('\n') : scriptSource.split('\n') };
  }

  /** The executed lines of one report of one script. */
  private async linesOf(id: string, script: Script, functions: FunctionCoverage[]): Promise<Lines> {
    if (!script.sorted) { script.known.sort((a, b) => a[0] - b[0] || b[1] - a[1]); script.sorted = true; }
    const text = await this.textOf(id, script);
    const seg = text.segments;
    /** The last segment beginning at or before a transpiled offset. */
    const at = (offset: number): number => {
      let lo = 0, hi = seg!.n;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (seg!.gen[mid] <= offset) lo = mid + 1; else hi = mid; }
      return lo - 1;
    };
    /** The source position a transpiled offset maps to, and where its
     * mapping begins in the transpiled text; 0-based. */
    const entry = (offset: number): { gen: number; src: [number, number] } | undefined => {
      if (!seg) {
        // no map: the text is the source
        let lo = 0, hi = text.lineStarts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (text.lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
        return { gen: offset, src: [lo, offset - text.lineStarts[lo]] };
      }
      const j = at(offset);
      return j >= 0 && seg.ours[j] ? { gen: seg.gen[j], src: [seg.line[j], seg.col[j]] } : undefined;
    };
    const after = (src: [number, number], past: [number, number] | undefined): boolean =>
      !past || src[0] > past[0] || (src[0] === past[0] && src[1] > past[1]);
    /** A piece's lines come from the mappings that begin inside it. The one
     * at or before its start may belong to what precedes it — a hole, or the
     * helper code tsx writes round a function (`__name(…)`, a keep-names
     * `static {}`), which maps back to wherever the function began. After a
     * hole the first token must also lie past the hole's own end. */
    const first = (s: number, e: number, past: [number, number] | undefined): [number, number] | undefined => {
      if (!seg) { const m = entry(s)!; return after(m.src, past) ? m.src : undefined; }
      for (let j = at(s - 1) + 1; j < seg.n && seg.gen[j] < e; j++) {
        if (seg.ours[j] && after([seg.line[j], seg.col[j]], past)) return [seg.line[j], seg.col[j]];
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
     * after that brace is code that runs. */
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
      // The module body is `moduleLevelChange`'s: under tsx the script itself,
      // under vite-node the wrapper's arrow, which begins inside the wrapper.
      if ((whole.startOffset === 0 && f.functionName === '') || whole.startOffset < text.shift) continue;
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
}
