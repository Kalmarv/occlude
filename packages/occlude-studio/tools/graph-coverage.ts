/**
 * How much of a sketch the node vocabulary can say.
 *
 *   pnpm --filter occlude-studio graph:coverage
 *   pnpm --filter occlude-studio graph:coverage --run      # render each one first
 *   pnpm --filter occlude-studio graph:coverage --top 20   # how many rows to print
 *
 * The importer reads every live docs fence and every sketch of both
 * libraries, and the report counts what each one became: a statement that is
 * a built-in node is a statement the palette can say, a statement that is a
 * code node is a statement it cannot. The share of statements that are nodes
 * is the metric.
 *
 * A code node is then read for what it holds — a `steps` rule, a `.map` over
 * rows, a `fill(...)` call, a force sum, a field lambda, plain arithmetic —
 * and the histogram is the work list: the bucket with the most lines in it is
 * the next thing worth a node.
 *
 * `--run` renders each sketch before counting it, so a sketch the library has
 * moved past is skipped and named rather than counted. Without it every
 * sketch that imports and compiles is counted, which is the cheap answer.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as occlude from 'occlude';
import * as three from 'occlude/3d';
import {
  DEFAULT_PENS, initOcclude, isSketch, isSketchAsync, liveExampleToJs, renderAsync, userModules,
  type AsyncSketchDef, type PaperDef, type PenDef, type SketchDef,
} from 'occlude';

import { assetsFromDisk } from '../../occlude/tools/asset-preload.js';
import { CATALOGUE } from '../src/graph/catalogue.js';
import { compileGraph, usedImports } from '../src/graph/compile.js';
import { importSketch, type ImportRefusal } from '../src/graph/import.js';
import { graphToJson, parseGraph, type Graph, type GraphNode } from '../src/graph/model.js';
import { DOC_PAGES } from '../../occlude/src/docsExamples.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const root = resolve(pkg, '../..');
/** The owner's own library, in the prod checkout. Read only, never written. */
const PROD = '/home/kalmarv/containers/occlude/packages/occlude-studio/sketches';
const PROD_ASSETS = '/home/kalmarv/containers/occlude/packages/occlude-studio/assets';

const args = process.argv.slice(2);
const RUN = args.includes('--run');
const TOP = Number(args[args.indexOf('--top') + 1]) || 24;

// ---- what a code node holds ----

/** The buckets, in the order a body is tested against them. A rule body that
 * also sums forces is a rule: the outer shape is the one worth a node. */
