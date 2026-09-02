/**
 * The built-in fills' source text, for the Fills panel: read-only viewing
 * and Clone. Globbed from the package's fill files so the text the artist
 * sees IS the code that runs — never a copy. Inside the package the files
 * import their contract relatively; a clone is a standalone fill file, so
 * those specifiers become `'occlude'`.
 */

const raw = import.meta.glob('../../occlude/src/fills/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export const BUILTIN_FILL_SOURCES: Record<string, string> = {};
for (const [path, src] of Object.entries(raw)) {
  const name = path.split('/').pop()!.replace(/\.ts$/, '');
  BUILTIN_FILL_SOURCES[name] = src.replace(/from '\.\.\/[a-zA-Z]+\.js'/g, "from 'occlude'");
}

/** Clone header: the copy is the artist's; the built-in stays as it was. */
export function cloneSource(from: string, source: string): string {
  return `// Cloned from '${from}' — this copy is yours to edit; '${from}' itself never changes.\n${source}`;
}
