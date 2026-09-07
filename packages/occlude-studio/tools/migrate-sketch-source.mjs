#!/usr/bin/env node
/**
 * Sketch-source migrations, as one pure function so every copy of a sketch
 * — working file, every commit in the store's history, every snapshot tag,
 * every `.history/` save — gets the identical rewrite.
 *
 * 2026-09-06 vocabulary renames:
 *   region(...)   → polygon(...)     (an area from its boundaries)
 *   trace(...)    → stroke(...)      (draw along a contour)
 *   t.loops(...)  → t.polylines(...) (a shape's outline as points)
 *
 * 2026-09-07 material-native geometry (docs/reviews/conversion.md):
 *   t.polylines(x) → t.material(x).curves().map((c) => c.pts)
 * `t.polylines` no longer exists; `t.material(x)` returns a Material, so
 * the rewrite keeps the array shape the caller expected by reading the
 * material's chains back as point arrays. The call is found by balancing
 * its parentheses (strings and comments inside the argument are skipped),
 * so a nested `t.polylines(rect(...))` rewrites whole. `t.loops` goes
 * through both steps. The other 2026-09-07 changes (isolines and
 * streamlines returning material) are shape changes of the RESULT, which a
 * text rewrite cannot adapt safely; the review lists them per sketch.
 *
 * `polygon(x, y, sides, r)` (the regular n-gon form) became `ngon(...)`,
 * but no sketch in the store ever used it — the survey over all 133
 * historical blobs found only `polygon(c.pts)`, which keeps its name —
 * so that rewrite is deliberately NOT here: a call-shape rewrite without
 * a use to test against would be a guess.
 *
 * Identifier-level, word-bounded: the survey over every git blob AND every
 * `.history/` save found the words `region`, `trace` and `loops` only as
 * these calls, imports, toolkit destructures and `t.`-prefixed calls —
 * never in comments, strings or as parameter names — so a word-boundary
 * rewrite is exact for this corpus. The renames were verified
 * byte-for-byte on rendered output by tools/verify-sketch-migration.mjs.
 *
 *   node tools/migrate-sketch-source.mjs < in.ts > out.ts
 */

/** The index just past the `)` that closes the call whose `(` is at `open`,
 * skipping strings, template literals and comments; -1 when unbalanced. */
function closeOfCall(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return -1; i++; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  return -1;
}

/** `t.polylines(<args>)` → `t.material(<args>).curves().map((c) => c.pts)`,
 * outside strings and comments; a bare `t.polylines` reference is left
 * for the author. */
function rewritePolylines(src) {
  let out = '';
  let last = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; continue; }
    if (src.startsWith('t.polylines', i) && !/[\w$.]/.test(src[i - 1] ?? ' ') && !/[\w$]/.test(src[i + 11] ?? ' ')) {
      const open = i + 11;
      if (src[open] !== '(') continue;
      const end = closeOfCall(src, open);
      if (end < 0) continue;
      out += src.slice(last, i) + 't.material' + src.slice(open, end) + '.curves().map((c) => c.pts)';
      last = end;
      i = end - 1;
    }
  }
  return out + src.slice(last);
}

export function migrateSketchSource(src) {
  // Bare identifiers (imports, destructures, calls) and the toolkit-prefixed
  // spellings `t.region` / `t.trace` / `t.loops`. Other receivers are left
  // alone (`console.trace`, a fill callback's `region.bbox`), which is why
  // the bare form excludes any preceding `.`.
  const renamed = src
    .replace(/(?<![\w.$])region(?![\w$])/g, 'polygon')
    .replace(/\bt\.region(?![\w$])/g, 't.polygon')
    .replace(/(?<![\w.$])trace(?![\w$])/g, 'stroke')
    .replace(/\bt\.trace(?![\w$])/g, 't.stroke')
    .replace(/\bt\.loops(?![\w$])/g, 't.polylines');
  return rewritePolylines(renamed);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    process.stdout.write(migrateSketchSource(Buffer.concat(chunks).toString('utf8')));
  });
}
