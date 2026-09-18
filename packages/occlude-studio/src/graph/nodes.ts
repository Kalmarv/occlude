/**
 * The node bodies: what a node looks like on the canvas.
 *
 * Rete knows nothing about a node but its id and its sockets; this file
 * builds the DOM inside the element Rete positions. One shape per node
 * kind — a built-in draws its word's inputs in call order, a code node
 * holds the studio's Monaco editor, a viewer draws its own picture, the
 * output node takes the return. Panel background, one-line title in the
 * sans font spelled the way the reference spells the word, sockets as
 * small labelled dots coloured by class.
 *
 * The body never holds the graph: it reads the document it is handed and
 * calls back for every edit, so the document stays the one truth.
 */

import * as monaco from 'monaco-editor';
import { scanUiControls, type UiControl } from 'occlude';

import { createEditor, type Editor } from '../editor.js';
import { sliderSpec } from '../uiPanel.js';
import { iconButton } from '../icons.js';
import { el } from '../widgets.js';
import { isRaw, usedImports, usedTypes } from './compile.js';
import { wordInputs, type Catalogue, type CatalogueInput, type CatalogueWord, type GraphNode, type Takes } from './model.js';

/** How a value type reads in TypeScript: what a code node's declared input
 * is checked as. `Geometry` has no one type, so it is `unknown`. */
const TS_TYPE: Record<string, { type: string; module?: 'occlude' | 'occlude/3d'; name?: string }> = {
  shape: { type: 'ShapeValue', module: 'occlude', name: 'ShapeValue' },
  material: { type: 'Material', module: 'occlude', name: 'Material' },
  points: { type: 'PointSelection', module: 'occlude', name: 'PointSelection' },
  faces: { type: 'Faces', module: 'occlude', name: 'Faces' },
  drawing: { type: 'Tree', module: 'occlude', name: 'Tree' },
  mesh: { type: 'Mesh', module: 'occlude/3d', name: 'Mesh' },
  curves: { type: 'SurfaceCurves', module: 'occlude/3d', name: 'SurfaceCurves' },
  Number: { type: 'number' },
  Vector: { type: 'Vec', module: 'occlude', name: 'Vec' },
  Field: { type: 'FieldFn', module: 'occlude', name: 'FieldFn' },
  Fill: { type: 'FillSpec', module: 'occlude', name: 'FillSpec' },
  Camera: { type: 'Camera3', module: 'occlude', name: 'Camera3' },
  // Geometry with no kind is "the graph does not know": `any`, not
  // `unknown`, because a squiggle the graph invented on a body that runs is
  // worse than no check. A node whose type the artist declares is checked.
  Geometry: { type: 'any' },
};

/** How tall a code node's editor may grow before it scrolls. */
const CODE_MAX_H = 460;

const SOCKET_CLASS_LABEL: Record<string, string> = {
  Geometry: 'geometry',
  Number: 'number',
  Vector: 'vector',
  Field: 'field',
  Fill: 'fill',
  Camera: 'camera',
};

/** The socket a value type travels on, and the geometry kinds it names. */
export function takesOf(type: string): Takes {
  const geometry = TS_TYPE[type]?.module === 'occlude/3d' || ['shape', 'material', 'points', 'faces', 'drawing'].includes(type);
  return geometry
    ? { socket: 'Geometry', kinds: [type as NonNullable<Takes['kinds']>[number]] }
    : { socket: type as Takes['socket'] };
}

/** How a socket reads in a chip: its kinds, or its class. */
export function takesLabel(takes: Takes): string {
  if (takes.socket === 'Geometry') return takes.kinds?.join(' | ') ?? 'geometry';
  return SOCKET_CLASS_LABEL[takes.socket] ?? takes.socket;
}

export interface NodePaintHooks {
  /** The catalogue entry of a built-in node. */
  word(node: GraphNode): CatalogueWord | undefined;
  /** The input keys a wire feeds. */
  wired(node: GraphNode): Set<string>;
  /** The colour of a socket class. */
  socketColor(socketClass: string): string;
  /** Write a literal into the graph. */
  setValue(node: GraphNode, key: string, value: unknown): void;
  /** Forget a control the artist emptied, so the library's default applies. */
  unset(node: GraphNode, key: string): void;
  /** The code node's body changed. */
  setBody(node: GraphNode, body: string): void;
  /** What a viewer can make of its input (`ViewerShow`). */
  viewerShow(node: GraphNode): ViewerShow;
  /** How many kept states the viewer's material has, 0 when unknown. */
  frames(node: GraphNode): number;
  /** The canvas zoom, so a drag in screen pixels becomes area units. */
  zoom(): number;
  /** Remember a node's size in the document. */
  setSize(node: GraphNode, width: number, height: number): void;
  /** Fit this viewer's picture to its canvas again. */
  fitViewer(node: GraphNode): void;
  /** Show this viewer's picture at full size. */
  showViewer(node: GraphNode): void;
  remove(node: GraphNode): void;
  select(node: GraphNode): void;
}

