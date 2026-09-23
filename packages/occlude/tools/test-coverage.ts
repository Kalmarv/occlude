/**
 * The test map: which source lines each test file ran, and which test files
 * a working-tree change can reach. The same idea as the docs oracle's map
 * (docs-coverage.ts), per test file instead of per fence, over the shared
 * machinery in coverage-map.ts. `test-affected.ts` drives it (`pnpm
 * test:map`, `pnpm test:affected`); the recorder half runs inside each
 * vitest worker, wired by test/setup/coverage.ts when OCCLUDE_TEST_MAP=1.
 *
 * What a test file reaches, beyond the lines it ran:
 * - every module it loaded, so a change to a module's import-time code
 *   (`moduleLevelChange`) reaches every file that loaded it;
 * - every file and directory it read through `node:fs` (fixtures, docs
 *   pages, the ink baseline), whole;
 * - the static closure of any script it spawned (a tsx tool), whole: a
 *   child process has its own isolate;
 * - the classifier worker's closure, whole, if it posted to a worker.
 *
 * A test file is keyed by its path and its content's git blob hash, so one
 * renamed since the map was built is found by content and run by its new
 * name; a test file whose content the map does not know is new or changed,
 * and runs.
 */

import { createHash } from 'node:crypto';
import cp from 'node:child_process';
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CoverageSession, SRC, WORKER_ENTRY, hunkHits, hunkLabel, repoRoot, short, staticClosure, treeHash, wholeFile, workerClosure,
  type Change, type Lines } from './coverage-map.js';

const PKG = 'packages/occlude/';
const TEST = `${PKG}test/`;

export interface TestRecord {
  /** Git blob hash of the file as it ran: finds it again after a rename. */
  readonly blob: string;
  /** Every repo module the file loaded, repo-relative. */
  readonly modules: string[];
  readonly lines: Record<string, Lines>;
  /** Files it read as data; a directory it listed ends in `/`. */
  readonly reads: string[];
}

export interface TestMap {
  readonly commit: string;
  /** `treeHash(TEST_PATHS)` at HEAD. */
  readonly tree: string;
  /** Hash of the harness as it ran (`testHarnessFiles`, working copy). */
  readonly harness: string;
  readonly builtMs: number;
  /** Which sets the map ran: `fast`, or `all` when slow files are in it. */
  readonly set: string;
  /** Keyed by repo-relative path as it ran. */
  readonly files: Record<string, TestRecord>;
}

/** Where the maps live, beside the docs maps: gitignored, keyed by commit. */
export const testCacheDir = join(repoRoot, `${PKG}node_modules/.cache/test-coverage`);
/** The tracked paths whose content can move a test, hashed into `tree`: what
 * moves ink, and the package's own tests and tools. */
