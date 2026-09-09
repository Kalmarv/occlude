/**
 * Geometry type hints in the editor: every identifier or call whose static
 * type is occlude geometry gets its kind's icon in front and a tint, with
 * the kind's description on hover. Static information only — nothing runs.
 * Clicking an icon asks the host to inspect that value, which is where the
 * Inspect tab comes in.
 *
 * The mode is a shared preference (studio and tutorial editors alike): off
 * by default, since the tint is a lot to look at all day. The Inspect tab
 * forces icons on while it is open, and the preference returns after.
 */
import * as monaco from 'monaco-editor';
import { GEOMETRY_TYPES, type GeometryAnalysis, type GeometryAnnotation, type GeometryInspectionRequest } from './geometryTypes.js';
import './geometryHints.css';

export type HintMode = 'off' | 'icons' | 'labels';
export const HINT_MODES: { key: HintMode; label: string }[] = [
  { key: 'off', label: 'Off' },
  { key: 'icons', label: 'Icons' },
  { key: 'labels', label: 'Icons + labels' },
];

const KEY = 'occlude.geometryHints';
const EVENT = 'occlude-geometry-hints';
let preference: HintMode = 'off';
let forced = false;
try {
  const saved = localStorage.getItem(KEY);
  if (saved === 'off' || saved === 'icons' || saved === 'labels') preference = saved;
} catch { /* preferences are optional */ }

export function getHintMode(): HintMode {
  return preference;
}

export function setHintMode(mode: HintMode): void {
  preference = mode;
  try { localStorage.setItem(KEY, mode); } catch { /* optional persistence */ }
  window.dispatchEvent(new Event(EVENT));
}

/** While the Inspect tab is open the icons show whatever the preference. */
export function forceHints(on: boolean): void {
  if (forced === on) return;
  forced = on;
  window.dispatchEvent(new Event(EVENT));
}

const effectiveMode = (): HintMode => (forced && preference === 'off' ? 'icons' : preference);

export function attachGeometryHints(editor: monaco.editor.IStandaloneCodeEditor, onInspect?: (request: GeometryInspectionRequest) => void): monaco.IDisposable {
  const model = editor.getModel()!;
  const decorations = editor.createDecorationsCollection();
  let disposed = false, visible = false, running = false, pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0, failures = 0;
  let annotations: GeometryAnnotation[] = [];
  let lastRequest = '';
  let mode = effectiveMode();

  const render = () => {
    decorations.set(mode === 'off' ? [] : annotations.flatMap((a) => {
      const info = GEOMETRY_TYPES[a.kind];
      const start = model.getPositionAt(a.start), end = model.getPositionAt(a.end);
      const label = `${info.label}${a.array ? '[]'.repeat(a.arrayDepth ?? 1) : ''}${a.optional ? ' (optional)' : ''}`;
      const hover = {
        value: `**${a.role === 'call' ? 'Returns ' : ''}${label}**\n\n${info.description}\n\n${info.use}\n\n---\nStatic type information.${onInspect ? ' Click the icon to inspect this value.' : ''}`,
        isTrusted: false,
      };
      const withLabel = a.role === 'declaration' && mode === 'labels';
      return [{
        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
        options: {
          description: 'geometry-type',
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          inlineClassName: `geometry-type-token ${withLabel ? 'geometry-type-has-label' : ''} geometry-type-${info.color}`,
          inlineClassNameAffectsLetterSpacing: true,
          before: {
            content: `${info.icon} `,
            inlineClassName: `geometry-type-badge geometry-type-icon geometry-type-${info.color}`,
            inlineClassNameAffectsLetterSpacing: true,
            cursorStops: monaco.editor.InjectedTextCursorStops.None,
          },
          after: withLabel ? {
            content: ` ${label}`,
            inlineClassName: `geometry-type-label geometry-type-${info.color}`,
            inlineClassNameAffectsLetterSpacing: true,
            cursorStops: monaco.editor.InjectedTextCursorStops.None,
          } : undefined,
        },
      }, {
        // Injected text maps to the identifier's end position; the hover
        // range reaches one column past it so the icon hovers too.
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
    const lines = model.getLineCount();
    const ranges = editor.getVisibleRanges().map((r) => {
      const lastLine = Math.min(lines, r.endLineNumber + 8);
      return {
        start: model.getOffsetAt({ lineNumber: Math.max(1, r.startLineNumber - 8), column: 1 }),
        end: model.getOffsetAt({ lineNumber: lastLine, column: model.getLineMaxColumn(lastLine) }),
      };
    });
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
      annotations = result.annotations;
      lastRequest = request;
      failures = 0;
      render();
    } catch {
      // The language worker registers asynchronously at boot: retry a few times.
      failures++;
      if (failures < 3) pending = true;
    } finally {
      running = false;
      if (pending) { pending = false; schedule(500); }
    }
  };
  const onMode = () => {
    mode = effectiveMode();
    if (mode === 'off') { clearTimeout(timer); clear(); }
    else { render(); schedule(0); }
  };
  const onVisibility = () => {
    if (document.hidden) clearTimeout(timer); else schedule();
  };
  window.addEventListener(EVENT, onMode);
  document.addEventListener('visibilitychange', onVisibility);
  const observer = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) schedule(); else clearTimeout(timer);
  });
  observer.observe(editor.getDomNode()!);
  const inspectAt = (offset: number) => {
    const annotation = annotations.find((a) => a.start === offset) ?? annotations.find((a) => offset >= a.start && offset < a.end);
    if (annotation) onInspect?.({ document: model.uri.toString(), revision: String(model.getVersionId()), annotation, label: model.getValue().slice(annotation.start, annotation.end) });
  };
  const action = editor.addAction({
    id: 'occlude.inspectGeometry',
    label: 'Inspect geometry at cursor',
    run: () => { const position = editor.getPosition(); if (position) inspectAt(model.getOffsetAt(position)); },
  });
  const subscriptions = [
    action,
    editor.onMouseDown((e) => {
      if (e.target.position && e.target.element?.closest('.geometry-type-icon')) inspectAt(model.getOffsetAt(e.target.position));
    }),
    model.onDidChangeContent(() => { clear(); failures = 0; schedule(); }),
    editor.onDidScrollChange(() => schedule()),
    editor.onDidLayoutChange(() => schedule()),
  ];
  return {
    dispose() {
      disposed = true;
      clearTimeout(timer);
      observer.disconnect();
      subscriptions.forEach((s) => s.dispose());
      window.removeEventListener(EVENT, onMode);
      document.removeEventListener('visibilitychange', onVisibility);
      decorations.clear();
      annotations = [];
    },
  };
}