/**
 * What a viewer does with the value on its socket.
 *
 * - `number` — not geometry at all: show the number, and what a run made of
 *   it (how many, the range, the mean) when it is a whole column of them.
 * - `ink` — a shape or a drawing: draw it as it stands.
 * - `strokes` — a material, points, faces, a mesh: not ink until something
 *   interprets it, so the viewer's own sketch wraps it in `strokes(...)`.
 *   The graph's ink is unchanged; only this picture is.
 * - `try` — geometry whose kind the graph does not know. Wrap it, and if
 *   that will not render, draw it bare. Best effort, which is the rule the
 *   rest of the engine follows.
 */
export type ViewerShow = 'number' | 'ink' | 'strokes' | 'try';

export interface NodePaint {
  /** The viewer's canvas, when the node has one. */
  canvas?: HTMLCanvasElement;
  /** Where a viewer on a number writes what it read. */
  value?: HTMLElement;
  /** The code node's editor, when the node has one. */
  editor?: Editor;
  /** Where a code node's first type error reads: a squiggle alone is thin. */
  note?: HTMLElement;
  dispose(): void;
}

/**
 * An element that handles its own input keeps it: pressing a picture to look
 * at it, or typing in the code, must not drag the node, and a wheel over the
 * body must not zoom the canvas behind it.
 */
function noDrag(element: HTMLElement): void {
  element.addEventListener('pointerdown', (event) => event.stopPropagation());
  element.addEventListener('wheel', (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });
}

/**
 * A node body owns every input that lands inside it: the canvas pans and
 * zooms only where it is empty. What a body legitimately needs the canvas for
 * it takes from its own chrome — the title row — so the rule is one
 * boundary, registered once per painted body, and a new node kind cannot
 * forget it.
 *
 * `pointermove` and `pointerup` are deliberately not swallowed: the area
 * tracks a connection being drawn through its own container listeners, and a
 * wire dragged across a node would freeze if the node stopped the move.
 */
function ownInputs(host: HTMLElement): void {
  host.addEventListener('wheel', (event) => {
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });
  for (const type of ['dblclick', 'pointerdown', 'contextmenu'] as const) {
    host.addEventListener(type, (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.graph-node-head')) return;
      event.stopPropagation();
    });
  }
}

/** A row of a node body. `data-row` names the input it edits, so a wire
 * can step its literal box aside without rebuilding the body. */
function nodeRow(className = 'graph-row graph-row-in'): HTMLElement {
  return el('div', className);
}

function socketDot(side: 'input' | 'output', key: string, socketClass: string, hooks: NodePaintHooks): HTMLElement {
  const dot = el('span', `graph-sock graph-sock-${side}`);
  dot.dataset.socket = `${side}:${key}`;
  dot.style.setProperty('--graph-sock', hooks.socketColor(socketClass));
  dot.title = `${key}: ${SOCKET_CLASS_LABEL[socketClass] ?? socketClass}`;
  return dot;
}

function nodeTitle(node: GraphNode): string {
  if (node.kind === 'builtin') return node.word ?? 'built-in';
  if (node.kind === 'code') return 'code';
  if (node.kind === 'viewer') return 'viewer';
  return 'output';
}

/**
 * A number the artist drags.
 *
 * A spinner's arrows are two pixels wide and change a value by one, which is
 * the wrong gesture for a drawing: the value wanted is almost always "a bit
 * more". So the field scrubs — press it and drag sideways — and a press that
 * does not move is a request to type, which is what the caret is for.
 *
 * The step is read from the value the drag started at, so a drag does not
 * change pace as it crosses ten or a hundred. `Ctrl` is ten times coarser,
 * `Shift` ten times finer, the way Blender's fields read.
 */
const HOLD = 3;

function stepFor(value: number): number {
  const size = Math.abs(value);
  if (size >= 100) return 1;
  if (size >= 10) return 0.5;
  if (size >= 1) return 0.1;
  return 0.01;
}

/** As many decimals as the step has, so a drag never writes 50.30000000004. */
function roundTo(value: number, step: number): number {
  const places = Math.max(0, Math.ceil(-Math.log10(step)) + 1);
  return Number(value.toFixed(places));
}

