/**
 * Fuck it up: every number literal in a sketch becomes a random draw around
 * itself, `t.rnd(lo, hi)` with lo and hi a fraction either side of the
 * literal. What a number was is still there, as the centre of its range;
 * what it is on any given seed is now the seed's business. Whole numbers
 * stay whole (`Math.round`). Left alone: the import lines, the sketch's
 * own options object (aspect, margin, seed), anything inside a `ui(…)`
 * call (its literal is a control), zeros (no range to speak of), and
 * numbers in strings and comments. Pure text in, text out; undo is the
 * editor's.
 */
import { numberAt } from './scrub.js';

/** The toolkit's name in the sketch callback, or what to call rnd through. */
export function rndCallee(source: string): string {
  const m = /sketch\s*\([\s\S]*?,\s*(?:async\s*)?\(\s*([^)]*)\)\s*=>/.exec(source);
  if (!m) return 't.rnd';
  const param = m[1].trim();
  if (param.startsWith('{')) return /\brnd\b/.test(param) ? 'rnd' : 't.rnd';
  const name = param.split(/[\s,=]/)[0];
  return name ? `${name}.rnd` : 't.rnd';
}

/** Offset range of the first argument of the sketch(...) call, if an object literal. */
function optionsSpan(source: string): [number, number] | null {
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

/** Is `col` on this line inside a `ui(...)` call's parentheses? */
function insideUi(line: string, col: number): boolean {
  const re = /\bui\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const open = m.index + m[0].length - 1;
    if (open >= col) break;
    let d = 0;
    for (let k = open; k < line.length; k++) {
      if (line[k] === '(') d++;
      else if (line[k] === ')') { d--; if (d === 0) { if (col < k) return true; break; } }
      if (k === line.length - 1 && d > 0) return col > open; // unclosed on this line
    }
  }
  return false;
}

export function fuckItUp(source: string, strength = 0.3): string {
  const s = Math.max(0, strength);
  const callee = rndCallee(source);
  const opts = optionsSpan(source);
  const lines = source.split('\n');
  let offset = 0;
  const out = lines.map((line) => {
    const lineStart = offset;
    offset += line.length + 1;
    if (/^\s*import\b/.test(line)) return line;
    // Numbers, right to left so earlier spans stay valid.
    const spans: { start: number; end: number; text: string }[] = [];
    const re = /\d*\.?\d+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const n = numberAt(line, m.index);
      if (!n || n.startCol !== m.index && n.startCol !== m.index - 1) continue;
      if (spans.length && n.startCol < spans[spans.length - 1].end) continue;
      spans.push({ start: n.startCol, end: n.endCol, text: n.text });
    }
    let result = line;
    for (const span of spans.reverse()) {
      const abs = lineStart + span.start;
      if (opts && abs >= opts[0] && abs < opts[1]) continue;
      if (insideUi(line, span.start)) continue;
      const v = Number(span.text);
      if (!Number.isFinite(v) || v === 0) continue;
      const lo = v - Math.abs(v) * s;
      const hi = v + Math.abs(v) * s;
      const whole = !span.text.includes('.');
      const fmt = (x: number) => String(+x.toPrecision(6));
      const draw = `${callee}(${fmt(lo)}, ${fmt(hi)})`;
      result = result.slice(0, span.start) + (whole ? `Math.round(${draw})` : draw) + result.slice(span.end);
    }
    return result;
  });
  return out.join('\n');
}
