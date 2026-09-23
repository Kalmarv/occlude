/**
 * The affected oracle's machinery: which source lines each docs fence runs,
 * and which fences a working-tree change can reach. `docs-hashes.ts` drives
 * it (`--map`, `--check --affected`); it lives apart so the selection is a
 * pure function the suite can test without rendering, and so nothing here
 * loads the library — the coverage session must start before `src` does.
 *
 * The map. One full oracle run under the V8 coverage session in
 * tools/coverage-map.ts (which also holds the working-tree diff and the
 * module-level skeleton this file and the test map share), taken between
 * fences: a fence's lines are what ran since the one before. The first
 * take, at import, registers every function of every loaded script. The
 * suite pins one function body to its true lines through the real tsx
 * loader.
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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CoverageSession, SRC, WORKER_ENTRY, hunkHits, hunkLabel, repoRoot, short, staticClosure, treeHash,
  wholeFile, workerClosure, type Change, type Lines, type Report } from './coverage-map.js';

// The shared machinery (tools/coverage-map.ts), under the names the oracle
// and its suite have always imported from here.
export {
  harnessHash, headCommit, hunkHits, importedBySrc, mergeLines, moduleLevelChange, repoRoot, staticClosure, withModuleLevel,
  withoutScriptEdits, workingChanges, WORKER_ENTRY, type Change, type Hunk, type Lines } from './coverage-map.js';

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

/** Where the maps live: gitignored, keyed by commit. */
export const cacheDir = join(repoRoot, 'packages/occlude/node_modules/.cache/docs-coverage');
/** The tracked paths whose content can move ink, hashed into `tree`. The
 * harness is hashed apart, from the working copy. */
const INK_PATHS = ['crates', 'packages/occlude/src', 'packages/occlude/package.json',
  'packages/occlude/test/fixtures/docs-ink.json', 'packages/occlude-studio/assets',
  'docs', 'README.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'];

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

/** A tree is clean enough to map when nothing that can move ink differs
 * from HEAD. */
export function inkDirty(changes: readonly Change[], pages: readonly { readonly file: string }[]): string[] {
  const docs = new Set(pages.map((p) => `docs/${p.file}`));
  return changes.map((c) => c.path).filter((p) => globalTrigger(p) || docs.has(p) || p.startsWith(SRC));
}

export function inkTree(): string { return treeHash(INK_PATHS); }

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

/** The oracle's own code outside the library, and the wasm it loads: what
 * draws the fences besides `src`. Data it reads by path is a global trigger
 * or the checkout's own (the pen and paper stores). */
export function harnessFiles(): Set<string> {
  const closure = staticClosure('packages/occlude/tools/docs-hashes.ts', (p) => p.startsWith(SRC));
  const code = [...closure].filter((p) => !p.startsWith(SRC) && /\.[cm]?[jt]s$/.test(p) && existsSync(join(repoRoot, p)));
  return new Set([...code, 'crates/occlude-core/pkg/occlude_core_bg.wasm']);
}

// ─── the recorder ────────────────────────────────────────────────────────

/** Records, per fence, the source lines it ran. Start it before the
 * library is imported: block counters exist only in code compiled after. */
export class CoverageRecorder {
  private readonly raw = new Map<string, Report>();
  private initRaw: Report = new Map();
  readonly workerFences: string[] = [];
  private constructor(private readonly session: CoverageSession) {}

  /** `under` is the directory whose scripts are recorded: the library. */
  static async start(under = join(repoRoot, SRC)): Promise<CoverageRecorder> {
    return new CoverageRecorder(await CoverageSession.start(under));
  }

  /** After the imports, before the first fence: what the import ran. */
  async init(): Promise<void> { this.initRaw = await this.session.take(); this.session.touched = false; }

  /** After a fence: its report, kept raw until the registry is complete. */
  async fence(key: string): Promise<void> {
    this.raw.set(key, await this.session.take());
    if (this.session.touched) this.workerFences.push(key);
    this.session.touched = false;
  }

  /** The map's per-fence and import-time lines, once every fence ran. */
  async finish(): Promise<Pick<CoverageMap, 'modules' | 'init' | 'fences' | 'workerFences'>> {
    const init = await this.session.lines(this.initRaw);
    const fences: Record<string, Record<string, Lines>> = {};
    // Code in a worker is not in any report: its whole closure stands in.
    const workerFiles = this.workerFences.length ? workerClosure() : [];
    for (const [key, report] of this.raw) {
      fences[key] = await this.session.lines(report);
      if (this.workerFences.includes(key)) for (const p of workerFiles) fences[key][p] = wholeFile(p);
    }
    const modules = new Set([...this.session.paths(), ...workerFiles]);
    await this.session.stop();
    return { modules: [...modules].sort(), init, fences, workerFences: this.workerFences };
  }
}