interface NumberFieldOptions {
  /** An empty field is a value the node does not carry (an unset option). */
  allowEmpty?: boolean;
  /** Whole numbers only (a frame, a count the library counts in). */
  integer?: boolean;
  min?: number;
  placeholder?: string;
}

function numberField(
  value: number | undefined,
  title: string,
  commit: (next: number | undefined) => void,
  options: NumberFieldOptions = {},
): HTMLInputElement {
  const box = document.createElement('input');
  box.type = 'text';
  box.inputMode = 'decimal';
  box.className = 'graph-lit graph-scrub';
  box.value = value === undefined ? '' : String(value);
  box.placeholder = options.placeholder ?? '0';
  box.title = `${title} — drag to scrub, Ctrl coarser, Shift finer; click to type`;
  noDrag(box);

  const clamp = (n: number): number => {
    const whole = options.integer ? Math.round(n) : n;
    return options.min !== undefined ? Math.max(options.min, whole) : whole;
  };
  const read = (): number => {
    const n = Number(box.value.trim());
    return Number.isFinite(n) ? n : 0;
  };
  const write = (n: number): void => {
    box.value = String(n);
    commit(n);
  };

  let drag: { x: number; from: number; step: number; moved: boolean } | null = null;
  box.addEventListener('pointerdown', (event) => {
    if (box.disabled || document.activeElement === box) return; // typing: the caret is the artist's
    // No focus, so no caret and no text selection while the value scrubs.
    event.preventDefault();
    const from = read();
    drag = { x: event.clientX, from, step: options.integer ? 1 : stepFor(from), moved: false };
    box.setPointerCapture(event.pointerId);
    box.classList.add('scrubbing');
  });
  box.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const travel = event.clientX - drag.x;
    if (!drag.moved && Math.abs(travel) < HOLD) return;
    drag.moved = true;
    const step = drag.step * (event.ctrlKey || event.metaKey ? 10 : event.shiftKey ? 0.1 : 1);
    write(clamp(roundTo(drag.from + travel * step, step)));
  });
  const release = (event: PointerEvent): void => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    box.classList.remove('scrubbing');
    if (box.hasPointerCapture(event.pointerId)) box.releasePointerCapture(event.pointerId);
    // A press that did not move is a request to type.
    if (!moved) {
      box.focus();
      box.select();
    }
  };
  box.addEventListener('pointerup', release);
  box.addEventListener('pointercancel', release);

  const typed = (): void => {
    const text = box.value.trim();
    if (text === '' && options.allowEmpty) {
      commit(undefined);
      return;
    }
    const n = Number(text);
    write(clamp(Number.isFinite(n) ? n : 0));
  };
  box.addEventListener('change', typed);
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      typed();
      box.blur();
    }
    if (event.key === 'Escape') {
      box.value = value === undefined ? '' : String(value);
      box.blur();
    }
  });
  return box;
}

/** A value JSON cannot spell (`mm(0.3)`, `pen({ width: mm(0.3) })`): the
 * box edits its own source text, and what the artist types stays raw — the
 * compiler is the only thing that can tell whether it still parses. */
function rawBox(node: GraphNode, key: string, text: string, hooks: NodePaintHooks): HTMLInputElement {
  const box = document.createElement('input');
  box.type = 'text';
  box.className = 'graph-text graph-raw';
  box.value = text;
  box.title = `${key}: source text, written into the sketch as it stands`;
  noDrag(box);
  box.oninput = () => hooks.setValue(node, key, { __raw: box.value });
  return box;
}

/** The literal an unwired Number input carries: the one way to give a
 * number to a socket with nothing wired into it. */
function literalBox(node: GraphNode, key: string, hooks: NodePaintHooks): HTMLInputElement {
  const value = node.inputs[key]?.value;
  if (isRaw(value)) return rawBox(node, key, value.__raw, hooks);
  const start = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined;
  return numberField(start, `${key}, while nothing is wired into it`, (next) => hooks.setValue(node, key, next ?? 0));
}

