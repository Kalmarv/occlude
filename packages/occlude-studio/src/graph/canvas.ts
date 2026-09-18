/**
 * The graph canvas: Rete's area, its connections and the plain-DOM render
 * plugin Rete v2 does not ship. Rete's own plugins render through a
 * framework (React, Vue, Angular, Svelte); the studio has no framework, so
 * the DOM is built here. The protocol is the one rete-react-plugin
 * implements, read off the installed packages:
 *
 * - the render plugin is a child of the area and owns a `render` pipe:
 *   a `render` signal for an element nothing has filled is mounted, and the
 *   context comes back marked `filled`;
 * - a node's element is positioned by `area.translate`, its size by the
 *   body inside it; the node body itself is built by the page (the `paint`
 *   hook), so Rete never learns what a node looks like;
 * - a socket is announced twice: a `render` signal so the connection plugin
 *   caches the element and listens on it, and a `rendered` signal so the
 *   socket-position watcher measures it. Both are emitted upward through
 *   the area, which is the only path from a child scope;
 * - a connection is an `<svg>` with one `<path>`, redrawn from the two
 *   socket positions the watcher reports;
 * - a refused wire is refused by `ClassicFlow`'s `canMakeConnection`; the
 *   page's hook says why, and drops the pseudo-connection itself.
 */

import { ClassicPreset, GetSchemes, NodeEditor, Scope } from 'rete';
import { AreaExtensions, AreaPlugin, type Area2D, type Position, type RenderSignal } from 'rete-area-plugin';
import { ClassicFlow, ConnectionPlugin, type Side, type SocketData } from 'rete-connection-plugin';
import { classicConnectionPath, getDOMSocketPosition, type DOMSocketPosition } from 'rete-render-utils';

export type ReteNode = ClassicPreset.Node;
export type GraphWire = ClassicPreset.Connection<ClassicPreset.Node, ClassicPreset.Node> & { isPseudo?: boolean };
export type GraphScheme = GetSchemes<ReteNode, GraphWire>;

/** The socket render signal: how a connection end finds its element. */
export type SocketRender = RenderSignal<'socket', { nodeId: string; side: Side; key: string }>;
/** The signals this page's area carries: Rete's own, and the socket render
 * signal the DOM render plugin announces a socket with. One union on both
 * sides of the area, so Rete's scope variance check is satisfied. */
export type AreaExtra = Area2D<GraphScheme> | SocketRender;

type RenderContext = { data: { element: HTMLElement; type: string; filled?: boolean } & Record<string, unknown> };

const SVG_NS = 'http://www.w3.org/2000/svg';
/** How far a wire bows between its two ends. */
const CURVATURE = 0.3;

export interface CanvasHooks {
  /** Build a node's body inside its element. Called on mount and whenever
   * the node is re-rendered (`area.update('node', id)`). */
  paint(id: string, body: HTMLElement): void;
  /** Where the node sits, in area coordinates. */
  position(id: string): Position | null;
  /** The node was picked: the page selects it, adding when shift is held. */
  pick(id: string, shift: boolean): void;
  /** May this wire exist? `from` is the socket the drag started at. */
  allowWire(from: SocketData, to: SocketData): boolean;
}

export interface GraphCanvas {
  editor: NodeEditor<GraphScheme>;
  area: AreaPlugin<GraphScheme, AreaExtra>;
  connection: ConnectionPlugin<GraphScheme, AreaExtra>;
  /** Area coordinates of a point of the page. */
  at(clientX: number, clientY: number): Position;
  /** The middle of the viewport, in area coordinates. */
  centre(): Position;
  /** Rebuild one node's body (sockets and all) and re-measure its wires. */
  refresh(id: string): void;
  /** Bring every node into view. */
  fit(): void;
}

/** The DOM render plugin. One element per node, socket and connection. */
class DomRender extends Scope<never, [AreaExtra]> {
  /** Each connection element's unlisten functions. */
  private wires = new Map<HTMLElement, (() => void)[]>();

  /** How many nodes have been pressed: the last one pressed is the one on
   * top. Nodes overlap, and a node under another one has its sockets and
   * its size handle out of reach until it comes forward. */
  private raised = 0;

  constructor(
    private area: AreaPlugin<GraphScheme, AreaExtra>,
    private watcher: DOMSocketPosition<GraphScheme, AreaExtra>,
    private hooks: CanvasHooks,
  ) {
    super('graph-dom-render');
    // The pipe sees every signal the area forwards. The union is Rete's, and
    // the spread keeps its discriminant, so the one cast below is honest.
    this.addPipe((context: AreaExtra) => {
      if (context.type === 'unmount') {
        this.unmount(context.data.element);
        return context;
      }
      if (context.type === 'render') {
        const element = context.data.element;
        // A socket we announced ourselves must never be mounted again: the
        // signal that announces it comes back through this same pipe.
        if (element.dataset.graphFilled === '1') return context;
        if (this.mount(element, context as RenderContext)) {
          return { ...context, data: { ...context.data, filled: true } } as AreaExtra;
        }
      }
      return context;
    });
  }

