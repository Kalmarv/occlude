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
  const stroke = /^stroke\(\s*[A-Za-z_$][\w$]*\s*(?:,\s*([\s\S]*?))?\s*\)$/.exec(m[2]);
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
    return strokeChain(producer, steps) ?? curveChain(producer, steps);
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
    let joinAt = -1;
    let tokenEnd = -1;
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
      tokenEnd = at;
      while (at < src.length && /\s/.test(src[at])) at++;
      if (src[at] === '.') {
        for (const p of producers) {
          if (src.startsWith(`.${p}`, at) && !/[\w$]/.test(src[at + p.length + 1] ?? ' ')) {
            name = p;
            open = at + 1 + p.length;
            break;
          }
        }
        // `t` + `.isolines(…)`: the gap was only line breaking.
        if (name !== null) joinAt = at;
      }
      if (name === null) continue;
    }
    if (src[open] !== '(') continue;
    const end = closeOfCall(src, open);
    if (end < 0) continue;
    const producerText = joinAt < 0 ? src.slice(emitFrom, end) : src.slice(emitFrom, tokenEnd) + src.slice(joinAt, end);
    const r = rewrite(producerText, src.slice(end));
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

/**
 * A result kept in a variable: `const blobs = isolines(…); … blobs.map(…)`.
 * The call-site rules above cannot see this shape — the consumer is elsewhere
 * — so the names bound to a producer are collected first and their uses
 * rewritten: inside a `polygon(...)` the point arrays ARE the material's
 * chains (`blobs.map((c) => c.pts)` → `blobs`), and a per-contour map reads
 * the chain records (`blobs.map(…)` → `blobs.curves().map(…)`). Name-based and
 * word-bounded, so a `blobs` that came from anywhere else is left alone.
 */
function rewriteBindings(src) {
  const bound = new Set();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:t\.)?(?:isolines|streamlines)\s*\(/g)) {
    bound.add(m[1]);
  }
  let out = src;
  for (const name of bound) {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(
      new RegExp(`((?:t\\.)?polygon\\(\\s*)${n}\\.map\\(\\s*\\(\\w+\\)\\s*=>\\s*\\w+\\.pts\\s*\\)`, 'g'),
      `$1${name}`,
    );
    out = out.replace(new RegExp(`\\b${n}\\.flat\\(\\)\\.map\\(`, 'g'), `${name}.curves().map(`);
    out = out.replace(new RegExp(`\\b${n}\\.map\\(`, 'g'), `${name}.curves().map(`);
  }
  return out;
}

/**
 * A scatter or settle result is a point-only MATERIAL now, not an Array
 * subclass: `.map`/`.filter`/`.length` on it read its points, so they become
 * `.points.map(…)` and friends. Both the chained form and a result kept in a
 * variable (`const pts = t.settle(…)`) are handled — the names are collected
 * the same way `rewriteBindings` collects contour producers.
 */