/** A control: a literal the node edits, which nothing may wire into. */
function controlBox(node: GraphNode, input: CatalogueInput, hooks: NodePaintHooks): HTMLElement {
  const key = input.name;
  const value = node.inputs[key]?.value;
  if (isRaw(value)) return rawBox(node, key, value.__raw, hooks);
  const kind = input.control ?? 'text';
  if (kind === 'check') {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'graph-check';
    box.checked = value === true;
    box.title = `${key}: ${input.optional ? 'optional' : 'required'}`;
    noDrag(box);
    box.onchange = () => hooks.setValue(node, key, box.checked);
    return box;
  }
  if (kind === 'menu') {
    const select = document.createElement('select');
    select.className = 'graph-menu';
    const choices = input.choices ?? [];
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '—';
    select.append(empty);
    for (const choice of choices) {
      const option = document.createElement('option');
      option.value = choice;
      option.textContent = choice;
      select.append(option);
    }
    select.value = typeof value === 'string' ? value : '';
    select.title = `${key}: one of ${choices.join(', ')}`;
    noDrag(select);
    select.onchange = () => (select.value === '' ? hooks.unset(node, key) : hooks.setValue(node, key, select.value));
    return select;
  }
  if (kind === 'number') {
    const start = typeof value === 'number' ? value : undefined;
    return numberField(start, `${key}, a number the node carries`, (next) => {
      if (next === undefined) hooks.unset(node, key);
      else hooks.setValue(node, key, next);
    }, { allowEmpty: true, placeholder: '—' });
  }
  const box = document.createElement('input');
  box.type = 'text';
  box.className = 'graph-text';
  box.value = value === undefined || value === null ? '' : String(value);
  box.placeholder = '—';
  box.title = `${key}: text the node carries. Empty leaves it out of the call.`;
  noDrag(box);
  box.oninput = () => {
    const text = box.value;
    if (text.trim() === '') {
      hooks.unset(node, key);
      return;
    }
    hooks.setValue(node, key, text);
  };
  return box;
}

/** One input's row: a socket on the edge, the name, and whatever edits it. */
function inputRow(node: GraphNode, input: CatalogueInput, hooks: NodePaintHooks): HTMLElement {
  const line = nodeRow();
  line.dataset.row = input.name;
  if (input.takes) {
    line.append(socketDot('input', input.name, input.takes.socket, hooks));
    line.append(el('span', 'graph-row-name', input.name));
    line.append(el('span', 'graph-row-type', takesLabel(input.takes)));
    if (input.takes.socket === 'Number') line.append(literalBox(node, input.name, hooks));
  } else {
    line.append(el('span', 'graph-row-name', input.name));
    line.append(controlBox(node, input, hooks));
  }
  return line;
}

/**
 * A built-in node's rows, in the order the word's call takes them. An
 * options record is the node's tweakable surface — one socket per option,
 * all of it present — folded away behind its own name, because a shape's
 * whole option list open on every node turns a graph into a wall of rows.
 * A record with anything wired into it opens by itself: a hidden socket
 * cannot be measured, and a hidden wire would be a lie.
 */
function builtinRows(host: HTMLElement, node: GraphNode, hooks: NodePaintHooks): void {
  const word = hooks.word(node);
  if (!word) {
    host.append(el('div', 'graph-row graph-note', `unknown word ${node.word ?? ''}`));
    return;
  }
  const inputs = wordInputs(word);
  // The receiver comes first and is not one of `params`: `Material.planarize`
  // takes its material on a socket, and without the row that socket has no
  // element, so the wire into it could not be measured and was never drawn.
  // That is what made an imported chain look like a row of loose nodes.
  const self = inputs.find((input) => input.self);
  if (self) host.append(inputRow(node, self, hooks));
  for (const param of word.params) {
    if (!param.options) {
      const input = inputs.find((i) => i.param === param.name && i.option === undefined);
      if (input) host.append(inputRow(node, input, hooks));
      continue;
    }
    const options = inputs.filter((i) => i.param === param.name);
    const details = document.createElement('details');
    details.className = 'graph-opts';
    const set = options.filter((option) => node.inputs[option.name] !== undefined).length;
    const wired = options.some((option) => node.inputs[option.name]?.from);
    if (wired) details.open = true;
    const summary = document.createElement('summary');
    noDrag(summary);
    summary.title = `${param.name}: ${options.length} option${options.length === 1 ? '' : 's'} this node carries`;
    summary.append(el('span', 'graph-row-name', param.name), el('span', 'graph-opts-count', `${set}/${options.length}`));
    details.append(summary);
    for (const option of options) details.append(inputRow(node, option, hooks));
    host.append(details);
  }
  const out = nodeRow('graph-row graph-row-out');
  out.dataset.row = 'out';
  out.append(el('span', 'graph-row-type', word.returns));
  out.append(el('span', 'graph-row-name', 'out'));
  out.append(socketDot('output', 'out', takesOf(word.returns).socket, hooks));
  host.append(out);
}

