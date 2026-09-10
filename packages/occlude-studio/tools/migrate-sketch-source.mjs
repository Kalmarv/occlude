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
 * 2026-09-07 material-native geometry (working/conversion-review.md):
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

/** Read the postfix chain that follows a producer call: whitespace, then
 * `.name(args)` steps (paren-balanced, strings and comments skipped). Gives
 * the steps and the index just past the last one. */
export function readChain(rest) {
  const steps = [];
  let i = 0;
  for (;;) {
    const ws = /^\s*/.exec(rest.slice(i))[0].length;
    const m = /^\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(rest.slice(i + ws));
    if (!m) return { steps, end: i };
    const open = i + ws + m[0].length - 1;
    const close = closeOfCall(rest, open);
    if (close < 0) return { steps, end: i };
    steps.push({ name: m[1], args: rest.slice(open + 1, close - 1), end: close });
    i = close;
  }
}

/** `isolines(x, levels, opts).map((cs, i) => polygon(cs.map((c) => c.pts), o))`
 * → `isolines(…).edges.groupBy((e) => e.attrs.level).map((cs, i) => polygon(cs, o))`.
 * The producer returns ONE material now, and `groupBy` splits its edges by the
 * `level` column in first-occurrence order — the order the old per-level array
 * had. `polygon(selection)` reads the same rings the old `cs.map((c) => c.pts)`
 * did: separate contours stay separate loops, and an open contour is closed
 * with a chord either way. */
export function levelGroupChain(producer, steps) {
  if (steps.length !== 1 || steps[0].name !== 'map') return null;
  const m = /^\s*\((\w+)\s*,\s*(\w+)\)\s*=>\s*polygon\(\s*(\w+)\.map\(\s*\(\w+\)\s*=>\s*\w+\.pts\s*\)\s*(?:,\s*([\s\S]*?))?\s*\)\s*,?\s*$/.exec(steps[0].args);
  if (!m) return null;
  const [, contours, index, scoped, opts] = m;
  if (scoped !== contours) return null;
  return {
    text: `${producer}.edges.groupBy((e) => e.attrs.level).map((${contours}, ${index}) => polygon(${contours}${opts !== undefined ? `, ${opts}` : ''}))`,
    consumed: steps[0].end,
  };
}

/** `isolines(…).flat().map((c) => stroke(c, o))` and
 * `streamlines(…).map((c) => stroke(c, o))` → `strokes(<producer>, o)`.
 * The material holds every contour of every level (streamlines: every chain),
 * which is what flattening the old array-of-arrays produced, and `strokes`
 * draws each one with the same options. */
export function strokeChain(producer, steps) {
  const flat = steps[0]?.name === 'flat' && steps[0].args.trim() === '';
  const map = steps[flat ? 1 : 0];
  if (!map || map.name !== 'map' || steps.length !== (flat ? 2 : 1)) return null;
  const m = /^\s*\((\w+)\)\s*=>\s*([\s\S]*?)\s*,?\s*$/.exec(map.args);
  if (!m) return null;
  const stroke = /^stroke\(\s*[A-Za-z_$][\w$]*\s*(?:,\s*([\s\S]*?))?\s*\)$/.exec(m[1]);
  if (!stroke) return null;
  const opts = stroke[1];
  return { text: `strokes(${producer}${opts ? `, ${opts}` : ''})`, consumed: map.end };
}

/** `isolines(…).map((c) => polygon(c.pts, o))` →
 * `….curves().map((c) => polygon(c, o))`: `curves()` is the array of contour
 * records the old result already was. */
export function curveChain(producer, steps) {
  if (steps.length !== 1 || steps[0].name !== 'map') return null;
  const m = /^\s*\((\w+)\)\s*=>\s*(t\.)?polygon\(\s*\1\.pts\s*(?:,\s*([\s\S]*?))?\s*\)\s*,?\s*$/.exec(steps[0].args);
  if (!m) return null;
  const [, c, , opts] = m;
  return { text: `${producer}.curves().map((${c}) => polygon(${c}${opts !== undefined ? `, ${opts}` : ''}))`, consumed: steps[0].end };
}