const BUCKETS: { name: string; holds(body: string): boolean }[] = [
  { name: 'a steps rule', holds: (b) => /\.steps\s*\(/.test(b) || /\.rules\s*\(/.test(b) },
  { name: 'a .map over rows', holds: (b) => /\.(map|forEach|filter|flatMap)\s*\(/.test(b) },
  { name: 'a fill(…) call', holds: (b) => /\bfill\s*\(/.test(b) },
  { name: 'a force sum', holds: (b) => /\bforce\./.test(b) },
  { name: 'a field lambda', holds: (b) => /\(\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\)\s*=>/.test(b) },
  { name: 'arithmetic', holds: (b) => !/[(]/.test(b.replace(/^\s*return\s*/, '')) },
  { name: 'other', holds: () => true },
];

function bucketOf(body: string): string {
  return BUCKETS.find((bucket) => bucket.holds(body))!.name;
}

const lineCount = (body: string): number => body.trim().split('\n').length;

// ---- the sources ----

interface Source { group: string; name: string; text: string }

const FENCE = /```ts live[^\n]*\n([\s\S]*?)```/g;

function docSources(): Source[] {
  const out: Source[] = [];
  for (const page of DOC_PAGES.filter((p) => p.live)) {
    const text = readFileSync(join(root, 'docs', page.file), 'utf8');
    [...text.matchAll(FENCE)].forEach((match, i) => {
      out.push({ group: 'docs', name: `${page.slug}#${i}`, text: match[1]! });
    });
  }
  return out;
}

function librarySources(group: string, dir: string): Source[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.ts'))
    .sort()
    .map((file) => ({ group, name: file.replace(/\.ts$/, ''), text: readFileSync(join(dir, file), 'utf8') }));
}

/** A library's own pens and papers, for the sketches that name them. */
function libraryOf(dir: string): { pens: PenDef[]; papers: PaperDef[] } {
  const read = <T>(file: string, fallback: T): T => {
    const path = join(dir, file);
    if (!existsSync(path)) return fallback;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return fallback;
    }
  };
  return {
    pens: read<PenDef[]>('pens.json', structuredClone(DEFAULT_PENS) as PenDef[]),
    papers: read<PaperDef[]>('papers.json', []),
  };
}

// ---- does it still run? ----

function definition(text: string, pens: PenDef[], papers: PaperDef[]): SketchDef | AsyncSketchDef {
  const modules = userModules(pens, papers);
  const module = { exports: {} as Record<string, unknown> };
  const require = (name: string): unknown => {
    if (name === 'occlude') return occlude;
    if (name === 'occlude/3d') return three;
    const mod = modules[name as keyof typeof modules];
    if (mod) return mod;
    throw new Error(`cannot import '${name}' here`);
  };
  // The same two steps the studio takes: the server strips the types
  // (`/api/transpile`), and the runner's own transform turns ESM into the CJS
  // the worker evaluates. A docs fence needs only the second; a sketch from
  // the library is ordinary TypeScript and needs both.
  const js = liveExampleToJs(stripTypeScriptTypes(text, { mode: 'strip' }));
  new Function('require', 'exports', 'module', js)(require, module.exports, module);
  const value = module.exports.default;
  if (isSketch(value) || isSketchAsync(value)) return value;
  const found = Object.values(module.exports).find((v) => isSketch(v) || isSketchAsync(v));
  if (found) return found as SketchDef;
  throw new Error('exports no sketch');
}

async function runs(text: string, pens: PenDef[], papers: PaperDef[], assetDir: string): Promise<void> {
  await renderAsync(definition(text, pens, papers), {
    paper: { paper: 'Square20', landscape: false },
    coarsen: 4,
    marginPct: 5,
    library: structuredClone(pens),
    // A sketch that reads an image reads it from the store it belongs to.
    assets: assetsFromDisk(text, assetDir),
  });
}

// ---- the count ----

interface Row {
  group: string;
  name: string;
  builtin: number;
  code: number;
  codeLines: number;
  buckets: Map<string, number>;
  words: string[];
  refusals: ImportRefusal[];
}

function countGraph(graph: Graph): Row {
  const row: Row = { group: '', name: '', builtin: 0, code: 0, codeLines: 0, buckets: new Map(), words: [], refusals: [] };
  for (const node of graph.nodes) {
    if (node.kind === 'builtin') row.builtin++;
    if (node.kind !== 'code') continue;
    const body = node.body ?? '';
    row.code++;
    const lines = lineCount(body);
    row.codeLines += lines;
    const bucket = bucketOf(body);
    row.buckets.set(bucket, (row.buckets.get(bucket) ?? 0) + lines);
    for (const used of usedImports(body, CATALOGUE, Object.keys(node.inputs))) row.words.push(used.spec);
  }
  return row;
}

const pad = (text: string, width: number): string => (text.length >= width ? text : text + ' '.repeat(width - text.length));
const padLeft = (text: string, width: number): string => (text.length >= width ? text : ' '.repeat(width - text.length) + text);
/** A thrown thing's first line. Not everything thrown is an Error with a
 * message: a decoder throws a string, and a report that crashes says less
 * than a report that names the sketch. */
const why = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  return (text || String(error)).split('\n')[0]!;
};

const share = (builtin: number, code: number): string => (builtin + code === 0 ? '—' : `${Math.round((100 * builtin) / (builtin + code))}%`);

async function main(): Promise<void> {
  if (RUN) {
    await initOcclude(readFileSync(join(root, 'crates/occlude-core/pkg/occlude_core_bg.wasm')));
  }
  const sources = [
    ...docSources(),
    ...librarySources('dev', join(pkg, 'sketches')),
    ...librarySources('mine', PROD),
  ];
  const libraries = new Map<string, { pens: PenDef[]; papers: PaperDef[] }>([
    ['docs', { pens: structuredClone(DEFAULT_PENS) as PenDef[], papers: [] }],
    ['dev', libraryOf(join(pkg, 'sketches'))],
    ['mine', libraryOf(PROD)],
  ]);

  const rows: Row[] = [];
  const skipped: { name: string; why: string }[] = [];

  for (const source of sources) {
    const library = libraries.get(source.group)!;
    if (RUN && source.group !== 'docs') {
      try {
        await runs(source.text, library.pens, library.papers, source.group === 'mine' ? PROD_ASSETS : join(pkg, 'assets'));
      } catch (error) {
        skipped.push({ name: `${source.group}/${source.name}`, why: `does not run: ${why(error)}` });
        continue;
      }
    }
    let graph: Graph;
    const refusals: ImportRefusal[] = [];
    try {
      graph = importSketch(source.text, CATALOGUE, refusals);
      compileGraph(graph, CATALOGUE);
      parseGraph(JSON.parse(graphToJson(graph)));
    } catch (error) {
      skipped.push({ name: `${source.group}/${source.name}`, why: `does not import: ${why(error)}` });
      continue;
    }
    const row = countGraph(graph);
    row.refusals = refusals;
    row.group = source.group;
    row.name = source.name;
    rows.push(row);
  }

  // ---- the report ----

  const total = { builtin: 0, code: 0, codeLines: 0 };
  const buckets = new Map<string, { lines: number; nodes: number }>();
  const words = new Map<string, number>();
  const perGroup = new Map<string, { builtin: number; code: number; codeLines: number; n: number }>();
  for (const row of rows) {
    total.builtin += row.builtin;
    total.code += row.code;
    total.codeLines += row.codeLines;
    const group = perGroup.get(row.group) ?? { builtin: 0, code: 0, codeLines: 0, n: 0 };
    group.builtin += row.builtin;
    group.code += row.code;
    group.codeLines += row.codeLines;
    group.n += 1;
    perGroup.set(row.group, group);
    for (const [name, lines] of row.buckets) {
      const bucket = buckets.get(name) ?? { lines: 0, nodes: 0 };
      bucket.lines += lines;
      bucket.nodes += 1;
      buckets.set(name, bucket);
    }
    for (const word of row.words) words.set(word, (words.get(word) ?? 0) + 1);
  }

  console.log(`\nGraph coverage — ${rows.length} sources, ${skipped.length} skipped${RUN ? ' (rendered first)' : ''}\n`);
  console.log(`${pad('', 30)}${padLeft('nodes', 7)}${padLeft('code', 7)}${padLeft('lines', 7)}${padLeft('share', 7)}`);
  for (const [group, sum] of perGroup) {
    console.log(`${pad(`${group} (${sum.n})`, 30)}${padLeft(String(sum.builtin), 7)}${padLeft(String(sum.code), 7)}${padLeft(String(sum.codeLines), 7)}${padLeft(share(sum.builtin, sum.code), 7)}`);
  }
  console.log(`${pad('all', 30)}${padLeft(String(total.builtin), 7)}${padLeft(String(total.code), 7)}${padLeft(String(total.codeLines), 7)}${padLeft(share(total.builtin, total.code), 7)}`);

  console.log(`\nWhat the code nodes hold, by lines\n`);
  const order = [...buckets].sort((a, b) => b[1].lines - a[1].lines);
  for (const [name, bucket] of order) {
    const pct = total.codeLines === 0 ? 0 : Math.round((100 * bucket.lines) / total.codeLines);
    console.log(`${pad(name, 24)}${padLeft(String(bucket.lines), 7)} lines ${padLeft(String(bucket.nodes), 5)} nodes ${padLeft(`${pct}%`, 5)}`);
  }

  console.log(`\nThe sketches with the most code, of ${rows.length}\n`);
  console.log(`${pad('', 30)}${padLeft('nodes', 7)}${padLeft('code', 7)}${padLeft('lines', 7)}${padLeft('share', 7)}  holds`);
  for (const row of [...rows].sort((a, b) => b.codeLines - a.codeLines).slice(0, TOP)) {
    const holds = [...row.buckets].sort((a, b) => b[1] - a[1]).map(([name]) => name).join(', ');
    console.log(`${pad(`${row.group}/${row.name}`, 30)}${padLeft(String(row.builtin), 7)}${padLeft(String(row.code), 7)}${padLeft(String(row.codeLines), 7)}${padLeft(share(row.builtin, row.code), 7)}  ${holds}`);
  }

  // Why a statement is code and not a node: the reason, and — where the call
  // does name a palette word — that word. A word high in this list is a word
  // the palette has and the importer cannot place, which is a gap in the
  // importer, not in the vocabulary.
  const reasons = new Map<string, number>();
  const missed = new Map<string, number>();
  for (const row of rows) {
    for (const refusal of row.refusals) {
      reasons.set(refusal.reason, (reasons.get(refusal.reason) ?? 0) + 1);
      if (refusal.word) missed.set(`${refusal.word} — ${refusal.reason}`, (missed.get(`${refusal.word} — ${refusal.reason}`) ?? 0) + 1);
    }
  }
  console.log(`\nWhy a statement is code and not a node\n`);
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
    console.log(`${padLeft(String(count), 6)}  ${reason}`);
  }
  console.log(`\nA palette word the importer could not place\n`);
  for (const [what, count] of [...missed].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`${padLeft(String(count), 6)}  ${what}`);
  }

  console.log(`\nThe words the code nodes reach for, and how many nodes read each\n`);
  const reached = [...words].sort((a, b) => b[1] - a[1]).slice(0, 30);
  for (const [word, count] of reached) console.log(`${pad(word, 24)}${padLeft(String(count), 5)}`);

  if (skipped.length > 0) {
    console.log(`\nSkipped\n`);
    for (const one of skipped) console.log(`${pad(one.name, 30)}${one.why}`);
  }
  console.log('');
}

void main();
