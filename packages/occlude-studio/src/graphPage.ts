/**
 * The Graph page: a canvas of nodes that compiles to an ordinary sketch.
 *
 * The graph document is the one truth. Rete draws and wires; every edit
 * writes the document first, then the page compiles the whole graph and
 * renders it through the studio's own render worker — the same path the
 * studio page and the docs examples take. A viewer node renders the
 * sub-graph it reads, through the same client, and wraps a material,
 * points or faces in `strokes(...)` for its own picture only.
 *
 * Nothing here is a second engine: the compiled source is the sketch, the
 * preview is the studio's Preview, the store is the graph store beside the
 * sketches, and "Open as sketch" hands the source to the studio.
 */

import './style.css';
import { liveExampleToJs, type PaperDef, type PenDef, type RenderResult } from 'occlude';
import { ClassicPreset, type Root } from 'rete';

import './wa.js';
import { iconButton, withIcon } from './icons.js';
import { confirmDialog, notify, promptDialog } from './wa.js';
import { Preview } from './preview.js';
import { RenderClient } from './workerClient.js';
import type { RunConfig } from './runner.js';
import { loadPapers, loadPens, loadSettings, sheetOf } from './store.js';
import { mountShell } from './shell.js';
import { button, el } from './widgets.js';
import { CATALOGUE } from './graph/catalogue.js';
import { createCanvas, type AreaExtra, type GraphCanvas, type GraphScheme, type GraphWire, type ReteNode } from './graph/canvas.js';
import { bridgeDiagnostics, markWired, paintNode, takesLabel, takesOf, type NodePaint, type NodePaintHooks } from './graph/nodes.js';
import { compileFor, compileGraph, type CompiledSketch } from './graph/compile.js';
import { importSketch } from './graph/import.js';
import { loadSketchByName } from './sketchApi.js';
import {
  accepts, graphToJson, inputTakes, kindOf, outputType, parseGraph, wordInputs, wordOf,
  type Catalogue, type CatalogueWord, type Graph, type GraphNode, type ValueType,
} from './graph/model.js';
import { deleteGraph, graphHref, listGraphs, loadGraphText, saveGraphText } from './graph/store.js';

mountShell('graph');

/**
 * What the page compiles with: the generated catalogue, plus the libraries
 * the studio already loaded. A sketch's body names pens and papers as plain
 * identifiers, and the compiler imports whatever module the catalogue names
 * for them — so an imported sketch that used `azure` compiles to an
 * `import { azure } from '@user/pens'`, which the render worker resolves.
 */
let catalogue: Catalogue = CATALOGUE;

/** One colour per socket class, from the studio's tokens. */
const SOCKET_COLORS: Record<string, string> = {
  Geometry: 'var(--accent)',
  Number: 'var(--toolpath)',
  Vector: 'var(--warn)',
  Field: 'var(--ink)',
  Fill: 'var(--muted)',
  Camera: 'var(--faint)',
};

/** What a viewer's own picture wraps: a material is not ink. */
const WRAPPED_KINDS: readonly string[] = ['material', 'points', 'faces'];

/** The sketch a New graph starts from: a shape, a code node that makes a
 * material of it, a viewer on that material, strokes, and the return. */
function template(): Graph {
  return {
    version: 1,
    name: 'untitled',
    config: { aspect: [1, 1], seed: 8 },
    nodes: [
      { id: 'n1', kind: 'builtin', word: 'circle', x: 40, y: 60, inputs: { x: { value: 60 }, y: { value: 60 }, r: { value: 26 } } },
      {
        id: 'n2', kind: 'code', x: 320, y: 60,
        inputs: { shape: { type: 'shape', from: ['n1', 'out'] } },
        outputs: { grown: 'material' },
        body: 'return { grown: t.material(shape) };',
      },
      { id: 'n3', kind: 'viewer', x: 320, y: 340, inputs: { in: { from: ['n2', 'grown'] } } },
      { id: 'n4', kind: 'builtin', word: 'strokes', x: 640, y: 60, inputs: { source: { from: ['n2', 'grown'] } } },
      { id: 'n5', kind: 'output', x: 920, y: 60, inputs: { in: { from: ['n4', 'out'] } } },
    ],
  };
}

const main = document.getElementById('graph-main')!;
main.classList.add('graph-page');

// ---- the page's own chrome (the html file holds only #graph-main) ----

