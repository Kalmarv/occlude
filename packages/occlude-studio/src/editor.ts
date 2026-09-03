/**
 * Monaco setup: TS editing with the real `occlude` types loaded so the
 * sketch gets completion, plus emit (transpile) via the TS worker.
 */

import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { attachScrubbing } from './scrub.js';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

// EVERY source file of the occlude package becomes a Monaco extra lib —
// globbed, so a new module (ease.ts once, memorably) can never be left
// out of the editor's type universe again.
const libSources = import.meta.glob('../../occlude/src/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};

const SKETCH_URI = monaco.Uri.parse('file:///sketch.ts');

export interface Editor {
  model: monaco.editor.ITextModel;
  editor: monaco.editor.IStandaloneCodeEditor;
  /** Transpile the current sketch to CommonJS JS (or null on syntax errors). */
  emit(): Promise<{ js: string | null; errors: string[] }>;
  onChange(fn: () => void): void;
  setValue(src: string): void;
  getValue(): string;
  /** Built-in fills open read-only: ink-immutable, clone to change. */
  setReadOnly(on: boolean): void;
  /** Format the document with Prettier (no-op on parse errors). */
  format(): Promise<void>;
}

export function createEditor(container: HTMLElement, initial: string): Editor {
  const ts = monaco.languages.typescript.typescriptDefaults;
  ts.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    module: monaco.languages.typescript.ModuleKind.CommonJS,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    esModuleInterop: true,
    strict: false,
    noEmitOnError: false,
    allowNonTsExtensions: true,
  });
  ts.setEagerModelSync(true);

  for (const [path, src] of Object.entries(libSources)) {
    const name = path.split('/').pop()!;
    ts.addExtraLib(src, `file:///node_modules/occlude/src/${name}`);
  }
  ts.addExtraLib(
    JSON.stringify({ name: 'occlude', types: './src/index.ts', main: './src/index.ts' }),
    'file:///node_modules/occlude/package.json',
  );
  // occlude-core types aren't needed for sketches; stub the import used by init.ts.
  ts.addExtraLib(
    'declare const init: (i?: unknown) => Promise<unknown>; export default init; export function wasm_render(...a: unknown[]): unknown; export function wasm_export_gcode(...a: unknown[]): string; export function wasm_export_svg(...a: unknown[]): string;',
    'file:///node_modules/occlude-core/index.d.ts',
  );

  monaco.editor.defineTheme('occlude-deck', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5c636a' },
      { token: 'string', foreground: 'a3be8c' },
      { token: 'number', foreground: 'd9a13d' },
      { token: 'keyword', foreground: '5b8bd9' },
    ],
    colors: {
      'editor.background': '#1a1c1f',
      'editor.lineHighlightBackground': '#212428',
      'editorLineNumber.foreground': '#4d5257',
      'editorGutter.background': '#1a1c1f',
    },
  });

  // Prettier as the document formatter (lazy-loaded): Shift+Alt+F, the
  // context menu's Format Document, and format-on-save all route through it.
  monaco.languages.registerDocumentFormattingEditProvider('typescript', {
    async provideDocumentFormattingEdits(m) {
      const [prettier, ts, estree] = await Promise.all([
        import('prettier/standalone'),
        import('prettier/plugins/typescript'),
        import('prettier/plugins/estree'),
      ]);
      const text = await prettier.format(m.getValue(), {
        parser: 'typescript',
        plugins: [ts.default, estree.default],
        singleQuote: true,
        printWidth: 90,
      });
      return [{ range: m.getFullModelRange(), text }];
    },
  });

  const model = monaco.editor.createModel(initial, 'typescript', SKETCH_URI);
  const editor = monaco.editor.create(container, {
    model,
    theme: 'occlude-deck',
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 12.5,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    padding: { top: 10 },
    renderLineHighlight: 'gutter',
    tabSize: 2,
  });

  // Alt-drag any number literal to change it (scrubby sliders).
  attachScrubbing(editor);

  return {
    model,
    editor,
    async emit() {
      // The TS language service registers asynchronously after the first
      // typescript model exists; at boot it may not be ready yet.
      const getWorker = await (async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await monaco.languages.typescript.getTypeScriptWorker();
          } catch (e) {
            if (attempt > 100) throw e;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      })();
      const client = await getWorker(SKETCH_URI);
      const uri = SKETCH_URI.toString();
      const [syntactic, out] = await Promise.all([
        client.getSyntacticDiagnostics(uri),
        client.getEmitOutput(uri),
      ]);
      const errors = syntactic.map((d) => {
        const pos = d.start !== undefined ? model.getPositionAt(d.start) : null;
        const msg =
          typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText;
        return pos ? `line ${pos.lineNumber}: ${msg}` : msg;
      });
      if (errors.length > 0) return { js: null, errors };
      const file = out.outputFiles.find((f) => f.name.endsWith('.js'));
      return { js: file?.text ?? null, errors: [] };
    },
    onChange(fn) {
      model.onDidChangeContent(() => fn());
    },
    async format() {
      try {
        await editor.getAction('editor.action.formatDocument')?.run();
      } catch {
        // unparseable source — leave it as typed
      }
    },
    setValue(src) {
      model.setValue(src);
    },
    getValue() {
      return model.getValue();
    },
    setReadOnly(on) {
      editor.updateOptions({ readOnly: on });
    },
  };
}

/** Surface a runtime error as a marker on the sketch (best-effort line). */
export function setRuntimeMarker(model: monaco.editor.ITextModel, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  let line = 1;
  if (err instanceof Error && err.stack) {
    const m = err.stack.match(/<anonymous>:(\d+):\d+/);
    if (m) line = Math.max(1, parseInt(m[1], 10) - 2); // function wrapper offset
  }
  monaco.editor.setModelMarkers(model, 'runtime', [
    {
      severity: monaco.MarkerSeverity.Error,
      message: msg,
      startLineNumber: line,
      startColumn: 1,
      endLineNumber: line,
      endColumn: 200,
    },
  ]);
}

export function clearRuntimeMarkers(model: monaco.editor.ITextModel): void {
  monaco.editor.setModelMarkers(model, 'runtime', []);
}
