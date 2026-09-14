import type { Camera3 } from 'occlude';

type Node = { type: string; range: [number, number]; [key: string]: unknown };
const node = (parent: Node, key: string) => parent[key] as Node | undefined;
const nodes = (parent: Node, key: string) => (parent[key] ?? []) as Node[];
const name = (value?: Node): string | undefined => value?.type === 'Identifier' ? value.name as string : typeof value?.value === 'string' ? value.value : undefined;
const property = (value: Node, key: string) => nodes(value, 'properties').find(p => p.type === 'Property' && !p.computed && name(node(p, 'key')) === key);
const unwrap = (value: Node): Node => ['TSAsExpression','TSSatisfiesExpression','TSNonNullExpression','ParenthesizedExpression'].includes(value.type) ? unwrap(node(value,'expression')!) : value;

/** Prepare a source edit without running any sketch code. Reuse the parser
 * already shipped for editor formatting; load it only when committing a view. */
export async function cameraConfigEdit(source: string): Promise<(cameras: Readonly<Record<string, Camera3>>) => string> {
  const { parsers } = await import('prettier/plugins/typescript');
  const ast = parsers.typescript.parse(source, { filepath: 'sketch.ts' } as Parameters<typeof parsers.typescript.parse>[1]) as Node;
  const body = nodes(ast, 'body');
  const factories = new Set<string>(), namespaces = new Set<string>();
  const bindings = new Map<string, Node>();
  for (const statement of body) {
    if (statement.type === 'ImportDeclaration' && node(statement,'source')?.value === 'occlude') {
      for (const spec of nodes(statement,'specifiers')) {
        if (spec.type === 'ImportNamespaceSpecifier') namespaces.add(name(node(spec,'local'))!);
        else if (['sketch','sketchAsync'].includes(name(node(spec,'imported')) ?? '')) factories.add(name(node(spec,'local'))!);
      }
    }
    const declaration = statement.type === 'ExportNamedDeclaration' ? node(statement,'declaration') : statement;
    if (declaration?.type === 'VariableDeclaration') for (const binding of nodes(declaration,'declarations')) {
      const id = name(node(binding,'id')), init = node(binding,'init');
      if (id && init) bindings.set(id, init);
    }
  }
  const isFactory = (call: Node) => {
    const callee = node(call,'callee');
    return callee?.type === 'Identifier' ? factories.has(name(callee)!) : callee?.type === 'MemberExpression' && namespaces.has(name(node(callee,'object'))!) && ['sketch','sketchAsync'].includes(name(node(callee,'property')) ?? '');
  };
  const findConfig = (input: Node, seen = new Set<string>()): Node | undefined => {
    const value = unwrap(input);
    if (value.type === 'Identifier') {
      const key = name(value)!;
      if (seen.has(key)) return;
      seen.add(key);
      const init = bindings.get(key); return init && findConfig(init,seen);
    }
    if (value.type === 'CallExpression' && isFactory(value)) {
      const argument = nodes(value,'arguments')[0];
      return argument?.type === 'SpreadElement' ? undefined : argument;
    }
    if (value.type === 'CallExpression') {
      const callee = node(value,'callee'), owner = callee && node(callee,'object');
      if (callee?.type === 'MemberExpression' && name(node(callee,'property')) === 'create' && owner?.type === 'MemberExpression' && name(node(owner,'object')) === 'globalThis' && name(node(owner,'property')) === 'Object') {
        const descriptors = nodes(value,'arguments')[1];
        const configDescriptor = descriptors && node(property(descriptors,'config') ?? descriptors,'value');
        const getter = configDescriptor && node(property(configDescriptor,'get') ?? configDescriptor,'value');
        const body = getter?.type === 'ArrowFunctionExpression' && node(getter,'body');
        if (body && unwrap(body).type === 'ObjectExpression') return body;
      }
    }
    if (value.type === 'ObjectExpression') {
      const config = property(value,'config');
      return config?.kind === 'init' && !config.method && !config.shorthand ? node(config,'value') : undefined;
    }
  };
  const exported = body.find(statement => statement.type === 'ExportDefaultDeclaration');
  let config = exported && findConfig(node(exported,'declaration')!);
  if (!exported) {
    const named = body.filter(s => s.type === 'ExportNamedDeclaration');
    const candidates = named.flatMap(s => {
      const declaration = node(s,'declaration');
      return declaration?.type === 'VariableDeclaration' ? nodes(declaration,'declarations') : [];
    });
    if (candidates.length === 1 && named.every(s => !nodes(s,'specifiers').length)) {
      const init = node(candidates[0],'init');
      config = init && findConfig(init);
    }
  }
  const serialize = (cameras: Readonly<Record<string, Camera3>>) => '{\n' + Object.entries(cameras).map(([key,camera]) =>
    `    ${key === '__proto__' ? '["__proto__"]' : JSON.stringify(key)}: ${JSON.stringify(camera)}`).join(',\n') + '\n  }';
  if (config) {
    const target = unwrap(config);
    const props = nodes(target,'properties'), last = props.at(-1);
    // A trailing property wins over earlier spreads. Repeated commits replace
    // this value rather than nesting configuration wrappers indefinitely.
    if (last?.type === 'Property' && last.kind === 'init' && !last.method && !last.shorthand && !last.computed && name(node(last,'key')) === 'cameras3') {
      const value = node(last,'value')!;
      return cameras => source.slice(0,value.range[0])+serialize(cameras)+source.slice(value.range[1]);
    }
    const [start,end] = config.range;
    return cameras => source.slice(0,start)+`{ ...(${source.slice(start,end)}), cameras3: ${serialize(cameras)} }`+source.slice(end);
  }
  // A default-exported factory can produce a definition without calling
  // sketch directly in this module. Capture it once; preserve its fn/marker.
  if (exported) {
    const value = node(exported,'declaration')!;
    if (value.type.endsWith('Declaration')) throw new Error('The default export must be a sketch value to save its camera configuration.');
    let binding = 'configuredSketch';
    while (source.includes(binding)) binding += '_';
    return cameras => source.slice(0,exported.range[0])+`const ${binding} = ${source.slice(...value.range)};\nexport default globalThis.Object.create(${binding}, { config: { get: () => ({ ...${binding}.config, cameras3: ${serialize(cameras)} }) } });`+source.slice(exported.range[1]);
  }
  throw new Error('Camera configuration needs one exported sketch definition. Use a default export to identify it.');
}
