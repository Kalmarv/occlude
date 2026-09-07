/**
 * Shared transform for `ts live` docs examples: the fences are written as
 * ordinary sketches (ESM imports from 'occlude', `export default`), and
 * both the docs page (browser) and the headless checker turn them into
 * CJS the sketch runner can execute. Examples stick to annotation-free
 * TS so no real transpiler is needed.
 */

export function liveExampleToJs(src: string): string {
  return src
    .replace(
      /import\s*\{([^}]*)\}\s*from\s*['"]occlude['"];?/g,
      (_, names: string) => `const {${names}} = require('occlude');`,
    )
    .replace(/export\s+default\s+/, 'module.exports.default = ');
}

/** The topic pages of the docs site, in navigation order. `live` pages hold
 * checked examples; developer notes are reachable but not required reading. */
export const DOC_PAGES: { slug: string; title: string; file: string; live: boolean; group: 'topics' | 'workshop' | 'developer' }[] = [
  { slug: 'getting-started', title: 'Getting started', file: 'getting-started.md', live: true, group: 'topics' },
  { slug: 'shapes', title: 'Shapes & layout', file: 'shapes.md', live: true, group: 'topics' },
  { slug: 'fills', title: 'Fills', file: 'fills.md', live: true, group: 'topics' },
  { slug: 'fields', title: 'Fields & variation', file: 'fields.md', live: true, group: 'topics' },
  { slug: 'materials', title: 'Materials', file: 'materials.md', live: true, group: 'topics' },
  { slug: 'images', title: 'Images & imports', file: 'images.md', live: true, group: 'topics' },
  { slug: 'plotting', title: 'Plotting & saving', file: 'plotting.md', live: true, group: 'topics' },
  { slug: 'gallery', title: 'Gallery', file: 'gallery.md', live: true, group: 'topics' },
  { slug: 'workshop-01', title: '1. Put marks on paper', file: 'workshop-01-marks.md', live: true, group: 'workshop' },
  { slug: 'workshop-02', title: '2. Turn a shape into something editable', file: 'workshop-02-material.md', live: true, group: 'workshop' },
  { slug: 'workshop-03', title: '3. Give geometry information', file: 'workshop-03-attributes.md', live: true, group: 'workshop' },
  { slug: 'architecture', title: 'Architecture', file: 'architecture.md', live: false, group: 'developer' },
  { slug: 'device-notes', title: 'Device notes', file: 'device-notes.md', live: false, group: 'developer' },
  { slug: 'idraw-log', title: 'iDraw log (2026)', file: 'idraw-integration.md', live: false, group: 'developer' },
];

/** Settings a live fence may carry after `ts live`: `paper=A5` or
 * `paper=120x80` (mm), `margin=8` (percent), `landscape`, `focus=10-13`
 * (lines the editor highlights). Everything else
 * is the default sheet: Square20 at a 5 % margin, the drawable shown whole. */
export interface LiveMeta {
  paper?: string;
  margin?: number;
  landscape?: boolean;
  /** Line ranges (1-based, inclusive) the editor highlights as the lines
   * this example is about: `focus=10-13,20`. */
  focus?: [number, number][];
}

export function parseLiveMeta(info: string): LiveMeta {
  const meta: LiveMeta = {};
  for (const tok of info.trim().split(/\s+/).filter(Boolean)) {
    const [k, v] = tok.split('=');
    if (k === 'paper' && v) meta.paper = v;
    else if (k === 'margin' && v && Number.isFinite(+v)) meta.margin = +v;
    else if (k === 'landscape') meta.landscape = true;
    else if (k === 'focus' && v) {
      meta.focus = v.split(',').map((part) => {
        const [a, b] = part.split('-').map(Number);
        if (!Number.isInteger(a) || a < 1 || (b !== undefined && (!Number.isInteger(b) || b < a))) throw new Error(`bad focus range '${part}' (lines like 10-13,20)`);
        return [a, b ?? a];
      });
    } else throw new Error(`unknown live setting '${tok}' (paper=, margin=, landscape, focus=)`);
  }
  return meta;
}

/** The paper a docs example renders on, as `render`/`paperSize` take it. */
export function docsPaper(meta: LiveMeta): { paper: string | { w: number; h: number }; landscape?: boolean } {
  const wh = meta.paper?.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/);
  if (wh) return { paper: { w: +wh[1], h: +wh[2] }, landscape: meta.landscape ?? false };
  return { paper: meta.paper ?? 'Square20', landscape: meta.landscape ?? false };
}