/** Scan for `isolines(` / `streamlines(` calls — toolkit-prefixed or bare —
 * and rewrite the CONSUMER of the result, which is the shape change the
 * 2026-09-07 migration could not adapt with a call-only rewrite. Anything
 * the three rules above do not recognise is left alone for the author, and
 * the verifier reports it. */
function rewriteFieldResults(src) {
  return rewriteProducers(src, ['t.isolines', 't.streamlines', 'isolines', 'streamlines'], (producer, rest) => {
    const { steps, end } = readChain(rest);
    if (steps.length === 0) return null;
    void end;
    return levelGroupChain(producer, steps) ?? strokeChain(producer, steps) ?? curveChain(producer, steps);
  });
}

/** The scan shared by the producer rewrites: find each producer call, hand its
 * span and the text after it to `rewrite`, which returns the replacement and
 * how many characters of the tail it consumed (or null to leave it alone). */
export function rewriteProducers(src, producers, rewrite) {
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
    let name = null;
    let emitFrom = i;
    let open = -1;
    for (const p of producers) {
      if (src.startsWith(p, i) && !/[\w$.]/.test(src[i - 1] ?? ' ') && !/[\w$]/.test(src[i + p.length] ?? ' ')) {
        name = p;
        open = i + p.length;
        break;
      }
    }
    if (name === null) {
      // The dotted form: a receiver, maybe a line break, then `.name(…)`.
      // The replacement must take the receiver with it, or it would be a
      // call with no receiver; the scan stays forward-only.
      let at = i;
      while (at < src.length && /[\w$]/.test(src[at])) at++;
      while (at < src.length && /\s/.test(src[at])) at++;
      if (src[at] === '.') {
        for (const p of producers) {
          if (src.startsWith(`.${p}`, at) && !/[\w$]/.test(src[at + p.length + 1] ?? ' ')) {
            name = p;
            open = at + 1 + p.length;
            break;
          }
        }
      }
      if (name === null) continue;
    }
    if (src[open] !== '(') continue;
    const end = closeOfCall(src, open);
    if (end < 0) continue;
    const r = rewrite(src.slice(emitFrom, end), src.slice(end));
    if (!r) continue;
    out += src.slice(last, emitFrom) + r.text;
    last = end + r.consumed;
    i = last - 1;
  }
  return out + src.slice(last);
}

/**
 * `t.scatter(field, { spacing }).settle(n)` → `t.settle(t.scatter(field, { spacing }), { density: field, spacing, iterations: n })`.
 * The `Points` class is gone; `t.settle` takes the material and the context
 * explicitly, and the context was exactly the scatter call's own arguments:
 * the same density field, the same spacing, the same iteration count.
 * Only the literal `(field, { spacing })` shape is rewritten — anything else
 * is a question for the author, and the verifier reports it.
 */
function rewriteScatterSettle(src) {
  return rewriteProducers(src, ['t.scatter', 'scatter'], (producer, rest) => {
    const { steps, end } = readChain(rest);
    if (steps.length !== 1 || steps[0].name !== 'settle' || steps[0].args.trim() === '') return null;
    const args = /^\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{\s*spacing\s*\}\s*\)$/.exec(producer.slice(producer.indexOf('(')));
    if (!args) return null;
    const field = args[1];
    return {
      text: `t.settle(${producer}, { density: ${field}, spacing, iterations: ${steps[0].args.trim()} })`,
      consumed: steps[0].end,
    };
  });
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
  return rewriteScatterSettle(rewriteFieldResults(rewritePolylines(renamed)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    process.stdout.write(migrateSketchSource(Buffer.concat(chunks).toString('utf8')));
  });
}
