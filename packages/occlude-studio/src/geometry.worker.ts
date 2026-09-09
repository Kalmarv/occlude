// Monaco exposes the same worker base used by its stock TS worker. Keep
// completion, diagnostics and emit on that worker; add one batched query.
// @ts-expect-error Monaco ships this worker entry without a declaration file.
import { initialize, TypeScriptWorker, ts } from 'monaco-editor/esm/vs/language/typescript/ts.worker.js';
import { emitInspection } from './inspectionEmit.js';
import { analyzeGeometry } from './geometryAnalysis.js';
import type { GeometryAnalysis } from './geometryTypes.js';
import type { LanguageService } from 'typescript';

const WorkerBase = TypeScriptWorker as new (ctx: unknown, data: unknown) => {
  getLanguageService(): LanguageService;
  getScriptVersion(fileName: string): string;
};

class GeometryWorker extends WorkerBase {
  getInspectionEmit(fileName: string): { js: string; version: string } {
    const program = this.getLanguageService().getProgram();
    const file = program?.getSourceFile(fileName);
    if (!program || !file) throw new Error('Source is not ready for inspection');
    const version = this.getScriptVersion(fileName);
    return { js: emitInspection(ts.typescript, file.text, fileName, version, program.getCompilerOptions(), new Set(analyzeGeometry(ts.typescript, program, fileName, [{ start: 0, end: file.text.length }]).filter(a => a.role === 'declaration' && a.kind === 'stations').map(a => a.start))), version };
  }

  getGeometryAnnotations(fileName: string, ranges: { start: number; end: number }[]): GeometryAnalysis {
    const program = this.getLanguageService().getProgram();
    return {
      version: this.getScriptVersion(fileName),
      annotations: program ? analyzeGeometry(ts.typescript, program, fileName, ranges) : [],
    };
  }
}

self.onmessage = () => initialize((ctx: unknown, data: unknown) => new GeometryWorker(ctx, data));