  private mount(element: HTMLElement, context: RenderContext): boolean {
    const data = context.data;
    if (data.type === 'node') {
      const node = data.payload as ReteNode;
      element.classList.add('graph-node');
      element.dataset.nodeId = node.id;
      let body = element.querySelector<HTMLElement>(':scope > .graph-node-body');
      if (!body) {
        body = document.createElement('div');
        body.className = 'graph-node-body';
        element.append(body);
      }
      this.retire(element);
      this.hooks.paint(node.id, body);
      for (const [key] of Object.entries(node.inputs)) if (key) this.announce(element, node.id, 'input', key);
      for (const [key] of Object.entries(node.outputs)) if (key) this.announce(element, node.id, 'output', key);
      const at = this.hooks.position(node.id);
      if (at) void this.area.translate(node.id, at);
      // The capture phase, because a node body owns its own pointer events
      // and stops them before they reach here: pressing the code, a picture
      // or a socket still selects the node it belongs to and brings it
      // forward.
      element.addEventListener('pointerdown', this.picked, true);
      return true;
    }
    if (data.type === 'connection') {
      const payload = data.payload as GraphWire;
      element.classList.add('graph-wire-host');
      // The wire can be named by what it carries: a compile refusal marks
      // the edge, not only the two nodes.
      element.dataset.wire = `${payload.source}:${payload.sourceOutput}->${payload.target}:${payload.targetInput}`;
      let svg = element.querySelector(':scope > svg');
      if (!svg) {
        svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'graph-wire');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('class', 'graph-wire-path');
        svg.append(path);
        element.append(svg);
      }
      element.classList.toggle('graph-wire-pseudo', payload.isPseudo === true);
      this.drawWire(element, payload, data.start as Position | undefined, data.end as Position | undefined);
      return true;
    }
    return false;
  }

  private picked = (event: PointerEvent): void => {
    const node = (event.target as HTMLElement | null)?.closest<HTMLElement>('.graph-node');
    const id = node?.dataset.nodeId;
    if (!id || !node) return;
    node.style.zIndex = String(++this.raised);
    this.hooks.pick(id, event.shiftKey);
  };

  /** Announce a socket: the connection plugin caches the element, the
   * socket-position watcher measures it. */
  private announce(nodeElement: HTMLElement, nodeId: string, side: Side, key: string): void {
    const element = nodeElement.querySelector<HTMLElement>(`[data-socket="${side}:${key}"]`);
    if (!element) return;
    element.dataset.graphFilled = '1';
    this.parentScope().emit({ type: 'render', data: { element, type: 'socket', nodeId, side, key } });
    this.parentScope().emit({ type: 'rendered', data: { element, type: 'socket', nodeId, side, key } });
  }

  /** A rebuilt body: the old sockets are gone, so drop their registrations
   * before the new ones are announced. */
  private retire(nodeElement: HTMLElement): void {
    for (const element of nodeElement.querySelectorAll<HTMLElement>('[data-socket]')) {
      this.parentScope().emit({ type: 'unmount', data: { element } });
    }
  }

  /** The wire follows both sockets for as long as it exists. */
  private drawWire(element: HTMLElement, payload: GraphWire, start?: Position, end?: Position): void {
    const path = element.querySelector('path');
    if (!path) return;
    let from = start ?? null;
    let to = end ?? null;
    const draw = (): void => {
      if (!from || !to) return;
      path.setAttribute('d', classicConnectionPath([from, to], CURVATURE));
    };
    const stop = this.wires.get(element) ?? [];
    for (const off of stop) off();
    const listeners: (() => void)[] = [];
    if (!start && payload.source) {
      listeners.push(this.watcher.listen(payload.source, 'output', String(payload.sourceOutput), (p) => { from = p; draw(); }));
    }
    if (!end && payload.target) {
      listeners.push(this.watcher.listen(payload.target, 'input', String(payload.targetInput), (p) => { to = p; draw(); }));
    }
    this.wires.set(element, listeners);
    draw();
  }

  private unmount(element: HTMLElement): void {
    const listeners = this.wires.get(element);
    if (listeners) {
      for (const off of listeners) off();
      this.wires.delete(element);
    }
    if (element.dataset.graphFilled !== '1') element.replaceChildren();
    delete element.dataset.graphFilled;
  }
}

export function createCanvas(container: HTMLElement, hooks: CanvasHooks): GraphCanvas {
  const editor = new NodeEditor<GraphScheme>();
  const area = new AreaPlugin<GraphScheme, AreaExtra>(container);
  const connection = new ConnectionPlugin<GraphScheme, AreaExtra>();
  const watcher = getDOMSocketPosition<GraphScheme, AreaExtra>({
    offset: (position, _nodeId, side) => ({ x: position.x + (side === 'output' ? 6 : -6), y: position.y }),
  });
  const render = new DomRender(area, watcher, hooks);

  editor.use(area);
  area.use(connection);
  area.use(render);
  // The watcher attaches to the area's *child* scope: it reads the area as
  // its parent's parent, and adds its pipe to the area's own chain.
  watcher.attach(render);
  // A refused wire: the flow asks, the page answers and says why.
  connection.addPreset(() => new ClassicFlow<GraphScheme, AreaExtra[]>({
    canMakeConnection: (from, to) => hooks.allowWire(from, to),
  }));

  const at = (clientX: number, clientY: number): Position => {
    const rect = container.getBoundingClientRect();
    const { x, y, k } = area.area.transform;
    return { x: (clientX - rect.left - x) / k, y: (clientY - rect.top - y) / k };
  };

  return {
    editor,
    area,
    connection,
    at,
    centre: () => at(container.clientWidth / 2, container.clientHeight / 2),
    refresh: (id) => void area.update('node', id),
    fit: () => void AreaExtensions.zoomAt(area, editor.getNodes(), { scale: 0.92 }),
  };
}
