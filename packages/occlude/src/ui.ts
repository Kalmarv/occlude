/**
 * Tweakable values. `ui(v, opts?)` is an identity function at runtime —
 * headless renders, plotstats, and docs examples see the literal, nothing
 * else. The studio statically scans the SOURCE for `ui(...)` calls and
 * builds a control panel whose sliders edit the literal in the editor —
 * the code stays the single source of truth, so a tuned sketch saves,
 * shares, and replots exactly as seen.
 *
 * The first argument must be a literal number or boolean (the slider
 * rewrites that exact span of text); computed expressions are simply not
 * picked up as controls.
 */

export interface UiOpts {
  min?: number;
  max?: number;
  step?: number;
  /** Panel label; defaults to the assigned variable/property name. */
  label?: string;
}

export function ui(value: number, opts?: UiOpts): number;
export function ui(value: boolean, opts?: UiOpts): boolean;
export function ui(value: number | boolean, _opts?: UiOpts): number | boolean {
  return value;
}

/** One `ui(...)` call found in sketch source. */
export interface UiControl {
  /** Offset span of the value literal — replace exactly this to retune. */
  valueStart: number;
  valueEnd: number;
  value: number | boolean;
  opts: UiOpts;
  /** opts.label, else the assigned name (`const rows = ui(…)`), else ui N. */
  label: string;
  index: number;
}

/**
 * Find every `ui(<literal>, opts?)` call in sketch source. A hand-rolled
 * walk (not a regex over the whole text) so occurrences inside strings,
 * template literals, and comments are ignored, and so the opts object is
 * extracted with real paren/brace balancing.
 */
export function scanUiControls(source: string): UiControl[] {
  const controls: UiControl[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    // Skip comments and string/template contents.
    if (ch === '/' && next === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i = source.indexOf('*/', i + 2);
      if (i < 0) break;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i);
      continue;
    }
    if (ch === 'u' && next === 'i' && !isIdentChar(source[i - 1]) && source[i - 1] !== '.') {
      let j = i + 2;
      while (j < n && source[j] === ' ') j++;
      if (source[j] === '(') {
        const parsed = parseUiCall(source, i, j + 1, controls.length);
        if (parsed) {
          controls.push(parsed.control);
          i = parsed.end;
          continue;
        }
      }
    }
    i++;
  }
  return controls;
}

const isIdentChar = (c: string | undefined): boolean =>
  c !== undefined && /[\w$]/.test(c);

/** Skip a string/template starting at `start` (its opening quote). */
function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === '\\') i += 2;
    else if (c === quote) return i + 1;
    // Template interpolation: balance braces so `${fn({a: 1})}` survives.
    else if (quote === '`' && c === '$' && source[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
          i = skipString(source, i) - 1;
        }
        i++;
      }
    } else i++;
  }
  return i;
}

function parseUiCall(
  source: string,
  uiStart: number,
  argStart: number,
  index: number,
): { control: UiControl; end: number } | null {
  let i = argStart;
  while (source[i] === ' ' || source[i] === '\n') i++;
  const lit = /^(?:-?\d+(?:\.\d+)?|true|false)/.exec(source.slice(i, i + 40));
  if (!lit) return null;
  const valueStart = i;
  const valueEnd = i + lit[0].length;
  const value: number | boolean =
    lit[0] === 'true' ? true : lit[0] === 'false' ? false : Number(lit[0]);
  // A literal must end the argument: `ui(12 * k)` is not a control.
  i = valueEnd;
  while (source[i] === ' ' || source[i] === '\n') i++;
  let opts: UiOpts = {};
  if (source[i] === ',') {
    const optsStart = i + 1;
    const close = matchParen(source, argStart - 1);
    if (close < 0) return null;
    try {
      const parsedOpts = new Function(`return (${source.slice(optsStart, close)});`)() as UiOpts;
      if (parsedOpts && typeof parsedOpts === 'object') opts = parsedOpts;
    } catch {
      return null; // malformed mid-edit — no control this pass
    }
    i = close + 1;
  } else if (source[i] === ')') {
    i++;
  } else {
    return null;
  }
  const label = opts.label ?? inferLabel(source, uiStart) ?? `ui ${index + 1}`;
  return {
    control: { valueStart, valueEnd, value, opts, label, index },
    end: i,
  };
}

/** Offset of the `)` matching the `(` at `open`. */
function matchParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "'" || c === '"' || c === '`') i = skipString(source, i) - 1;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** `const rows = ui(…)` / `{ rows: ui(…) }` → "rows". */
function inferLabel(source: string, uiStart: number): string | null {
  const before = source.slice(Math.max(0, uiStart - 80), uiStart);
  const m = /([A-Za-z_$][\w$]*)\s*[=:]\s*$/.exec(before);
  return m ? m[1] : null;
}