const head = el('div', 'page-head');
const heading = el('div');
heading.append(el('h1', undefined, 'Graph'), el('div', 'sub', 'Nodes that compile to a sketch'));
const actions = el('div', 'page-actions');
const nameInput = document.createElement('input');
nameInput.className = 'graph-name';
nameInput.placeholder = 'untitled';
nameInput.spellcheck = false;
nameInput.title = 'The graph’s name, as the store keeps it';
const openSelect = document.createElement('select');
openSelect.className = 'graph-open';
openSelect.title = 'Open a saved graph';
const refreshBtn = iconButton('refresh', 'Reload the graph list', () => void refreshList());
const newBtn = iconButton('new', 'New graph — the small template', () => void newGraph());
const saveBtn = iconButton('save', 'Save (Ctrl+S)', () => void save());
const deleteBtn = iconButton('trash', 'Delete this graph', () => void remove());
const sketchBtn = withIcon(button('Open as sketch', () => openAsSketch()), 'export');
sketchBtn.classList.add('graph-sketch');
sketchBtn.title = 'Write the compiled source into the studio and open it there';
const importBtn = withIcon(button('Import', () => void importFrom()), 'import');
importBtn.title = 'Read a sketch from the library into a graph';
actions.append(nameInput, openSelect, refreshBtn, newBtn, importBtn, saveBtn, deleteBtn, sketchBtn);
head.append(heading, actions);

const body = el('div', 'graph-body');
const canvasHost = el('div', 'graph-canvas');
const rail = el('div', 'graph-rail');

const palette = el('section', 'graph-panel graph-palette');
const paletteHead = el('div', 'graph-panel-head');
paletteHead.append(el('span', 'graph-panel-title', 'Words'), el('span', 'graph-palette-count', ''));
const paletteSearch = document.createElement('input');
paletteSearch.className = 'graph-search';
paletteSearch.placeholder = 'search the catalogue';
paletteSearch.spellcheck = false;
const paletteList = el('div', 'graph-palette-list');
palette.append(paletteHead, paletteSearch, paletteList);

const paperPanel = el('section', 'graph-panel graph-paper-panel');
const paperHead = el('div', 'graph-panel-head');
const seedInput = document.createElement('input');
seedInput.type = 'number';
seedInput.className = 'graph-seed';
seedInput.title = 'The seed the compiled sketch runs with';
const fitBtn = iconButton('frame', 'Fit the sheet', () => preview.fit());
fitBtn.classList.add('graph-fit');
paperHead.append(el('span', 'graph-panel-title', 'Preview'), el('label', 'graph-seed-label', 'seed', seedInput), fitBtn);
const paperBox = el('div', 'graph-paper');
const paperCanvas = document.createElement('canvas');
paperBox.append(paperCanvas);
const statusLine = el('div', 'graph-status', 'ready');
const statsLine = el('div', 'graph-stats');
paperPanel.append(paperHead, paperBox, statusLine, statsLine);

rail.append(palette, paperPanel);
body.append(canvasHost, rail);
main.append(head, body);

// ---- state ----

let graph: Graph = template();
let pens: PenDef[] = [];
let papers: PaperDef[] = [];
let settings = loadSettings();
let dirty = false;
let loading = true;
let selected: string | null = null;
let generation = 0;
let pending: number | null = null;
/** The sheet the main preview is fitted to: a new one re-fits, an ordinary
 * re-render keeps the artist's view. */
let fitted: string | null = null;
/** The compiled source the main preview last rendered: byte-identical means
 * nothing to do. */
let mainSource: string | null = null;

interface NodeView {
  paint: NodePaint;
  body: HTMLElement;
  off?: () => void;
  preview?: Preview;
}

const views = new Map<string, NodeView>();
/** A viewer's last picture, keyed by its compiled sub-graph: a change
 * upstream of nothing must not re-render it. */
const viewerResults = new Map<string, { hash: string; result: RenderResult }>();
/** How many kept states each viewer's material has, from its own render. */
const viewerFrames = new Map<string, number>();

const client = new RenderClient();
const preview = new Preview(paperCanvas);
preview.setPaperColor(settings.paperColor);

const nodeById = (id: string): GraphNode | undefined => graph.nodes.find((n) => n.id === id);
const wiredOf = (node: GraphNode): Set<string> =>
  new Set(Object.entries(node.inputs).filter(([, input]) => input.from).map(([key]) => key));

function status(text: string, kind: 'ok' | 'err' = 'ok'): void {
  statusLine.textContent = text;
  statusLine.className = `graph-status graph-status-${kind}`;
}

// ---- the canvas ----

