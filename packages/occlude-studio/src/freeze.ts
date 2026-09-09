/**
 * Freeze: an evolved or rolled drawing written back into its sketch as
 * numbers you can edit. Pure text in, text out; undo is the editor's.
 */
import { formatSeed, parseSeed, tagDraws } from 'occlude';

/** Offset range of the first argument of the sketch(...) call, if an object literal. */
export function optionsSpan(source: string): [number, number] | null {
  const at = source.search(/\bsketch\s*\(/);
  if (at < 0) return null;
  let i = source.indexOf('(', at) + 1;
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source[i] !== '{') return null;
  let d = 0;
  for (let k = i; k < source.length; k++) {
    if (source[k] === '{') d++;
    else if (source[k] === '}') { d--; if (d === 0) return [i, k + 1]; }
  }
  return null;
}

/** A render's addressed draws, as the worker reports them. */
export interface FreezeDraws {
  addrs: string[];
  /** The unit float each draw returned: what pins a draw that stays. */
  f: ArrayLike<number>;
  values: (number | boolean | null)[];
}

const literalOf = (v: number): string => String(+v.toPrecision(12));

/**
 * Freeze: the last render's values written back over the random calls
 * that made them. A site that drew exactly once becomes its value — a
 * number for `rnd`, `true`/`false` for `chance`, `(list)[i]` for `pick`.
 * A site that drew more than once has no single value and is left as a
 * draw. Removing a draw from a stream shifts every later draw on it, so
 * the seed pinned in the sketch's options carries an override for EVERY
 * draw that stays: each keeps the float it had, wherever the stream now
 * is. What the sketch decided is exact; only the library's own draws
 * (scatter, settle) behind them can move.
 */
export function freeze(source: string, draws: FreezeDraws, seed: string): { source: string; frozen: number; kept: number } {
  const { sites } = tagDraws(source);
  const bySite = new Map<string, { addr: string; value: number | boolean | null }[]>();
  draws.addrs.forEach((addr, i) => {
    const site = addr.slice(0, addr.lastIndexOf(':'));
    (bySite.get(site) ?? bySite.set(site, []).get(site)!).push({ addr, value: draws.values[i] ?? null });
  });
  const edits: { start: number; end: number; text: string }[] = [];
  const frozenAddrs = new Set<string>();
  let kept = 0;
  // Nested sites: an outer call's span contains an inner's; freezing the
  // outer writes over the inner too, so inner spans within a frozen outer
  // are skipped (their value is inside the outer's).
  const outerSorted = [...sites].sort((a, b) => a.start - b.start || b.end - a.end);
  let coveredTo = -1;
  for (const site of outerSorted) {
    if (site.start < coveredTo) continue;
    const entries = bySite.get(site.id);
    if (!entries || entries.length === 0) continue;
    if (entries.length > 1) { kept += 1; continue; }
    const { addr, value } = entries[0];
    if (value === null) continue;
    let text: string;
    if (typeof value === 'boolean') text = String(value);
    else if (/^(?:[\w$.]+\.)?pick\s*\(/.test(site.text)) {
      const open = site.text.indexOf('(');
      text = `(${site.text.slice(open + 1, site.text.lastIndexOf(')'))})[${value}]`;
    } else text = value < 0 ? `(${literalOf(value)})` : literalOf(value);
    edits.push({ start: site.start, end: site.end, text });
    frozenAddrs.add(addr);
    coveredTo = site.end;
  }
  let out = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  // Pin the seed: the base, plus every draw that stays, at the float it had.
  const parsed = parseSeed(seed);
  const remaining: Record<string, number> = {};
  draws.addrs.forEach((addr, i) => { if (!frozenAddrs.has(addr)) remaining[addr] = draws.f[i]; });
  const pinned = formatSeed(parsed.seed, remaining);
  const opts = optionsSpan(out);
  if (opts) {
    const body = out.slice(opts[0], opts[1]);
    const seedRe = /(\bseed\s*:\s*)(?:'[^']*'|"[^"]*"|[^,}\s]+)/;
    const next = seedRe.test(body)
      ? body.replace(seedRe, `$1'${pinned}'`)
      : body.replace(/^\{\s*/, (m) => (body.trim() === '{}' ? '{ ' : `${m}seed: '${pinned}', `)) + (body.trim() === '{}' ? `seed: '${pinned}' }` : '');
    out = out.slice(0, opts[0]) + (body.trim() === '{}' ? `{ seed: '${pinned}' }` : next) + out.slice(opts[1]);
  }
  return { source: out, frozen: edits.length, kept };
}
