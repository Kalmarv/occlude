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

import { createEditor, type Editor } from '../editor.js';
import { iconButton } from '../icons.js';
import { el } from '../widgets.js';
import { isRaw, usedImports } from './compile.js';
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
  Geometry: { type: 'unknown' },
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
  /** What one input takes, when it is a socket rather than a control. */
  takes(node: GraphNode, key: string): Takes | undefined;
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
  /** A viewer wraps a material, points or faces in `strokes(...)` for its
   * own picture — the graph's ink does not change. */
  viewerWrap(node: GraphNode): boolean;
  remove(node: GraphNode): void;
  select(node: GraphNode): void;
}

export interface NodePaint {
  /** The viewer's canvas, when the node has one. */
  canvas?: HTMLCanvasElement;
  /** The code node's editor, when the node has one. */
  editor?: Editor;
  /** Where a code node's first type error reads: a squiggle alone is thin. */
  note?: HTMLElement;
  dispose(): void;
}

/** The canvas chrome in a node: what a body may not do is drag the node. */
function noDrag(element: HTMLElement): void {
  element.addEventListener('pointerdown', (event) => event.stopPropagation());
  element.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
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
  const box = document.createElement('input');
  box.type = 'number';
  box.className = 'graph-lit';
  box.step = 'any';
  box.value = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  box.placeholder = '0';
  box.title = `A literal for ${key}, used while nothing is wired into it`;
  noDrag(box);
  box.oninput = () => {
    const text = box.value.trim();
    const n = Number(text);
    hooks.setValue(node, key, text === '' || !Number.isFinite(n) ? 0 : n);
  };
  return box;
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
  const box = document.createElement('input');
  box.type = kind === 'number' ? 'number' : 'text';
  box.className = kind === 'number' ? 'graph-lit' : 'graph-text';
  if (kind === 'number') box.step = 'any';
  box.value = value === undefined || value === null ? '' : String(value);
  box.placeholder = '—';
  box.title = `${key}: ${kind === 'number' ? 'a number' : 'text'} the node carries. Empty leaves it out of the call.`;
  noDrag(box);
  box.oninput = () => {
    const text = box.value;
    if (text.trim() === '') {
      hooks.unset(node, key);
      return;
    }
    hooks.setValue(node, key, kind === 'number' ? Number(text) : text);
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
    const summary = el('summary', 'graph-opts-head');
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
  });
  const note = el('div', 'graph-code-note');
  host.append(note);
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
function viewerRows(host: HTMLElement, node: GraphNode, hooks: NodePaintHooks): HTMLCanvasElement {
  const line = nodeRow();
  line.dataset.row = 'in';
  line.append(socketDot('input', 'in', 'Geometry', hooks));
  line.append(el('span', 'graph-row-name', 'in'));
  host.append(line);
  const canvas = document.createElement('canvas');
  canvas.className = 'graph-viewer';
  host.append(canvas);
  if (hooks.viewerWrap(node)) {
    const tag = el('div', 'graph-viewer-tag', 'strokes');
    tag.title = 'This picture wraps its input in strokes(...): a material is not ink. The graph itself is unchanged.';
    host.append(tag);
  }
  return canvas;
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
  } else if (node.kind === 'viewer') paint.canvas = viewerRows(host, node, hooks);
  else outputRows(host, node, hooks);

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
    const lines = [`import type { ${['Toolkit', ...typesOf('occlude')].join(', ')} } from 'occlude';`];
    if (typesOf('occlude/3d').length > 0) lines.push(`import type { ${typesOf('occlude/3d').join(', ')} } from 'occlude/3d';`);
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