const canvas: GraphCanvas = createCanvas(canvasHost, {
  paint,
  position: (id) => {
    const node = nodeById(id);
    return node ? { x: node.x, y: node.y } : null;
  },
  pick: (id) => select(id),
  allowWire: (from, to) => {
    const forward = from.side === 'output' && to.side === 'input';
    const backward = from.side === 'input' && to.side === 'output';
    if (!forward && !backward) {
      refuse(`${socketName(from)} → ${socketName(to)}: a wire runs from an output to an input`);
      return false;
    }
    const source = forward ? from : to;
    const target = forward ? to : from;
    const out = typeOfOutput(source.nodeId, String(source.key));
    const targetNode = nodeById(target.nodeId);
    const takes = targetNode ? inputTakes(targetNode, catalogue)[String(target.key)] : undefined;
    if (!out || !targetNode) {
      refuse(`${socketName(source)} → ${socketName(target)}: that socket takes no wire`);
      return false;
    }
    // A viewer shows anything, whatever the socket class says.
    if (targetNode.kind === 'viewer') return true;
    if (!takes || !accepts(out, takes)) {
      refuse(`${socketName(source)} is ${out} · ${socketName(target)} takes ${takes ? takesLabel(takes) : 'nothing'}`);
      return false;
    }
    return true;
  },
});

function socketName(socket: { nodeId: string; key: string | number }): string {
  return `${socket.nodeId}.${String(socket.key)}`;
}

function refuse(reason: string): void {
  notify(reason, 'warning');
  canvas.connection.drop();
}

function typeOfOutput(id: string, key: string): ValueType | undefined {
  const node = nodeById(id);
  return node ? outputType(node, key, catalogue) : undefined;
}

/** A viewer shows a material, points or faces as ink: its own sketch wraps
 * them in `strokes(...)`. The graph's return does not. */
function viewerWrap(node: GraphNode): boolean {
  const input = node.inputs['in'];
  if (!input?.from) return false;
  const type = typeOfOutput(input.from[0], input.from[1]);
  const kind = type ? kindOf(type) : undefined;
  return kind !== undefined && WRAPPED_KINDS.includes(kind);
}

/** The history frame a viewer shows: `inputs.frame`, -1 for the material
 * itself. It belongs to the document, so it survives a save and a reopen. */
function viewerFrame(node: GraphNode): number {
  // It rides on the viewer's own `in` input: the compiler refuses an input
  // key a node's word does not have, and the document keeps `value`
  // alongside `from`, so the frame survives a save without a second key.
  const value = node.inputs['in']?.value;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : -1;
}

/** The body Rete is positioning: the page paints it, from the document. */
function paint(id: string, host: HTMLElement): void {
  const node = nodeById(id);
  if (!node) return;
  const previous = views.get(id);
  if (previous) {
    previous.paint.dispose();
    previous.off?.();
    previous.preview?.dispose();
  }
  const paint = paintNode(host, node, paintHooks);
  const view: NodeView = { paint, body: host };
  if (node.kind === 'code' && paint.editor) {
    view.off = bridgeDiagnostics(paint.editor, node, catalogue, (message) => {
      setBad(id, message !== null);
      if (view.paint.note) {
        view.paint.note.textContent = message ?? '';
        view.paint.note.classList.toggle('on', message !== null);
      }
    });
  }
  if (paint.canvas) {
    const viewer = new Preview(paint.canvas);
    viewer.setPaperColor(settings.paperColor);
    view.preview = viewer;
    const cached = viewerResults.get(id);
    if (cached) {
      viewer.setResult(cached.result);
      viewer.fit();
    }
  }
  views.set(id, view);
}

const paintHooks: NodePaintHooks = {
  word: (node) => (node.word ? wordOf(catalogue, node.word) : undefined),
  wired: wiredOf,
  socketColor: (socketClass) => SOCKET_COLORS[socketClass] ?? 'var(--muted)',
  setValue: (node, key, value) => {
    node.inputs[key] = { ...node.inputs[key], value };
    touch();
  },
  unset: (node, key) => {
    delete node.inputs[key];
    touch();
  },
  setBody: (node, text) => {
    node.body = text;
    touch();
  },
  viewerWrap,
  frames: (node) => viewerFrames.get(node.id) ?? 0,
  remove: (node) => void removeNode(node.id),
  select: (node) => select(node.id),
};

// ---- the document and the canvas, kept in step ----

const wireId = (wire: { source: string; sourceOutput: string; target: string; targetInput: string }): string =>
  `${wire.source}:${wire.sourceOutput}->${wire.target}:${wire.targetInput}`;

/** The Rete node for a document node: its sockets are exactly the ones its
 * body draws, and nothing else. */
