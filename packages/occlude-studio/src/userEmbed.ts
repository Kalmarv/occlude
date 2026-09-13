/**
 * A downloaded sketch travels complete: the `@user/pens` and `@user/papers`
 * entries it imports are bundled as inline definitions (`penModel({…})` /
 * `paperModel({…})` from 'occlude'), each under a marker comment naming the
 * library entry, so the file runs anywhere with exactly the definitions it
 * was written against. Import leaves them inline; "relink" is the explicit
 * action that rewrites the bundled definitions back into library imports
 * when the local library has every name — its definitions then apply.
 *
 * Text rewrites only, on the import lines and the bundled blocks; the rest
 * of the sketch is untouched.
 */

import { moduleName, penModel, paperModel, type PaperDef, type PenDef } from 'occlude';

void penModel; void paperModel; // the names the bundle spells; kept in the type graph

const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*['"]@user\/(pens|papers)['"];?[ \t]*$/gm;
const MARK = (kind: 'pens' | 'papers', name: string): string => `// ---- @user/${kind} bundled: ${name} ----`;
const MARK_RE = /^\/\/ ---- @user\/(pens|papers) bundled: (.+?) ----$/;

export interface UserImport {
  kind: 'pens' | 'papers';
  /** The export identifier imported, and the local binding it takes. */
  entries: { id: string; local: string }[];
}

/** The `@user/*` imports a source declares. */
export function scanUserImports(source: string): UserImport[] {
  const out: UserImport[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const entries = m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const as = s.split(/\s+as\s+/);
      return { id: as[0].trim(), local: (as[1] ?? as[0]).trim() };
    });
    out.push({ kind: m[2] as 'pens' | 'papers', entries });
  }
  return out;
}

/** Bundle every imported library entry inline. An import whose entry the
 * library lacks is left as it is (and reported), so nothing is invented. */
export function bundleUserImports(source: string, pens: readonly PenDef[], papers: readonly PaperDef[]): { source: string; bundled: string[]; missing: string[] } {
  const bundled: string[] = [];
  const missing: string[] = [];
  let needPen = false;
  let needPaper = false;
  const out = source.replace(IMPORT_RE, (line, list: string, kind: 'pens' | 'papers') => {
    const entries = scanUserImports(line)[0]?.entries ?? [];
    const library: readonly { name: string }[] = kind === 'pens' ? pens : papers;
    const lines: string[] = [];
    const keep: string[] = [];
    for (const e of entries) {
      const def = library.find((p) => moduleName(p.name) === e.id);
      if (!def) { missing.push(`@user/${kind}:${e.id}`); keep.push(e.local === e.id ? e.id : `${e.id} as ${e.local}`); continue; }
      bundled.push(def.name);
      lines.push(MARK(kind, def.name));
      if (kind === 'pens') {
        needPen = true;
        lines.push(`const ${e.local} = penModel(${JSON.stringify(def)});`);
      } else {
        needPaper = true;
        const p = def as PaperDef;
        lines.push(`const ${e.local} = paperModel(${JSON.stringify(p.color === undefined ? { w: p.w, h: p.h } : { w: p.w, h: p.h, color: p.color })});`);
      }
    }
    if (keep.length) lines.unshift(`import { ${keep.join(', ')} } from '@user/${kind}';`);
    void list;
    return lines.join('\n');
  });
  return { source: withOccludeImports(out, [...(needPen ? ['penModel'] : []), ...(needPaper ? ['paperModel'] : [])]), bundled, missing };
}

/** The bundled definitions a source carries: kind, library name, binding. */
export function scanBundled(source: string): { kind: 'pens' | 'papers'; name: string; local: string; line: number }[] {
  const out: { kind: 'pens' | 'papers'; name: string; local: string; line: number }[] = [];
  const lines = source.split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    const m = lines[i].match(MARK_RE);
    if (!m) continue;
    const def = lines[i + 1].match(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:penModel|paperModel)\(/);
    if (!def) continue;
    out.push({ kind: m[1] as 'pens' | 'papers', name: m[2], local: def[1], line: i });
  }
  return out;
}

/** Rewrite bundled definitions back into `@user/*` imports — the explicit
 * "use my libraries" action. Every bundled name must exist locally (under
 * its export identifier); otherwise nothing changes and the missing names
 * are returned. */
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
  return { source: withOccludeImports(out.join('\n'), [], ['penModel', 'paperModel']), relinked: bundled.map((b) => b.name), missing: [] };
}

/** Add `add` to (and drop `remove` from) the sketch's `import { … } from
 * 'occlude'` line, if it has one; names still used elsewhere are kept. */
function withOccludeImports(source: string, add: string[], remove: string[] = []): string {
  return source.replace(/import\s*\{([^}]*)\}\s*from\s*['"]occlude['"];?/, (line, list: string) => {
    let names = list.split(',').map((s) => s.trim()).filter(Boolean);
    for (const r of remove) {
      const used = new RegExp(`\\b${r}\\(`).test(source.replace(line, ''));
      if (!used) names = names.filter((n) => n !== r);
    }
    for (const a of add) if (!names.includes(a)) names.push(a);
    return `import { ${names.join(', ')} } from 'occlude';`;
  });
}