function rewriteCloudConsumers(src) {
  const direct = rewriteProducers(src, ['t.scatter', 'scatter', 't.settle', 'settle'], (producer, rest) => {
    const m = /^(\s*)\.(map|filter|forEach|some|every|find)\s*\(/.exec(rest);
    if (m) return { text: `${producer}.points.${m[2]}(`, consumed: m[0].length };
    const len = /^(\s*)\.length\b/.exec(rest);
    return len ? { text: `${producer}.n`, consumed: len[0].length } : null;
  });
  const names = new Set();
  for (const m of direct.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:t\.)?(?:scatter|settle)\s*\(/g)) {
    names.add(m[1]);
  }
  let out = direct;
  for (const name of names) {
    const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\b${n}\\.(map|filter|forEach|some|every|find)\\(`, 'g'), `${name}.points.$1(`);
    out = out.replace(new RegExp(`\\b${n}\\.length\\b`, 'g'), `${n}.n`);
  }
  return out;
}

/** `strokes(…)` is introduced by the rewrites above; a source that never drew
 * with it has no import for it. Added to the `occlude` import, once. */
function addStrokesImport(src) {
  if (!/\bstrokes\s*\(/.test(src) || /\bstrokes\b/.test(src.slice(0, src.indexOf('from')))) return src;
  return src.replace(/(import\s*\{)([^}]*)(\}\s*from\s*['"]occlude['"])/, (all, open, names, close) =>
    `${open}${names.trimEnd().replace(/,$/, '')}, strokes ${close}`,
  );
}

/** Split top-level commas of a call's argument text (nesting and literals
 * respected), so the requested level list can be read back from the call. */
function splitArgs(args) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < args.length && args[i] !== c; i++) if (args[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      out.push(args.slice(start, i));
      start = i + 1;
    }
  }
  out.push(args.slice(start));
  return out.map((a) => a.trim()).filter((a) => a !== '');
}

/**
 * `const X = isolines(f, levels, o).map((cs, i) => polygon(cs.map((c) => c.pts), p));`
 * → the material bound once, then the map over the REQUESTED levels:
 *
 *   const __iso = isolines(f, levels, o);
 *   const X = levels.map((lvl, i) => polygon(__iso.edges.filter((e) => e.attrs.level === lvl), p));
 *
 * Grouping the produced edges by level would read well, but a level with no
 * contours produces no group, so the old array's empty slot would vanish —
 * one shape fewer, which shifts every later shape's draw index and with it the
 * seeded fill sub-stream, so the hatch phase of everything after it moves.
 * Mapping the requested levels keeps the empty slot (an empty selection is the
 * same no-op path the old empty array made) and the index the callback sees is
 * the level's own index, as before.
 */
function rewriteLevelStatement(src) {
  const re = /(^|\n)([ \t]*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*((?:t\.)?isolines\s*)\(/g;
  let out = '';
  let last = 0;
  for (const m of src.matchAll(re)) {
    const [full, nl, indent, name, callee] = m;
    const open = m.index + full.length - 1;
    const close = closeOfCall(src, open);
    if (close < 0) continue;
    const args = src.slice(open + 1, close - 1);
    const { steps } = readChain(src.slice(close));
    if (steps.length !== 1 || steps[0].name !== 'map') continue;
    // The callback's shape: (cs, i) => polygon(cs.map((c) => c.pts), opts)
    const shape = /^\s*\((\w+)\s*,\s*(\w+)\)\s*=>\s*polygon\(/.exec(steps[0].args);
    if (!shape) continue;
    const [, cs, index] = shape;
    const optsText = /polygon\(\s*\w+\.map\(\s*\(\w+\)\s*=>\s*\w+\.pts\s*\)\s*(?:,\s*([\s\S]*?))?\s*\)\s*,?\s*$/.exec(steps[0].args);
    if (!optsText) continue;
    // Any other use of the callback's first parameter expected a CONTOUR ARRAY,
    // which is now the level value: refuse rather than change its meaning.
    const body = steps[0].args.slice(steps[0].args.indexOf('=>') + 2);
    const uses = body.split(new RegExp(`\\b${cs}\\b`)).length - 1;
    if (uses !== 1) continue;
    const parts = splitArgs(args);
    if (parts.length < 2) continue;
    const levels = parts[1];
    const opts = optsText[1]?.replace(/,\s*$/, '');
    const r = { consumed: steps[0].end };
    const replacement =
      `${nl}${indent}const __iso = ${callee}(${args});` +
      `${nl}${indent}const ${name} = ${levels}.map((${cs}, ${index}) => polygon(` +
      `__iso.edges.filter((e) => e.attrs.level === ${cs})${opts ? `, ${opts}` : ''}))`;
    out += src.slice(last, m.index) + replacement;
    last = close + r.consumed;
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
  const rewritten = rewriteScatterSettle(
    rewriteCloudConsumers(
      rewriteFieldResults(rewriteBindings(rewriteLevelStatement(rewritePolylines(renamed)))),
    ),
  );
  return addStrokesImport(rewritten);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    process.stdout.write(migrateSketchSource(Buffer.concat(chunks).toString('utf8')));
  });
}
