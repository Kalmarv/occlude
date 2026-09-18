/**
 * Which names a stretch of source actually reaches for.
 *
 * A code node's body is TypeScript the compiler does not otherwise read, and
 * the compiled sketch has to import every library word that body names — an
 * unused import is harmless, a missing one does not run. That question was
 * answered by counting regular-expression matches and subtracting the ones
 * that looked like property keys or arrow parameters. It got three things
 * wrong over the docs (a bare argument, a spread, a false `Cannot find name
 * 'force'` in the editor), because "is this identifier a read, and is it
 * bound here?" is a question about scope, and scope is not a pattern.
 *
 * So the body is parsed. TypeScript is already in this page's bundle — the
 * importer parses sketches with it — so reading the body properly costs
 * nothing but this file.
 *
 * A **free name** is an identifier that is read where it stands and that no
 * enclosing scope binds. Declarations are collected for a scope before its
 * statements are walked, which is what makes a name declared anywhere in a
 * block shadow the import throughout it.
 */

import ts from 'typescript';

/**
 * Every type name the source references. A code node's body is ordinary
 * TypeScript — `as Vec3`, a parameter annotation — and the compiled sketch
 * has to declare that name or it does not typecheck, in the node's own
 * editor and in the studio after "Open as sketch". Only the leftmost name of
 * a reference is a name to import: `occlude.Vec3` imports nothing.
 */
export function typeNames(source: string): Set<string> {
  const file = ts.createSourceFile(
    'body.ts',
    `async function __body() {\n${source}\n}`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const out = new Set<string>();
  const leftmost = (name: ts.EntityName): string => (ts.isIdentifier(name) ? name.text : leftmost(name.left));
  const walk = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      out.add(leftmost(node.typeName));
      // The arguments are types too: `Prepared<Mesh>` names both.
      for (const argument of node.typeArguments ?? []) walk(argument);
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return out;
}

/** A lexical scope: the names it binds. */
interface Scope {
  names: Set<string>;
  /** A function scope takes `var` and function declarations; a block does
   * not. */
  isFunction: boolean;
}

/** Whether an identifier is read where it stands, rather than being the name
 * of a property, a binding key, a label, or an import. */
function isRead(id: ts.Identifier): boolean {
  const parent = id.parent as ts.Node | undefined;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isQualifiedName(parent) && parent.right === id) return false;
  // `{ circle: 3 }` names a key; `{ circle }` reads the name.
  if (ts.isPropertyAssignment(parent) && parent.name === id) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (ts.isBindingElement(parent) && parent.name === id) return false;
  if (ts.isParameter(parent) && parent.name === id) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === id) return false;
  if ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) && parent.name === id) return false;
  if (ts.isMethodDeclaration(parent) || ts.isMethodSignature(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isEnumMember(parent) || ts.isGetAccessor(parent) || ts.isSetAccessor(parent)) {
    if ((parent as { name?: ts.Node }).name === id) return false;
  }
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent)) return false;
  if (ts.isLabeledStatement(parent) && parent.label === id) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === id) return false;
  return true;
}

/** Every name a binding pattern binds. */
function bound(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isBindingElement(element)) bound(element.name, out);
  }
}

/**
 * The names a scope binds, collected before its body is walked. `deep` takes
 * `var` and function declarations from nested blocks too, which is what a
 * function scope gets and a block scope does not.
 */
function declarations(nodes: readonly ts.Node[], into: Set<string>, deep: boolean): void {
  const visit = (node: ts.Node, nested: boolean): void => {
    if (ts.isVariableStatement(node)) {
      const isVar = (node.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
      if (!nested || (deep && isVar)) {
        for (const decl of node.declarationList.declarations) bound(decl.name, into);
      }
    } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      if (!nested || deep) {
        if (node.name) into.add(node.name.text);
      }
    }
    // A nested function's own body has its own scope: nothing in it belongs
    // here, not even a `var`.
    if (ts.isFunctionLike(node) && nested) return;
    if (ts.isBlock(node) || ts.isCaseBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)
      || ts.isIfStatement(node) || ts.isIterationStatement(node, false) || ts.isTryStatement(node)
      || ts.isCatchClause(node) || ts.isLabeledStatement(node) || ts.isSwitchStatement(node)
      || ts.isWithStatement(node) || ts.isModuleBlock(node)) {
      ts.forEachChild(node, (child) => visit(child, true));
    }
  };
  for (const node of nodes) visit(node, false);
}

/**
 * Every name the source reads and does not itself bind.
 *
 * The text is read as the body of an async function, because that is what it
 * is: statements ending in a `return`, sometimes with an `await`. A raw
 * config value is an expression, which is a statement too.
 */
export function freeNames(source: string): Set<string> {
  const file = ts.createSourceFile(
    'body.ts',
    `async function __body() {\n${source}\n}`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const free = new Set<string>();
  const stack: Scope[] = [];
  const binds = (name: string): boolean => stack.some((scope) => scope.names.has(name));

  const push = (isFunction: boolean, declare: (into: Set<string>) => void): Scope => {
    const scope: Scope = { names: new Set(), isFunction };
    declare(scope.names);
    stack.push(scope);
    return scope;
  };
  const pop = (): void => {
    stack.pop();
  };

  const walk = (node: ts.Node): void => {
    // A type never needs a value import.
    if (ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;

    if (ts.isFunctionLike(node)) {
      push(true, (into) => {
        for (const parameter of node.parameters) bound(parameter.name, into);
        if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name) into.add(node.name.text);
        const body = (node as { body?: ts.Node }).body;
        if (body && ts.isBlock(body)) declarations(body.statements, into, true);
      });
      // The parameters' defaults are read in the new scope, the body too.
      ts.forEachChild(node, walk);
      pop();
      return;
    }

    if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      push(false, (into) => declarations(node.statements, into, false));
      ts.forEachChild(node, walk);
      pop();
      return;
    }

    if (ts.isCatchClause(node)) {
      push(false, (into) => {
        if (node.variableDeclaration) bound(node.variableDeclaration.name, into);
      });
      ts.forEachChild(node, walk);
      pop();
      return;
    }

    // `for (const p of rows)`: the loop's own binding is not free inside it.
    if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      push(false, (into) => {
        const initializer = ts.isForStatement(node) ? node.initializer : node.initializer;
        if (initializer && ts.isVariableDeclarationList(initializer)) {
          for (const decl of initializer.declarations) bound(decl.name, into);
        }
      });
      ts.forEachChild(node, walk);
      pop();
      return;
    }

    if (ts.isIdentifier(node)) {
      if (isRead(node) && !binds(node.text)) free.add(node.text);
      return;
    }
    ts.forEachChild(node, walk);
  };

  walk(file);
  return free;
}