function reteNode(node: GraphNode): ReteNode {
  const rete = new ClassicPreset.Node(node.id);
  // The constructor's argument is the label; the id is ours (a graph node's
  // id is the `const` name in the compiled sketch).
  rete.id = node.id;
  rete.label = node.id;
  const port = (socketClass: string): ClassicPreset.Socket => new ClassicPreset.Socket(socketClass);
  if (node.kind === 'builtin') {
    const word = node.word ? wordOf(catalogue, node.word) : undefined;
    for (const input of word ? wordInputs(word) : []) {
      if (input.takes) rete.addInput(input.name, new ClassicPreset.Input(port(input.takes.socket), input.name));
    }
    if (word) rete.addOutput('out', new ClassicPreset.Output(port(takesOf(word.returns).socket), 'out'));
  } else if (node.kind === 'code') {
    for (const [key, input] of Object.entries(node.inputs)) {
      rete.addInput(key, new ClassicPreset.Input(port(takesOf(input.type ?? 'drawing').socket), key));
    }
    for (const [key, type] of Object.entries(node.outputs ?? {})) {
      rete.addOutput(key, new ClassicPreset.Output(port(takesOf(type).socket), key));
    }
  } else {
    rete.addInput('in', new ClassicPreset.Input(port('Geometry'), 'in'));
  }
  return rete;
}

canvas.editor.addPipe((context: Root<GraphScheme>) => {
  if (context.type === 'connectioncreated') applyWire(context.data);
  if (context.type === 'connectionremoved') clearWire(context.data);
  return context;
});

canvas.area.addPipe((context: AreaExtra | Root<GraphScheme>) => {
  if (context.type === 'nodedragged') {
    const node = nodeById(context.data.id);
    const view = canvas.area.nodeViews.get(context.data.id);
    if (node && view) {
      node.x = Math.round(view.position.x);
      node.y = Math.round(view.position.y);
      dirty = true;
    }
  }
  return context;
});

function applyWire(wire: GraphWire): void {
  // While the canvas is being rebuilt the document is already the truth:
  // and the teardown of the graph being replaced must never touch the new
  // one, whose node ids are likely the same names.
  if (loading) return;
  const target = nodeById(wire.target);
  if (!target) return;
  const key = String(wire.targetInput);
  target.inputs[key] = { ...target.inputs[key], from: [wire.source, String(wire.sourceOutput)] };
  syncWired(target);
  if (target.kind === 'viewer') canvas.refresh(target.id);
  touch();
}

function clearWire(wire: GraphWire): void {
  if (loading) return;
  const target = nodeById(wire.target);
  if (!target) return;
  const input = target.inputs[String(wire.targetInput)];
  if (input) delete input.from;
  syncWired(target);
  if (target.kind === 'viewer') canvas.refresh(target.id);
  touch();
}

function syncWired(node: GraphNode): void {
  const host = views.get(node.id)?.body;
  if (host) markWired(host, wiredOf(node));
}

/** Rebuild the canvas from the document. */
async function buildCanvas(): Promise<void> {
  loading = true;
  for (const wire of canvas.editor.getConnections()) await canvas.editor.removeConnection(wire.id);
  for (const node of canvas.editor.getNodes()) await canvas.editor.removeNode(node.id);
  for (const view of views.values()) {
    // The paint's disposer releases the editor; the bridge's releases its
    // second model — a model whose uri is the node id, which the next graph
    // reuses. Leaving it alive makes the next paint throw inside a
    // fire-and-forget signal: the node lands without sockets and at the
    // origin.
    view.paint.dispose();
    view.off?.();
  }
  views.clear();
  for (const node of graph.nodes) await canvas.editor.addNode(reteNode(node));
  for (const node of graph.nodes) {
    for (const [key, input] of Object.entries(node.inputs)) {
      if (!input.from) continue;
      const [source, output] = input.from;
      if (!nodeById(source)) continue;
      await canvas.editor.addConnection({
        id: wireId({ source, sourceOutput: output, target: node.id, targetInput: key }),
        source,
        sourceOutput: output,
        target: node.id,
        targetInput: key,
      });
    }
  }
  loading = false;
  // A graph's own positions can sit anywhere; bring them into view, once.
  canvas.fit();
}

function freshId(): string {
  for (let i = 1; ; i++) if (!nodeById(`n${i}`)) return `n${i}`;
}

function select(id: string): void {
  if (selected === id) return;
  for (const other of [selected, id]) {
    const element = other ? canvas.area.nodeViews.get(other)?.element : undefined;
    element?.classList.toggle('graph-sel', other === id);
  }
  selected = id;
}

async function place(node: GraphNode): Promise<void> {
  const at = canvas.centre();
  node.x = Math.round(at.x - 104);
  node.y = Math.round(at.y - 40);
  graph.nodes.push(node);
  await canvas.editor.addNode(reteNode(node));
  select(node.id);
  touch();
}

/** A word from the palette: its required numbers start at zero, so the node
 * is a node and not a hole. */
function addBuiltin(word: CatalogueWord): void {
  const node: GraphNode = { id: freshId(), kind: 'builtin', word: word.word, x: 0, y: 0, inputs: {} };
  for (const input of wordInputs(word)) {
    // A required number starts at zero so the node is a node and not a hole;
    // every option stays unset, so the library's own default applies.
    if (input.takes && !input.optional && input.takes.socket === 'Number') node.inputs[input.name] = { value: 0 };
  }
  void place(node);
}

