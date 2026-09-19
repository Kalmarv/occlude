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
import { iconButton, withIcon, type IconName } from './icons.js';
import { confirmDialog, notify, promptDialog, showPanel } from './wa.js';
import { transpileToCjs } from './editor.js';
import { Preview } from './preview.js';
import { RenderClient } from './workerClient.js';
import type { ConstructionInfo3 } from './three/construction.js';
import { NodeCamera3 } from './graph/camera3.js';
import type { RunConfig } from './runner.js';
import { loadPapers, loadPens, loadSettings, sheetOf } from './store.js';
import { mountShell } from './shell.js';
import { button, el } from './widgets.js';
import { CATALOGUE } from './graph/catalogue.js';
import { createCanvas, type AreaExtra, type GraphCanvas, type GraphScheme, type GraphWire, type ReteNode } from './graph/canvas.js';
import { bridgeDiagnostics, markWired, paintNode, takesLabel, takesOf, type NodePaint, type NodePaintHooks, type ViewerShow } from './graph/nodes.js';
import { compileFor, compileGraph, type CompiledSketch } from './graph/compile.js';
import { collapse, expand, groupInputs, groupOutputs, type Group } from './graph/groups.js';
import { estimateBox, layoutGraph, type NodeBox } from './graph/layout.js';
import { importSketch, layoutBlock } from './graph/import.js';
import { loadSketchByName, stashLive, takeLive } from './sketchApi.js';
import {
  PAPER_OUTPUTS, accepts, cloneNode, graphToJson, inputTakes, isUsableName, kindOf, listPlaces, outputType, parseGraph, socketOf, wordInputs, wordOf,
  type Catalogue, type CatalogueWord, type Graph, type GraphNode, type Takes, type ValueType,
} from './graph/model.js';
import { deleteGraph, graphHref, listGraphs, listGroups, loadGraphText, loadGroupText, saveGraphText, saveGroupText } from './graph/store.js';

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
  VectorField: 'var(--toolpath)',
  Tone: 'var(--muted)',
  Pen: 'var(--accent-edge)',
  Image: 'var(--warn)',
  Force: 'var(--accent-edge)',
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
const evolveBtn = iconButton('evolve', 'Evolve this graph — the compiled sketch, seed by seed', () => evolveGraph());
const fitCanvasBtn = iconButton('frame', 'Fit the whole graph in view (Home)', () => canvas.fit());
/** The ground follows the view, so the dots are the grid a node snaps to and
 * not decoration that happens to look like one. */
function paintGrid(): void {
  const { x, y, k } = canvas.area.area.transform;
  canvasHost.style.backgroundSize = `${GRID * k}px ${GRID * k}px`;
  canvasHost.style.backgroundPosition = `${x}px ${y}px`;
}

/** Snapping is how the artist works, not what the graph is, so it lives with
 * the page and not in the document. */
const GRID = 22;
let snapping = false;
try { snapping = localStorage.getItem('occlude.graph.snap') === 'on'; } catch { /* private window */ }
const onGrid = (n: number): number => Math.round(n / GRID) * GRID;
const snapBtn = iconButton('grid', 'Snap to the grid while dragging', () => setSnap(!snapping));
function setSnap(on: boolean): void {
  snapping = on;
  snapBtn.setAttribute('aria-pressed', String(on));
  canvasHost.classList.toggle('graph-gridded', on);
  try { localStorage.setItem('occlude.graph.snap', on ? 'on' : 'off'); } catch { /* private window */ }
}

const layoutBtn = iconButton('layout', 'Lay the graph out — columns that follow the wires', () => void autoLayout());
const importBtn = withIcon(button('Import', () => void importFrom()), 'import');
importBtn.title = 'Read a sketch from the library into a graph';
actions.append(nameInput, openSelect, refreshBtn, newBtn, fitCanvasBtn, layoutBtn, snapBtn, importBtn, saveBtn, deleteBtn, evolveBtn, sketchBtn);
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
  /** The viewer is showing the model, and this holds its camera. */
  camera?: NodeCamera3;
}

/** The groups the host holds, by name. A group is a word the artist made:
 * the catalogue carries what its sockets are, and this carries the graph the
 * compiler inlines. */
const groupCache = new Map<string, Group>();

const views = new Map<string, NodeView>();
/** A viewer's last picture, keyed by its compiled sub-graph: a change
 * upstream of nothing must not re-render it. */
const viewerResults = new Map<string, { hash: string; result: RenderResult }>();
/** The 3D scene a viewer's last render built, and the execution that holds
 * it. The worker keeps one execution at a time, so this is what a camera
 * asks for and what tells it to ask for the sketch again. */
const viewerModels = new Map<string, { executionId: number; construction: ConstructionInfo3[] }>();
/** How many kept states each viewer's material has, from its own render. */
const viewerFrames = new Map<string, number>();

const client = new RenderClient();
const preview = new Preview(paperCanvas);
preview.setPaperColor(settings.paperColor);

/**
 * A zone's body is painted in THIS document, inside a frame of its own, so
 * an inner node needs a name on the canvas that cannot collide with an
 * outer one: `n4/n1` is node `n1` of the body of zone `n4`. Everything the
 * page does by id — paint, position, select, wire, drag — goes through
 * `nodeById`, so teaching that one function the path teaches all of it.
 *
 * The inner nodes are the very objects in `zone.graph`, so an edit lands in
 * the document with nothing to write back.
 */
const PATH = '/';

/** Where a zone's body is painted: under the zone, in its own column. */
const FRAME_GAP = 44;
const FRAME_PAD = 26;
const ZONE_HEIGHT = 180;

function zoneOf(id: string): { zone: GraphNode; innerId: string } | undefined {
  const cut = id.indexOf(PATH);
  if (cut < 0) return undefined;
  const zone = graph.nodes.find((n) => n.id === id.slice(0, cut));
  return zone?.kind === 'zone' && zone.graph ? { zone, innerId: id.slice(cut + 1) } : undefined;
}

const nodeById = (id: string): GraphNode | undefined => {
  const inner = zoneOf(id);
  if (inner) return inner.zone.graph!.nodes.find((n) => n.id === inner.innerId);
  return graph.nodes.find((n) => n.id === id);
};

/** The zones whose bodies are open, in document order. */
const openZones = (): GraphNode[] => graph.nodes.filter((n) => n.kind === 'zone' && n.opened && n.graph);

/** Where an open zone's body sits on the canvas. The body's own positions
 * are relative to it, so the document never learns where the frame is. */
function frameOrigin(zone: GraphNode): { x: number; y: number } {
  const view = canvas.area.nodeViews.get(zone.id);
  const height = view?.element.offsetHeight ?? ZONE_HEIGHT;
  return { x: zone.x + FRAME_PAD, y: zone.y + height + FRAME_GAP + FRAME_PAD };
}

/** The canvas name of a node object, for the hooks: an inner node is known
 * by its path, and a hook is handed the node, not the name. Rebuilt with
 * the canvas, which is the only thing that changes it. */
const canvasName = new Map<GraphNode, string>();
const idOf = (node: GraphNode): string => canvasName.get(node) ?? node.id;

/** Every node the canvas paints: this graph's, and the body of every zone
 * that is open, under the name the canvas knows it by. */
function painted(): { id: string; node: GraphNode }[] {
  const out = graph.nodes.map((node) => ({ id: node.id, node }));
  for (const zone of openZones()) {
    for (const inner of zone.graph!.nodes) out.push({ id: `${zone.id}${PATH}${inner.id}`, node: inner });
  }
  canvasName.clear();
  for (const { id, node } of out) canvasName.set(node, id);
  return out;
}

/** Where the canvas puts a node: a body's places are its frame's. */
function placeOf(id: string): { x: number; y: number } | null {
  const node = nodeById(id);
  if (!node) return null;
  const inner = zoneOf(id);
  if (!inner) return { x: node.x, y: node.y };
  const origin = frameOrigin(inner.zone);
  return { x: origin.x + node.x, y: origin.y + node.y };
}

/** The other way: what the artist dragged a node to, in the node's own
 * terms. */
function placeTo(id: string, at: { x: number; y: number }): void {
  const node = nodeById(id);
  if (!node) return;
  const inner = zoneOf(id);
  const origin = inner ? frameOrigin(inner.zone) : { x: 0, y: 0 };
  node.x = Math.round(at.x - origin.x);
  node.y = Math.round(at.y - origin.y);
}

/**
 * A body that has never been looked at has no places: the importer writes
 * the nodes and leaves them at the origin, which would paint them all on
 * top of each other. Lay one out the first time it is painted — on opening
 * it, and on opening a document that was saved with it open — and leave it
 * alone ever after, because where the artist puts a node is the artist's.
 */
function settleBodies(): void {
  for (const zone of openZones()) {
    const body = zone.graph!;
    if (body.nodes.length < 2 || !body.nodes.every((n) => n.x === 0 && n.y === 0)) continue;
    try {
      const places = layoutGraph(body, (n) => estimateBox(n, catalogue));
      for (const inner of body.nodes) {
        const at = places.get(inner.id);
        if (!at) continue;
        inner.x = Math.round(at.x);
        inner.y = Math.round(at.y);
      }
    } catch {
      // A cycle inside a body is the compiler's to report, not the canvas's:
      // paint it stacked rather than refuse to open it.
    }
  }
}

