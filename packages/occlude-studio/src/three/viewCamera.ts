import type { Camera3 } from 'occlude';
import { cameraConfigEdit } from './cameraConfig.js';
import { cameraSource } from './constructionPanel.js';

type Node = { type: string; range: [number, number]; [key: string]: unknown };
const node = (parent: Node, key: string) => parent[key] as Node | undefined;
const nodes = (parent: Node, key: string) => (parent[key] ?? []) as Node[];
const name = (value?: Node): string | undefined => value?.type === 'Identifier' ? value.name as string : typeof value?.value === 'string' ? value.value : undefined;
const property = (value: Node, key: string) => nodes(value, 'properties').find(p => p.type === 'Property' && !p.computed && name(node(p, 'key')) === key);
const unwrap = (value: Node): Node => ['TSAsExpression','TSSatisfiesExpression','TSNonNullExpression','ParenthesizedExpression'].includes(value.type) ? unwrap(node(value,'expression')!) : value;
function* walk(value: unknown): Generator<Node> {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const v of value) yield* walk(v); return; }
  const n = value as Node;
  if (typeof n.type === 'string') yield n;
  for (const [k, v] of Object.entries(n)) if (k !== 'range' && k !== 'loc' && k !== 'parent' && v && typeof v === 'object') yield* walk(v);
}

/** Write committed cameras into the sketch where the artist wrote them: the
 * `camera:` of each `view(...)` call, matched by its `key` or, for unkeyed
 * scenes (`@n`), by order among unkeyed view calls. Factories missing from
 * the `occlude/3d` import are added. Scenes without a matching view call
 * (explicit `lineArt3` scenes) fall back to the `cameras3` configuration. */
export async function viewCameraEdit(source: string): Promise<(cameras: Readonly<Record<string, Camera3>>) => Promise<string>> {
  const { parsers } = await import('prettier/plugins/typescript');
  const ast = parsers.typescript.parse(source, { filepath: 'sketch.ts' } as Parameters<typeof parsers.typescript.parse>[1]) as Node;
  let viewName: string | undefined, threeImport: Node | undefined;
  const factories = new Map<string, string>();
  for (const statement of nodes(ast, 'body')) {
    if (statement.type !== 'ImportDeclaration' || node(statement, 'source')?.value !== 'occlude/3d') continue;
    threeImport = statement;
    for (const spec of nodes(statement, 'specifiers')) {
      if (spec.type !== 'ImportSpecifier') continue;
      const imported = name(node(spec, 'imported')), local = name(node(spec, 'local'));
      if (imported === 'view') viewName = local;
      if ((imported === 'orthographic' || imported === 'perspective') && local) factories.set(imported, local);
    }
  }
  const views: { key?: string; camera?: Node; options: Node }[] = [];
  if (viewName) for (const n of walk(nodes(ast, 'body'))) {
    if (n.type !== 'CallExpression' || name(node(n, 'callee')) !== viewName) continue;
    const options = nodes(n, 'arguments')[1] && unwrap(nodes(n, 'arguments')[1]);
    if (!options || options.type !== 'ObjectExpression') continue;
    const key = property(options, 'key'), camera = property(options, 'camera');
    const keyValue = key && unwrap(node(key, 'value')!);
    views.push({ key: keyValue?.type === 'Literal' && typeof keyValue.value === 'string' ? keyValue.value : undefined, camera: camera ? node(camera, 'value') : undefined, options });
  }
  views.sort((a, b) => a.options.range[0] - b.options.range[0]);
  const unkeyed = views.filter(v => v.key === undefined);
  return async cameras => {
    const edits: { range: [number, number]; text: string }[] = [], leftover: Record<string, Camera3> = {};
    const needed = new Set<string>();
    for (const [key, camera] of Object.entries(cameras)) {
      const target = key.startsWith('@') ? unkeyed[Number(key.slice(1)) - 1] : views.find(v => v.key === key);
      if (!target) { leftover[key] = camera; continue; }
      const factory = camera.kind === 'orthographic' ? 'orthographic' : 'perspective';
      const local = factories.get(factory) ?? factory; if (!factories.has(factory)) needed.add(factory);
      const text = cameraSource(camera).replace(/^(orthographic|perspective)\(/, `${local}(`);
      if (target.camera) edits.push({ range: target.camera.range, text });
      else { const props = nodes(target.options, 'properties'), last = props.at(-1); const at = last ? last.range[1] : target.options.range[0] + 1; edits.push({ range: [at, at], text: last ? `, camera: ${text}` : ` camera: ${text} ` }); }
    }
    if (needed.size && threeImport) {
      const specifiers = nodes(threeImport, 'specifiers'), last = specifiers.at(-1);
      if (last) edits.push({ range: [last.range[1], last.range[1]], text: [...needed].map(f => `, ${f}`).join('') });
    }
    let out = source;
    for (const edit of edits.sort((a, b) => b.range[0] - a.range[0])) out = out.slice(0, edit.range[0]) + edit.text + out.slice(edit.range[1]);
    if (Object.keys(leftover).length) out = (await cameraConfigEdit(out))(leftover);
    return out;
  };
}