function addNode(kind: 'code' | 'viewer' | 'output'): void {
  const id = freshId();
  const node: GraphNode = kind === 'code'
    ? { id, kind, x: 0, y: 0, inputs: {}, outputs: { out: 'Number' }, body: 'return { out: 1 };' }
    : { id, kind, x: 0, y: 0, inputs: {} };
  void place(node);
}

async function removeNode(id: string): Promise<void> {
  const node = nodeById(id);
  if (!node) return;
  for (const wire of canvas.editor.getConnections().filter((c) => c.source === id || c.target === id)) {
    await canvas.editor.removeConnection(wire.id);
  }
  await canvas.editor.removeNode(id);
  const view = views.get(id);
  view?.paint.dispose();
  view?.off?.();
  view?.preview?.dispose();
  views.delete(id);
  viewerResults.delete(id);
  if (selected === id) selected = null;
  graph.nodes = graph.nodes.filter((n) => n.id !== id);
  for (const other of graph.nodes) {
    for (const input of Object.values(other.inputs)) if (input.from?.[0] === id) delete input.from;
    syncWired(other);
  }
  touch();
}

// ---- compile and render ----

function compileNow(): CompiledSketch | null {
  markErrors(null);
  try {
    return compileGraph(graph, catalogue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status(message, 'err');
    markErrors(message);
    return null;
  }
}

/** The node a compile message is about, when it names one. */
function culprit(message: string): string | null {
  for (const pattern of [/\bnode ([A-Za-z_$][\w$]*)/, /graph: ([A-Za-z_$][\w$]*)[.\s]/]) {
    const found = pattern.exec(message);
    if (found) return found[1];
  }
  return null;
}

/** The node a runtime error came from: the worker's stack names a line of the
 * JavaScript it ran, so the nearest `const <id> =` above it is the node that
 * threw. The same reading the studio's own runtime marker does. */
function nodeFromStack(stack: string | undefined, js: string, ids: Set<string>): string | null {
  const at = stack ? /<anonymous>:(\d+):\d+/.exec(stack) : null;
  if (!at) return null;
  const lines = js.split('\n');
  for (let i = Math.min(Number(at[1]), lines.length) - 1; i >= 0; i--) {
    const found = /^\s*const ([A-Za-z_$][\w$]*) = /.exec(lines[i]);
    if (found && ids.has(found[1])) return found[1];
  }
  return null;
}

/** A node whose own body or picture failed: the code node a diagnostic
 * landed on, the viewer whose render failed. */
function setBad(id: string, bad: boolean): void {
  canvas.area.nodeViews.get(id)?.element.classList.toggle('graph-bad', bad);
}

function markErrors(message: string | null): void {
  for (const id of canvas.area.nodeViews.keys()) canvas.area.nodeViews.get(id)?.element.classList.remove('graph-node-err');
  if (!message) return;
  const id = culprit(message);
  if (id) canvas.area.nodeViews.get(id)?.element.classList.add('graph-node-err');
}

function runConfig(): RunConfig {
  const seed = graph.config.seed;
  return {
    pens,
    papers,
    paper: sheetOf(settings, papers),
    landscape: settings.landscape,
    defaultMarginPct: settings.defaultMarginPct,
    coarsen: 1,
    seed: typeof seed === 'number' || typeof seed === 'string' ? seed : null,
    draws: true,
  };
}

function schedule(): void {
  if (pending !== null) clearTimeout(pending);
  pending = window.setTimeout(() => {
    pending = null;
    void renderAll();
  }, 200);
}

function touch(): void {
  dirty = true;
  schedule();
}

async function renderAll(): Promise<void> {
  const mine = ++generation;
  const compiled = compileNow();
  if (!compiled) {
    preview.setStale(true);
    // The viewers hold pictures of a graph that no longer compiles: they are
    // as stale as the preview, and must look it.
    for (const view of views.values()) view.preview?.setStale(true);
    return;
  }
  // The graph's own source decides the main preview: a change that does not
  // reach it (a node moved, a viewer relit) costs no render.
  if (compiled.source !== mainSource) {
    await renderMain(compiled, mine);
    if (mine !== generation) return;
  }
  for (const node of graph.nodes.filter((n) => n.kind === 'viewer')) {
    if (mine !== generation) return;
    await renderViewer(node, mine);
  }
}

async function renderMain(compiled: CompiledSketch, mine: number): Promise<void> {
  status('rendering…');
  try {
    const reply = await client.render({ js: liveExampleToJs(compiled.source), cfg: runConfig() }, () => mine === generation);
    if (!reply || mine !== generation) return;
    mainSource = compiled.source;
    preview.setPaperColor(reply.result.paper.color ?? settings.paperColor);
    preview.setResult(reply.result);
    // Fit the first sheet, and any change of sheet: the artist's own pan and
    // zoom must survive an ordinary re-render.
    const sheet = `${reply.result.paper.w}x${reply.result.paper.h}`;
    if (fitted !== sheet) {
      fitted = sheet;
      preview.fit();
    }
    preview.setStale(false);
    status(`${reply.result.stats.fragments} fragments · ${reply.result.stats.renderMs.toFixed(0)} ms`);
    statsLine.textContent = `${compiled.nodes.filter((n) => n.kind !== 'viewer').length} nodes · seed ${reply.seedUsed}`;
  } catch (error) {
    if (mine !== generation) return;
    const message = error instanceof Error ? error.message : String(error);
    status(message, 'err');
    const ids = new Set(compiled.nodes.filter((n) => n.kind === 'code').map((n) => n.id));
    markErrors(culprit(message) ?? nodeFromStack(error instanceof Error ? error.stack : undefined, liveExampleToJs(compiled.source), ids) ?? message);
    preview.setStale(true);
  }
}

async function renderViewer(node: GraphNode, mine: number): Promise<void> {
  const view = views.get(node.id);
  if (!node.inputs['in']?.from) {
    viewerResults.delete(node.id);
    view?.preview?.setStale(true);
    setBad(node.id, false);
    return;
  }
  const wrap = viewerWrap(node);
  const frame = viewerFrame(node);
  let compiled: CompiledSketch;
  try {
    // A viewer shows a material, points or faces as ink: the wrapper is the
    // compiler's, so the import and the return are right by construction. A
    // chosen frame shows that kept state instead — the ternary keeps a
    // material with no history from throwing, which is the library's own
    // best-effort rule.
    // The frame count is not in the document — the material is only in the
    // worker — so the sketch probes it and the reply carries it back.
    compiled = compileFor(graph, catalogue, node.id, 'in', {
      wrap: wrap
        ? (expression: string) => `strokes(${frame >= 0 ? `(${expression}).history.length > ${frame} ? (${expression}).history[${frame}].material : ${expression}` : expression})`
        : undefined,
      prelude: wrap ? (expression: string) => [`t.probe('frames', ${expression}.history.length);`] : undefined,
    });
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), 'err');
    return;
  }
  // The frame is part of the picture: the same nodes at another frame are
  // another render.
  const hash = `${compiled.nodes.map((n) => n.hash).join('|')}${wrap ? '|strokes' : ''}|f${frame}`;
  const cached = viewerResults.get(node.id);
  if (cached?.hash === hash) {
    view?.preview?.setStale(false);
    setBad(node.id, false);
    return;
  }
  try {
    const reply = await client.render({ js: liveExampleToJs(compiled.source), cfg: runConfig() }, () => mine === generation);
    if (!reply || mine !== generation) return;
    viewerResults.set(node.id, { hash, result: reply.result });
    setBad(node.id, false);
    // A material's kept states, from the probe: the scrubber's extent. The
    // node is repainted only when that number changes, and the repaint takes
    // the picture it already has.
    const frames = Math.max(0, Math.round(reply.probes.frames?.max ?? 0));
    if (frames !== (viewerFrames.get(node.id) ?? -1)) {
      viewerFrames.set(node.id, frames);
      canvas.refresh(node.id);
    }
    const live = views.get(node.id)?.preview;
    if (live) {
      live.setPaperColor(reply.result.paper.color ?? settings.paperColor);
      live.setResult(reply.result);
      live.fit();
    }
  } catch (error) {
    if (mine !== generation) return;
    // The node is marked and the status names it: no toast per viewer.
    status(`${node.id}: ${error instanceof Error ? error.message : String(error)}`, 'err');
    setBad(node.id, true);
    view?.preview?.setStale(true);
  }
}