/** The frames behind the nodes, measured from the bodies they hold. */
function paintFrames(): void {
  canvas.setFrames(openZones().map((zone) => {
    const origin = frameOrigin(zone);
    let w = 220;
    let h = 120;
    for (const inner of zone.graph!.nodes) {
      const view = canvas.area.nodeViews.get(`${zone.id}${PATH}${inner.id}`);
      const width = view?.element.offsetWidth ?? 180;
      const height = view?.element.offsetHeight ?? 120;
      w = Math.max(w, inner.x + width);
      h = Math.max(h, inner.y + height);
    }
    const binds = (zone.binds ?? []).join(', ');
    return {
      id: zone.id,
      x: origin.x - FRAME_PAD,
      y: origin.y - FRAME_PAD,
      w: w + FRAME_PAD * 2,
      h: h + FRAME_PAD * 2,
      label: `${zone.id} · ${zone.zone ?? 'zone'}${binds ? ` (${binds})` : ''}`,
    };
  }));
}
const wiredOf = (node: GraphNode): Set<string> =>
  new Set(Object.entries(node.inputs).filter(([, input]) => input.from).map(([key]) => key));

function status(text: string, kind: 'ok' | 'err' = 'ok'): void {
  statusLine.textContent = text;
  statusLine.className = `graph-status graph-status-${kind}`;
}

/** The name field wears the unsaved mark, and the tab title with it: work
 * that is not saved has to look unsaved. */
function showDirty(): void {
  nameInput.classList.toggle('graph-dirty', dirty);
  const name = nameInput.value.trim() || 'untitled';
  document.title = `${dirty ? '• ' : ''}${name} — occlude graph`;
}

/**
 * The open graph, kept in this browser. A crash, a reload or a stray link
 * loses nothing: the draft is written on every change and read back on the
 * next visit, and the name it was drafted under is what says whether it is
 * still the graph you were looking at.
 */
/**
 * Undo and redo.
 *
 * The document is a plain value, so a step back is the document as it was.
 * The whole thing is kept rather than a description of the change: a graph is
 * small beside a drawing, and a history of *what happened* is a second model
 * of the page that has to agree with the first one.
 *
 * Typing in a body is coalesced — a step per keystroke is not a step — and a
 * step is only kept when the document actually differs, so a drag that ends
 * where it began costs nothing.
 */
const HISTORY = 40;
const past: string[] = [];
const ahead: string[] = [];
/** The document as the last step saw it. */
let settled = '';
let stepAt: number | null = null;

/** Remember where the document was, once the edits stop arriving. */
function step(): void {
  if (stepAt !== null) clearTimeout(stepAt);
  stepAt = window.setTimeout(() => {
    stepAt = null;
    const now = graphToJson(graph);
    if (now === settled) return;
    past.push(settled);
    if (past.length > HISTORY) past.shift();
    ahead.length = 0;
    settled = now;
  }, 450);
}

/** A graph just opened: its history starts here, and nothing before it
 * belongs to it. */
function startHistory(): void {
  if (stepAt !== null) clearTimeout(stepAt);
  stepAt = null;
  past.length = 0;
  ahead.length = 0;
  settled = graphToJson(graph);
}

/** Take the document back, or forward, and rebuild the canvas on it. */
async function walk(back: boolean): Promise<void> {
  if (stepAt !== null) {
    // An edit that has not settled is itself a step, or it would be skipped.
    clearTimeout(stepAt);
    stepAt = null;
    const now = graphToJson(graph);
    if (now !== settled) {
      past.push(settled);
      settled = now;
    }
  }
  const from = back ? past : ahead;
  const to = back ? ahead : past;
  const text = from.pop();
  if (text === undefined || text === '') {
    status(back ? 'nothing to undo' : 'nothing to redo');
    return;
  }
  to.push(settled);
  settled = text;
  generation += 1;
  try {
    graph = parseGraph(JSON.parse(text));
  } catch (error) {
    status(`undo: ${error instanceof Error ? error.message : String(error)}`, 'err');
    return;
  }
  mainSource = null;
  viewerResults.clear();
  viewerFrames.clear();
  const keep = canvas.viewport();
  await buildCanvas();
  canvas.lookAt(keep);
  dirty = true;
  showDirty();
  saveDraft();
  await renderAll();
  status(back ? 'undone' : 'redone');
}

const DRAFT = 'occlude.graph.draft';
/** Where each graph was last looked at from, by name. Coming back to a graph
 * and finding it where you left it is the difference between a document and
 * a page that reloads. */
const VIEWS = 'occlude.graph.views';

function rememberView(): void {
  const name = nameInput.value.trim();
  if (!name) return;
  try {
    const all = JSON.parse(localStorage.getItem(VIEWS) ?? '{}') as Record<string, unknown>;
    all[name] = canvas.viewport();
    localStorage.setItem(VIEWS, JSON.stringify(all));
  } catch {
    // nothing to do
  }
}

function recallView(name: string): boolean {
  try {
    const all = JSON.parse(localStorage.getItem(VIEWS) ?? '{}') as Record<string, { x: number; y: number; k: number }>;
    const at = all[name];
    if (!at || ![at.x, at.y, at.k].every((n) => typeof n === 'number' && Number.isFinite(n)) || at.k <= 0) return false;
    canvas.lookAt(at);
    return true;
  } catch {
    return false;
  }
}

function saveDraft(): void {
  try {
    localStorage.setItem(DRAFT, JSON.stringify({ name: nameInput.value.trim(), at: Date.now(), graph: JSON.parse(graphToJson(graph)) }));
  } catch {
    // A full or blocked store is not a reason to stop drawing.
  }
}

function takeDraft(): { name: string; at: number; graph: unknown } | null {
  try {
    const raw = localStorage.getItem(DRAFT);
    return raw === null ? null : (JSON.parse(raw) as { name: string; at: number; graph: unknown });
  } catch {
    return null;
  }
}

function dropDraft(): void {
  try {
    localStorage.removeItem(DRAFT);
  } catch {
    // nothing to do
  }
}

// ---- the canvas ----

