/**
 * Addressed random draws: the substrate for evolving a drawing by choosing
 * among variations without touching the source.
 *
 * Every user-facing draw (`rnd`, `pick`, `chance`, `prob`, on the toolkit
 * or a named stream) consumes one unit float from its stream. The studio
 * tags each such call in the sketch's compiled code with a SITE id derived
 * from the call's own text (`tagDraws`), so a draw has an address
 * `site:k` — the k-th draw that site made this run. A seed may carry
 * OVERRIDES, `base~site.k=f,…`: at those addresses the draw returns the
 * given unit float instead of the stream's, and the stream still advances,
 * so nothing after it moves. The override is a raw unit float whatever the
 * call's range, so `rnd(10, 100)` maps it into 10..100 itself and a
 * mutation can never leave the range the call declared.
 *
 * Library-internal draws (scatter, settle, fills) are made with no site on
 * the stack and are never addressed: only the sketch's own decisions are.
 */

/** A seed as the sketch sees it: the base, and the overrides by address. */
export interface ParsedSeed {
  seed: string;
  overrides: Record<string, number>;
}

const SEP = '~';

/** `base~site.k=f,site.k=f` → parts; a seed without a tail has none. */
export function parseSeed(s: string | number): ParsedSeed {
  const str = String(s);
  const at = str.indexOf(SEP);
  if (at < 0) return { seed: str, overrides: {} };
  const overrides: Record<string, number> = {};
  const tail = str.slice(at + 1);
  if (tail.length) {
    for (const part of tail.split(',')) {
      const eq = part.lastIndexOf('=');
      if (eq <= 0) throw new Error(`seed: bad override '${part}' (want site.k=f)`);
      const addr = part.slice(0, eq).replace('.', ':');
      const f = Number(part.slice(eq + 1));
      if (!/^[A-Za-z0-9]+:\d+$/.test(addr)) throw new Error(`seed: bad draw address '${part.slice(0, eq)}' (want site.k)`);
      if (!(f >= 0 && f < 1)) throw new Error(`seed: override '${part}' must be a unit float in [0, 1)`);
      overrides[addr] = f;
    }
  }
  return { seed: str.slice(0, at), overrides };
}

/** The one-string form of a seed with overrides (addresses sorted). */
export function formatSeed(seed: string | number, overrides: Record<string, number>): string {
  const keys = Object.keys(overrides).sort();
  if (keys.length === 0) return String(seed);
  return `${seed}${SEP}${keys.map((k) => `${k.replace(':', '.')}=${overrides[k]}`).join(',')}`;
}

/** FNV-1a over a string, as 6 base-36 characters: a site id. */
export function siteId(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).padStart(7, '0').slice(-6);
}

export const DRAW_HOOK = '__occlude_draw';

const DRAW_NAMES = new Set(['rnd', 'pick', 'chance', 'prob']);
const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

/** The tagging pass, as a report: what each site's text was. */
export interface DrawSite {
  id: string;
  text: string;
}

/**
 * Wrap every draw call in a sketch's compiled code so the library learns
 * its site: `t.rnd(10, 100)` becomes `__occlude_draw("c3f1x0", () => t.rnd(10, 100))`.
 * The site id is a hash of the call's text (receiver included, whitespace
 * collapsed) plus its ordinal among identical texts, so editing other lines
 * leaves it alone and editing the call itself makes a new site. A callee
 * whose receiver is not a plain dotted name (`t.stream('a').rnd(…)`) is left
 * untagged rather than misattributed. Strings, templates, comments and
 * regexes are skipped. Pure; the same pass headless and in the studio.
 */
export function tagDraws(js: string, hook = DRAW_HOOK): { js: string; sites: DrawSite[] } {
  const sites: DrawSite[] = [];
  const seen = new Map<string, number>();
  return { js: tagWithin(js, hook, sites, seen), sites };
}

/** One pass over `js`; a wrapped call's arguments are passed through again
 * so a draw nested in another's arguments gets its own site. */
