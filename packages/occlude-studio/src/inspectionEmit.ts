import type ts from 'typescript';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { tagDraws } from '../../occlude/src/draws.js';
import { INSPECT_HOOK } from './instrument.js';

/** Opt-in compiler path. Source maps associate emitted declarations with their
 * original source ranges. Draw tagging runs BEFORE capture insertion so seed
 * override addresses remain identical to ordinary execution. */
export function emitInspection(T: typeof ts, source: string, fileName: string, revision: string, options: ts.CompilerOptions, stationStarts: Set<number> = new Set()): string {
  const original = T.createSourceFile(fileName, source, T.ScriptTarget.Latest, true);
  const names = new Map<number, ts.Identifier>();
  const collect = (node: ts.Node) => {
    if (T.isVariableDeclaration(node) && T.isIdentifier(node.name) && node.initializer) names.set(node.name.getStart(original), node.name);
    T.forEachChild(node, collect);
  };
  collect(original);
  const emitted = T.transpileModule(source, {
    fileName, compilerOptions: { ...options, sourceMap: true, inlineSourceMap: false, inlineSources: false },
  });
  if (!emitted.sourceMapText) throw new Error('Inspection emit requires a source map');
  const map = new TraceMap(emitted.sourceMapText);
  const js = emitted.outputText.replace(/\n\/\/# sourceMappingURL=[^\r\n]*\r?\n?$/, '\n');
  const declarations = (text: string) => {
    const file = T.createSourceFile('sketch.js', text, T.ScriptTarget.Latest, true, T.ScriptKind.JS);
    const nodes: ts.VariableDeclaration[] = [];
    const visit = (node: ts.Node) => {
      if (T.isVariableDeclaration(node)) nodes.push(node);
      T.forEachChild(node, visit);
    };
    visit(file);
    return { file, nodes };
  };
  const before = declarations(js);
  const tagged = tagDraws(js).js;
  const after = declarations(tagged);
  // tagDraws only wraps expressions with calls/arrows; it cannot add, remove,
  // or reorder variable declarations. Fail closed if that contract changes.
  if (before.nodes.length !== after.nodes.length) throw new Error('Draw tagging changed declaration structure');
  const edits: { start: number; text: string }[] = [];
  before.nodes.forEach((node, i) => {
    const target = after.nodes[i];
    if (node.name.getText(before.file) !== target.name.getText(after.file)) throw new Error('Draw tagging changed declaration order');
    if (!T.isIdentifier(node.name) || !target.initializer) return;
    const point = before.file.getLineAndCharacterOfPosition(node.name.getStart(before.file));
    const mapped = originalPositionFor(map, { line: point.line + 1, column: point.character });
    if (mapped.line === null || mapped.column === null) return;
    const name = names.get(original.getPositionOfLineAndCharacter(mapped.line - 1, mapped.column));
    if (!name || name.text !== node.name.text) return;
    // Wrapping anonymous functions/classes changes inferred .name. These are
    // not inspectable material values; leave their initialization untouched.
    let init = target.initializer;
    while (T.isParenthesizedExpression(init)) init = init.expression;
    if (T.isArrowFunction(init) || T.isFunctionExpression(init) || T.isClassExpression(init)) return;
    const start = name.getStart(original);
    const location = original.getLineAndCharacterOfPosition(start);
    const sourceId = { document: fileName, revision, start, end: name.end, label: name.text, line: location.line + 1, kind: stationStarts.has(start) ? 'stations' : undefined };
    const id = `@source:${JSON.stringify([fileName, revision, start])}`;
    edits.push({ start: target.initializer.getStart(after.file), text: `${INSPECT_HOOK}(${JSON.stringify(id)}, (` });
    edits.push({ start: target.initializer.end, text: `), ${JSON.stringify(sourceId)})` });
  });
  // Descending offsets preserve all original JS text and expression order.
  return edits.sort((a, b) => b.start - a.start).reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.start), tagged);
}
