/**
 * A downloaded sketch travels complete: the `@user/pens` and `@user/papers`
 * entries it imports are bundled as inline definitions (`penModel({…})` /
 * `paperModel({…})` from 'occlude'), each under a marker comment naming the
 * library entry, so the file runs anywhere with exactly the definitions it
 * was written against. Import leaves them inline; "relink" is the explicit
 * action that rewrites the bundled definitions back into library imports
 * when the local library has every name — its definitions then apply.
 *
 * Import statements are read syntactically: `{ a, b as c }` lists, either
 * quote, an optional semicolon and a trailing `//` comment. The occlude
 * helper is reached through whatever the sketch already has — a named
 * import (extended), a namespace import (`o.penModel`), or a new import
 * line — under a binding that cannot collide with the sketch's own names.
 */

import { moduleName, type PaperDef, type PenDef } from 'occlude';

const USER_IMPORT_RE = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*(['"])@user\/(pens|papers)\2\s*;?[ \t]*(?:\/\/[^\n]*)?$/gm;
const OCCLUDE_NAMED_RE = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*(['"])occlude\2\s*;?[ \t]*(?:\/\/[^\n]*)?$/m;
const OCCLUDE_NS_RE = /^[ \t]*import\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*(['"])occlude\2\s*;?[ \t]*(?:\/\/[^\n]*)?$/m;
const MARK = (kind: 'pens' | 'papers', name: string): string => `// ---- @user/${kind} bundled: ${name} ----`;
const MARK_RE = /^\/\/ ---- @user\/(pens|papers) bundled: (.+?) ----$/;
const DEF_RE = /^const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$.]*)\(/;
const HELPERS = ['penModel', 'paperModel'] as const;
type Helper = (typeof HELPERS)[number];

export interface UserImport {
  kind: 'pens' | 'papers';
  /** The export identifier imported, and the local binding it takes. */
  entries: { id: string; local: string }[];
}

function parseList(list: string): { id: string; local: string }[] {
  return list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const as = s.split(/\s+as\s+/);
    return { id: as[0].trim(), local: (as[1] ?? as[0]).trim() };
  });
}

/** The `@user/*` imports a source declares. */
export function scanUserImports(source: string): UserImport[] {
  const out: UserImport[] = [];
  for (const m of source.matchAll(USER_IMPORT_RE)) out.push({ kind: m[3] as 'pens' | 'papers', entries: parseList(m[1]) });
  return out;
}

/** How the bundled definitions reach the occlude helpers: the expression to
 * call for each, and the import edit that makes it valid. */
function helperAccess(source: string, need: Helper[]): { expr: Record<Helper, string>; apply(src: string): string } {
  const expr = { penModel: 'penModel', paperModel: 'paperModel' } as Record<Helper, string>;
  if (need.length === 0) return { expr, apply: (s) => s };
  const ns = source.match(OCCLUDE_NS_RE);
  if (ns) {
    for (const h of need) expr[h] = `${ns[1]}.${h}`;
    return { expr, apply: (s) => s };
  }
  const named = source.match(OCCLUDE_NAMED_RE);
  const have = named ? parseList(named[1]) : [];
  const add: string[] = [];
  const bodyWithoutImports = source.replace(USER_IMPORT_RE, '').replace(OCCLUDE_NAMED_RE, '');
  for (const h of need) {
    const already = have.find((e) => e.id === h);
    if (already) { expr[h] = already.local; continue; }
    // a binding the sketch does not use anywhere: `penModel`, else a suffixed one
    let local: string = h;
    for (let k = 1; new RegExp(`\\b${local}\\b`).test(bodyWithoutImports) || have.some((e) => e.local === local); k++) local = `${h}$${k}`;
    expr[h] = local;
    add.push(local === h ? h : `${h} as ${local}`);
  }
  return {
    expr,
    apply: (s) => {
      if (add.length === 0) return s;
      if (named) return s.replace(OCCLUDE_NAMED_RE, (line, list: string, q: string) => `import { ${[...list.split(',').map((x) => x.trim()).filter(Boolean), ...add].join(', ')} } from ${q}occlude${q};`);
      return `import { ${add.join(', ')} } from 'occlude';\n${s}`;
    },
  };
}

/** Bundle every imported library entry inline. An import whose entry the
 * library lacks is left as it is and reported, so nothing is invented. */
export function bundleUserImports(source: string, pens: readonly PenDef[], papers: readonly PaperDef[]): { source: string; bundled: string[]; missing: string[] } {
  const bundled: string[] = [];
  const missing: string[] = [];
  const need = new Set<Helper>();
  for (const imp of scanUserImports(source)) {
    const library: readonly { name: string }[] = imp.kind === 'pens' ? pens : papers;
    if (imp.entries.some((e) => library.some((p) => moduleName(p.name) === e.id))) need.add(imp.kind === 'pens' ? 'penModel' : 'paperModel');
  }
  const access = helperAccess(source, [...need]);
  const out = source.replace(USER_IMPORT_RE, (_line, list: string, q: string, kind: 'pens' | 'papers') => {
    const library: readonly { name: string }[] = kind === 'pens' ? pens : papers;
    const lines: string[] = [];
    const keep: string[] = [];
    for (const e of parseList(list)) {
      const def = library.find((p) => moduleName(p.name) === e.id);
      if (!def) { missing.push(`@user/${kind}:${e.id}`); keep.push(e.local === e.id ? e.id : `${e.id} as ${e.local}`); continue; }
      bundled.push(def.name);
      lines.push(MARK(kind, def.name));
      if (kind === 'pens') {
        lines.push(`const ${e.local} = ${access.expr.penModel}(${JSON.stringify(def)});`);
      } else {
        const p = def as PaperDef;
        lines.push(`const ${e.local} = ${access.expr.paperModel}(${JSON.stringify(p.color === undefined ? { w: p.w, h: p.h } : { w: p.w, h: p.h, color: p.color })});`);
      }
    }
    if (keep.length) lines.unshift(`import { ${keep.join(', ')} } from ${q}@user/${kind}${q};`);
    return lines.join('\n');
  });
  return { source: access.apply(out), bundled, missing };
}

/** The bundled definitions a source carries: kind, library name, binding. */
export function scanBundled(source: string): { kind: 'pens' | 'papers'; name: string; local: string; line: number }[] {
  const out: { kind: 'pens' | 'papers'; name: string; local: string; line: number }[] = [];
  const lines = source.split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    const m = lines[i].match(MARK_RE);
    if (!m) continue;
    // the marker is the authority; the definition below it calls the helper
    // through whatever binding the bundle used (`penModel`, `o.penModel`,
    // `makePen` …)
    const def = lines[i + 1].match(DEF_RE);
    if (!def) continue;
    out.push({ kind: m[1] as 'pens' | 'papers', name: m[2], local: def[1], line: i });
  }
  return out;
}

/** Rewrite bundled definitions back into `@user/*` imports — the explicit
 * "use my libraries" action. Every bundled name must exist locally (under
 * its export identifier); otherwise nothing changes and the missing names
 * are returned. Helper bindings the bundle added and nothing else uses
 * leave the occlude import with it. */
export function relinkUserImports(source: string, pens: readonly PenDef[], papers: readonly PaperDef[]): { source: string; relinked: string[]; missing: string[] } {
  const bundled = scanBundled(source);
  if (bundled.length === 0) return { source, relinked: [], missing: [] };
  const missing = bundled.filter((b) => !(b.kind === 'pens' ? pens : papers).some((p) => moduleName(p.name) === moduleName(b.name))).map((b) => `@user/${b.kind}:${b.name}`);
  if (missing.length) return { source, relinked: [], missing };
  const lines = source.split('\n');
  const drop = new Set<number>();
  const imports: Record<'pens' | 'papers', string[]> = { pens: [], papers: [] };
  for (const b of bundled) {
    drop.add(b.line); drop.add(b.line + 1);
    const id = moduleName(b.name);
    imports[b.kind].push(id === b.local ? id : `${id} as ${b.local}`);
  }
  const first = Math.min(...bundled.map((b) => b.line));
  const importLines = (['pens', 'papers'] as const).filter((k) => imports[k].length).map((k) => `import { ${imports[k].join(', ')} } from '@user/${k}';`);
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (i === first) out.push(...importLines);
    if (!drop.has(i)) out.push(l);
  });
  return { source: dropUnusedHelpers(out.join('\n')), relinked: bundled.map((b) => b.name), missing: [] };
}

/** Remove penModel/paperModel bindings from the occlude named import when
 * nothing in the source uses them any more; an import left empty goes. */
function dropUnusedHelpers(source: string): string {
  const m = source.match(OCCLUDE_NAMED_RE);
  if (!m) return source;
  const rest = source.replace(m[0], '');
  const keep = parseList(m[1]).filter((e) => !(HELPERS as readonly string[]).includes(e.id) || new RegExp(`\\b${e.local}\\b`).test(rest));
  if (keep.length === 0) return source.replace(`${m[0]}\n`, '').replace(m[0], '');
  const list = keep.map((e) => (e.id === e.local ? e.id : `${e.id} as ${e.local}`)).join(', ');
  return source.replace(m[0], `import { ${list} } from ${m[2]}occlude${m[2]};`);
}
