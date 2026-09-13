/**
 * The run's inputs for the node tools: the paper choice, the pen library
 * (the studio's `sketches/pens.json`, or the package's own for the docs),
 * the seed, and the assets and custom fills a source references, read
 * from the studio's directories on disk. Every tool builds its
 * `ExecutionInputs` here — explicitly, per run — where the studio worker
 * builds the same object from its fetches.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as occlude from '../src/index.js';
import {
  DEFAULT_PAPERS, DEFAULT_PENS, paperSize, userModules, type ExecutionInputs, type PaperChoice, type PaperDef, type PenDef,
} from '../src/index.js';
import { assetsFromDisk } from './asset-preload.js';
import { fillsFromDisk } from './fill-preload.js';

const pensPath = fileURLToPath(new URL('../../occlude-studio/sketches/pens.json', import.meta.url));
const papersPath = fileURLToPath(new URL('../../occlude-studio/sketches/papers.json', import.meta.url));

/** The studio's pen library from disk, or the package's own pens when
 * `'docs'` is asked for or the studio has none saved. */
export function penLibrary(which: 'studio' | 'docs' | string = 'studio'): PenDef[] {
  if (which === 'docs') return structuredClone(DEFAULT_PENS);
  const path = which === 'studio' ? pensPath : which;
  try {
    const pens = JSON.parse(readFileSync(path, 'utf8')) as PenDef[];
    if (Array.isArray(pens) && pens.length > 0) return pens;
  } catch {
    // no library saved: the defaults
  }
  return structuredClone(DEFAULT_PENS);
}

/** Inputs for one run of `js` (the transpiled sketch source, scanned for
 * asset and fill names) on `paper`. */
export function inputsFor(
  js: string,
  opts: { paper: PaperChoice | string; seed?: number | string; pens?: 'studio' | 'docs' | string | PenDef[]; marginPct?: number; inspect?: boolean },
): ExecutionInputs {
  const { w, h } = paperSize(typeof opts.paper === 'string' ? { paper: opts.paper } : opts.paper);
  const library = Array.isArray(opts.pens) ? opts.pens : penLibrary(opts.pens);
  return {
    paper: { w, h },
    library,
    seed: opts.seed,
    marginPct: opts.marginPct,
    assets: assetsFromDisk(js),
    fills: fillsFromDisk(js),
    inspect: opts.inspect,
  };
}

/** The `--seed` of a tool as the run's seed: numbers as numbers. */
export function seedArg(raw: string | undefined): number | string | undefined {
  if (raw === undefined) return undefined;
  return /^-?\d+$/.test(raw) ? Number(raw) : raw;
}

/** The studio's paper library from disk, or the package's presets when
 * `'docs'` is asked for or the studio has none saved. */
export function paperLibrary(which: 'studio' | 'docs' | string = 'studio'): PaperDef[] {
  if (which === 'docs') return structuredClone(DEFAULT_PAPERS);
  const path = which === 'studio' ? papersPath : which;
  try {
    const papers = JSON.parse(readFileSync(path, 'utf8')) as PaperDef[];
    if (Array.isArray(papers) && papers.length > 0) return papers;
  } catch {
    // no library saved: the presets
  }
  return structuredClone(DEFAULT_PAPERS);
}

/** The `require` a sketch module gets: `occlude` itself, and the user
 * modules built from the given libraries. */
export function requireFor(pens: readonly PenDef[], papers: readonly PaperDef[]): (name: string) => unknown {
  const modules = userModules(pens, papers);
  return (name) => {
    if (name === 'occlude') return occlude;
    const mod = modules[name as keyof typeof modules];
    if (mod) return mod;
    throw new Error(`sketches can import from 'occlude', '@user/pens' and '@user/papers' (tried '${name}')`);
  };
}
