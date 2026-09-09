import type ts from 'typescript';
import type { GeometryAnnotation, GeometryKind } from './geometryTypes.js';

/** Canonical declaration identity, never variable names or printed type strings. */
const symbols: Record<string, Record<string, GeometryKind>> = {
  'api.ts': { ShapeValue: 'shape', PathValue: 'path', GroupValue: 'drawing', ClipValue: 'drawing', InvertValue: 'drawing', Tree: 'drawing' },
  'material.ts': { Material: 'material', Station: 'station', Vertex: 'vertex', Edge: 'edge', Curve: 'contour' },
  'relation.ts': { PointSelection: 'points', EdgeSelection: 'edges' },
  'faces.ts': { Faces: 'faces', FaceSelection: 'faces', Face: 'face' },
  'isolines.ts': { IsoContour: 'contour' },
  'shapes.ts': { FieldFn: 'scalar', VectorFieldFn: 'vector' },
  'distance.ts': { DistanceField: 'scalar' },
};

type Classification = Pick<GeometryAnnotation, 'kind' | 'array' | 'optional'>;

export function analyzeGeometry(T: typeof ts, program: ts.Program, fileName: string, ranges: { start: number; end: number }[]): GeometryAnnotation[] {
  const file = program.getSourceFile(fileName);
  if (!file || ranges.length === 0) return [];
  const checker = program.getTypeChecker();
  const memo = new Map<ts.Type, Classification | null>();
  const canonical = (symbol: ts.Symbol | undefined): GeometryKind | undefined => {
    if (!symbol) return;
    for (const declaration of symbol.declarations ?? []) {
      const path = declaration.getSourceFile().fileName.replace(/\\/g, '/');
      const match = /\/occlude\/src\/([^/]+)$/.exec(path);
      if (match) {
        const kind = symbols[match[1]]?.[symbol.getName()];
        if (kind) return kind;
      }
    }
  };
  const classify = (type: ts.Type, depth = 0): Classification | null => {
    if (depth > 8 || type.flags & (T.TypeFlags.Any | T.TypeFlags.Unknown | T.TypeFlags.Never)) return null;
    if (memo.has(type)) return memo.get(type)!;
    memo.set(type, null);
    const kind = canonical(type.aliasSymbol) ?? canonical(type.getSymbol());
    let result: Classification | null = kind ? { kind, array: false, optional: false } : null;
    if (!result && type.isUnion()) {
      const concrete = type.types.filter(t => !(t.flags & (T.TypeFlags.Null | T.TypeFlags.Undefined)));
      const members = concrete.map(t => classify(t, depth + 1));
      const first = members[0];
      if (first && members.every(m => m && m.kind === first.kind && m.array === first.array)) {
        result = { ...first, optional: concrete.length !== type.types.length || members.some(m => m!.optional) };
      }
    }
    if (!result && checker.isArrayType(type)) {
      const item = checker.getTypeArguments(type as ts.TypeReference)[0];
      const child = item && classify(item, depth + 1);
      if (child && !child.array && !child.optional) {
        result = { kind: child.kind === 'station' ? 'stations' : child.kind, array: child.kind !== 'station', optional: false };
      }
    }
    memo.set(type, result);
    return result;
  };
  const out: GeometryAnnotation[] = [];
  const visit = (node: ts.Node) => {
    if (!ranges.some(r => node.end >= r.start && node.pos <= r.end)) return;
    // Types and imports are syntax, not geometry values in the sketch.
    if (T.isTypeNode(node) || T.isImportDeclaration(node) || T.isExportDeclaration(node)) return;
    if (T.isIdentifier(node)) {
      const parent = node.parent;
      const callee = T.isPropertyAccessExpression(parent) && parent.name === node ? parent : node;
      const call = callee.parent;
      const isCall = T.isCallExpression(call) && call.expression === callee;
      const declaration = (T.isVariableDeclaration(parent) || T.isParameter(parent)) && parent.name === node;
      const isName = (T.isPropertyAssignment(parent) && parent.name === node)
        || T.isFunctionDeclaration(parent) || T.isMethodDeclaration(parent)
        || T.isClassDeclaration(parent) || T.isBindingElement(parent) && parent.propertyName === node;
      const start = node.getStart(file);
      if (!isName && ranges.some(r => start >= r.start && start <= r.end)) {
        const type = classify(checker.getTypeAtLocation(isCall ? call : node));
        if (type) out.push({ start, end: node.end, role: isCall ? 'call' : declaration ? 'declaration' : 'value', ...type });
      }
    }
    T.forEachChild(node, visit);
  };
  visit(file);
  return out;
}
