/**
 * Scrubby sliders in the editor: hold Alt and drag any number literal to
 * change it. The literal itself is edited — the code stays the single
 * source of truth, exactly like the ui() panel's sliders — so the normal
 * change→re-run pipeline picks the new value up and a tuned sketch saves
 * and replots as seen.
 *
 * The step comes from the literal's own precision: `0.28` moves by 0.01,
 * `180` by 1. Shift is ×10, Ctrl (or Cmd) is ÷10 and gains a decimal.
 * Monaco types only — the scanning below is pure, and tested as such.
 */

import type { editor as Mon } from 'monaco-editor';

/** Pixels of travel per step. */
const PX_PER_STEP = 4;

/** A number literal inside one line, as 0-based column offsets. */
export interface NumberSpan {
  startCol: number;
  endCol: number;
  text: string;
}

const WORD = /[A-Za-z0-9_$]/;
/** What may sit before a `-` for it to be part of the number, not a subtraction. */
const UNARY_AFTER = new Set(['', '(', '[', '{', ',', ';', '=', '+', '-', '*', '/', '%',
  '<', '>', '?', ':', '&', '|', '!', '^', '~']);
const UNARY_WORD = /\b(return|case|typeof|in|of)$/;

/** Cheap per-line scan: is this offset inside a string, or past a `//`? */
function inStringOrComment(line: string, idx: number): boolean {
  let quote = '';
  for (let i = 0; i < idx; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && line[i + 1] === '/') return true;
  }
  return quote !== '';
}

/**
 * The scrubbable number at `col` (0-based) of `line`, or null. Skips what
 * a drag would corrupt: identifiers (`Ivy2`), property access (`p.0`),
 * hex and exponents (`0x1f`, `1e-9`), strings, and comments.
 */
export function numberAt(line: string, col: number): NumberSpan | null {
  const re = /\d*\.?\d+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    let start = m.index;
    const end = start + m[0].length;
    if (col < start || col > end) continue;
    const before = start > 0 ? line[start - 1] : '';
    const after = end < line.length ? line[end] : '';
    if (WORD.test(before) || before === '.') continue;
    if (WORD.test(after) || after === '.') continue;
    if (inStringOrComment(line, start)) continue;
    if (before === '-') {
      // A unary minus belongs to the literal, so a drag can cross zero.
      const prev = line.slice(0, start - 1).trimEnd();
      const p = prev.length > 0 ? prev[prev.length - 1] : '';
      if (UNARY_AFTER.has(p) || UNARY_WORD.test(prev)) start -= 1;
    }
    return { startCol: start, endCol: end, text: line.slice(start, end) };
  }
  return null;
}

/** Decimal places the literal was written with — the scrub's precision. */
export function decimalsOf(text: string): number {
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/** The new literal, keeping the original's shape (and never `-0`). */
export function formatValue(value: number, decimals: number): string {
  const s = value.toFixed(decimals);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

/** The value after `dx` pixels of drag, formatted for the source. */
export function scrubbed(
  text: string, dx: number, mods: { fine?: boolean; coarse?: boolean } = {},
): string {
  const decimals = decimalsOf(text) + (mods.fine ? 1 : 0);
  const step = 10 ** -decimals * (mods.coarse ? 10 : 1);
  const steps = Math.round(dx / PX_PER_STEP);
  return formatValue(Number(text) + steps * step, decimals);
}

/** Wire Alt-drag scrubbing onto an editor. */
export function attachScrubbing(editor: Mon.IStandaloneCodeEditor): void {
  const dom = editor.getDomNode();
  if (!dom) return;
  let marks: string[] = [];
  let marked = '';

  const readOnly = (): boolean => editor.getRawOptions().readOnly === true;

  const hit = (clientX: number, clientY: number):
  { line: number; span: NumberSpan } | null => {
    const pos = editor.getTargetAtClientPoint(clientX, clientY)?.position;
    const model = editor.getModel();
    if (!pos || !model || pos.lineNumber > model.getLineCount()) return null;
    const span = numberAt(model.getLineContent(pos.lineNumber), pos.column - 1);
    return span ? { line: pos.lineNumber, span } : null;
  };

  const mark = (line: number, startCol: number, endCol: number): void => {
    const key = `${line}:${startCol}:${endCol}`;
    if (key === marked) return;
    marked = key;
    marks = editor.getModel()?.deltaDecorations(marks, [{
      range: {
        startLineNumber: line, startColumn: startCol + 1,
        endLineNumber: line, endColumn: endCol + 1,
      },
      options: { inlineClassName: 'scrub-hot' },
    }]) ?? [];
  };

  const unmark = (): void => {
    if (marked === '') return;
    marked = '';
    marks = editor.getModel()?.deltaDecorations(marks, []) ?? [];
  };

  // Capture phase: Monaco's own Alt-drag (column select) never starts.
  dom.addEventListener('mousedown', (e) => {
    if (!e.altKey || e.button !== 0 || readOnly()) return;
    const target = hit(e.clientX, e.clientY);
    const model = editor.getModel();
    if (!target || !model) return;
    e.preventDefault();
    e.stopPropagation();

    const { line, span } = target;
    const offset = model.getOffsetAt({ lineNumber: line, column: span.startCol + 1 });
    const startX = e.clientX;
    const original = span.text;
    let text = original;
    editor.pushUndoStop();
    document.body.classList.add('scrubbing');
    mark(line, span.startCol, span.endCol);

    const move = (ev: MouseEvent): void => {
      const next = scrubbed(original, ev.clientX - startX, {
        fine: ev.ctrlKey || ev.metaKey,
        coarse: ev.shiftKey,
      });
      if (next === text || !Number.isFinite(Number(next))) return;
      const a = model.getPositionAt(offset);
      const b = model.getPositionAt(offset + text.length);
      editor.executeEdits('scrub', [{
        range: {
          startLineNumber: a.lineNumber, startColumn: a.column,
          endLineNumber: b.lineNumber, endColumn: b.column,
        },
        text: next,
      }]);
      text = next;
      marked = '';
      mark(a.lineNumber, a.column - 1, a.column - 1 + next.length);
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
      document.body.classList.remove('scrubbing');
      editor.pushUndoStop();
      unmark();
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
  }, true);

  // Alt-hover: show what a drag would grab.
  dom.addEventListener('mousemove', (e) => {
    if (document.body.classList.contains('scrubbing')) return;
    if (!e.altKey || readOnly()) return unmark();
    const target = hit(e.clientX, e.clientY);
    if (target) mark(target.line, target.span.startCol, target.span.endCol);
    else unmark();
  });
  dom.addEventListener('mouseleave', unmark);
  window.addEventListener('keyup', (e) => { if (!e.altKey) unmark(); });
  window.addEventListener('blur', unmark);
}