const canvas: GraphCanvas = createCanvas(canvasHost, {
  paint,
  position: (id) => placeOf(id),
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
    previous.camera?.dispose();
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
  if (paint.canvas3) {
    // The model: its own canvas, its own camera, and a way to build the
    // scene again when the worker has moved on to another viewer.
    const camera = new NodeCamera3(
      paint.canvas3,
      client,
      async () => {
        viewerResults.delete(id);
        await renderViewer(node, generation);
        return viewerModels.get(id) ?? null;
      },
      (message) => status(`${id}: ${message}`, 'err'),
    );
    view.camera = camera;
    const known = viewerModels.get(id);
    if (known) camera.offer(known.executionId, known.construction[0]);
    else schedule();
  }
  if (paint.canvas) {
    const viewer = new Preview(paint.canvas);
    viewer.setPaperColor(settings.paperColor);
    view.preview = viewer;
    const cached = viewerResults.get(id);
    if (cached) {
      viewer.setResult(cached.result);
      viewer.fit();
    } else {
      // Nothing drawn yet: the picture is coming, and blank paper says the
      // opposite. It brightens the moment the first result lands.
      viewer.setStale(true);
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
  frames: (node) => viewerFrames.get(idOf(node)) ?? 0,
  zoom: () => canvas.area.area.transform.k,
  takesOf: (node) => inputTakes(node, catalogue),
  pens: () => pens.map((pen) => pen.name),
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
    canvas.area.resize(idOf(node), width, height);
    dirty = true;
    showDirty();
  },
  fold: (node, on) => {
    if (on) node.collapsed = true;
    else delete node.collapsed;
    canvas.refresh(idOf(node));
    // A folded viewer draws nothing, so opening one has a picture to make.
    if (node.kind === 'viewer' && !on) schedule();
    touch();
  },
  openGroup: (node) => void openGroup(node.word ?? ''),
  openZone: (node, on) => {
    if (on) node.opened = true;
    else delete node.opened;
    // The body's nodes join the canvas or leave it, so this is a rebuild,
    // not a repaint. The document did not change what it MAKES, so the
    // preview is not stale and nothing re-renders.
    void buildCanvas().then(() => {
      canvas.refresh(node.id);
      paintFrames();
    });
    touch();
  },
  hasModel: (node) => (viewerModels.get(idOf(node))?.construction.length ?? 0) > 0,
  setModel: (node, on) => {
    if (on) node.view3 = true;
    else delete node.view3;
    canvas.refresh(idOf(node));
    // Going back to the drawing needs the picture the 2D canvas never got.
    if (!on) schedule();
    touch();
  },
  remove: (node) => void removeNode(idOf(node)),
  select: (node) => select(idOf(node)),
  fitViewer: (node) => {
    const view = views.get(idOf(node));
    // One word, two pictures: framing the model is what Home does there.
    if (view?.camera) view.camera.fit();
    else view?.preview?.fit();
  },
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
function reteNode(node: GraphNode, id: string = node.id): ReteNode {
  const rete = new ClassicPreset.Node(id);
  // The constructor's argument is the label; the id is ours (a graph node's
  // id is the `const` name in the compiled sketch). An open zone's body is
  // painted in this document, so an inner node is known by its path.
  rete.id = id;
  rete.label = id;
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
  } else if (node.kind === 'paper') {
    for (const key of Object.keys(PAPER_OUTPUTS)) rete.addOutput(key, new ClassicPreset.Output(port('Number'), key));
  } else if (node.kind === 'group') {
    // A group's sockets are the group's, read the same way the wire rule and
    // the body read them.
    for (const [key, takes] of Object.entries(inputTakes(node, catalogue))) {
      if (takes) rete.addInput(key, new ClassicPreset.Input(port(takes.socket), key));
    }
    for (const [key, type] of Object.entries(node.outputs ?? {})) {
      rete.addOutput(key, new ClassicPreset.Output(port(takesOf(type).socket), key));
    }
  } else if (node.kind === 'input') {
    for (const [key, type] of Object.entries(node.outputs ?? {})) {
      rete.addOutput(key, new ClassicPreset.Output(port(takesOf(type).socket), key));
    }
  } else if (node.kind === 'zone') {
    for (const [key, takes] of Object.entries(inputTakes(node, catalogue))) {
      if (takes) rete.addInput(key, new ClassicPreset.Input(port(takes.socket), key));
    }
    rete.addOutput('out', new ClassicPreset.Output(port('Geometry'), 'out'));
  } else if (node.kind === 'output') {
    for (const [key, takes] of Object.entries(inputTakes(node, catalogue))) {
      if (takes) rete.addInput(key, new ClassicPreset.Input(port(takes.socket), key));
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

/** The drag in progress: the picked node's own track, and where the rest of
 * the selection started, so the whole selection moves as one. */
let group: { id: string; from: { x: number; y: number }; others: { id: string; from: { x: number; y: number } }[] } | null = null;

/**
 * While a wire is being dragged, every socket it could land on is lit and
 * everything else steps back. Wiring a graph you do not know by heart is
 * guessing until the canvas answers, and this is the answer.
 */
function showReach(from: { nodeId: string; side: string; key: string | number } | null): void {
  canvasHost.classList.toggle('graph-wiring', from !== null);
  for (const dot of canvasHost.querySelectorAll<HTMLElement>('[data-socket]')) {
    dot.classList.remove('graph-sock-fits');
    if (!from) continue;
    const body = dot.closest<HTMLElement>('.graph-node-body');
    const id = body?.dataset.node;
    const socket = dot.dataset.socket?.split(':') ?? [];
    if (!id || socket.length !== 2) continue;
    const [side, key] = socket as [string, string];
    // The same question the wire itself asks, asked of every socket at once.
    const forward = from.side === 'output' ? { from, to: { nodeId: id, side, key } } : { from: { nodeId: id, side, key }, to: from };
    if (wouldWire(forward.from, forward.to)) dot.classList.add('graph-sock-fits');
  }
}

/** What a wire let go over nothing is looking for: a word that takes what
 * the output carries, or one that makes what the input wants. */
export type Want = { side: 'output'; type: ValueType } | { side: 'input'; takes: Takes };

/** The wire that is waiting for a word, and where its node will stand. */
let waiting: { from: SocketSpot; at: { x: number; y: number }; want: Want } | null = null;

/** Every palette item's answer to "would you fit here?", set when it is
 * built, because a predicate per keystroke over 260 words is a filter the
 * artist can feel. */
const paletteFits = new Map<HTMLElement, (want: Want) => boolean>();

function wantOf(from: SocketSpot): Want | null {
  if (from.side === 'output') {
    const type = typeOfOutput(from.nodeId, from.key);
    return type ? { side: 'output', type } : null;
  }
  const node = nodeById(from.nodeId);
  const takes = node ? inputTakes(node, catalogue)[from.key] : undefined;
  return takes ? { side: 'input', takes } : null;
}

function wantLabel(want: Want): string {
  return want.side === 'output' ? want.type : (want.takes.any ? 'anything' : want.takes.kinds?.join(' | ') ?? want.takes.socket);
}

/** Show the words that would land on this wire, and wait for one. */
function askPalette(from: SocketSpot, at: { x: number; y: number }): void {
  const want = wantOf(from);
  if (!want) return;
  waiting = { from, at, want };
  for (const [item, fits] of paletteFits) item.dataset.fits = fits(want) ? '1' : '0';
  palette.classList.add('graph-asking');
  paletteSearch.value = '';
  paletteSearch.placeholder = want.side === 'output' ? `takes ${wantLabel(want)}` : `makes ${wantLabel(want)}`;
  filterPalette();
  paletteSearch.focus();
}

/** The wire is no longer waiting: every word is on offer again. */
function stopAsking(): void {
  if (!waiting) return;
  waiting = null;
  for (const item of paletteFits.keys()) delete item.dataset.fits;
  palette.classList.remove('graph-asking');
  paletteSearch.placeholder = 'search the catalogue';
  filterPalette();
}

/** Wire the node that answered to the socket that asked. The sockets are
 * read off the built node, so this knows what every kind has without a
 * second table. */
async function wireWaiting(node: GraphNode): Promise<void> {
  const held = waiting;
  if (!held) return;
  const rete = canvas.editor.getNode(node.id) as ReteNode | undefined;
  if (!rete) return;
  const mine = held.from.side === 'output' ? Object.keys(rete.inputs) : Object.keys(rete.outputs);
  const key = mine.find((name) => (held.from.side === 'output'
    ? wouldWire(held.from, { nodeId: node.id, side: 'input', key: name })
    : wouldWire({ nodeId: node.id, side: 'output', key: name }, held.from)));
  if (key !== undefined) {
    const wire = held.from.side === 'output'
      ? { source: held.from, target: { nodeId: node.id, side: 'input', key } }
      : { source: { nodeId: node.id, side: 'output', key }, target: held.from };
    await canvas.editor.addConnection({
      id: wireId({ source: wire.source.nodeId, sourceOutput: wire.source.key, target: wire.target.nodeId, targetInput: wire.target.key }),
      source: wire.source.nodeId, sourceOutput: wire.source.key, target: wire.target.nodeId, targetInput: wire.target.key,
    });
  }
  stopAsking();
}

/** A socket, as the connection plugin names one. */
interface SocketSpot { nodeId: string; side: string; key: string }

/** How far from a socket a drop still counts, in screen pixels. A ten-pixel
 * dot is a ten-pixel target only if the drop is judged by the dot. */
const REACH = 46;

/**
 * A wire let go over nothing. Two answers, in order: the nearest socket it
 * could have meant, if one is close enough to have been meant; otherwise the
 * palette, showing only the words that take (or make) what is on the wire,
 * and the word the artist picks is placed at the drop and wired.
 */
async function landWire(from: SocketSpot): Promise<void> {
  const at = pointerAt;
  if (!at) return;
  const near = nearestSocket(from, at);
  if (near) {
    const wire = from.side === 'output' ? { source: from, target: near } : { source: near, target: from };
    await canvas.editor.addConnection({
      id: wireId({ source: wire.source.nodeId, sourceOutput: wire.source.key, target: wire.target.nodeId, targetInput: wire.target.key }),
      source: wire.source.nodeId, sourceOutput: wire.source.key, target: wire.target.nodeId, targetInput: wire.target.key,
    });
    return;
  }
  if (tookAWire) return;
  askPalette(from, canvas.at(at.x, at.y));
}

/** The compatible socket nearest the drop, within reach. */
function nearestSocket(from: SocketSpot, at: { x: number; y: number }): SocketSpot | null {
  let best: { spot: SocketSpot; away: number } | null = null;
  for (const dot of canvasHost.querySelectorAll<HTMLElement>('[data-socket]')) {
    const body = dot.closest<HTMLElement>('.graph-node-body');
    const id = body?.dataset.node;
    const parts = dot.dataset.socket?.split(':') ?? [];
    if (!id || parts.length !== 2) continue;
    const spot: SocketSpot = { nodeId: id, side: parts[0]!, key: parts[1]! };
    const ok = from.side === 'output' ? wouldWire(from, spot) : wouldWire(spot, from);
    if (!ok) continue;
    const rect = dot.getBoundingClientRect();
    const away = Math.hypot(rect.x + rect.width / 2 - at.x, rect.y + rect.height / 2 - at.y);
    if (away > REACH) continue;
    if (!best || away < best.away) best = { spot, away };
  }
  return best?.spot ?? null;
}

/** Whether a wire from one socket to another would be allowed, without
 * saying anything about it: `allowWire` is the same rule, and it talks. */
function wouldWire(from: { nodeId: string; side: string; key: string | number }, to: { nodeId: string; side: string; key: string | number }): boolean {
  if (from.side !== 'output' || to.side !== 'input') return false;
  if (from.nodeId === to.nodeId) return false;
  const out = typeOfOutput(from.nodeId, String(from.key));
  const target = nodeById(to.nodeId);
  if (!out || !target) return false;
  if (target.kind === 'viewer') return true;
  const takes = inputTakes(target, catalogue)[String(to.key)];
  return takes !== undefined && accepts(out, takes);
}

// A wire being dragged: light what it can reach, and let go when it lands.
// These signals are the connection plugin's own, so this is where they are.
canvas.connection.addPipe((context) => {
  const signal = context as { type: string; data?: { socket?: { nodeId: string; side: string; key: string | number } } };
  if (signal.type === 'connectionpick' && signal.data?.socket) {
    tookAWire = false;
    showReach(signal.data.socket);
  }
  if (signal.type === 'connectiondrop') {
    showReach(null);
    const drop = signal.data as unknown as { initial: SocketSpot; socket: SocketSpot | null; created: boolean };
    if (!drop.created && drop.socket === null && drop.initial) void landWire(drop.initial);
  }
  return context;
});

/** This drag pulled an existing wire off its input. Dropping it over nothing
 * means "disconnect", so the palette does not then ask what to put there. */
let tookAWire = false;

canvas.editor.addPipe((context: Root<GraphScheme>) => {
  // A wire that landed: the drag is over either way.
  if (context.type === 'connectioncreated' || context.type === 'connectionremoved') showReach(null);
  if (context.type === 'connectionremoved') tookAWire = true;
  return context;
});

canvas.area.addPipe((context: AreaExtra | Root<GraphScheme>) => {
  // The artist's own view of this graph, kept as they move it.
  if (context.type === 'translated' || context.type === 'zoomed') {
    rememberView();
    paintGrid();
    paintMap();
  }
  if (context.type === 'nodetranslated' || context.type === 'noderesized') paintMap();
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
  if (context.type === 'nodetranslated') {
    const at = context.data.position;
    // Snap the node under the hand; the rest of the selection follows by the
    // same delta, so a picture that was arranged stays arranged. The
    // corrected translate comes back through here already on the grid, and
    // that pass is the one that moves the others.
    const leading = !group || context.data.id === group.id;
    if (snapping && leading && (onGrid(at.x) !== at.x || onGrid(at.y) !== at.y)) {
      void canvas.area.translate(context.data.id, { x: onGrid(at.x), y: onGrid(at.y) });
      return context;
    }
    if (group && context.data.id === group.id) {
      const dx = at.x - group.from.x;
      const dy = at.y - group.from.y;
      for (const other of group.others) {
        void canvas.area.translate(other.id, { x: other.from.x + dx, y: other.from.y + dy });
      }
    }
  }
  if (context.type === 'nodedragged') {
    const moved = group;
    group = null;
    const node = nodeById(context.data.id);
    const view = canvas.area.nodeViews.get(context.data.id);
    if (node && view) {
      placeTo(context.data.id, view.position);
      dirty = true;
      showDirty();
    }
    // The rest followed; their new places are the document's too.
    for (const other of moved?.others ?? []) {
      const rest = nodeById(other.id);
      const otherView = canvas.area.nodeViews.get(other.id);
      if (rest && otherView) placeTo(other.id, otherView.position);
    }
  }
  if (context.type === 'nodetranslated' || context.type === 'nodedragged' || context.type === 'noderesized') paintFrames();
  return context;
});

// A double-click on the empty canvas goes to the palette, ready to type.
canvasHost.addEventListener('dblclick', (event) => {
  const target = event.target as HTMLElement | null;
  if (target?.closest('.graph-node')) return;
  if (target && onChrome(target)) return;
  paletteSearch.focus();
  paletteSearch.select();
});

// A press on the empty canvas clears the selection.
canvasHost.addEventListener('pointerdown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && !target.closest('.graph-node') && !onChrome(target)) clearSelection();
});

/** The page's own controls that sit on the canvas rather than beside it. A
 * press on one is a press on a control: it clears nothing and draws no box.
 * Without this the align strip cleared the selection it was about to act
 * on — `pointerdown` lands before `click`. */
function onChrome(target: Element): boolean {
  return target.closest('.graph-arrange, .graph-map') !== null;
}

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
  if (target && onChrome(target)) return;
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
  const inside = (rect: DOMRect): string[] => painted()
    .filter(({ id }) => {
      const body = views.get(id)?.body?.getBoundingClientRect();
      if (!body) return false;
      return body.left < rect.right && body.right > rect.left && body.top < rect.bottom && body.bottom > rect.top;
    })
    .map(({ id }) => id);
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

/**
 * Align and distribute. The strip shows itself only when there is more than
 * one node picked, because that is the only time it means anything, and it
 * sits on the canvas rather than in the page head so it is next to the work.
 * Sizes are measured from the drawn node and fall back to the estimate the
 * layout uses, so a node that has not been drawn yet still lines up.
 */
type Placed = { node: GraphNode; w: number; h: number };

function placedSelection(): Placed[] {
  const zoom = canvas.area.area.transform.k || 1;
  return painted().filter(({ id }) => selection.has(id)).map(({ id, node }) => {
    const rect = views.get(id)?.body?.getBoundingClientRect();
    const box = rect && rect.width > 0 && rect.height > 0
      ? { width: rect.width / zoom, height: rect.height / zoom }
      : estimateBox(node, catalogue);
    return { node, w: box.width, h: box.height };
  });
}

/** Put the nodes where the arrangement says, in the document and on the
 * canvas at once. */
async function settle(places: { node: GraphNode; x: number; y: number }[]): Promise<void> {
  for (const place of places) {
    // The canvas is told where on the canvas; the node keeps its own place,
    // which for a node inside a frame is the frame's.
    const id = idOf(place.node);
    placeTo(id, { x: place.x, y: place.y });
    await canvas.area.translate(id, { x: Math.round(place.x), y: Math.round(place.y) });
  }
  paintFrames();
  touch();
}

type AlignTo = 'left' | 'middleX' | 'right' | 'top' | 'middleY' | 'bottom';

async function align(to: AlignTo): Promise<void> {
  const chosen = placedSelection();
  if (chosen.length < 2) return;
  const edge = {
    left: Math.min(...chosen.map((p) => p.node.x)),
    right: Math.max(...chosen.map((p) => p.node.x + p.w)),
    top: Math.min(...chosen.map((p) => p.node.y)),
    bottom: Math.max(...chosen.map((p) => p.node.y + p.h)),
  };
  const midX = (edge.left + edge.right) / 2;
  const midY = (edge.top + edge.bottom) / 2;
  await settle(chosen.map((p) => ({
    node: p.node,
    x: to === 'left' ? edge.left : to === 'right' ? edge.right - p.w : to === 'middleX' ? midX - p.w / 2 : p.node.x,
    y: to === 'top' ? edge.top : to === 'bottom' ? edge.bottom - p.h : to === 'middleY' ? midY - p.h / 2 : p.node.y,
  })));
}

/** Even gaps, with the two outermost nodes left where they are: the artist
 * set the span, the strip only shares it out. */
async function spread(axis: 'x' | 'y'): Promise<void> {
  const chosen = placedSelection();
  if (chosen.length < 3) return;
  const near = (p: Placed): number => (axis === 'x' ? p.node.x : p.node.y);
  const size = (p: Placed): number => (axis === 'x' ? p.w : p.h);
  const order = [...chosen].sort((a, b) => near(a) - near(b));
  const first = order[0]!;
  const last = order[order.length - 1]!;
  const span = near(last) + size(last) - near(first);
  const gap = (span - order.reduce((sum, p) => sum + size(p), 0)) / (order.length - 1);
  let at = near(first);
  await settle(order.map((p) => {
    const place = { node: p.node, x: axis === 'x' ? at : p.node.x, y: axis === 'y' ? at : p.node.y };
    at += size(p) + gap;
    return place;
  }));
}

const arrange = el('div', 'graph-arrange');
arrange.hidden = true;
for (const [name, label, run] of [
  ['alignLeft', 'Align left edges', () => align('left')],
  ['alignMiddleX', 'Align centres across', () => align('middleX')],
  ['alignRight', 'Align right edges', () => align('right')],
  ['alignTop', 'Align top edges', () => align('top')],
  ['alignMiddleY', 'Align centres down', () => align('middleY')],
  ['alignBottom', 'Align bottom edges', () => align('bottom')],
  ['spreadX', 'Even gaps across', () => spread('x')],
  ['spreadY', 'Even gaps down', () => spread('y')],
] as [IconName, string, () => Promise<void>][]) {
  arrange.append(iconButton(name, label, () => void run()));
}
canvasHost.append(arrange);

/**
 * The minimap. It shows itself only when the graph does not fit in the
 * viewport, because a map of what you can already see is furniture. The
 * picture is the document's own boxes — the same sizes align and the layout
 * use — with the viewport drawn over them, and a press anywhere on it takes
 * the view there.
 */
const mapBox = el('div', 'graph-map');
const mapCanvas = document.createElement('canvas');
mapBox.append(mapCanvas);
mapBox.hidden = true;
canvasHost.append(mapBox);

const MAP_W = 168;
const MAP_H = 118;

/** Every node's box in area units, and what the canvas can see of them. */
function mapShapes(): { boxes: { id: string; x: number; y: number; w: number; h: number }[]; view: { x: number; y: number; w: number; h: number } } {
  const zoom = canvas.area.area.transform.k || 1;
  const boxes = graph.nodes.map((node) => {
    const rect = views.get(node.id)?.body?.getBoundingClientRect();
    const box = rect && rect.width > 0 && rect.height > 0
      ? { width: rect.width / zoom, height: rect.height / zoom }
      : estimateBox(node, catalogue);
    return { id: node.id, x: node.x, y: node.y, w: box.width, h: box.height };
  });
  const { x, y, k } = canvas.area.area.transform;
  const view = { x: -x / k, y: -y / k, w: canvasHost.clientWidth / k, h: canvasHost.clientHeight / k };
  return { boxes, view };
}

let mapPending = false;

function paintMap(): void {
  if (mapPending) return;
  mapPending = true;
  requestAnimationFrame(() => {
    mapPending = false;
    drawMap();
  });
}

function drawMap(): void {
  const { boxes, view } = mapShapes();
  if (boxes.length === 0) { mapBox.hidden = true; return; }
  const world = {
    left: Math.min(...boxes.map((b) => b.x)),
    right: Math.max(...boxes.map((b) => b.x + b.w)),
    top: Math.min(...boxes.map((b) => b.y)),
    bottom: Math.max(...boxes.map((b) => b.y + b.h)),
  };
  // Everything in sight: no map.
  const inside = world.left >= view.x && world.right <= view.x + view.w
    && world.top >= view.y && world.bottom <= view.y + view.h;
  mapBox.hidden = inside;
  if (inside) return;

  const left = Math.min(world.left, view.x);
  const top = Math.min(world.top, view.y);
  const width = Math.max(world.right, view.x + view.w) - left;
  const height = Math.max(world.bottom, view.y + view.h) - top;
  const scale = Math.min(MAP_W / width, MAP_H / height);
  const dpr = window.devicePixelRatio || 1;
  mapCanvas.width = Math.round(MAP_W * dpr);
  mapCanvas.height = Math.round(MAP_H * dpr);
  mapCanvas.style.width = `${MAP_W}px`;
  mapCanvas.style.height = `${MAP_H}px`;
  const ink = mapCanvas.getContext('2d');
  if (!ink) return;
  ink.setTransform(dpr, 0, 0, dpr, 0, 0);
  ink.clearRect(0, 0, MAP_W, MAP_H);
  // Centred, so a tall graph is not stuck against one edge.
  const offX = (MAP_W - width * scale) / 2;
  const offY = (MAP_H - height * scale) / 2;
  const at = (x: number, y: number): [number, number] => [offX + (x - left) * scale, offY + (y - top) * scale];
  const style = getComputedStyle(canvasHost);
  const edge = style.getPropertyValue('--edge-strong') || 'rgba(255,255,255,0.2)';
  const accent = style.getPropertyValue('--accent') || '#5ac8a0';
  for (const box of boxes) {
    const [x, y] = at(box.x, box.y);
    ink.fillStyle = selection.has(box.id) ? accent : edge;
    ink.fillRect(x, y, Math.max(1.5, box.w * scale), Math.max(1.5, box.h * scale));
  }
  const [vx, vy] = at(view.x, view.y);
  ink.strokeStyle = accent;
  ink.lineWidth = 1;
  ink.strokeRect(vx + 0.5, vy + 0.5, view.w * scale, view.h * scale);
  mapCanvas.dataset.scale = String(scale);
  mapCanvas.dataset.left = String(left - offX / scale);
  mapCanvas.dataset.top = String(top - offY / scale);
}

/** A press on the map takes the view there, and a drag keeps taking it. */
function mapTo(event: PointerEvent): void {
  const scale = Number(mapCanvas.dataset.scale);
  if (!Number.isFinite(scale) || scale <= 0) return;
  const rect = mapCanvas.getBoundingClientRect();
  const wantX = Number(mapCanvas.dataset.left) + (event.clientX - rect.left) / scale;
  const wantY = Number(mapCanvas.dataset.top) + (event.clientY - rect.top) / scale;
  const k = canvas.area.area.transform.k || 1;
  canvas.lookAt({ k, x: canvasHost.clientWidth / 2 - wantX * k, y: canvasHost.clientHeight / 2 - wantY * k });
}

mapBox.addEventListener('pointerdown', (event) => {
  event.stopPropagation();
  event.preventDefault();
  mapBox.setPointerCapture(event.pointerId);
  mapTo(event);
});
mapBox.addEventListener('pointermove', (event) => {
  if (!mapBox.hasPointerCapture(event.pointerId)) return;
  mapTo(event);
});
mapBox.addEventListener('pointerup', (event) => {
  if (mapBox.hasPointerCapture(event.pointerId)) mapBox.releasePointerCapture(event.pointerId);
});
mapBox.addEventListener('wheel', (event) => event.stopPropagation());

/**
 * What flows through a socket, as a picture, while the pointer rests on it.
 *
 * The brief asks for thumbnails on geometry sockets. Always-on would be a
 * render per socket per edit, which is the opposite of the fifty-node rule in
 * the same list — so the picture is made when it is asked for, by resting on
 * the socket, and kept until the graph that made it changes. It is the viewer
 * node's own machinery: a viewer is wired to the socket in a copy of the
 * document, and what that viewer would show is what the thumbnail shows.
 */
const THUMB_DELAY = 420;
const THUMB_ID = 'thumb_socket';

const thumb = el('div', 'graph-thumb');
thumb.hidden = true;
const thumbCanvas = document.createElement('canvas');
const thumbNote = el('div', 'graph-thumb-note');
thumb.append(thumbCanvas, thumbNote);
canvasHost.append(thumb);
const thumbPreview = new Preview(thumbCanvas);

/** The last picture, by the compiled hash of what it draws. */
const thumbCache = new Map<string, RenderResult>();
let thumbTimer: number | undefined;
let thumbShowing: string | null = null;
let thumbTurn = 0;

function hideThumb(): void {
  window.clearTimeout(thumbTimer);
  thumbTimer = undefined;
  thumbTurn++;
  thumbShowing = null;
  thumb.hidden = true;
}

/** The viewer this socket would have, if it had one. */
function thumbViewer(nodeId: string, key: string): GraphNode {
  return { id: THUMB_ID, kind: 'viewer', x: 0, y: 0, inputs: { in: { from: [nodeId, key] } } };
}

async function showThumb(nodeId: string, key: string, dot: HTMLElement): Promise<void> {
  const at = `${nodeId}:${key}`;
  const type = typeOfOutput(nodeId, key);
  // Only geometry: a number is already written on the node that made it.
  if (!type || socketOf(type) !== 'Geometry') return;
  const fake = thumbViewer(nodeId, key);
  const show = viewerShow(fake);
  if (show === 'number') return;
  const host = canvasHost.getBoundingClientRect();
  const spot = dot.getBoundingClientRect();
  thumb.style.left = `${Math.min(host.width - 176, spot.right - host.left + 10)}px`;
  thumb.style.top = `${Math.max(6, Math.min(host.height - 150, spot.top - host.top - 60))}px`;
  thumbNote.textContent = `${key === 'out' ? nodeId : at} · ${type}`;
  thumb.hidden = false;
  thumbShowing = at;

  let compiled: CompiledSketch;
  try {
    const flattened = flat();
    compiled = compileFor(
      { ...flattened, nodes: [...flattened.nodes, fake] },
      catalogue,
      THUMB_ID,
      'in',
      {
        wrap: show === 'strokes' || show === 'try' ? (expression: string) => `strokes(${expression})` : undefined,
      },
    );
  } catch (error) {
    thumbPreview.setStale(true);
    thumbNote.textContent = error instanceof Error ? error.message : String(error);
    return;
  }
  const key2 = compiled.nodes.map((n) => n.hash).join('|');
  const cached = thumbCache.get(key2);
  if (cached) {
    thumbPreview.setPaperColor(cached.paper.color ?? settings.paperColor);
    thumbPreview.setResult(cached);
    thumbPreview.fit();
    return;
  }
  const mine = ++thumbTurn;
  thumbPreview.setStale(true);
  try {
    const reply = await client.render({ js: await jsOf(compiled.source), cfg: runConfig() }, () => mine === thumbTurn);
    if (!reply || mine !== thumbTurn || thumbShowing !== at) return;
    // A graph is small and a socket is looked at many times: keep a few.
    if (thumbCache.size > 24) thumbCache.clear();
    thumbCache.set(key2, reply.result);
    thumbPreview.setPaperColor(reply.result.paper.color ?? settings.paperColor);
    thumbPreview.setResult(reply.result);
    thumbPreview.fit();
  } catch (error) {
    if (mine !== thumbTurn) return;
    thumbPreview.setStale(true);
    thumbNote.textContent = error instanceof Error ? error.message : String(error);
  }
}

canvasHost.addEventListener('pointerover', (event) => {
  const target = event.target as HTMLElement | null;
  const dot = target?.closest<HTMLElement>('[data-socket]');
  const parts = dot?.dataset.socket?.split(':') ?? [];
  const body = dot?.closest<HTMLElement>('.graph-node-body');
  if (!dot || !body || parts[0] !== 'output' || !body.dataset.node) {
    if (!target?.closest('.graph-thumb')) hideThumb();
    return;
  }
  const at = `${body.dataset.node}:${parts[1]}`;
  if (thumbShowing === at) return;
  hideThumb();
  const turn = thumbTurn;
  thumbTimer = window.setTimeout(() => {
    if (turn !== thumbTurn) return;
    void showThumb(body.dataset.node!, parts[1]!, dot);
  }, THUMB_DELAY);
});

canvasHost.addEventListener('pointerleave', () => hideThumb());

/** Where the pointer last was over the canvas, in client pixels: paste puts
 * what it makes under the hand, the way the palette's drop does. */
let pointerAt: { x: number; y: number } | null = null;
canvasHost.addEventListener('pointermove', (event) => {
  pointerAt = { x: event.clientX, y: event.clientY };
});
canvasHost.addEventListener('pointerleave', () => { pointerAt = null; });

function applyWire(wire: GraphWire): void {
  // While the canvas is being rebuilt the document is already the truth:
  // and the teardown of the graph being replaced must never touch the new
  // one, whose node ids are likely the same names.
  if (loading) return;
  const target = nodeById(wire.target);
  if (!target) return;
  const key = String(wire.targetInput);
  // A wire inside a frame is a wire of the body, and the body names its own
  // nodes: the frame's prefix is the canvas's word, not the document's.
  const scope = wire.target.slice(0, wire.target.length - target.id.length);
  const source = wire.source.startsWith(scope) ? wire.source.slice(scope.length) : wire.source;
  target.inputs[key] = { ...target.inputs[key], from: [source, String(wire.sourceOutput)] };
  syncWired(target);
  // A list grows: the place that was free is taken, so a new free one has to
  // appear, and the node's sockets are rebuilt with it.
  if (target.kind === 'viewer' || target.kind === 'list') canvas.refresh(wire.target);
  touch();
}

function clearWire(wire: GraphWire): void {
  if (loading) return;
  const target = nodeById(wire.target);
  if (!target) return;
  // An input whose wire is taken off, with no literal left, is not in the
  // document: `{}` is neither a value nor an edge, and the compiler would
  // read it as a value of `undefined` rather than say which input is
  // missing. A list's place closes the gap by the same rule.
  cutWire(target, String(wire.targetInput));
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
  settleBodies();
  const showing = painted();
  for (const { id, node } of showing) await canvas.editor.addNode(reteNode(node, id));
  for (const { id, node } of showing) {
    // An inner node reads inner nodes: its wires are named inside the frame
    // it belongs to, so they take the same prefix its own name does.
    const scope = id.slice(0, id.length - node.id.length);
    for (const [key, input] of Object.entries(node.inputs)) {
      if (!input.from) continue;
      const [from, output] = input.from;
      const source = `${scope}${from}`;
      if (!nodeById(source)) continue;
      await canvas.editor.addConnection({
        id: wireId({ source, sourceOutput: output, target: id, targetInput: key }),
        source,
        sourceOutput: output,
        target: id,
        targetInput: key,
      });
    }
  }
  loading = false;
  paintFrames();
  // A graph's own positions can sit anywhere; bring them into view, once —
  // unless this graph has been looked at before, and then leave it where the
  // artist left it.
  if (!recallView(nameInput.value.trim())) canvas.fit();
}

function freshId(besides?: Map<string, string>, held: Graph = graph): string {
  const taken = new Set(besides ? [...besides.values()] : []);
  for (let i = 1; ; i++) if (!held.nodes.some((n) => n.id === `n${i}`) && !taken.has(`n${i}`)) return `n${i}`;
}

function paintSelection(): void {
  arrange.hidden = selection.size < 2;
  paintMap();
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
  // A wire that is waiting decides where its node stands: at the drop.
  const spot = freeSpot(waiting ? waiting.at : at);
  // Dropped inside an open frame, the node belongs to that body: the frame
  // is where the body is, so putting a node in it means putting it there.
  const host = frameAt(spot);
  const held = host ? host.graph! : graph;
  const origin = host ? frameOrigin(host) : { x: 0, y: 0 };
  node.id = freshId(undefined, held);
  node.x = spot.x - origin.x;
  node.y = spot.y - origin.y;
  held.nodes.push(node);
  const id = host ? `${host.id}${PATH}${node.id}` : node.id;
  canvasName.set(node, id);
  await canvas.editor.addNode(reteNode(node, id));
  // In front and picked: the node the artist just made is the node they are
  // working on.
  canvas.raise(id);
  select(id);
  if (waiting) await wireWaiting(node);
  if (host) paintFrames();
  touch();
}

/** The open zone whose frame covers this place, if any. */
function frameAt(at: { x: number; y: number }): GraphNode | undefined {
  for (const zone of openZones()) {
    const origin = frameOrigin(zone);
    let w = 220;
    let h = 120;
    for (const inner of zone.graph!.nodes) {
      const view = canvas.area.nodeViews.get(`${zone.id}${PATH}${inner.id}`);
      w = Math.max(w, inner.x + (view?.element.offsetWidth ?? 180));
      h = Math.max(h, inner.y + (view?.element.offsetHeight ?? 120));
    }
    if (at.x >= origin.x - FRAME_PAD && at.x <= origin.x + w + FRAME_PAD
      && at.y >= origin.y - FRAME_PAD && at.y <= origin.y + h + FRAME_PAD) return zone;
  }
  return undefined;
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

/** A group from the palette: it carries what its boundary declares, so a
 * document whose group has since been deleted still shows its shape. */
function addGroup(name: string, at?: { x: number; y: number }): void {
  const group = groupCache.get(name);
  if (!group) {
    status(`no group named ${name}`, 'err');
    return;
  }
  void place({
    id: freshId(), kind: 'group', word: name, x: 0, y: 0,
    inputs: {}, outputs: groupOutputs(group, catalogue),
  }, at);
}

function addNode(kind: 'code' | 'viewer' | 'output' | 'value' | 'list' | 'paper', at?: { x: number; y: number }): void {
  const id = freshId();
  const node: GraphNode = kind === 'code'
    ? { id, kind, x: 0, y: 0, inputs: {}, outputs: { out: 'Number' }, body: 'return { out: 1 };' }
    : kind === 'value'
      ? { id, kind, x: 0, y: 0, inputs: { v: { value: 0 } }, outputs: { out: 'Number' } }
      : kind === 'list'
        ? { id, kind, x: 0, y: 0, inputs: {}, outputs: { out: 'Geometry' } }
        : kind === 'paper'
          ? { id, kind, x: 0, y: 0, inputs: {}, outputs: Object.fromEntries(Object.keys(PAPER_OUTPUTS).map((k) => [k, 'Number' as const])) }
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
  // A node inside an open frame belongs to that body, and so do the wires
  // that named it.
  const inner = zoneOf(id);
  const held = inner ? inner.zone.graph! : graph;
  const name = inner ? inner.innerId : id;
  held.nodes = held.nodes.filter((n) => n.id !== name);
  for (const other of held.nodes) {
    for (const input of Object.values(other.inputs)) if (input.from?.[0] === name) delete input.from;
    syncWired(other);
  }
  if (inner) paintFrames();
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
  showDirty();
  status(`laid out ${graph.nodes.length} nodes`);
}

// ---- compile and render ----

/** The document as the compiler sees it: every group inlined. The page
 * paints and saves the document — group nodes intact — and compiles this. */
function flat(source: Graph = graph): Graph {
  if (!source.nodes.some((node) => node.kind === 'group')) return source;
  return expand(source, { get: (name) => groupCache.get(name) });
}

function compileNow(): CompiledSketch | null {
  markErrors(null);
  try {
    return compileGraph(flat(), catalogue);
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
  paintMap();
  // A picture of a socket is a picture of the graph that fed it.
  thumbCache.clear();
  hideThumb();
  dirty = true;
  showDirty();
  saveDraft();
  step();
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
  // A folded viewer has no canvas, and a picture nobody can see is a render
  // nobody asked for.
  for (const node of graph.nodes.filter((n) => n.kind === 'viewer' && !n.collapsed)) {
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
  const sketchFor = (wrapped: boolean): CompiledSketch => compileFor(flat(), catalogue, node.id, 'in', {
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
  // A camera with a scene in hand needs no new run; without one it does, and
  // the cache would have said there was nothing to do.
  if (cached?.hash === hash && (!view?.camera || viewerModels.has(node.id))) {
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
      showModel(node, reply);
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
        showModel(node, bare);
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

/** A render arrived: remember the scene it built, hand it to the camera that
 * is showing it, and let a viewer that has just grown one say so. */
function showModel(node: GraphNode, reply: { executionId: number; construction: ConstructionInfo3[] }): void {
  const had = (viewerModels.get(node.id)?.construction.length ?? 0) > 0;
  viewerModels.set(node.id, { executionId: reply.executionId, construction: reply.construction });
  const has = reply.construction.length > 0;
  const view = views.get(node.id);
  if (view?.camera) view.camera.offer(reply.executionId, reply.construction[0]);
  // The switch appears (or goes) with the scene, and only then: a repaint
  // per render would throw away the editor state of every node.
  else if (has !== had && !node.collapsed) canvas.refresh(node.id);
}

// ---- the palette ----

/** The word being dragged out of the palette, and how to add it. */
let dragging: ((at?: { x: number; y: number }) => void) | null = null;

function paletteItem(
  word: string,
  returns: string,
  add: (at?: { x: number; y: number }) => void,
  hint: string,
  fits: (want: Want) => boolean = () => false,
): HTMLButtonElement {
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
  paletteFits.set(item, fits);
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
  paletteFits.clear();
  const nodes = el('div', 'graph-palette-group');
  nodes.append(el('div', 'graph-palette-title', 'Nodes'));
  const makes = (type: ValueType) => (want: Want): boolean => want.side === 'input' && accepts(type, want.takes);
  const takesAny = (want: Want): boolean => want.side === 'output';
  nodes.append(paletteItem('value', 'Number', (at) => addNode('value', at), 'A number the graph holds', makes('Number')));
  nodes.append(paletteItem('list', 'drawing', (at) => addNode('list', at), 'Several values as one, in order',
    (want) => want.side === 'output' || accepts('Geometry', want.takes)));
  nodes.append(paletteItem('paper', 'Number', (at) => addNode('paper', at), 'The sheet: its width, its height and its middle', makes('Number')));
  // One pen, wired wherever it draws: change it in one place.
  nodes.append(paletteItem('pen', 'Pen', (at) => void place({
    id: freshId(), kind: 'value', x: 0, y: 0,
    inputs: { v: { value: pens[0]?.name ?? '' } }, outputs: { out: 'Pen' },
  }, at), 'A pen, wired wherever it draws', makes('Pen')));
  nodes.append(paletteItem('code', 'body', (at) => addNode('code', at), 'A function body with declared inputs and outputs', makes('Number')));
  nodes.append(paletteItem('viewer', 'picture', (at) => addNode('viewer', at), 'Draw what this point of the graph holds', takesAny));
  nodes.append(paletteItem('output', 'return', (at) => addNode('output', at), 'What the sketch returns',
    (want) => want.side === 'output' && accepts(want.type, { socket: 'Geometry', kinds: ['shape', 'drawing'] })));
  paletteList.append(nodes);

  if (groupCache.size > 0) {
    const mine = el('div', 'graph-palette-group');
    mine.append(el('div', 'graph-palette-title', 'Groups'));
    for (const [name, group] of groupCache) {
      const outs = groupOutputs(group, catalogue);
      const returns = Object.values(outs)[0] ?? 'drawing';
      mine.append(paletteItem(
        name,
        returns,
        (at) => addGroup(name, at),
        `${name} — a sub-graph you made`,
        (want) => (want.side === 'input'
          ? Object.values(outs).some((type) => accepts(type, want.takes))
          : Object.values(groupInputs(group)).some((takes) => accepts(want.type, takes))),
      ));
    }
    paletteList.append(mine);
  }

  const groups = new Map<string, HTMLElement>();
  for (const word of catalogue.words) {
    let group = groups.get(word.group);
    if (!group) {
      group = el('div', 'graph-palette-group');
      group.append(el('div', 'graph-palette-title', word.group));
      groups.set(word.group, group);
      paletteList.append(group);
    }
    group.append(paletteItem(word.word, word.returns, (at) => addBuiltin(word, at), `${word.word} → ${word.returns}${word.page ? ` · ${word.page}` : ''}`,
      (want) => (want.side === 'input'
        ? accepts(word.returns, want.takes)
        : wordInputs(word).some((input) => input.takes !== undefined && accepts(want.type, input.takes)))));
  }
  // The count is the filter's to write: it is the number on offer.
  filterPalette();
}

/** The word the arrows are on: typing filters, the arrows move, Enter adds. */
let marked = -1;

function shownWords(): HTMLElement[] {
  return [...paletteList.querySelectorAll<HTMLElement>('.graph-palette-item')].filter((item) => !item.hidden);
}

function mark(at: number): void {
  const items = shownWords();
  for (const item of items) item.classList.remove('graph-palette-on');
  if (items.length === 0) {
    marked = -1;
    return;
  }
  marked = ((at % items.length) + items.length) % items.length;
  const item = items[marked]!;
  item.classList.add('graph-palette-on');
  item.scrollIntoView({ block: 'nearest' });
}

function filterPalette(): void {
  const query = paletteSearch.value.trim().toLowerCase();
  let offered = 0;
  for (const group of paletteList.querySelectorAll<HTMLElement>('.graph-palette-group')) {
    let shown = 0;
    for (const item of group.querySelectorAll<HTMLElement>('.graph-palette-item')) {
      const word = item.querySelector('.graph-palette-word')?.textContent?.toLowerCase() ?? '';
      const named = query === '' || word.includes(query) || (group.querySelector('.graph-palette-title')?.textContent ?? '').toLowerCase().includes(query);
      // A wire is waiting: only the words that would land on it are on offer.
      const on = named && (item.dataset.fits === undefined || item.dataset.fits === '1');
      item.hidden = !on;
      if (on) shown++;
    }
    group.hidden = shown === 0;
    offered += shown;
  }
  // The count says how many words are on offer, not how many exist, whenever
  // those differ: a narrowed palette that still reads 259 is a lie.
  const count = paletteHead.querySelector('.graph-palette-count');
  const all = paletteFits.size;
  if (count) count.textContent = offered === all ? `${all}` : `${offered}/${all}`;
  // Typing puts the mark on the first word it finds, so Enter adds the word
  // you were looking for without reaching for the mouse.
  mark(0);
}

paletteSearch.oninput = filterPalette;

// The palette is a keyboard first: type to narrow, arrows to move, Enter to
// add at the middle of the view, Escape to give up on the search.
paletteSearch.addEventListener('keydown', (event) => {
  const items = shownWords();
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    mark(marked + (event.key === 'ArrowDown' ? 1 : -1));
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    items[marked === -1 ? 0 : marked]?.click();
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (paletteSearch.value === '') {
      // A wire waiting for a word is called off first: the artist is looking
      // at a narrowed palette, and Escape is how they say never mind.
      if (waiting) stopAsking();
      else paletteSearch.blur();
      return;
    }
    paletteSearch.value = '';
    filterPalette();
  }
});

// ---- storage ----

/**
 * The group a Save writes back, when the page is showing the inside of one
 * rather than a graph. A group's document holds an `input` node, which no
 * compiled graph may hold, so the two cannot be confused — and Save says so
 * rather than writing a graph nothing can compile.
 */
let editingGroup: string | null = null;

/** Read every saved group, and tell the catalogue what each one offers. */
async function loadGroups(): Promise<void> {
  const known = new Map<string, Group>();
  try {
    for (const info of await listGroups()) {
      try {
        known.set(info.name, JSON.parse(await loadGroupText(info.name)) as Group);
      } catch (error) {
        notify(`group '${info.name}': ${error instanceof Error ? error.message : String(error)}`, 'warning');
      }
    }
  } catch (error) {
    notify(`groups: ${error instanceof Error ? error.message : String(error)}`, 'danger');
    return;
  }
  groupCache.clear();
  for (const [name, group] of known) groupCache.set(name, group);
  catalogue = {
    ...catalogue,
    groups: Object.fromEntries([...groupCache].map(([name, group]) => [name, {
      inputs: groupInputs(group),
      outputs: groupOutputs(group, catalogue),
    }])),
  };
}

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

/**
 * Show the inside of a group as its own document. It is a graph like any
 * other except for its boundary: an `input` node is a source, and Save
 * writes it back to the group library rather than to the graph store.
 */
async function openGroup(name: string): Promise<boolean> {
  const group = groupCache.get(name);
  if (!group) {
    notify(`no group named '${name}'`, 'warning');
    return false;
  }
  if (dirty && !(await confirmDialog({ title: `Open the group '${name}'?`, body: 'The open graph has unsaved changes.', confirm: 'Open' }))) return false;
  generation += 1;
  try {
    graph = parseGraph(JSON.parse(JSON.stringify(group.graph)));
    graph.name = name;
    editingGroup = name;
    nameInput.value = name;
    mainSource = null;
    fitted = null;
    viewerResults.clear();
    viewerFrames.clear();
    viewerModels.clear();
    await buildCanvas();
    seedInput.value = typeof graph.config.seed === 'number' ? String(graph.config.seed) : '';
    startHistory();
    dirty = false;
    showDirty();
    clearSelection();
    // The inside of a group has no output of its own to draw: what it makes
    // is the group's result, and a render of it would be a render of nothing.
    // The picture on the page belongs to the graph that was open before.
    preview.setStale(true);
    status(`the group '${name}' — Save writes it back`);
    return true;
  } catch (error) {
    notify(`open group '${name}': ${error instanceof Error ? error.message : String(error)}`, 'danger');
    return false;
  }
}

/**
 * The selection becomes a group: one node in its place, and a document of
 * its own in the library. Every wire that entered the selection is an input
 * of the group and every wire that left it an output — `collapse` works that
 * out, and the ink must not change, which is what makes it worth doing.
 */
async function collapseSelection(): Promise<void> {
  if (selection.size === 0) {
    status('pick the nodes to group first', 'err');
    return;
  }
  const name = await promptDialog({ title: 'Group', body: 'The nodes you picked become one node, and a graph of their own.', label: 'Name', placeholder: 'a name for this group', confirm: 'Group' });
  if (name === null) return;
  const clean = name.trim();
  // A group's name is part of the name of every node inside it once it is
  // inlined, so it is an identifier and not a title.
  if (!isUsableName(clean) || clean.length > 64) {
    notify('a group name is letters, digits and _ — not starting with a digit (max 64)', 'warning');
    return;
  }
  if (groupCache.has(clean) && !(await confirmDialog({ title: `Replace '${clean}'?`, body: 'A group of that name is already saved.', confirm: 'Replace' }))) return;
  let made;
  try {
    made = collapse(graph, [...selection], clean, catalogue);
  } catch (error) {
    notify(`group: ${error instanceof Error ? error.message : String(error)}`, 'danger');
    return;
  }
  try {
    await saveGroupText(clean, JSON.stringify(made.group));
  } catch (error) {
    notify(`group: ${error instanceof Error ? error.message : String(error)}`, 'danger');
    return;
  }
  await loadGroups();
  buildPalette();
  graph = made.graph;
  generation += 1;
  mainSource = null;
  viewerResults.clear();
  viewerModels.clear();
  await buildCanvas();
  selection = new Set([made.node.id]);
  paintSelection();
  touch();
  notify(`grouped ${made.group.graph.nodes.length - 2} nodes as '${clean}'`, 'success');
}

async function open(name: string): Promise<boolean> {
  if (dirty && !(await confirmDialog({ title: `Open '${name}'?`, body: 'The open graph has unsaved changes.', confirm: 'Open' }))) return false;
  // The document is about to change: a reply in flight belongs to the graph
  // being left behind, and must not be applied to the new one.
  generation += 1;
  try {
    const text = await loadGraphText(name);
    const next = parseGraph(JSON.parse(text));
    graph = next;
    editingGroup = null;
    nameInput.value = next.name;
    mainSource = null;
    fitted = null;
    viewerResults.clear();
    viewerFrames.clear();
    await buildCanvas();
    seedInput.value = typeof next.config.seed === 'number' ? String(next.config.seed) : '';
  startHistory();
    history.replaceState(null, '', graphHref(next.name));
    dirty = false;
    showDirty();
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
  // A document with a boundary in it is the inside of a group. It is saved as
  // one, because as a graph it is a thing the compiler must refuse.
  if (graph.nodes.some((node) => node.kind === 'input')) {
    if (editingGroup === null) {
      notify('this graph holds a group boundary — it can only be saved as a group', 'warning');
      return;
    }
    try {
      await saveGroupText(name, JSON.stringify({ version: 1, name, graph } satisfies Group));
      editingGroup = name;
      await loadGroups();
      buildPalette();
      dirty = false;
      showDirty();
      dropDraft();
      notify(`saved the group '${name}'`, 'success');
    } catch (error) {
      notify(`save: ${error instanceof Error ? error.message : String(error)}`, 'danger');
    }
    return;
  }
  try {
    await saveGraphText(name, graphToJson(graph));
    history.replaceState(null, '', graphHref(name));
    dirty = false;
    showDirty();
    // What is in the store needs no draft.
    dropDraft();
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
  dirty = true;
  showDirty(); // the imported graph has no name in the store yet
  startHistory();
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
  startHistory();
  history.replaceState(null, '', '/graph.html');
  dirty = false;
  showDirty();
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
    startHistory();
    clearSelection();
    await renderAll();
  } catch (error) {
    notify(`delete: ${error instanceof Error ? error.message : String(error)}`, 'danger');
  }
}

/** Exactly what the docs' live embeds do: the source goes into the studio's
 * buffer and the studio opens on it. */
/**
 * Evolve, on a graph. The page rewrites literals in source and runs seeds
 * against each other; a graph is a program like any other once it is
 * compiled, so it goes over as the editor's unsaved buffer does — which is
 * also why what comes back is a sketch, not a graph. The graph is untouched.
 */
function evolveGraph(): void {
  let compiled: CompiledSketch;
  try {
    compiled = compileGraph(flat(), catalogue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status(message, 'err');
    markErrors(message);
    return;
  }
  const name = graph.name && graph.name !== 'untitled' ? graph.name : '';
  stashLive({ name, source: `${compiled.source}\n${layoutBlock(graph)}` });
  const params = new URLSearchParams({ live: '1' });
  if (name) params.set('sketch', name);
  if (typeof graph.config.seed === 'number') params.set('seed', String(graph.config.seed));
  leaving = true;
  location.href = `/evolve.html?${params.toString()}`;
}

function openAsSketch(): void {
  let compiled: CompiledSketch;
  try {
    compiled = compileGraph(flat(), catalogue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status(message, 'err');
    markErrors(message);
    return;
  }
  // The sketch carries where the nodes stood, so opening it back as a graph
  // lands them where the artist left them. The compiler never writes this:
  // its source is the ink's, and the ink oracle compares it.
  localStorage.setItem('occlude.sketch', `${compiled.source}\n${layoutBlock(graph)}`);
  localStorage.setItem('occlude.sketchName', '');
  localStorage.setItem('occlude.openSettings', JSON.stringify({
    paper: settings.paper,
    customPaper: settings.customPaper,
    landscape: settings.landscape,
    defaultMarginPct: settings.defaultMarginPct,
  }));
  // The page is leaving on purpose, with the work handed to the studio: the
  // unsaved-work guard must not stop the artist from doing what they asked
  // for. The draft is written either way, so nothing is lost.
  leaving = true;
  location.href = '/';
}

nameInput.oninput = () => { dirty = true; };
seedInput.onchange = () => {
  const n = Number(seedInput.value);
  graph.config.seed = seedInput.value.trim() === '' || !Number.isFinite(n) ? undefined : n;
  touch();
};

document.addEventListener('keydown', (event) => {
  // The document itself can be the target, and it has no `closest`: a key
  // pressed with nothing focused would have thrown before it was read.
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('input, textarea, select, .monaco-editor')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    void walk(!event.shiftKey);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    void walk(false);
    return;
  }
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
  if (event.key === 'Escape') { stopAsking(); clearSelection(); }
  // Blender's key for it: frame everything.
  if (event.key === 'Home') {
    event.preventDefault();
    canvas.fit();
  }
  // Blender's key for it: the selection becomes a group.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') {
    event.preventDefault();
    void collapseSelection();
  }
  // Blender's key: fold the selection down to titles and sockets.
  if (event.key.toLowerCase() === 'h' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (selection.size === 0) return;
    event.preventDefault();
    void foldSelection();
  }
  // Duplicate the selection where it stands, a little aside.
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
    event.preventDefault();
    void duplicateSelection();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
    event.preventDefault();
    copySelection();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'x') {
    event.preventDefault();
    void cutSelection();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
    event.preventDefault();
    void pasteClipping();
  }
});

/** Take the wire off an input. What is left is the input's own literal, or
 * nothing at all — and an input that is set to nothing is not in the
 * document, because `{}` is neither a value nor an edge. */
function cutWire(node: GraphNode, key: string): void {
  const input = node.inputs[key];
  if (!input) return;
  delete input.from;
  delete input.spread;
  if (input.value === undefined) delete node.inputs[key];
}

/**
 * Put a set of nodes into the open graph: fresh ids, moved by (dx, dy), and
 * the wires among them re-pointed at the copies. A wire that leaves the set
 * survives only when the thing it comes from is still in this graph — true
 * for a duplicate, false for a paste from another document, where it is
 * dropped and the input falls back to its own control.
 */
async function implant(source: GraphNode[], dx: number, dy: number): Promise<GraphNode[]> {
  const renamed = new Map<string, string>();
  for (const node of source) renamed.set(node.id, freshId(renamed));
  const made: GraphNode[] = [];
  for (const node of source) {
    const copy = cloneNode(node);
    copy.id = renamed.get(node.id)!;
    copy.x = node.x + dx;
    copy.y = node.y + dy;
    for (const [key, input] of Object.entries(copy.inputs)) {
      const from = input.from?.[0];
      if (from === undefined) continue;
      if (renamed.has(from)) input.from = [renamed.get(from)!, input.from![1]];
      // An input with nothing left in it is an input that is not set: the
      // document says so by leaving the key out, not by holding `{}`.
      else if (!nodeById(from)) cutWire(copy, key);
    }
    graph.nodes.push(copy);
    made.push(copy);
  }
  for (const copy of made) await canvas.editor.addNode(reteNode(copy));
  for (const copy of made) {
    for (const [key, input] of Object.entries(copy.inputs)) {
      if (!input.from || !nodeById(input.from[0])) continue;
      await canvas.editor.addConnection({
        id: wireId({ source: input.from[0], sourceOutput: input.from[1], target: copy.id, targetInput: key }),
        source: input.from[0], sourceOutput: input.from[1], target: copy.id, targetInput: key,
      });
    }
  }
  selection = new Set(made.map((node) => node.id));
  paintSelection();
  for (const copy of made) canvas.raise(copy.id);
  touch();
  return made;
}

/** Fold the picked nodes, or open them all again when every one is already
 * folded. One key, and the answer is never half of each. */
async function foldSelection(): Promise<void> {
  const chosen = graph.nodes.filter((node) => selection.has(node.id));
  if (chosen.length === 0) return;
  const on = !chosen.every((node) => node.collapsed === true);
  for (const node of chosen) {
    if (on) node.collapsed = true;
    else delete node.collapsed;
    canvas.refresh(node.id);
  }
  if (!on && chosen.some((node) => node.kind === 'viewer')) schedule();
  touch();
}

/** The selection again, a little down and to the right. */
async function duplicateSelection(): Promise<void> {
  const chosen = graph.nodes.filter((node) => selection.has(node.id));
  if (chosen.length === 0) return;
  await implant(chosen, 36, 30);
}

const CLIP = 'occlude.graph.clip';

/**
 * A clipping is a graph document that holds only the copied nodes, so the
 * one reader (`parseGraph`) reads it. It is written to the system clipboard
 * *and* to local storage: the clipboard carries it between windows and out
 * to a text editor, and the store is what a browser that refuses to hand
 * back the clipboard falls back to.
 */
function copySelection(): void {
  const chosen = graph.nodes.filter((node) => selection.has(node.id));
  if (chosen.length === 0) return;
  // A wire that leaves the selection has no meaning once the clipping is on
  // its own, so it is cut here and the clipping is a graph in its own right.
  const kept = new Set(chosen.map((node) => node.id));
  const nodes = chosen.map((node) => {
    const copy = cloneNode(node);
    for (const [key, input] of Object.entries(copy.inputs)) {
      if (input.from && !kept.has(input.from[0])) cutWire(copy, key);
    }
    return copy;
  });
  const text = graphToJson({ ...graph, name: 'clipping', nodes });
  try { localStorage.setItem(CLIP, text); } catch { /* private window */ }
  void navigator.clipboard?.writeText(text).catch(() => undefined);
  status(`copied ${chosen.length} node${chosen.length === 1 ? '' : 's'}`);
}

async function cutSelection(): Promise<void> {
  if (selection.size === 0) return;
  copySelection();
  for (const id of [...selection]) await removeNode(id);
}

function clippingOf(text: string | null): GraphNode[] | null {
  if (!text || !text.trimStart().startsWith('{')) return null;
  try {
    const nodes = parseGraph(JSON.parse(text)).nodes;
    return nodes.length > 0 ? nodes : null;
  } catch { return null; }
}

/** Paste under the pointer, or in the middle of the view when the pointer is
 * elsewhere. The clipping keeps its own shape: every node moves by the same
 * amount, so what was one picture stays one picture. */
async function pasteClipping(): Promise<void> {
  let text: string | null = null;
  try { text = await navigator.clipboard.readText(); } catch { text = null; }
  let nodes = clippingOf(text);
  if (!nodes) {
    try { nodes = clippingOf(localStorage.getItem(CLIP)); } catch { nodes = null; }
  }
  if (!nodes) { status('nothing to paste', 'err'); return; }
  const at = pointerAt ? canvas.at(pointerAt.x, pointerAt.y) : canvas.centre();
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const spot = freeSpot(at);
  const made = await implant(nodes, spot.x - left, spot.y - top);
  status(`pasted ${made.length} node${made.length === 1 ? '' : 's'}`);
}

// Leaving with work that is not saved asks first. The draft is written
// either way, so an answer of "leave" still loses nothing.
/** This page is navigating because the artist asked it to. */
let leaving = false;

window.addEventListener('beforeunload', (event) => {
  if (!dirty || leaving) return;
  event.preventDefault();
  event.returnValue = '';
});

window.addEventListener('resize', () => {
  for (const view of views.values()) view.preview?.fit();
  // A smaller window is a smaller viewport: what fitted a moment ago may not.
  paintMap();
});

// ---- boot ----

async function boot(): Promise<void> {
  setSnap(snapping);
  paintGrid();
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
  // The groups are words too: read them before the palette is built, and the
  // catalogue answers for them from the first paint.
  await loadGroups();
  buildPalette();
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
  // A draft of work that was never saved: it is the artist's, and it is
  // offered before the template is.
  const draft = takeDraft();
  if (!wanted && draft) {
    const when = new Date(draft.at);
    const name = draft.name || 'an unnamed graph';
    const keep = await confirmDialog({
      title: 'Unsaved work',
      body: `${name} has changes from ${when.toLocaleString()} that were never saved. Open them?`,
      confirm: 'Open the draft',
    });
    if (keep) {
      try {
        graph = parseGraph(draft.graph);
        nameInput.value = draft.name;
        seedInput.value = typeof graph.config.seed === 'number' ? String(graph.config.seed) : '';
        await buildCanvas();
        startHistory();
        await refreshList();
        dirty = true;
        showDirty();
        await renderAll();
        return;
      } catch (error) {
        notify(`that draft would not open: ${error instanceof Error ? error.message : String(error)}`, 'danger');
      }
    }
    dropDraft();
  }
  graph = template();
  seedInput.value = String(graph.config.seed ?? '');
  await buildCanvas();
  startHistory();
  await refreshList();
  dirty = false;
  showDirty();
  await renderAll();
  if (fallback) {
    status(fallback, 'err');
    notify(fallback, 'warning');
  }
}

void boot();