function tagWithin(js: string, hook: string, sites: DrawSite[], seen: Map<string, number>): string {
  const out: string[] = [];
  const n = js.length;
  let i = 0;
  let last = 0;
  let lastSignificant = ';';
  const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '/', '%', '<', '>', '~', '^']);
  const skipString = (quote: string): number => {
    let k = i + 1;
    while (k < n && js[k] !== quote) {
      if (js[k] === '\\') k++;
      if (js[k] === '\n') break;
      k++;
    }
    return k + 1;
  };
  const skipTemplate = (from: number): number => {
    let k = from + 1;
    while (k < n && js[k] !== '`') {
      if (js[k] === '\\') { k += 2; continue; }
      if (js[k] === '$' && js[k + 1] === '{') {
        k += 2;
        let d = 1;
        while (k < n && d > 0) {
          const c = js[k];
          if (c === '`') { k = skipTemplate(k); continue; }
          if (c === '{') d++;
          else if (c === '}') d--;
          k++;
        }
        continue;
      }
      k++;
    }
    return k + 1;
  };
  /** The index just past the `)` matching the `(` at `open`, honouring nesting and literals. */
  const closeOf = (open: number): number => {
    let d = 0;
    let k = open;
    while (k < n) {
      const c = js[k];
      if (c === '"' || c === "'") { i = k; k = skipString(c); continue; }
      if (c === '`') { k = skipTemplate(k); continue; }
      if (c === '/' && js[k + 1] === '/') { while (k < n && js[k] !== '\n') k++; continue; }
      if (c === '/' && js[k + 1] === '*') { k = js.indexOf('*/', k + 2); k = k < 0 ? n : k + 2; continue; }
      if (c === '(' || c === '[' || c === '{') d++;
      else if (c === ')' || c === ']' || c === '}') { d--; if (d === 0) return k + 1; }
      k++;
    }
    return n;
  };
  while (i < n) {
    const c = js[i];
    if (c === '/' && js[i + 1] === '/') { while (i < n && js[i] !== '\n') i++; continue; }
    if (c === '/' && js[i + 1] === '*') { i = js.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
    if (c === '"' || c === "'") { i = skipString(c); lastSignificant = c; continue; }
    if (c === '`') { i = skipTemplate(i); lastSignificant = '`'; continue; }
    if (c === '/' && REGEX_BEFORE.has(lastSignificant)) {
      let k = i + 1;
      let inClass = false;
      while (k < n && js[k] !== '\n') {
        if (js[k] === '\\') { k += 2; continue; }
        if (js[k] === '[') inClass = true;
        else if (js[k] === ']') inClass = false;
        else if (js[k] === '/' && !inClass) break;
        k++;
      }
      i = k + 1;
      while (i < n && isIdentChar(js[i])) i++;
      lastSignificant = '/';
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (isIdentStart(c) && !(i > 0 && isIdentChar(js[i - 1]))) {
      let j = i;
      while (j < n && isIdentChar(js[j])) j++;
      const word = js.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(js[k])) k++;
      if (DRAW_NAMES.has(word) && js[k] === '(') {
        // The callee: walk back over a dotted chain of plain names.
        let start = i;
        let p = i - 1;
        while (p >= 0 && /\s/.test(js[p])) p--;
        let dotted = js[p] === '.';
        let ok = true;
        while (dotted) {
          p--;
          while (p >= 0 && /\s/.test(js[p])) p--;
          if (p < 0 || !isIdentChar(js[p])) { ok = false; break; }
          let q = p;
          while (q >= 0 && isIdentChar(js[q])) q--;
          start = q + 1;
          p = q;
          while (p >= 0 && /\s/.test(js[p])) p--;
          dotted = js[p] === '.';
        }
        // Not a definition or a property key: `function rnd(`, `rnd: (`, `.rnd = (`.
        const before = js.slice(Math.max(0, start - 12), start);
        const isDef = /function\s*$/.test(before) || /\bnew\s*$/.test(before);
        const after = js.slice(k);
        const isKey = /^\([^)]*\)\s*(=>|\{)/.test(after) && /(,|\{|\(|;|^)\s*$/.test(before) && start === i && !dotted;
        if (ok && !isDef && !isKey && (start === i ? true : true)) {
          const end = closeOf(k);
          const text = js.slice(start, end).replace(/\s+/g, ' ');
          const nth = seen.get(text) ?? 0;
          seen.set(text, nth + 1);
          const id = siteId(nth === 0 ? text : `${text}#${nth}`);
          sites.push({ id, text });
          const args = tagWithin(js.slice(k + 1, end - 1), hook, sites, seen);
          out.push(js.slice(last, start), `${hook}(${JSON.stringify(id)}, () => ${js.slice(start, k + 1)}${args}))`);
          last = end;
          i = end;
          lastSignificant = ')';
          continue;
        }
      }
      lastSignificant = word[word.length - 1];
      i = j;
      continue;
    }
    lastSignificant = c;
    i++;
  }
  out.push(js.slice(last));
  return out.join('');
}