/** A code node: declared inputs, the body, declared outputs. */
function codeRows(host: HTMLElement, node: GraphNode, hooks: NodePaintHooks): { editor: Editor; note: HTMLElement } {
  for (const [key, input] of Object.entries(node.inputs)) {
    const type = input.type ?? 'drawing';
    const line = nodeRow();
    line.dataset.row = key;
    line.append(socketDot('input', key, takesOf(type).socket, hooks));
    line.append(el('span', 'graph-row-name', key));
    line.append(el('span', 'graph-row-type', takesLabel(takesOf(type))));
    if (type === 'Number') line.append(literalBox(node, key, hooks));
    host.append(line);
  }
  const code = el('div', 'graph-code');
  host.append(code);
  noDrag(code);
  const editor = createEditor(code, node.body ?? '', { uri: `file:///graph-${node.id}.ts`, inline: true });
  // A body the artist cannot read is a body they cannot edit: the editor is
  // as tall as its text, up to the point where scrolling is the honest
  // answer.
  const size = (): void => {
    code.style.height = `${Math.min(CODE_MAX_H, Math.max(48, editor.contentHeight() + 4))}px`;
  };
  size();
  requestAnimationFrame(size);
  editor.onChange(() => {
    size();
    hooks.setBody(node, editor.getValue());
    syncUi();
  });
  const note = el('div', 'graph-code-note');
  host.append(note);
  const ui = el('div', 'graph-ui');
  ui.hidden = true;
  host.append(ui);
  // The ui() literals in the body, as controls. The literal IS the value:
  // dragging one edits the body through Monaco, exactly as the studio's
  // panel does, and the compiler, the diagnostics and the render follow from
  // the edit as they follow any other.
  interface UiRow { control: UiControl; root: HTMLElement; slider?: HTMLInputElement; num?: HTMLInputElement; box?: HTMLInputElement }
  let rows: UiRow[] = [];
  let signature = '';
  let selfEdit = false;

  const write = (row: UiRow, value: number | boolean): void => {
    const control = row.control;
    const text = String(value);
    const model = editor.model;
    const start = model.getPositionAt(control.valueStart);
    const end = model.getPositionAt(control.valueEnd);
    selfEdit = true;
    try {
      editor.editor.executeEdits('graph-ui', [{
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
        text,
      }]);
    } finally {
      selfEdit = false;
    }
    const delta = text.length - (control.valueEnd - control.valueStart);
    control.valueEnd += delta;
    control.value = value;
    for (const other of rows) {
      if (other.control.valueStart > control.valueStart) {
        other.control.valueStart += delta;
        other.control.valueEnd += delta;
      }
    }
  };

  const syncUi = (): void => {
    if (selfEdit) return; // our own literal edit: offsets were shifted by hand
    // A shaper's knots are a curve, not a slider: they stay in the body.
    const controls = scanUiControls(editor.getValue()).filter((c) => c.kind !== 'points');
    ui.hidden = controls.length === 0;
    const next = controls
      .map((c) => `${c.label}|${c.kind}|${c.opts.min}|${c.opts.max}|${c.opts.step}`)
      .join(';');
    if (next === signature) {
      controls.forEach((c, k) => {
        const row = rows[k];
        if (!row) return;
        row.control = c;
        const shown = String(c.value);
        if (row.box) row.box.checked = c.value === true;
        if (row.slider && document.activeElement !== row.slider) row.slider.value = shown;
        if (row.num && document.activeElement !== row.num) row.num.value = shown;
      });
      return;
    }
    signature = next;
    rows = [];
    ui.replaceChildren();
    for (const control of controls) {
      const row = el('div', 'graph-ui-row');
      const entry: UiRow = { control, root: row };
      row.append(el('span', 'graph-ui-name', control.label));
      if (control.kind === 'boolean') {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = control.value === true;
        box.title = `${control.label}: ${control.value ? 'true' : 'false'} in the body`;
        noDrag(box);
        box.onchange = () => write(entry, box.checked);
        row.append(box);
        entry.box = box;
      } else {
        const value = Number(control.value);
        const spec = sliderSpec(value, control.opts);
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(spec.min);
        slider.max = String(spec.max);
        slider.step = String(spec.step);
        slider.value = String(value);
        slider.title = `${control.label}: ${spec.min} … ${spec.max}, step ${spec.step}`;
        const num = document.createElement('input');
        num.type = 'number';
        num.className = 'graph-ui-num';
        num.step = String(spec.step);
        num.value = String(value);
        noDrag(slider);
        noDrag(num);
        // One undo stop per drag, not one per pixel of thumb travel.
        slider.onpointerdown = () => editor.editor.pushUndoStop();
        slider.oninput = () => {
          num.value = slider.value;
          write(entry, Number(slider.value));
        };
        slider.onpointerup = () => editor.editor.pushUndoStop();
        num.onchange = () => {
          const typed = Number(num.value);
          if (!Number.isFinite(typed)) return;
          slider.value = num.value;
          write(entry, typed);
        };
        row.append(slider, num);
        entry.slider = slider;
        entry.num = num;
      }
      ui.append(row);
      rows.push(entry);
    }
  };
  syncUi();

  for (const [key, type] of Object.entries(node.outputs ?? {})) {
    const line = nodeRow('graph-row graph-row-out');
    line.dataset.row = key;
    line.append(el('span', 'graph-row-type', takesLabel(takesOf(type))));
    line.append(el('span', 'graph-row-name', key));
    line.append(socketDot('output', key, takesOf(type).socket, hooks));
    host.append(line);
  }
  return { editor, note };
}

