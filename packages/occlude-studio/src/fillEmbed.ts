/**
 * Export embedding and import reconciliation for custom fills (spec rule
 * 8): "Download .ts" appends the resolved source of every custom fill the
 * sketch uses in a clearly marked, comment-only block — the file stays a
 * valid sketch; "Import .ts" restores them to the library: identical
 * content reuses the name silently, a genuine mismatch takes a fresh name
 * and the sketch's literal is rewired. Never a prompt, never an overwrite.
 */

import { isBuiltinFill, scanFillNames } from 'occlude';

export interface EmbeddedFill {
  name: string;
  source: string;
}

const HEADER =
  '// ==== occlude fills — embedded by Download .ts; Import .ts restores them to the fill library ====';
const FILL_START = /^\/\/ ---- fill: ([a-zA-Z0-9_-]+) ----$/;
const FILL_END = '// ---- end fill ----';
const LINE_PREFIX = '//| ';

/** Append the fills block. Any earlier block is replaced, not stacked. */
export function embedFills(sketch: string, fills: EmbeddedFill[]): string {
  const base = extractEmbeddedFills(sketch).sketch.replace(/\s+$/, '');
  if (fills.length === 0) return `${base}\n`;
  const lines = [base, '', HEADER];
  for (const f of fills) {
    lines.push(`// ---- fill: ${f.name} ----`);
    for (const l of f.source.replace(/\s+$/, '').split('\n')) {
      lines.push(l === '' ? LINE_PREFIX.trimEnd() : LINE_PREFIX + l);
    }
    lines.push(FILL_END);
  }
  return `${lines.join('\n')}\n`;
}

/** Split a downloaded file back into the sketch and its embedded fills. */
export function extractEmbeddedFills(text: string): { sketch: string; fills: EmbeddedFill[] } {
  const at = text.indexOf(HEADER);
  if (at < 0) return { sketch: text, fills: [] };
  const sketch = text.slice(0, at).replace(/\s+$/, '') + '\n';
  const fills: EmbeddedFill[] = [];
  let current: { name: string; lines: string[] } | null = null;
  for (const line of text.slice(at + HEADER.length).split('\n')) {
    const start = line.match(FILL_START);
    if (start) {
      current = { name: start[1], lines: [] };
      continue;
    }
    if (line === FILL_END) {
      if (current) fills.push({ name: current.name, source: `${current.lines.join('\n')}\n` });
      current = null;
      continue;
    }
    if (current && line.startsWith('//|')) {
      current.lines.push(line.startsWith(LINE_PREFIX) ? line.slice(LINE_PREFIX.length) : '');
    }
  }
  return { sketch, fills };
}

/** Change every `fill('from'` literal to `fill('to'` (either quote style). */
export function rewireFillName(source: string, from: string, to: string): string {
  const q = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(new RegExp(`(\\bfill\\(\\s*)(['"])${q}\\2`, 'g'), `$1$2${to}$2`);
}

/** First unused `base-2`, `base-3`, … (a trailing -N on `base` is reset). */
export function freshFillName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const stem = base.replace(/-\d+$/, '');
  for (let n = 2; ; n++) {
    const candidate = `${stem}-${n}`;
    if (!set.has(candidate) && !isBuiltinFill(candidate)) return candidate;
  }
}

/** Custom fill names a sketch references (built-ins excluded). */
export function customFillNames(source: string): string[] {
  return scanFillNames(source).filter((n) => !isBuiltinFill(n));
}

export interface FillLibrary {
  list(): Promise<string[]>;
  load(name: string): Promise<string | null>;
  save(name: string, source: string): Promise<void>;
}

export interface ImportOutcome {
  sketch: string;
  /** Fills that landed in the library under their own name (new). */
  added: string[];
  /** Fills that matched the library byte-for-byte (reused silently). */
  reused: string[];
  /** Mismatches imported under a fresh name, with the sketch rewired. */
  renamed: { from: string; to: string }[];
}

/**
 * Reconcile a downloaded file's embedded fills with the library. Content
 * equality short-circuits; a same-named different fill (or a built-in
 * name) takes the first free `name-N` and the sketch literal follows it.
 */
export async function importSketchWithFills(
  text: string,
  lib: FillLibrary,
): Promise<ImportOutcome> {
  const { sketch, fills } = extractEmbeddedFills(text);
  const out: ImportOutcome = { sketch, added: [], reused: [], renamed: [] };
  if (fills.length === 0) return out;
  const taken = new Set(await lib.list());
  for (const f of fills) {
    const existing = isBuiltinFill(f.name) ? undefined : await lib.load(f.name);
    if (existing === f.source) {
      out.reused.push(f.name);
      continue;
    }
    if (existing === null) {
      await lib.save(f.name, f.source);
      taken.add(f.name);
      out.added.push(f.name);
      continue;
    }
    const fresh = freshFillName(f.name, taken);
    await lib.save(fresh, f.source);
    taken.add(fresh);
    out.sketch = rewireFillName(out.sketch, f.name, fresh);
    out.renamed.push({ from: f.name, to: fresh });
  }
  return out;
}