const TEST_PATHS = ['crates', 'packages/occlude', 'packages/occlude-studio/assets',
  'docs', 'README.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

export function testTree(): string { return treeHash(TEST_PATHS); }

/** A test file in any set (the spikes are untracked and excluded by git). */
export const isTestFile = (path: string): boolean => path.startsWith(TEST) && /\.test\.[cm]?[jt]sx?$/.test(path);

/** The code a map is built with: the config, the setup files, and what they
 * and the driver import outside `src`. Keyed like the docs harness: a
 * changed harness finds no map, so every one of these is global. */
export function testHarnessFiles(): Set<string> {
  const setup = readdirSync(join(repoRoot, `${TEST}setup`)).map((f) => `${TEST}setup/${f}`);
  const out = new Set<string>([`${PKG}vitest.config.ts`]);
  for (const entry of [...setup, `${PKG}tools/test-affected.ts`]) {
    for (const p of staticClosure(entry, (q) => q.startsWith(SRC))) if (!p.startsWith(SRC) && existsSync(join(repoRoot, p))) out.add(p);
  }
  return out;
}

// ─── selection (pure) ────────────────────────────────────────────────────

/** A change to one of these reaches tests outside anything the map can
 * attribute: the fast set runs whole. The harness (config, setup files,
 * coverage-map.ts, this file) is keyed, not listed: a changed harness finds
 * no map. */
export function globalTrigger(path: string, change?: Pick<Change, 'added'>): string | null {
  if (path.startsWith('crates/')) return 'the engine crate';
  if (/(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/.test(path)) return 'the dependency set';
  // vite's transform reads the nearest tsconfig.json; tsconfig.check.json is the typecheck's alone
  if (/(^|\/)tsconfig\.json$/.test(path)) return 'a tsconfig';
  if (path === `${SRC}index.ts`) return 'the library surface';
  if (path === WORKER_ENTRY) return 'the classifier worker entry (a run at one worker never enters it)';
  if (change?.added && path.startsWith(SRC) && /\.[cm]?[jt]sx?$/.test(path)) return 'a new src module';
  return null;
}

export interface TestSelectInput {
  readonly map: Pick<TestMap, 'files'>;
  /** Harness and script-only edits removed, `moduleLevel` filled. */
  readonly changes: readonly Change[];
  /** Every test file now, repo-relative, with its blob hash. */
  readonly tests: readonly { readonly path: string; readonly blob: string }[];
}
export interface TestSelection {
  /** Set when the change asks for the whole fast set: the reason, named. */
  readonly full: string | null;
  /** Test files to run, repo-relative, in path order. */
  readonly files: string[];
  readonly reasons: { readonly label: string; readonly files: string[] }[];
  /** Changed paths no test reached. */
  readonly ignored: string[];
}

export function selectTests(input: TestSelectInput): TestSelection {
  const { map, changes, tests } = input;
  const byBlob = new Map<string, TestRecord>();
  for (const r of Object.values(map.files)) byBlob.set(r.blob, r);
  // Each test file now, with what it ran when the map was built.
  const covered: { path: string; record: TestRecord }[] = [];
  const fresh: string[] = [];
  for (const t of tests) {
    const own = map.files[t.path];
    const record = own ? (own.blob === t.blob ? own : undefined) : byBlob.get(t.blob);
    if (record) covered.push({ path: t.path, record });
    else fresh.push(t.path);
  }
  const picked = new Set<string>();
  const reasons: { label: string; files: string[] }[] = [];
  const ignored: string[] = [];
  const add = (label: string, files: string[]): void => {
    if (!files.length) return;
    for (const f of files) picked.add(f);
    reasons.push({ label, files });
  };
  add('new or changed', fresh);
  for (const change of changes) {
    const { path } = change;
    if (isTestFile(path)) continue; // by content, above
    const trigger = globalTrigger(path, change);
    if (trigger) return { full: `${short(path)}: ${trigger}`, files: [], reasons: [], ignored: [] };
    const readers = covered.filter(({ record }) => record.reads.some((r) => r === path || (r.endsWith('/') && path.startsWith(r))));
    const loaders = covered.filter(({ record }) => record.modules.includes(path));
    if (!readers.length && !loaders.length) { ignored.push(path); continue; }
    add(short(path), readers.map((c) => c.path));
    if (change.whole || change.moduleLevel) {
      add(change.moduleLevel ? `${short(path)} (${change.moduleLevel})` : short(path), loaders.map((c) => c.path));
      continue;
    }
    for (const hunk of change.hunks) {
      add(hunkLabel(path, hunk), loaders.filter(({ record }) => hunkHits(hunk, record.lines[path] ?? [])).map((c) => c.path));
    }
  }
  return { full: null, files: [...picked].sort(), reasons, ignored };
}

// ─── the maps ────────────────────────────────────────────────────────────

/** The map for HEAD and this harness: by commit, else any map of the same
 * tree. */
export function findTestMap(commit: string, tree: string, harness: string): { map: TestMap; path: string } | null {
  const own = join(testCacheDir, `${commit}.json`);
  const candidates = existsSync(own) ? [own] : [];
  if (existsSync(testCacheDir)) candidates.push(...readdirSync(testCacheDir).filter((f) => f.endsWith('.json')).map((f) => join(testCacheDir, f)));
  for (const path of candidates) {
    try {
      const map = JSON.parse(readFileSync(path, 'utf8')) as TestMap;
      if (map.tree === tree && map.harness === harness) return { map, path };
    } catch {
      // a torn write is no map
    }
  }
  return null;
}

export function saveTestMap(map: TestMap): string {
  mkdirSync(testCacheDir, { recursive: true });
  const path = join(testCacheDir, `${map.commit}.json`);
  writeFileSync(path, JSON.stringify(map));
  return path;
}

/** `git hash-object` of some bytes, without a process. */
export function blobHash(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

// ─── the recorder (inside a vitest worker) ──────────────────────────────

const CODE = /\.[cm]?[jt]sx?$/;

/** Records one test file: started before it imports anything, finished in
 * its last `afterAll`. Writes `<out>/<blob of path>.json`. */
export class TestFileRecorder {
  private readonly reads = new Set<string>();
  private readonly spawned = new Set<string>();
  private recording = true;
  private constructor(private readonly session: CoverageSession, private readonly harness: ReadonlySet<string>) {}

  static async start(): Promise<TestFileRecorder> {
    const harness = testHarnessFiles();
    const pkg = join(repoRoot, PKG);
    const accept = (abs: string): boolean => abs.startsWith(pkg) && !abs.includes('/node_modules/') && !harness.has(relative(repoRoot, abs));
    const recorder = new TestFileRecorder(await CoverageSession.start(accept), harness);
    recorder.hook();
    return recorder;
  }

  /** A path argument as a repo-relative path inside the repo, or null. */
  private static repoPath(arg: unknown, cwd = process.cwd()): string | null {
    let abs: string;
    if (typeof arg === 'string') abs = arg.startsWith('file://') ? fileURLToPath(arg) : resolve(cwd, arg);
    else if (arg instanceof URL && arg.protocol === 'file:') abs = fileURLToPath(arg);
    else return null;
    const rel = relative(repoRoot, abs);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes('node_modules/') && !rel.startsWith('.git/') ? rel : null;
  }

  /** Wrap `node:fs` reads and `node:child_process` spawns; ESM importers
   * see the wrappers through `syncBuiltinESMExports`. */
  private hook(): void {
    const note = (arg: unknown, dir = false): void => {
      if (!this.recording) return;
      const p = TestFileRecorder.repoPath(arg);
      if (p) this.reads.add(dir ? `${p.replace(/\/$/, '')}/` : p);
    };
    const wrap = <T extends object>(obj: T, name: keyof T, before: (args: unknown[]) => void): void => {
      const orig = obj[name] as unknown as (...a: unknown[]) => unknown;
      if (typeof orig !== 'function') return;
      (obj as Record<string, unknown>)[name as string] = function (this: unknown, ...args: unknown[]) { before(args); return orig.apply(this, args); };
    };
    for (const name of ['readFileSync', 'readFile', 'copyFileSync', 'createReadStream'] as const) wrap(fs, name, (a) => note(a[0]));
    wrap(fs, 'readdirSync', (a) => note(a[0], true));
    wrap(fs.promises, 'readFile', (a) => note(a[0]));
    wrap(fs.promises, 'readdir', (a) => note(a[0], true));
    const spawnArgs = (a: unknown[]): void => {
      if (!this.recording) return;
      const opts = a.find((x): x is { cwd?: string | URL } => !!x && typeof x === 'object' && !Array.isArray(x));
      const cwd = opts?.cwd ? (opts.cwd instanceof URL ? fileURLToPath(opts.cwd) : opts.cwd) : process.cwd();
      const tokens = a.flatMap((x) => typeof x === 'string' ? x.split(/\s+/) : Array.isArray(x) ? x.filter((y) => typeof y === 'string') : []);
      for (const t of tokens) {
        const p = TestFileRecorder.repoPath(t, cwd);
        if (p && CODE.test(p) && existsSync(join(repoRoot, p))) this.spawned.add(p);
      }
    };
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'] as const) wrap(cp, name, spawnArgs);
    syncBuiltinESMExports();
  }

  /** Take the file's coverage and write its record. */
  async finish(testFile: string, out: string): Promise<void> {
    this.recording = false;
    const report = await this.session.take();
    const lines = await this.session.lines(report);
    const modules = new Set(this.session.paths());
    const whole = new Set<string>();
    if (this.session.touched) for (const p of workerClosure()) whole.add(p);
    for (const s of this.spawned) {
      for (const p of staticClosure(s)) if (CODE.test(p) && existsSync(join(repoRoot, p)) && !this.harness.has(p)) whole.add(p);
    }
    for (const p of whole) { lines[p] = wholeFile(p); modules.add(p); }
    const path = relative(repoRoot, testFile);
    // A module read as text (a signature extractor) is data: any change to it counts.
    const reads = [...this.reads].filter((r) => r !== path && !this.harness.has(r)).sort();
    const record: TestRecord = { blob: blobHash(readFileSync(testFile)), modules: [...modules].sort(), lines, reads };
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${blobHash(Buffer.from(path))}.json`), JSON.stringify({ path, record }));
  }
}
