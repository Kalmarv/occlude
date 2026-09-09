import type ts from 'typescript';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { tagDraws, DRAW_HOOK, INSPECT_HOOK } from 'occlude';
import type { GeometryAnnotation } from './geometryTypes.js';

/** Source maps associate emitted AST nodes with source spans. Draw tagging
 * precedes insertion, preserving seed override addresses. Hooks return exactly
 * the value they receive; no expression is evaluated twice. */
export function emitInspection(
  T: typeof ts,
  source: string,
  fileName: string,
  revision: string,
  options: ts.CompilerOptions,
  annotations: readonly GeometryAnnotation[] = [],
): string {
  const original = T.createSourceFile(
    fileName,
    source,
    T.ScriptTarget.Latest,
    true,
  );
  const names = new Map<number, ts.Identifier>(),
    parameters = new Map<number, ts.Identifier>();
  const collect = (node: ts.Node) => {
    if (
      T.isVariableDeclaration(node) &&
      T.isIdentifier(node.name) &&
      node.initializer
    )
      names.set(node.name.getStart(original), node.name);
    if (T.isParameter(node) && T.isIdentifier(node.name))
      parameters.set(node.name.getStart(original), node.name);
    T.forEachChild(node, collect);
  };
  collect(original);
  const descriptions = new Map(
    annotations
      .filter((a) => a.role === 'declaration')
      .map((a) => [a.start, a]),
  );
  const expressions = new Map(
    annotations
      .filter((a) => a.expressionStart !== undefined)
      .map((a) => [`${a.expressionStart}:${a.expressionEnd}`, a]),
  );
  const emitted = T.transpileModule(source, {
    fileName,
    compilerOptions: {
      ...options,
      sourceMap: true,
      inlineSourceMap: false,
      inlineSources: false,
    },
  });
  if (!emitted.sourceMapText)
    throw new Error('Inspection emit requires a source map');
  const map = new TraceMap(emitted.sourceMapText);
  const js = emitted.outputText.replace(
    /\n\/\/# sourceMappingURL=[^\r\n]*\r?\n?$/,
    '\n',
  );
  const parse = (text: string) => {
    const file = T.createSourceFile(
      'sketch.js',
      text,
      T.ScriptTarget.Latest,
      true,
      T.ScriptKind.JS,
    );
    const declarations: ts.VariableDeclaration[] = [],
      params: ts.ParameterDeclaration[] = [],
      expressions: (ts.CallExpression | ts.PropertyAccessExpression)[] = [];
    const visit = (node: ts.Node) => {
      if (T.isVariableDeclaration(node)) declarations.push(node);
      if (T.isParameter(node)) params.push(node);
      if (
        T.isPropertyAccessExpression(node) ||
        (T.isCallExpression(node) &&
          !(
            T.isIdentifier(node.expression) &&
            node.expression.text === DRAW_HOOK
          ))
      )
        expressions.push(node);
      T.forEachChild(node, visit);
    };
    visit(file);
    return { file, declarations, params, expressions };
  };
  const before = parse(js),
    tagged = tagDraws(js).js,
    after = parse(tagged);
  if (
    before.params.length !== after.params.length ||
    before.declarations.length !== after.declarations.length ||
    before.expressions.length !== after.expressions.length
  )
    throw new Error('Draw tagging changed capture structure');
  const mappedOffset = (offset: number) => {
    const p = before.file.getLineAndCharacterOfPosition(offset),
      m = originalPositionFor(map, { line: p.line + 1, column: p.character });
    return m.line === null || m.column === null
      ? undefined
      : original.getPositionOfLineAndCharacter(m.line - 1, m.column);
  };
  const wraps: {
      start: number;
      end: number;
      prefix: string;
      suffix: string;
      order: number;
    }[] = [],
    statements: { pos: number; text: string }[] = [];
  // A declaration's initializer is captured under the variable's name; the
  // call it is made of would be the same value twice in the list.
  const initializers = new Set<ts.Node>();
  const hook = (
    start: number,
    end: number,
    label: string,
    kind?: string,
    expression = false,
  ) => {
    const location = original.getLineAndCharacterOfPosition(start);
    const meta = {
      document: fileName,
      revision,
      start,
      end,
      label,
      line: location.line + 1,
      kind,
      expression,
    };
    return {
      id: `@source:${JSON.stringify([fileName, revision, start, end])}`,
      meta,
    };
  };
  const wrap = (target: ts.Expression, identity: ReturnType<typeof hook>) =>
    wraps.push({
      start: target.getStart(after.file),
      end: target.end,
      prefix: `${INSPECT_HOOK}(${JSON.stringify(identity.id)}, (`,
      suffix: `), ${JSON.stringify(identity.meta)})`,
      order: wraps.length,
    });
  before.declarations.forEach((node, i) => {
    const target = after.declarations[i];
    if (node.name.getText(before.file) !== target.name.getText(after.file))
      throw new Error('Draw tagging changed declaration order');
    if (!T.isIdentifier(node.name) || !target.initializer) return;
    const offset = mappedOffset(node.name.getStart(before.file)),
      name = offset === undefined ? undefined : names.get(offset);
    if (!name || name.text !== node.name.text) return;
    const start = name.getStart(original),
      identity = hook(
        start,
        name.end,
        name.text,
        descriptions.get(start)?.kind,
      );
    let init = target.initializer;
    while (T.isParenthesizedExpression(init)) init = init.expression;
    if (
      T.isArrowFunction(init) ||
      T.isFunctionExpression(init) ||
      T.isClassExpression(init)
    ) {
      // Preserve inferred function/class .name by registering AFTER its
      // declaration. No wrapping or double evaluation of anonymous values.
      const statement = target.parent.parent;
      if (
        T.isVariableStatement(statement) &&
        (T.isBlock(statement.parent) || T.isSourceFile(statement.parent))
      )
        statements.push({
          pos: statement.end,
          text: ` ${INSPECT_HOOK}(${JSON.stringify(identity.id)}, ${name.text}, ${JSON.stringify(identity.meta)});`,
        });
    } else {
      wrap(target.initializer, identity);
      initializers.add(init);
    }
  });
  before.params.forEach((param, i) => {
    if (!T.isIdentifier(param.name)) return;
    const offset = mappedOffset(param.name.getStart(before.file)),
      name = offset === undefined ? undefined : parameters.get(offset);
    if (!name || !descriptions.has(name.getStart(original))) return;
    const target = after.params[i],
      fn = target.parent;
    if (!T.isFunctionLike(fn) || !('body' in fn) || !fn.body) return;
    const identity = hook(
      name.getStart(original),
      name.end,
      name.text,
      descriptions.get(name.getStart(original))?.kind,
    );
    const text = `${INSPECT_HOOK}(${JSON.stringify(identity.id)}, ${name.text}, ${JSON.stringify(identity.meta)})`;
    const body = fn.body as ts.ConciseBody;
    if (T.isBlock(body)) {
      let pos = body.getStart(after.file) + 1;
      for (const statement of body.statements) {
        if (
          T.isExpressionStatement(statement) &&
          T.isStringLiteral(statement.expression)
        )
          pos = statement.end;
        else break;
      }
      statements.push({ pos, text: `;${text};` });
    } else
      wraps.push({
        start: body.getStart(after.file),
        end: body.end,
        prefix: `(${text}, (`,
        suffix: '))',
        order: wraps.length,
      });
  });
  // Find exact original expression spans, not names or ordinal source guesses.
  const sourceExpressions = new Map<number, ts.Node[]>();
  const find = (node: ts.Node) => {
    if (T.isCallExpression(node) || T.isPropertyAccessExpression(node)) {
      const start = node.getStart(original);
      sourceExpressions.set(start, [
        ...(sourceExpressions.get(start) ?? []),
        node,
      ]);
    }
    T.forEachChild(node, find);
  };
  find(original);
  before.expressions.forEach((node, i) => {
    const offset = mappedOffset(node.getStart(before.file));
    if (offset === undefined) return;
    const target = after.expressions[i];
    if (target.kind !== node.kind)
      throw new Error('Draw tagging changed expression order');
    if (initializers.has(target)) return;
    // End mappings are not always emitted. The original callee/property token
    // disambiguates nested expressions sharing a start; source-map start plus
    // AST node kind and property/callee name must agree.
    const token = (n: ts.Node): string => {
      if (T.isPropertyAccessExpression(n)) return n.name.text;
      if (!T.isCallExpression(n)) return '';
      let callee: ts.Expression = n.expression;
      while (T.isParenthesizedExpression(callee)) callee = callee.expression;
      if (
        T.isBinaryExpression(callee) &&
        callee.operatorToken.kind === T.SyntaxKind.CommaToken
      )
        callee = callee.right;
      return T.isPropertyAccessExpression(callee)
        ? callee.name.text
        : T.isIdentifier(callee)
          ? callee.text
          : '';
    };
    const candidates = (sourceExpressions.get(offset) ?? []).filter(
      (n) =>
        n.kind === node.kind &&
        token(n) === token(node) &&
        expressions.has(`${n.getStart(original)}:${n.end}`),
    );
    if (candidates.length !== 1) return;
    const n = candidates[0],
      a = expressions.get(`${n.getStart(original)}:${n.end}`)!;
    wrap(
      target,
      hook(
        n.getStart(original),
        n.end,
        source.slice(a.start, a.end),
        a.kind,
        true,
      ),
    );
  });
  const events = new Map<
    number,
    { open: typeof wraps; close: typeof wraps; text: string[] }
  >();
  const at = (pos: number) => {
    let event = events.get(pos);
    if (!event) {
      event = { open: [], close: [], text: [] };
      events.set(pos, event);
    }
    return event;
  };
  for (const w of wraps) {
    at(w.start).open.push(w);
    at(w.end).close.push(w);
  }
  for (const statement of statements)
    at(statement.pos).text.push(statement.text);
  let result = '',
    last = 0;
  for (const [pos, event] of [...events].sort(([a], [b]) => a - b)) {
    result += tagged.slice(last, pos);
    result += event.close
      .sort((a, b) => b.start - a.start || b.order - a.order)
      .map((w) => w.suffix)
      .join('');
    result += event.text.join('');
    result += event.open
      .sort((a, b) => b.end - a.end || a.order - b.order)
      .map((w) => w.prefix)
      .join('');
    last = pos;
  }
  return result + tagged.slice(last);
}