// ---- the palette ----

function paletteItem(word: string, returns: string, run: () => void, hint: string): HTMLButtonElement {
  const item = el('button', 'graph-palette-item');
  item.title = hint;
  const dot = el('span', 'graph-palette-dot');
  dot.style.setProperty('--graph-sock', SOCKET_COLORS[takesOf(returns).socket] ?? 'var(--muted)');
  item.append(dot, el('span', 'graph-palette-word', word), el('span', 'graph-palette-ret', returns));
  item.onclick = run;
  return item;
}

function buildPalette(): void {
  paletteList.replaceChildren();
  const nodes = el('div', 'graph-palette-group');
  nodes.append(el('div', 'graph-palette-title', 'Nodes'));
  nodes.append(paletteItem('code', 'body', () => addNode('code'), 'A function body with declared inputs and outputs'));
  nodes.append(paletteItem('viewer', 'picture', () => addNode('viewer'), 'Draw what this point of the graph holds'));
  nodes.append(paletteItem('output', 'return', () => addNode('output'), 'What the sketch returns'));
  paletteList.append(nodes);

  const groups = new Map<string, HTMLElement>();
  for (const word of catalogue.words) {
    let group = groups.get(word.group);
    if (!group) {
      group = el('div', 'graph-palette-group');
      group.append(el('div', 'graph-palette-title', word.group));
      groups.set(word.group, group);
      paletteList.append(group);
    }
    group.append(paletteItem(word.word, word.returns, () => addBuiltin(word), `${word.word} → ${word.returns} · ${word.page}`));
  }
  const count = paletteHead.querySelector('.graph-palette-count');
  if (count) count.textContent = `${catalogue.words.length}`;
}