/** A viewer: the input, its own picture, and the word `strokes` when the
 * picture needs it. */
function viewerRows(host: HTMLElement, node: GraphNode, hooks: NodePaintHooks): { canvas?: HTMLCanvasElement; value?: HTMLElement } {
  const show = hooks.viewerShow(node);
  const line = nodeRow();
  line.dataset.row = 'in';
  line.append(socketDot('input', 'in', 'Geometry', hooks));
  line.append(el('span', 'graph-row-name', 'in'));
  host.append(line);
  if (show === 'number') {
    // Not a picture: a number, and what the run made of it.
    const value = el('div', 'graph-value', '—');
    value.title = 'What this point of the graph held, read back from the run';
    noDrag(value);
    host.append(value);
    return { value };
  }
  if (show === 'strokes' || show === 'try') {
    // A material carries its kept states: pick one to look at. Empty shows
    // the material itself, which is what a material with no history has.
    const frame = el('div', 'graph-row graph-row-in');
    frame.dataset.row = 'frame';
    frame.append(el('span', 'graph-row-name', 'frame'));
    const chosen = node.inputs['in']?.value;
    const value = typeof chosen === 'number' && chosen >= 0 ? Math.round(chosen) : -1;
    const count = hooks.frames(node);
    // Never `unset`: the frame lives beside the wire on `in`, and removing
    // the input would remove the picture. An empty field is -1, the material
    // itself.
    const write = (next: number): void => hooks.setValue(node, 'in', next);
    const box = numberField(
      value >= 0 ? value : undefined,
      count > 0 ? `the kept state to show, 0 to ${count - 1}; empty shows the material itself` : 'the kept state to show; empty shows the material itself',
      (next) => write(next ?? -1),
      { allowEmpty: true, integer: true, min: 0, placeholder: '—' },
    );
    if (count > 0) {
      const range = document.createElement('input');
      range.type = 'range';
      range.className = 'graph-frame';
      range.min = '0';
      range.max = String(count - 1);
      range.step = '1';
      range.value = String(Math.max(0, value));
      range.title = `Kept state ${Math.max(0, value)} of ${count}`;
      noDrag(range);
      range.oninput = () => {
        box.value = range.value;
        write(Number(range.value));
      };
      frame.append(range, box);
    } else {
      frame.append(box);
    }
    host.append(frame);
  }
  // The picture's own two controls sit in the title row, where every node
  // keeps its chrome: fit it to the canvas again, and open it big enough to
  // look at.
  const head = host.querySelector<HTMLElement>('.graph-node-head');
  if (head) {
    const fit = iconButton('frame', 'Fit the picture', () => hooks.fitViewer(node));
    const open = iconButton('view', 'Open this picture at full size', () => hooks.showViewer(node));
    noDrag(fit);
    noDrag(open);
    head.querySelector('.graph-node-id')?.after(fit, open);
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'graph-viewer';
  noDrag(canvas);
  host.append(canvas);
  if (show === 'strokes' || show === 'try') {
    const tag = el('div', 'graph-viewer-tag', show === 'try' ? 'strokes?' : 'strokes');
    tag.title = show === 'try'
      ? 'The graph does not know what this value is. The picture wraps it in strokes(...) and draws it bare if that will not render. The graph itself is unchanged.'
      : 'This picture wraps its input in strokes(...): a material is not ink. The graph itself is unchanged.';
    host.append(tag);
  }
  return { canvas };
}

/** An output node: what the sketch returns. */
function outputRows(host: HTMLElement, node: GraphNode, hooks: NodePaintHooks): void {
  const line = nodeRow();
  line.dataset.row = 'in';
  line.append(socketDot('input', 'in', 'Geometry', hooks));
  line.append(el('span', 'graph-row-name', 'in'));
  line.append(el('span', 'graph-row-type', 'shape | drawing'));
  host.append(line);
}

/** Build (or rebuild) one node's body. */
export function paintNode(host: HTMLElement, node: GraphNode, hooks: NodePaintHooks): NodePaint {
  const cleanups: (() => void)[] = [];
  const paint: NodePaint = { dispose: () => { for (const off of cleanups) off(); } };
  host.className = 'graph-node-body';
  host.dataset.node = node.id;
  host.dataset.kind = node.kind;
  host.replaceChildren();
  ownInputs(host);

  const head = el('div', 'graph-node-head');
  head.append(el('span', 'graph-node-title', nodeTitle(node)));
  head.append(el('span', 'graph-node-id', node.id));
  const del = iconButton('close', 'Remove this node', () => hooks.remove(node));
  noDrag(del);
  head.append(del);
  host.append(head);

  if (node.kind === 'builtin') builtinRows(host, node, hooks);
  else if (node.kind === 'code') {
    const code = codeRows(host, node, hooks);
    paint.editor = code.editor;
    paint.note = code.note;
    cleanups.push(() => code.editor.dispose());
  } else if (node.kind === 'viewer') {
    const shown = viewerRows(host, node, hooks);
    paint.canvas = shown.canvas;
    paint.value = shown.value;
  }
  else outputRows(host, node, hooks);

  // A remembered size is the node's own; without one it sizes to its
  // content, as every node did before.
  if (node.width !== undefined) host.style.width = `${node.width}px`;
  if (node.height !== undefined) host.style.height = `${node.height}px`;

  // Only a node with room inside it is sized by hand: a built-in and the
  // output node are exactly their rows, and a handle on them would sit on
  // the output socket and take its presses.
  if (node.kind !== 'code' && node.kind !== 'viewer') {
    markWired(host, hooks.wired(node));
    return paint;
  }

  const corner = el('div', 'graph-size');
  corner.title = 'Drag to size this node';
  noDrag(corner);
  let grab: { x: number; y: number; w: number; h: number } | null = null;
  corner.onpointerdown = (event: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    const zoom = hooks.zoom();
    grab = { x: event.clientX, y: event.clientY, w: rect.width / zoom, h: rect.height / zoom };
    corner.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };
  corner.onpointermove = (event: PointerEvent) => {
    if (!grab) return;
    const zoom = hooks.zoom();
    const width = Math.max(140, Math.round(grab.w + (event.clientX - grab.x) / zoom));
    const height = Math.max(52, Math.round(grab.h + (event.clientY - grab.y) / zoom));
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
  };
  corner.onpointerup = () => {
    if (!grab) return;
    grab = null;
    const rect = host.getBoundingClientRect();
    const zoom = hooks.zoom();
    hooks.setSize(node, Math.round(rect.width / zoom), Math.round(rect.height / zoom));
  };
  host.append(corner);

  markWired(host, hooks.wired(node));
  return paint;
}

/** A wire now feeds a row: its literal box steps aside. Called after a
 * connection changes, without rebuilding the body (an editor would flash). */
export function markWired(host: HTMLElement, wired: Set<string>): void {
  for (const line of host.querySelectorAll<HTMLElement>('[data-row]')) {
    const on = wired.has(line.dataset.row ?? '');
    line.classList.toggle('graph-row-wired', on);
    for (const box of line.querySelectorAll<HTMLInputElement>('input.graph-lit, input.graph-text')) box.disabled = on;
    // A wired socket must be visible: the record it lives in opens.
    if (on) {
      const record = line.closest<HTMLDetailsElement>('details.graph-opts');
      if (record) record.open = true;
    }
  }
}

/**
 * Typecheck a code node's body without lying to the artist about it. The
 * visible model holds the raw body, and a bare `return` is not valid at
 * module top level; a second model holds the body inside the function the
 * compiler wraps it in, with the real library types, and the markers its
 * diagnostics produce are shown on the visible model. The prologue is
 * whole lines, so no column moves and the shift is exact.
 *
 * Monaco validates every open model by default, which would mark the raw
 * body as broken code; the page turns that off and lets this bridge be the
 * one voice.
 */
export function bridgeDiagnostics(
  editor: Editor,
  node: GraphNode,
  catalogue: Catalogue,
  onError: (message: string | null) => void,
): () => void {
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });

  const body = (): string => editor.getValue();
  const typeNames: { module: 'occlude' | 'occlude/3d'; name: string }[] = [];
  const params: string[] = [];
  for (const [key, input] of Object.entries(node.inputs)) {
    const mapped = TS_TYPE[input.type ?? 'drawing'];
    if (mapped?.name && mapped.module && !typeNames.some((n) => n.name === mapped.name)) typeNames.push({ module: mapped.module, name: mapped.name });
    params.push(`${key}: ${mapped?.type ?? 'unknown'}`);
  }
  const typesOf = (module: 'occlude' | 'occlude/3d'): string[] =>
    typeNames.filter((n) => n.module === module).map((n) => n.name).sort();

  /** The prologue the body is checked inside: the same wrapper the compiler
   * emits, with the real library types, and the very names the compiler
   * imports for this body — a red marker that is wrong is worse than no
   * marker. Its length is the line shift back to the visible model. */
  const prologue = (text: string): string[] => {
    const used = usedImports(text, catalogue);
    const specs = (module: 'occlude' | 'occlude/3d'): string[] =>
      [...new Set(used.filter((u) => u.module === module).map((u) => u.spec))].sort();
    // The types the node's own inputs carry, and the ones the body names for
    // itself (`as Vec3`): the compiled sketch imports both, and a prologue
    // that imports less marks a body red for a name the sketch will have.
    const named = new Map<'occlude' | 'occlude/3d', Set<string>>();
    for (const module of ['occlude', 'occlude/3d'] as const) named.set(module, new Set(typesOf(module)));
    for (const { module, name } of usedTypes(text, catalogue)) {
      if (module === 'occlude' || module === 'occlude/3d') named.get(module)!.add(name);
    }
    const all = (module: 'occlude' | 'occlude/3d'): string[] => [...named.get(module)!].sort();
    const lines = [`import type { ${['Toolkit', ...all('occlude')].join(', ')} } from 'occlude';`];
    if (all('occlude/3d').length > 0) lines.push(`import type { ${all('occlude/3d').join(', ')} } from 'occlude/3d';`);
    lines.push(`import { ${['sketch', ...specs('occlude')].join(', ')} } from 'occlude';`);
    if (specs('occlude/3d').length > 0) lines.push(`import { ${specs('occlude/3d').join(', ')} } from 'occlude/3d';`);
    lines.push(`export default (t: Toolkit${params.length > 0 ? `, ${params.join(', ')}` : ''}) => {`);
    return lines;
  };

  const check = monaco.editor.createModel('', 'typescript', monaco.Uri.parse(`file:///graph-check-${node.id}.ts`));
  let timer: number | null = null;
  let generation = 0;
  const update = async (): Promise<void> => {
    const mine = ++generation;
    const text = body();
    const lines = prologue(text);
    const head = lines.length;
    check.setValue(`${lines.join('\n')}\n${text}\n};\n`);
    const lastBodyLine = head + text.split('\n').length;
    try {
      const worker = await monaco.languages.typescript.getTypeScriptWorker();
      const client = await worker(check.uri);
      const [syntactic, semantic] = await Promise.all([
        client.getSyntacticDiagnostics(check.uri.toString()),
        client.getSemanticDiagnostics(check.uri.toString()),
      ]);
      if (mine !== generation) return;
      const markers: monaco.editor.IMarkerData[] = [];
      let first: string | null = null;
      for (const diagnostic of [...syntactic, ...semantic]) {
        if (diagnostic.start === undefined) continue;
        const at = check.getPositionAt(diagnostic.start);
        const end = check.getPositionAt(diagnostic.start + (diagnostic.length ?? 0));
        if (at.lineNumber <= head || at.lineNumber > lastBodyLine) continue;
        const message = typeof diagnostic.messageText === 'string' ? diagnostic.messageText : diagnostic.messageText.messageText;
        markers.push({
          severity: diagnostic.category === 1 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          message,
          startLineNumber: at.lineNumber - head,
          startColumn: at.column,
          endLineNumber: end.lineNumber - head,
          endColumn: end.column,
        });
        if (first === null && diagnostic.category === 1) first = `line ${at.lineNumber - head}: ${message}`;
      }
      monaco.editor.setModelMarkers(editor.model, 'graph', markers);
      onError(first);
    } catch {
      // The TypeScript worker is not up yet: the next change tries again.
    }
  };
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = window.setTimeout(() => { timer = null; void update(); }, 350);
  };
  const subscription = editor.model.onDidChangeContent(schedule);
  schedule();
  return () => {
    generation += 1;
    if (timer !== null) clearTimeout(timer);
    subscription.dispose();
    monaco.editor.setModelMarkers(editor.model, 'graph', []);
    check.dispose();
  };
}
