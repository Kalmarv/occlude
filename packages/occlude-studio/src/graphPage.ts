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
import { moduleName, type PaperDef, type PenDef, type RenderResult } from 'occlude';
import { ClassicPreset, type Root } from 'rete';

import './wa.js';
import { iconButton, withIcon } from './icons.js';
import { confirmDialog, notify, promptDialog, showPanel } from './wa.js';
import { transpileToCjs } from './editor.js';
import { Preview } from './preview.js';
import { RenderClient } from './workerClient.js';
import type { RunConfig } from './runner.js';
import { loadPapers, loadPens, loadSettings, sheetOf } from './store.js';
import { mountShell } from './shell.js';
import { button, el } from './widgets.js';
import { CATALOGUE } from './graph/catalogue.js';
import { createCanvas, type AreaExtra, type GraphCanvas, type GraphScheme, type GraphWire, type ReteNode } from './graph/canvas.js';
import { bridgeDiagnostics, markWired, paintNode, takesLabel, takesOf, type NodePaint, type NodePaintHooks, type ViewerShow } from './graph/nodes.js';
import { compileFor, compileGraph, type CompiledSketch } from './graph/compile.js';
import { estimateBox, layoutGraph, type NodeBox } from './graph/layout.js';
import { importSketch } from './graph/import.js';
import { loadSketchByName, takeLive } from './sketchApi.js';
import {
  accepts, graphToJson, inputTakes, kindOf, listPlaces, outputType, parseGraph, wordInputs, wordOf,
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
  Modifier: 'var(--warn)',
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
const layoutBtn = iconButton('layout', 'Lay the graph out — columns that follow the wires', () => void autoLayout());
const importBtn = withIcon(button('Import', () => void importFrom()), 'import');
importBtn.title = 'Read a sketch from the library into a graph';
actions.append(nameInput, openSelect, refreshBtn, newBtn, layoutBtn, importBtn, saveBtn, deleteBtn, sketchBtn);
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

/** A wheel over the rail belongs to the rail: Rete's zoom must not answer a
 * scroll the artist aimed at a panel. Inside the palette's own list the
 * wheel keeps its native scrolling. */
function holdWheel(panel: HTMLElement, scrollsInside?: HTMLElement): void {
  panel.addEventListener('wheel', (event) => {
    if (scrollsInside && event.target instanceof Node && scrollsInside.contains(event.target)) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, { passive: false });
}

/** The rail is the same rule as a node body: content stops the event, the
 * empty canvas answers it. */
function holdPanel(panel: HTMLElement, scrollsInside?: HTMLElement): void {
  holdWheel(panel, scrollsInside);
  for (const type of ['dblclick', 'pointerdown', 'contextmenu'] as const) {
    panel.addEventListener(type, (event) => event.stopPropagation());
  }
}

holdPanel(paperPanel);
holdPanel(palette, paletteList);

/**
 * A splitter. The rail's width and the preview's height are the artist's,
 * and they survive a reload: a preview big enough to judge ink is worth
 * keeping, and so is a palette wide enough to read.
 */
function splitter(
  axis: 'x' | 'y',
  property: '--graph-rail-w' | '--graph-preview-h',
  key: string,
  bounds: [number, number],
  sign: 1 | -1,
): HTMLElement {
  const handle = el('div', `graph-split graph-split-${axis}`);
  handle.title = axis === 'x' ? 'Drag to size the panels' : 'Drag to size the preview';
  const saved = Number(localStorage.getItem(key));
  const apply = (value: number): void => {
    main.style.setProperty(property, `${Math.round(value)}px`);
  };
  let size = Number.isFinite(saved) && saved >= bounds[0] && saved <= bounds[1] ? saved : Number.NaN;
  if (Number.isFinite(size)) apply(size);
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const from = axis === 'x' ? event.clientX : event.clientY;
    const start = Number.isFinite(size)
      ? size
      : (axis === 'x' ? rail.getBoundingClientRect().width : paperPanel.getBoundingClientRect().height);
    const move = (moved: PointerEvent): void => {
      const travel = (axis === 'x' ? moved.clientX : moved.clientY) - from;
      size = Math.min(bounds[1], Math.max(bounds[0], start + sign * travel));
      apply(size);
      preview.fit();
      for (const view of views.values()) view.preview?.fit();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (Number.isFinite(size)) localStorage.setItem(key, String(Math.round(size)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  return handle;
}

const railSplit = splitter('x', '--graph-rail-w', 'occlude.graph.railWidth', [240, 760], -1);
const previewSplit = splitter('y', '--graph-preview-h', 'occlude.graph.previewHeight', [180, 1000], -1);
rail.append(palette, previewSplit, paperPanel);
body.append(canvasHost, railSplit, rail);
main.append(head, body);

// ---- state ----

let graph: Graph = template();
let pens: PenDef[] = [];
let papers: PaperDef[] = [];
let settings = loadSettings();
let dirty = false;
let loading = true;
let selection = new Set<string>();
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
  pick: (id, shift) => select(id, shift),
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

/**
 * What a viewer can make of the value on its socket. A shape or a drawing is
 * ink already; a material, points, faces or a mesh is not, and the viewer's
 * own sketch wraps it in `strokes(...)`; a number is not a picture at all
 * and is read back from the run; and a value whose kind the graph does not
 * know is tried both ways. The graph's own return is unchanged by any of it.
 */
function viewerShow(node: GraphNode): ViewerShow {
  const input = node.inputs['in'];
  if (!input?.from) return 'ink';
  const type = typeOfOutput(input.from[0], input.from[1]);
  if (type === undefined) return 'ink';
  if (type === 'Number') return 'number';
  if (type === 'Geometry') return 'try';
  const kind = kindOf(type);
  if (kind === undefined) return 'ink';
  return WRAPPED_KINDS.includes(kind) ? 'strokes' : 'ink';
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
  viewerShow,
  frames: (node) => viewerFrames.get(node.id) ?? 0,
  zoom: () => canvas.area.area.transform.k,
  takesOf: (node) => inputTakes(node, catalogue),
  setSpread: (node, key, spread) => {
    const input = node.inputs[key];
    if (!input) return;
    if (spread) input.spread = true;
    else delete input.spread;
    touch();
  },
  setSize: (node, width, height) => {
    node.width = width;
    node.height = height;
    canvas.area.resize(node.id, width, height);
    dirty = true;
  },
  remove: (node) => void removeNode(node.id),
  select: (node) => select(node.id),
  fitViewer: (node) => views.get(node.id)?.preview?.fit(),
  showViewer: (node) => showViewer(node),
};

/**
 * A viewer's picture, big. The node's canvas is a thumbnail of a step; this
 * is the same picture on the same painter, with room to read it. It paints
 * what the viewer already rendered — opening a picture costs no render.
 */
function showViewer(node: GraphNode): void {
  const cached = viewerResults.get(node.id);
  if (!cached) {
    notify(`${node.id} has no picture yet`, 'warning');
    return;
  }
  const box = el('div', 'graph-shown');
  const canvas = document.createElement('canvas');
  box.append(canvas);
  const big = new Preview(canvas);
  showPanel({
    title: `${node.id} — ${node.inputs['in']?.from?.join('.') ?? 'nothing'}`,
    body: box,
    wide: true,
    onClose: () => big.dispose(),
  });
  // The canvas has no size until the dialog has laid out.
  requestAnimationFrame(() => {
    big.setPaperColor(cached.result.paper.color ?? settings.paperColor);
    big.setResult(cached.result);
    big.fit();
  });
}

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
  } else if (node.kind === 'value') {
    // A literal: nothing wires in, one wire out.
    const type = node.outputs?.out ?? 'Number';
    rete.addOutput('out', new ClassicPreset.Output(port(takesOf(type).socket), 'out'));
  } else if (node.kind === 'list') {
    for (const key of listPlaces(node)) rete.addInput(key, new ClassicPreset.Input(port('Geometry'), key));
    rete.addOutput('out', new ClassicPreset.Output(port('Geometry'), 'out'));
  } else if (node.kind === 'zone') {
    for (const [key, takes] of Object.entries(inputTakes(node, catalogue))) {
      if (takes) rete.addInput(key, new ClassicPreset.Input(port(takes.socket), key));
    }
    rete.addOutput('out', new ClassicPreset.Output(port('Geometry'), 'out'));
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

/** The drag in progress: the picked node's own track, and where the rest of
 * the selection started, so the whole selection moves as one. */
let group: { id: string; from: { x: number; y: number }; others: { id: string; from: { x: number; y: number } }[] } | null = null;

canvas.area.addPipe((context: AreaExtra | Root<GraphScheme>) => {
  if (context.type === 'nodepicked') {
    const id = context.data.id;
    const at = (other: string): { x: number; y: number } => {
      const view = canvas.area.nodeViews.get(other);
      return view ? { x: view.position.x, y: view.position.y } : { x: 0, y: 0 };
    };
    group = selection.has(id) && selection.size > 1
      ? { id, from: at(id), others: [...selection].filter((other) => other !== id).map((other) => ({ id: other, from: at(other) })) }
      : null;
  }
  if (context.type === 'nodetranslated' && group && context.data.id === group.id) {
    const dx = context.data.position.x - group.from.x;
    const dy = context.data.position.y - group.from.y;
    for (const other of group.others) {
      void canvas.area.translate(other.id, { x: other.from.x + dx, y: other.from.y + dy });
    }
  }
  if (context.type === 'nodedragged') {
    const moved = group;
    group = null;
    const node = nodeById(context.data.id);
    const view = canvas.area.nodeViews.get(context.data.id);
    if (node && view) {
      node.x = Math.round(view.position.x);
      node.y = Math.round(view.position.y);
      dirty = true;
    }
    // The rest followed; their new places are the document's too.
    for (const other of moved?.others ?? []) {
      const rest = nodeById(other.id);
      const otherView = canvas.area.nodeViews.get(other.id);
      if (rest && otherView) {
        rest.x = Math.round(otherView.position.x);
        rest.y = Math.round(otherView.position.y);
      }
    }
  }
  return context;
});

// A press on the empty canvas clears the selection.
canvasHost.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && !target.closest('.graph-node')) clearSelection();
});

/**
 * Shift and drag on the empty canvas draws a box, and every node it touches
 * joins the selection. The capture phase, and the area never sees the press:
 * a box and a pan are the same gesture, and shift is what tells them apart.
 */
const marquee = el('div', 'graph-marquee');
marquee.hidden = true;
canvasHost.append(marquee);

canvasHost.addEventListener('pointerdown', (event) => {
  if (!event.shiftKey || event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest('.graph-node')) return;
  event.stopPropagation();
  event.preventDefault();
  const host = canvasHost.getBoundingClientRect();
  const from = { x: event.clientX, y: event.clientY };
  // Shift adds, so what was already picked stays picked.
  const held = new Set(selection);
  const box = (to: { x: number; y: number }): DOMRect => new DOMRect(
    Math.min(from.x, to.x), Math.min(from.y, to.y),
    Math.abs(to.x - from.x), Math.abs(to.y - from.y),
  );
  const paint = (rect: DOMRect): void => {
    marquee.hidden = false;
    marquee.style.left = `${rect.x - host.left}px`;
    marquee.style.top = `${rect.y - host.top}px`;
    marquee.style.width = `${rect.width}px`;
    marquee.style.height = `${rect.height}px`;
  };
  const inside = (rect: DOMRect): string[] => graph.nodes
    .filter((node) => {
      const body = views.get(node.id)?.body?.getBoundingClientRect();
      if (!body) return false;
      return body.left < rect.right && body.right > rect.left && body.top < rect.bottom && body.bottom > rect.top;
    })
    .map((node) => node.id);
  const move = (moved: PointerEvent): void => {
    const rect = box({ x: moved.clientX, y: moved.clientY });
    paint(rect);
    selection = new Set([...held, ...inside(rect)]);
    paintSelection();
  };
  const up = (): void => {
    marquee.hidden = true;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}, true);

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
  // A list grows: the place that was free is taken, so a new free one has to
  // appear, and the node's sockets are rebuilt with it.
  if (target.kind === 'viewer' || target.kind === 'list') canvas.refresh(target.id);
  touch();
}

function clearWire(wire: GraphWire): void {
  if (loading) return;
  const target = nodeById(wire.target);
  if (!target) return;
  const key = String(wire.targetInput);
  const input = target.inputs[key];
  if (input) delete input.from;
  // A place nothing reaches is not a place: a list closes the gap.
  if (target.kind === 'list' && input && input.value === undefined) delete target.inputs[key];
  syncWired(target);
  if (target.kind === 'viewer' || target.kind === 'list') canvas.refresh(target.id);
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

function paintSelection(): void {
  for (const id of canvas.area.nodeViews.keys()) {
    canvas.area.nodeViews.get(id)?.element.classList.toggle('graph-sel', selection.has(id));
  }
}

/** Shift adds to the selection, a plain pick replaces it. Rete ships
 * `selectableNodes`, but it repaints a node through `area.update` on every
 * pick — which on this page rebuilds a code node's Monaco editor — so the
 * selection is kept here, where it is only a class and a set. */
function select(id: string, add = false): void {
  if (add) {
    if (selection.has(id)) selection.delete(id);
    else selection.add(id);
  } else if (!(selection.size === 1 && selection.has(id))) {
    selection = new Set([id]);
  }
  paintSelection();
}

function clearSelection(): void {
  if (selection.size === 0) return;
  selection = new Set();
  paintSelection();
}

/** A place near `at` that no node already covers. A new node that lands
 * under an existing one looks like nothing happened. */
function freeSpot(at: { x: number; y: number }): { x: number; y: number } {
  const taken = graph.nodes.map((node) => {
    const body = views.get(node.id)?.body;
    const zoom = canvas.area.area.transform.k || 1;
    const rect = body?.getBoundingClientRect();
    return {
      x: node.x,
      y: node.y,
      w: rect && rect.width > 0 ? rect.width / zoom : (node.width ?? 208),
      h: rect && rect.height > 0 ? rect.height / zoom : (node.height ?? 120),
    };
  });
  const clear = (x: number, y: number): boolean =>
    !taken.some((other) => x < other.x + other.w && x + 208 > other.x && y < other.y + other.h && y + 80 > other.y);
  let spot = { x: Math.round(at.x - 104), y: Math.round(at.y - 40) };
  for (let step = 0; step < 40 && !clear(spot.x, spot.y); step++) {
    spot = { x: spot.x + 28, y: spot.y + 24 };
  }
  return spot;
}

async function place(node: GraphNode, at = canvas.centre()): Promise<void> {
  const spot = freeSpot(at);
  node.x = spot.x;
  node.y = spot.y;
  graph.nodes.push(node);
  await canvas.editor.addNode(reteNode(node));
  // In front and picked: the node the artist just made is the node they are
  // working on.
  canvas.raise(node.id);
  select(node.id);
  touch();
}

/** A word from the palette: its required numbers start at zero, so the node
 * is a node and not a hole. */
function addBuiltin(word: CatalogueWord, at?: { x: number; y: number }): void {
  const node: GraphNode = { id: freshId(), kind: 'builtin', word: word.word, x: 0, y: 0, inputs: {} };
  for (const input of wordInputs(word)) {
    // A required number starts at zero so the node is a node and not a hole;
    // every option stays unset, so the library's own default applies.
    if (input.takes && !input.optional && input.takes.socket === 'Number') node.inputs[input.name] = { value: 0 };
  }
  void place(node, at);
}

function addNode(kind: 'code' | 'viewer' | 'output' | 'value' | 'list', at?: { x: number; y: number }): void {
  const id = freshId();
  const node: GraphNode = kind === 'code'
    ? { id, kind, x: 0, y: 0, inputs: {}, outputs: { out: 'Number' }, body: 'return { out: 1 };' }
    : kind === 'value'
      ? { id, kind, x: 0, y: 0, inputs: { v: { value: 0 } }, outputs: { out: 'Number' } }
      : kind === 'list'
        ? { id, kind, x: 0, y: 0, inputs: {}, outputs: { out: 'drawing' } }
        : { id, kind, x: 0, y: 0, inputs: {} };
  void place(node, at);
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
  selection.delete(id);
  paintSelection();
  graph.nodes = graph.nodes.filter((n) => n.id !== id);
  for (const other of graph.nodes) {
    for (const input of Object.values(other.inputs)) if (input.from?.[0] === id) delete input.from;
    syncWired(other);
  }
  touch();
}

/**
 * Lay the graph out: columns that follow the wires, every node level with
 * what feeds it, nothing overlapping. The sizes are the ones on the canvas —
 * a code node that grew to its body and a viewer the artist sized are as
 * tall as they look — so the result is what the eye sees, not an estimate.
 *
 * It moves every node, which is why it is a button and not something the
 * page does on its own: a place the artist chose is theirs until they ask.
 */
async function autoLayout(): Promise<void> {
  const zoom = canvas.area.area.transform.k || 1;
  const measure = (node: GraphNode): NodeBox => {
    const body = views.get(node.id)?.body;
    if (!body) return estimateBox(node, catalogue);
    const rect = body.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return estimateBox(node, catalogue);
    return { width: rect.width / zoom, height: rect.height / zoom };
  };
  let places: Map<string, { x: number; y: number }>;
  try {
    places = layoutGraph(graph, measure);
  } catch (error) {
    // A cycle has no layering, and the compiler says so first anyway.
    status(error instanceof Error ? error.message : String(error), 'err');
    return;
  }
  for (const node of graph.nodes) {
    const at = places.get(node.id);
    if (!at) continue;
    node.x = Math.round(at.x);
    node.y = Math.round(at.y);
    await canvas.area.translate(node.id, { x: node.x, y: node.y });
  }
  canvas.fit();
  dirty = true;
  status(`laid out ${graph.nodes.length} nodes`);
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

/** Every mark a refused graph carries: the node, and the wire. Cleared
 * together on the next compile that gets through. */
function clearErrors(): void {
  for (const id of canvas.area.nodeViews.keys()) canvas.area.nodeViews.get(id)?.element.classList.remove('graph-node-err');
  for (const host of canvasHost.querySelectorAll('.graph-wire-host')) host.classList.remove('graph-wire-bad');
}

function markWire(from: string, out: string, to: string, key: string): void {
  const host = canvasHost.querySelector<HTMLElement>(`[data-wire="${from}:${out}->${to}:${key}"]`);
  host?.classList.add('graph-wire-bad');
}

function markErrors(message: string | null): void {
  clearErrors();
  if (!message) return;
  // `graph: n2.count takes Number; n1.out is shape` names both ends of the
  // wire that cannot be made.
  const mismatch = /graph: ([A-Za-z_$][\w$]*)\.([\w$.]+) takes .*; ([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*) is /.exec(message);
  if (mismatch) {
    const [, target, key, source, out] = mismatch;
    canvas.area.nodeViews.get(target)?.element.classList.add('graph-node-err');
    canvas.area.nodeViews.get(source)?.element.classList.add('graph-node-err');
    markWire(source, out, target, key);
    return;
  }
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

/**
 * The JavaScript the worker runs. A compiled graph is TypeScript: a code
 * node's body is ordinary TypeScript, and `(n: number) => …` inside one is a
 * type annotation the worker cannot evaluate. The studio's own editor emits
 * through the TypeScript worker and this does the same — a hand rewrite of
 * the import lines only works on source with no annotations at all, which is
 * true of a docs fence and of nothing else.
 */
async function jsOf(source: string): Promise<string> {
  const emitted = await transpileToCjs(source);
  if (emitted.js === null) throw new Error(emitted.errors[0] ?? 'the compiled sketch would not emit');
  return emitted.js;
}

async function renderMain(compiled: CompiledSketch, mine: number): Promise<void> {
  status('rendering…');
  try {
    const reply = await client.render({ js: await jsOf(compiled.source), cfg: runConfig() }, () => mine === generation);
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
    const thrown = culprit(message) ?? nodeFromStack(error instanceof Error ? error.stack : undefined, (await transpileToCjs(compiled.source)).js ?? '', ids);
    markErrors(thrown ?? message);
    // A body that threw: its own drives are suspect too, so they go red with
    // it — the stack usually names the node and nothing else.
    if (thrown) {
      canvas.area.nodeViews.get(thrown)?.element.classList.add('graph-node-err');
      for (const wire of canvas.editor.getConnections()) {
        if (wire.target === thrown) markWire(wire.source, String(wire.sourceOutput), wire.target, String(wire.targetInput));
      }
    }
    preview.setStale(true);
  }
}

async function renderViewer(node: GraphNode, mine: number): Promise<void> {
  const view = views.get(node.id);
  if (!node.inputs['in']?.from) {
    viewerResults.delete(node.id);
    view?.preview?.setStale(true);
    if (view?.paint.value) view.paint.value.textContent = '—';
    setBad(node.id, false);
    return;
  }
  const show = viewerShow(node);
  const frame = viewerFrame(node);

  /** The viewer's own sketch. `wrapped` decides whether the value is asked
   * to be ink; `try` asks once each way. */
  const sketchFor = (wrapped: boolean): CompiledSketch => compileFor(graph, catalogue, node.id, 'in', {
    // A chosen frame shows that kept state instead — the ternary keeps a
    // material with no history from throwing, which is the library's own
    // best-effort rule. The frame count is not in the document (the material
    // is only in the worker), so the sketch probes it and the reply carries
    // it back.
    wrap: show === 'number'
      ? () => '[]'
      : wrapped
        ? (expression: string) => `strokes(${frame >= 0 ? `(${expression}).history.length > ${frame} ? (${expression}).history[${frame}].material : ${expression}` : expression})`
        : undefined,
    prelude: show === 'number'
      ? (expression: string) => [`t.probe('value', ${expression});`]
      : wrapped
        ? (expression: string) => [`t.probe('frames', ${expression}.history.length);`]
        : undefined,
  });

  const wantsInk = show === 'strokes' || show === 'try';
  let compiled: CompiledSketch;
  try {
    compiled = sketchFor(wantsInk);
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), 'err');
    return;
  }
  // The frame and the way it is shown are part of the picture: the same
  // nodes shown another way are another render.
  const hash = `${compiled.nodes.map((n) => n.hash).join('|')}|${show}|f${frame}`;
  const cached = viewerResults.get(node.id);
  if (cached?.hash === hash) {
    view?.preview?.setStale(false);
    setBad(node.id, false);
    return;
  }
  const run = async (source: CompiledSketch): Promise<Awaited<ReturnType<typeof client.render>>> =>
    client.render({ js: await jsOf(source.source), cfg: runConfig() }, () => mine === generation);
  try {
    let reply = await run(compiled);
    if (!reply || mine !== generation) return;
    if (reply) {
      viewerResults.set(node.id, { hash, result: reply.result });
      setBad(node.id, false);
      showReply(node, reply, show);
    }
  } catch (error) {
    if (mine !== generation) return;
    // Best effort: a value the graph could not name may simply not be ink.
    // Draw it bare before calling it an error.
    if (show === 'try') {
      try {
        const bare = await run(sketchFor(false));
        if (!bare || mine !== generation) return;
        viewerResults.set(node.id, { hash, result: bare.result });
        setBad(node.id, false);
        showReply(node, bare, show);
        return;
      } catch {
        // fall through to the message from the first attempt
      }
    }
    // The node is marked and the status names it: no toast per viewer.
    status(`${node.id}: ${error instanceof Error ? error.message : String(error)}`, 'err');
    setBad(node.id, true);
    view?.preview?.setStale(true);
  }
}

/** Put a viewer's reply on its face: a picture, or the number it read. */
function showReply(node: GraphNode, reply: { result: RenderResult; probes: Record<string, { count: number; min: number; max: number; mean: number }> }, show: ViewerShow): void {
  const view = views.get(node.id);
  if (show === 'number') {
    const probe = reply.probes.value;
    if (view?.paint.value) {
      // One number reads as itself; a column of them reads as what the run
      // made of it.
      const round = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(3));
      view.paint.value.textContent = !probe || probe.count === 0
        ? '—'
        : probe.count === 1
          ? round(probe.mean)
          : `${probe.count} · ${round(probe.min)} … ${round(probe.max)} · mean ${round(probe.mean)}`;
    }
    return;
  }
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
}

// ---- the palette ----

/** The word being dragged out of the palette, and how to add it. */
let dragging: ((at?: { x: number; y: number }) => void) | null = null;

function paletteItem(word: string, returns: string, add: (at?: { x: number; y: number }) => void, hint: string): HTMLButtonElement {
  const item = el('button', 'graph-palette-item');
  item.title = `${hint} — click to add at the middle, or drag one onto the canvas`;
  const dot = el('span', 'graph-palette-dot');
  dot.style.setProperty('--graph-sock', SOCKET_COLORS[takesOf(returns).socket] ?? 'var(--muted)');
  item.append(dot, el('span', 'graph-palette-word', word), el('span', 'graph-palette-ret', returns));
  item.onclick = () => add();
  // A word is dragged onto the place it should stand. The palette is the
  // source, the canvas is the target, and the word itself rides in a closure
  // rather than in the drag's own data, which only carries text.
  item.draggable = true;
  item.addEventListener('dragstart', (event) => {
    dragging = add;
    canvasHost.classList.add('graph-dropping');
    event.dataTransfer?.setData('text/plain', word);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
  });
  item.addEventListener('dragend', () => {
    dragging = null;
    canvasHost.classList.remove('graph-dropping');
  });
  return item;
}

canvasHost.addEventListener('dragover', (event) => {
  if (!dragging) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});

canvasHost.addEventListener('drop', (event) => {
  if (!dragging) return;
  event.preventDefault();
  const add = dragging;
  dragging = null;
  canvasHost.classList.remove('graph-dropping');
  add(canvas.at(event.clientX, event.clientY));
});

function buildPalette(): void {
  paletteList.replaceChildren();
  const nodes = el('div', 'graph-palette-group');
  nodes.append(el('div', 'graph-palette-title', 'Nodes'));
  nodes.append(paletteItem('value', 'Number', (at) => addNode('value', at), 'A number the graph holds'));
  nodes.append(paletteItem('list', 'drawing', (at) => addNode('list', at), 'Several values as one, in order'));
  nodes.append(paletteItem('code', 'body', (at) => addNode('code', at), 'A function body with declared inputs and outputs'));
  nodes.append(paletteItem('viewer', 'picture', (at) => addNode('viewer', at), 'Draw what this point of the graph holds'));
  nodes.append(paletteItem('output', 'return', (at) => addNode('output', at), 'What the sketch returns'));
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
    group.append(paletteItem(word.word, word.returns, (at) => addBuiltin(word, at), `${word.word} → ${word.returns}${word.page ? ` · ${word.page}` : ''}`));
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
    clearSelection();
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
async function readSketch(source: string, name: string): Promise<boolean> {
  generation += 1;
  try {
    graph = importSketch(source, catalogue);
  } catch (error) {
    // A sketch that cannot be read is an answer, not a crash: the importer
    // names the statement it stopped at.
    const message = error instanceof Error ? error.message : String(error);
    status(`import '${name}': ${message}`, 'err');
    notify(`import '${name}': ${message}`, 'danger');
    return false;
  }
  nameInput.value = '';
  mainSource = null;
  fitted = null;
  viewerResults.clear();
  viewerFrames.clear();
  await buildCanvas();
  history.replaceState(null, '', '/graph.html');
  dirty = true; // the imported graph has no name in the store yet
  clearSelection();
  await renderAll();
  return true;
}

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
  if (await readSketch(source, name)) notify(`imported '${name}' as a graph — Save gives it a name`, 'success');
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
  clearSelection();
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
    clearSelection();
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
    if (selection.size === 0) return;
    event.preventDefault();
    for (const id of [...selection]) void removeNode(id);
  }
  if (event.key === 'Escape') clearSelection();
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
      // A library entry is imported under the identifier the module exports,
      // not under its own name: `pigma-005-black` is `pigma_005_black` in a
      // sketch, and a catalogue keyed by the display name matches nothing.
      { module: '@user/pens', names: pens.map((pen) => ({ name: moduleName(pen.name), spec: moduleName(pen.name) })) },
      { module: '@user/papers', names: papers.map((paper) => ({ name: moduleName(paper.name), spec: moduleName(paper.name) })) },
    ],
  };
  preview.setPaperColor(settings.paperColor);
  const params = new URLSearchParams(location.search);
  // "Open in Graph" on the studio page hands the editor's own buffer over,
  // the way Evolve is handed one: what the artist is looking at, saved or
  // not.
  // Why the page fell back to the template, when it did. The template
  // renders, and its own status would wipe the reason off the line: a
  // handoff that failed must not look like a page that simply opened.
  let fallback: string | null = null;
  if (params.get('live') === '1') {
    const live = takeLive();
    const from = live?.name || 'the editor';
    if (!live?.source) fallback = `nothing arrived from the studio — open the sketch there and press Open in Graph again`;
    else if (await readSketch(live.source, from)) {
      await refreshList();
      nameInput.value = live.name;
      seedInput.value = typeof graph.config.seed === 'number' ? String(graph.config.seed) : '';
      notify(`read '${from}' as a graph — Save gives it a name`, 'success');
      return;
    } else {
      fallback = `'${from}' would not read as a graph — the template is below`;
    }
  }
  const wanted = params.get('graph');
  if (wanted) {
    const opened = await open(wanted);
    await refreshList();
    // A link that cannot open falls back to the template: the document must
    // never be left half-loaded with the canvas still in build mode.
    if (opened) return;
    fallback = `'${wanted}' would not open — the template is below`;
    history.replaceState(null, '', '/graph.html');
  }
  graph = template();
  seedInput.value = String(graph.config.seed ?? '');
  await buildCanvas();
  await refreshList();
  dirty = false;
  await renderAll();
  if (fallback) {
    status(fallback, 'err');
    notify(fallback, 'warning');
  }
}

void boot();