paletteSearch.oninput = () => {
  const query = paletteSearch.value.trim().toLowerCase();
  for (const group of paletteList.querySelectorAll<HTMLElement>('.graph-palette-group')) {
    let shown = 0;
    for (const item of group.querySelectorAll<HTMLElement>('.graph-palette-item')) {
      const word = item.querySelector('.graph-palette-word')?.textContent?.toLowerCase() ?? '';
      const on = query === '' || word.includes(query) || (group.querySelector('.graph-palette-title')?.textContent ?? '').toLowerCase().includes(query);
      item.hidden = !on;
      if (on) shown++;
    }
    group.hidden = shown === 0;
  }
};

// ---- storage ----

async function refreshList(): Promise<void> {
  try {
    const list = await listGraphs();
    const current = openSelect.value;
    openSelect.replaceChildren();
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = list.length > 0 ? 'open…' : 'no saved graphs';
    openSelect.append(blank);
    for (const info of list) {
      const option = document.createElement('option');
      option.value = info.name;
      option.textContent = info.name;
      openSelect.append(option);
    }
    openSelect.value = list.some((info) => info.name === current) ? current : '';
  } catch (error) {
    notify(`graph list: ${error instanceof Error ? error.message : String(error)}`, 'danger');
  }
}

openSelect.onchange = () => {
  const wanted = openSelect.value;
  if (!wanted) return;
  void open(wanted).then((opened) => {
    // A cancelled open leaves the list on the graph that is still open.
    if (!opened) openSelect.value = graph.name && nameInput.value === graph.name ? graph.name : '';
  });
};

async function open(name: string): Promise<boolean> {
  if (dirty && !(await confirmDialog({ title: `Open '${name}'?`, body: 'The open graph has unsaved changes.', confirm: 'Open' }))) return false;
  // The document is about to change: a reply in flight belongs to the graph
  // being left behind, and must not be applied to the new one.
  generation += 1;
  try {
    const text = await loadGraphText(name);
    const next = parseGraph(JSON.parse(text));
    graph = next;
    nameInput.value = next.name;
    mainSource = null;
    fitted = null;
    viewerResults.clear();
    viewerFrames.clear();
    await buildCanvas();
    seedInput.value = typeof next.config.seed === 'number' ? String(next.config.seed) : '';
    history.replaceState(null, '', graphHref(next.name));
    dirty = false;
    select('');
    await renderAll();
    return true;
  } catch (error) {
    notify(`open '${name}': ${error instanceof Error ? error.message : String(error)}`, 'danger');
    return false;
  }
}

async function save(): Promise<void> {
  const name = nameInput.value.trim();
  if (!/^[a-zA-Z0-9 _-]{1,64}$/.test(name)) {
    notify('a graph name is letters, digits, spaces, _ and - (max 64)', 'warning');
    return;
  }
  graph.name = name;
  try {
    await saveGraphText(name, graphToJson(graph));
    history.replaceState(null, '', graphHref(name));
    dirty = false;
    await refreshList();
    notify(`saved '${name}'`, 'success');
  } catch (error) {
    notify(`save: ${error instanceof Error ? error.message : String(error)}`, 'danger');
  }
}

/**
 * Read a sketch into a graph. The sketch is not touched; the graph is the
 * imported document, and from here it behaves like any other — it paints,
 * it renders, it saves under a name, its viewers show its steps.
 */
