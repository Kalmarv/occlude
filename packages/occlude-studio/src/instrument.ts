/**
 * Automatic material inspection: after every `const x = …;` (or let/var)
 * in the emitted sketch, add a call that registers `x` under its own
 * name if it turns out to be a Material, and does nothing otherwise. The
 * source in the editor is untouched; this runs on the CommonJS the TS
 * worker emitted, only when the material layer is on. The scanner keeps
 * out of strings, template literals, comments and regex literals, leaves
 * `for (…)` heads alone, and skips destructuring and multi-declarator
 * statements, which have no single name to register under.
 */

export const INSPECT_HOOK = '__occlude_inspect';

const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);

/** Where a `/` after this character starts a regex rather than dividing. */
const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

export function instrumentDeclarations(js: string, hook = INSPECT_HOOK): string {
  const out: string[] = [];
  let last = 0; // js[0…last) already copied to out
  const n = js.length;
  let i = 0;
  /** Bracket depth over the whole text. */
  let depth = 0;
  /** Declarations whose terminating `;` has not been seen, innermost last:
   * each ends at a `;` at the depth it was declared at. */
  const open: { name: string; depth: number }[] = [];
  let lastSignificant = ';';

  const skipString = (quote: string): void => {
    i++;
    while (i < n && js[i] !== quote) {
      if (js[i] === '\\') i++;
      if (js[i] === '\n') break;
      i++;
    }
    i++;
  };
  const skipTemplate = (): void => {
    i++; // opening backtick
    while (i < n && js[i] !== '`') {
      if (js[i] === '\\') { i += 2; continue; }
      if (js[i] === '$' && js[i + 1] === '{') {
        i += 2;
        let d = 1;
        while (i < n && d > 0) {
          const c = js[i];
          if (c === '`') { skipTemplate(); continue; }
          if (c === '"' || c === "'") { skipString(c); continue; }
          if (c === '{') d++;
          else if (c === '}') d--;
          i++;
        }
        continue;
      }
      i++;
    }
    i++;
  };
  const skipRegex = (): void => {
    i++;
    let inClass = false;
    while (i < n && js[i] !== '\n') {
      const c = js[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      i++;
    }
    i++;
    while (i < n && isIdentChar(js[i])) i++; // flags
  };
  const prevIsForParen = (at: number): boolean => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(js[k])) k--;
    if (js[k] !== '(') return false;
    k--;
    while (k >= 0 && /\s/.test(js[k])) k--;
    return js.slice(Math.max(0, k - 2), k + 1) === 'for' && (k - 3 < 0 || !isIdentChar(js[k - 3]));
  };
  const top = (): { name: string; depth: number } | undefined => open[open.length - 1];

  while (i < n) {
    const c = js[i];
    if (c === '/' && js[i + 1] === '/') { while (i < n && js[i] !== '\n') i++; continue; }
    if (c === '/' && js[i + 1] === '*') { i = js.indexOf('*/', i + 2); i = i < 0 ? n : i + 2; continue; }
    if (c === '"' || c === "'") { skipString(c); lastSignificant = c; continue; }
    if (c === '`') { skipTemplate(); lastSignificant = '`'; continue; }
    if (c === '/' && REGEX_BEFORE.has(lastSignificant)) { skipRegex(); lastSignificant = '/'; continue; }
    if (/\s/.test(c)) { i++; continue; }

    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      // A closing bracket below a declaration's depth: that statement never ended (no injection).
      while (top() && top()!.depth > depth) open.pop();
    } else if (c === ',' && top() && top()!.depth === depth) {
      open.pop(); // several declarators: no single name to register
    } else if (c === ';' && top() && top()!.depth === depth) {
      const { name } = open.pop()!;
      out.push(js.slice(last, i + 1), ` ${hook}(${JSON.stringify(name)}, ${name});`);
      last = i + 1;
    }

    if (isIdentStart(c) && !(i > 0 && isIdentChar(js[i - 1]))) {
      let j = i;
      while (j < n && isIdentChar(js[j])) j++;
      const word = js.slice(i, j);
      if ((word === 'const' || word === 'let' || word === 'var') && !prevIsForParen(i)) {
        let k = j;
        while (k < n && /\s/.test(js[k])) k++;
        if (k < n && isIdentStart(js[k])) {
          let e = k;
          while (e < n && isIdentChar(js[e])) e++;
          const name = js.slice(k, e);
          let f = e;
          while (f < n && /\s/.test(js[f])) f++;
          if (js[f] === '=' && js[f + 1] !== '=' && js[f + 1] !== '>') {
            open.push({ name, depth });
            i = f + 1;
            lastSignificant = '=';
            continue;
          }
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
