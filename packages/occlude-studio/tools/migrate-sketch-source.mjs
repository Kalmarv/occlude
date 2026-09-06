#!/usr/bin/env node
/**
 * The 2026-09-06 vocabulary migration for sketch sources, as one pure
 * function so every copy of a sketch — working file, every commit in the
 * store's history, every snapshot tag, every `.history/` save — gets the
 * identical rewrite:
 *
 *   region(...)   → polygon(...)     (an area from its boundaries)
 *   trace(...)    → stroke(...)      (draw along a contour)
 *   t.loops(...)  → t.polylines(...) (a shape's outline as points)
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
 * rewrite is exact for this corpus. Verified byte-for-byte
 * on rendered output by tools/verify-sketch-migration.mjs.
 *
 *   node tools/migrate-sketch-source.mjs < in.ts > out.ts
 */

export function migrateSketchSource(src) {
  // Bare identifiers (imports, destructures, calls) and the toolkit-prefixed
  // spellings `t.region` / `t.trace` / `t.loops`. Other receivers are left
  // alone (`console.trace`, a fill callback's `region.bbox`), which is why
  // the bare form excludes any preceding `.`.
  return src
    .replace(/(?<![\w.$])region(?![\w$])/g, 'polygon')
    .replace(/\bt\.region(?![\w$])/g, 't.polygon')
    .replace(/(?<![\w.$])trace(?![\w$])/g, 'stroke')
    .replace(/\bt\.trace(?![\w$])/g, 't.stroke')
    .replace(/\bt\.loops(?![\w$])/g, 't.polylines');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    process.stdout.write(migrateSketchSource(Buffer.concat(chunks).toString('utf8')));
  });
}