async function importFrom(): Promise<void> {
  const asked = await promptDialog({
    title: 'Import a sketch',
    body: 'The sketch is read into a graph. The sketch itself is not changed.',
    placeholder: 'sketch name',
    confirm: 'Import',
    validate: (v) => (v.trim() === '' ? 'Name a sketch from the library.' : null),
  });
  if (asked === null) return;
  if (dirty && !(await confirmDialog({ title: 'Import over this graph?', body: 'The open graph has unsaved changes.', confirm: 'Import' }))) return;
  const name = asked.trim();
  let source: string;
  try {
    source = await loadSketchByName(name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status(`import: ${message}`, 'err');
    notify(`import '${name}': ${message}`, 'danger');
    return;
  }
  generation += 1;
  try {
    graph = importSketch(source, catalogue);
  } catch (error) {
    // A sketch that cannot be read is an answer, not a crash: the importer
    // names the statement it stopped at.
    const message = error instanceof Error ? error.message : String(error);
    status(`import '${name}': ${message}`, 'err');
    notify(`import '${name}': ${message}`, 'danger');
    return;
  }
  nameInput.value = '';
  mainSource = null;
  fitted = null;
  viewerResults.clear();
  viewerFrames.clear();
  await buildCanvas();
  history.replaceState(null, '', '/graph.html');
  dirty = true; // the imported graph has no name in the store yet
  select('');
  await renderAll();
  notify(`imported '${name}' as a graph — Save gives it a name`, 'success');
}

async function newGraph(): Promise<void> {
  if (dirty && !(await confirmDialog({ title: 'New graph', body: 'The current graph has unsaved changes. Start from the template?', confirm: 'New graph' }))) return;
  generation += 1;
  graph = template();
  nameInput.value = '';
  seedInput.value = String(graph.config.seed ?? '');
  mainSource = null;
  fitted = null;
  viewerResults.clear();
  await buildCanvas();
  history.replaceState(null, '', '/graph.html');
  dirty = false;
  select('');
  await renderAll();
}

async function remove(): Promise<void> {
  const name = nameInput.value.trim();
  if (!name) return;
  if (!(await confirmDialog({ title: `Delete '${name}'?`, body: 'The graph file is removed from the store. This cannot be undone.', confirm: 'Delete', danger: true }))) return;
  try {
    await deleteGraph(name);
    await refreshList();
    notify(`deleted '${name}'`, 'success');
    generation += 1;
    graph = template();
    nameInput.value = '';
    seedInput.value = String(graph.config.seed ?? '');
    history.replaceState(null, '', '/graph.html');
    mainSource = null;
    fitted = null;
    viewerResults.clear();
    viewerFrames.clear();
    await buildCanvas();
    select('');
    await renderAll();
  } catch (error) {
    notify(`delete: ${error instanceof Error ? error.message : String(error)}`, 'danger');
  }
}

/** Exactly what the docs' live embeds do: the source goes into the studio's
 * buffer and the studio opens on it. */
function openAsSketch(): void {
  let compiled: CompiledSketch;
  try {
    compiled = compileGraph(graph, catalogue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status(message, 'err');
    markErrors(message);
    return;
  }
  localStorage.setItem('occlude.sketch', compiled.source);
  localStorage.setItem('occlude.sketchName', '');
  localStorage.setItem('occlude.openSettings', JSON.stringify({
    paper: settings.paper,
    customPaper: settings.customPaper,
    landscape: settings.landscape,
    defaultMarginPct: settings.defaultMarginPct,
  }));
  location.href = '/';
}

nameInput.oninput = () => { dirty = true; };
seedInput.onchange = () => {
  const n = Number(seedInput.value);
  graph.config.seed = seedInput.value.trim() === '' || !Number.isFinite(n) ? undefined : n;
  touch();
};

document.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest('input, textarea, select, .monaco-editor')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void save();
    return;
  }
  if (event.key === 'Delete' || event.key === 'Backspace') {
    if (!selected) return;
    event.preventDefault();
    void removeNode(selected);
  }
  if (event.key === 'Escape') select('');
});

window.addEventListener('resize', () => {
  for (const view of views.values()) view.preview?.fit();
});

// ---- boot ----

async function boot(): Promise<void> {
  buildPalette();
  pens = await loadPens();
  papers = await loadPapers();
  settings = loadSettings();
  catalogue = {
    ...CATALOGUE,
    importable: [
      ...CATALOGUE.importable,
      { module: '@user/pens', names: pens.map((pen) => ({ name: pen.name, spec: pen.name })) },
      { module: '@user/papers', names: papers.map((paper) => ({ name: paper.name, spec: paper.name })) },
    ],
  };
  preview.setPaperColor(settings.paperColor);
  const wanted = new URLSearchParams(location.search).get('graph');
  if (wanted) {
    const opened = await open(wanted);
    await refreshList();
    // A link that cannot open falls back to the template: the document must
    // never be left half-loaded with the canvas still in build mode.
    if (opened) return;
    history.replaceState(null, '', '/graph.html');
  }
  graph = template();
  seedInput.value = String(graph.config.seed ?? '');
  await buildCanvas();
  await refreshList();
  dirty = false;
  await renderAll();
}

void boot();
