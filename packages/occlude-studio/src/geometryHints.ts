import * as monaco from 'monaco-editor';
import { GEOMETRY_TYPES, type GeometryAnalysis, type GeometryAnnotation, type GeometryInspectionRequest } from './geometryTypes.js';
import './geometryHints.css';

type Mode = 'off' | 'icons' | 'labels';
const key = 'occlude.geometryHints';
const event = 'occlude-geometry-hints';
let mode: Mode = 'icons';
try {
  const saved = localStorage.getItem(key);
  if (saved === 'off' || saved === 'icons' || saved === 'labels') mode = saved;
} catch { /* Preferences are optional. */ }

/** Static-only UI: no runner, capture, or geometry evaluation dependencies. */
export function attachGeometryHints(editor: monaco.editor.IStandaloneCodeEditor, onInspect?: (request: GeometryInspectionRequest) => void): monaco.IDisposable {
  const model = editor.getModel()!;
  const decorations = editor.createDecorationsCollection();
  let disposed = false, visible = false, running = false, pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0, failures = 0;
  let annotations: GeometryAnnotation[] = [];
  let lastRequest = '';
  const control = document.createElement('label');
  control.className = 'geometry-hints-control';
  const caption = document.createElement('span');
  caption.textContent = 'Types';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Geometry type hints');
  select.title = 'Static type information — does not enable runtime inspection';
  for (const [value, text] of [['off', 'Off'], ['icons', 'Icons'], ['labels', 'Icons + labels']]) {
    const option = document.createElement('option');
    option.value = value; option.textContent = text; select.append(option);
  }
  select.value = mode;
  control.append(caption, select);
  const widget: monaco.editor.IOverlayWidget = {
    getId: () => `geometry-hints-${model.id}`,
    getDomNode: () => control,
    getPosition: () => ({ preference: monaco.editor.OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER }),
  };
  editor.addOverlayWidget(widget);
  const render = () => {
    decorations.set(mode === 'off' ? [] : annotations.flatMap(a => {
      const info = GEOMETRY_TYPES[a.kind];
      const start = model.getPositionAt(a.start), end = model.getPositionAt(a.end);
      const label = `${info.label}${a.array ? '[]' : ''}${a.optional ? ' (optional)' : ''}`;
      const hover = { value: `**${a.role === 'call' ? 'Returns ' : ''}${label}**\n\n${info.description}\n\n${info.use}\n\n---\nStatic type information.${onInspect ? ' Click the icon to inspect this value.' : ''}`, isTrusted: false };
      return [{
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: {
          description: 'geometry-type',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          inlineClassName: `geometry-type-token ${a.role === 'declaration' && mode === 'labels' ? 'geometry-type-has-label' : ''} geometry-type-${info.color}`,
          inlineClassNameAffectsLetterSpacing: true,
          before: {
            content: `${info.icon} `,
            inlineClassName: `geometry-type-badge geometry-type-icon geometry-type-${info.color}`,
            inlineClassNameAffectsLetterSpacing: true,
            cursorStops: monaco.editor.InjectedTextCursorStops.None,
          },
          after: a.role === 'declaration' && mode === 'labels' ? {
            content: ` ${label}`,
            inlineClassName: `geometry-type-label geometry-type-${info.color}`,
            inlineClassNameAffectsLetterSpacing: true,
            cursorStops: monaco.editor.InjectedTextCursorStops.None,
          } : undefined,
        },
      }, {
        // Injected text maps to the identifier's end position. Include that
        // position inside a separate hover range, not just at its boundary.
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, Math.min(end.column + 1, model.getLineMaxColumn(end.lineNumber))),
        options: { description: 'geometry-type-hover', hoverMessage: hover },
      }];
    }));
  };
  const clear = () => { generation++; annotations = []; lastRequest = ''; decorations.clear(); };
  const schedule = (delay = 250) => {
    clearTimeout(timer);
    if (disposed || !visible || mode === 'off' || document.hidden) return;
    timer = setTimeout(() => { void analyze(); }, delay);
  };
  const analyze = async () => {
    if (disposed || !visible || mode === 'off' || document.hidden) return;
    if (running) { pending = true; return; }
    const ranges = editor.getVisibleRanges().map(r => ({
      start: model.getOffsetAt({ lineNumber: Math.max(1, r.startLineNumber - 8), column: 1 }),
      end: model.getOffsetAt({ lineNumber: Math.min(model.getLineCount(), r.endLineNumber + 8), column: model.getLineMaxColumn(Math.min(model.getLineCount(), r.endLineNumber + 8)) }),
    }));
    const version = model.getVersionId();
    const request = JSON.stringify([version, ranges]);
    if (!ranges.length || request === lastRequest) return;
    const revision = generation;
    running = true;
    try {
      const getWorker = await monaco.languages.typescript.getTypeScriptWorker();
      const worker = await getWorker(model.uri) as monaco.languages.typescript.TypeScriptWorker & {
        getGeometryAnnotations(file: string, ranges: { start: number; end: number }[]): Promise<GeometryAnalysis>;
      };
      const result = await worker.getGeometryAnnotations(model.uri.toString(), ranges);
      if (disposed || revision !== generation || model.getVersionId() !== version || result.version !== String(version)) return;
      annotations = result.annotations; lastRequest = request; failures = 0;
      select.title = 'Static type information — does not enable runtime inspection';
      render();
    } catch {
      // Bounded retry for asynchronous language-worker initialization.
      failures++;
      if (!disposed) select.title = 'Type hints unavailable; editing and runtime inspection still work';
      if (failures < 3) pending = true;
    } finally {
      running = false;
      if (pending) { pending = false; schedule(500); }
    }
  };
  const onMode = () => {
    select.value = mode;
    if (mode === 'off') { clearTimeout(timer); clear(); }
    else { render(); schedule(0); }
  };
  const onSelect = () => {
    mode = select.value as Mode;
    try { localStorage.setItem(key, mode); } catch { /* optional persistence */ }
    window.dispatchEvent(new Event(event));
  };
  const onVisibility = () => {
    if (document.hidden) clearTimeout(timer); else schedule();
  };
  select.addEventListener('change', onSelect);
  window.addEventListener(event, onMode);
  document.addEventListener('visibilitychange', onVisibility);
  const observer = new IntersectionObserver(entries => {
    visible = entries.some(e => e.isIntersecting);
    if (visible) schedule(); else clearTimeout(timer);
  });
  observer.observe(editor.getDomNode()!);
  const inspectAt = (offset: number) => {
    const annotation = annotations.find(a => a.start === offset) ?? annotations.find(a => offset >= a.start && offset < a.end);
    if (annotation) onInspect?.({ document: model.uri.toString(), revision: String(model.getVersionId()), annotation, label: model.getValue().slice(annotation.start, annotation.end) });
  };
  const action = editor.addAction({ id: 'occlude.inspectGeometry', label: 'Inspect geometry at cursor',
    run: () => { const position = editor.getPosition(); if (position) inspectAt(model.getOffsetAt(position)); },
  });
  const subscriptions = [
    action,
    editor.onMouseDown(e => {
      if (e.target.position && e.target.element?.closest('.geometry-type-icon')) {
        inspectAt(model.getOffsetAt(e.target.position));
      }
    }),
    model.onDidChangeContent(() => { clear(); failures = 0; schedule(); }),
    editor.onDidScrollChange(() => schedule()),
    editor.onDidLayoutChange(() => schedule()),
  ];
  return { dispose() {
    disposed = true; clearTimeout(timer); observer.disconnect();
    subscriptions.forEach(s => s.dispose());
    window.removeEventListener(event, onMode);
    document.removeEventListener('visibilitychange', onVisibility);
    select.removeEventListener('change', onSelect);
    editor.removeOverlayWidget(widget); decorations.clear(); annotations = [];
  } };
}
