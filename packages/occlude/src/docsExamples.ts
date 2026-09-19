/**
 * Shared transform for `ts live` docs examples: the fences are written as
 * ordinary sketches (ESM imports from 'occlude', `export default`), and
 * both the docs page (browser) and the headless checker turn them into
 * CJS the sketch runner can execute. Examples stick to annotation-free
 * TS so no real transpiler is needed.
 */

export function liveExampleToJs(src: string): string {
  // Every module specifier is rewritten, not only 'occlude': a sketch may
  // import '@user/pens' or '@user/papers', and the runner's `require`
  // is what decides which names exist (and says so when one does not).
  return src
    .replace(
      /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/g,
      // `circle as disc` is ordinary ESM, not a type annotation, but in a
      // destructuring binding the rename is spelled with a colon.
      (_, names: string, module: string) => `const {${names.replace(/\s+as\s+/g, ': ')}} = require('${module}');`,
    )
    .replace(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"];?/g, (_, name: string, module: string) => `const ${name} = require('${module}');`)
    .replace(/import\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"];?/g, (_, name: string, module: string) => `const ${name} = require('${module}').default;`)
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
  { slug: 'three', title: '3D line art', file: 'three.md', live: true, group: 'topics' },
  { slug: 'images', title: 'Images & imports', file: 'images.md', live: true, group: 'topics' },
  { slug: 'plotting', title: 'Plotting & saving', file: 'plotting.md', live: true, group: 'topics' },
  { slug: 'studio', title: 'The studio', file: 'studio.md', live: false, group: 'topics' },
  { slug: 'gallery', title: 'Gallery', file: 'gallery.md', live: true, group: 'topics' },
  { slug: 'reference-shapes', title: 'Reference: Shapes', file: 'reference/shapes.mdx', live: true, group: 'topics' },
  { slug: 'reference-fields', title: 'Reference: Fields', file: 'reference/fields.mdx', live: true, group: 'topics' },
  { slug: 'reference-points', title: 'Reference: Points', file: 'reference/points.mdx', live: true, group: 'topics' },
  { slug: 'reference-fills', title: 'Reference: Fills', file: 'reference/fills.mdx', live: true, group: 'topics' },
  { slug: 'reference-connect', title: 'Reference: Connect', file: 'reference/connect.mdx', live: true, group: 'topics' },
  { slug: 'reference-transforms', title: 'Reference: Transforms', file: 'reference/transforms.mdx', live: true, group: 'topics' },
  { slug: 'reference-material', title: 'Reference: Material', file: 'reference/material.mdx', live: true, group: 'topics' },
  { slug: 'reference-math', title: 'Reference: Math', file: 'reference/math.mdx', live: true, group: 'topics' },
  { slug: 'reference-random', title: 'Reference: Random', file: 'reference/random.mdx', live: true, group: 'topics' },
  { slug: 'reference-sketch', title: 'Reference: Sketch', file: 'reference/sketch.mdx', live: true, group: 'topics' },
  // The graph page carries screenshots, not a runnable example: there is
  // no ink to hash, and the canvas is the thing to look at.
  { slug: 'reference-graph', title: 'Reference: Graph', file: 'reference/graph.mdx', live: false, group: 'topics' },
  { slug: 'reference-selections', title: 'Reference: Selections', file: 'reference/selections.mdx', live: true, group: 'topics' },
  { slug: 'reference-steps', title: 'Reference: Steps and forces', file: 'reference/steps.mdx', live: true, group: 'topics' },
  { slug: 'reference-faces', title: 'Reference: Faces', file: 'reference/faces.mdx', live: true, group: 'topics' },
  { slug: 'reference-images', title: 'Reference: Images', file: 'reference/images.mdx', live: true, group: 'topics' },
  { slug: 'reference-plotting', title: 'Reference: Plotting', file: 'reference/plotting.mdx', live: true, group: 'topics' },
  { slug: 'reference-3d-primitives', title: 'Reference: 3D primitives', file: 'reference/3d/primitives.mdx', live: true, group: 'topics' },
  { slug: 'reference-3d-edits', title: 'Reference: 3D edits', file: 'reference/3d/edits.mdx', live: true, group: 'topics' },
  { slug: 'reference-3d-curves', title: 'Reference: 3D curves', file: 'reference/3d/curves.mdx', live: true, group: 'topics' },
  { slug: 'reference-3d-instances', title: 'Reference: 3D instances', file: 'reference/3d/instances.mdx', live: true, group: 'topics' },
  { slug: 'reference-3d-view', title: 'Reference: 3D view', file: 'reference/3d/view.mdx', live: true, group: 'topics' },
  { slug: 'reference-3d-surface', title: 'Reference: 3D surface curves', file: 'reference/3d/surface.mdx', live: true, group: 'topics' },
  { slug: 'reference-3d-fields', title: 'Reference: 3D surface fields', file: 'reference/3d/fields.mdx', live: true, group: 'topics' },
  { slug: 'examples-tangle', title: 'Example: Tangle', file: 'examples/tangle.mdx', live: true, group: 'topics' },
  { slug: 'examples-terraces', title: 'Example: terraces', file: 'examples/terraces.mdx', live: true, group: 'topics' },
  { slug: 'examples-delta', title: 'Example: delta', file: 'examples/delta.mdx', live: true, group: 'topics' },
  { slug: 'examples-bloom', title: 'Example: bloom', file: 'examples/bloom.mdx', live: true, group: 'topics' },
  { slug: 'examples-plaid', title: 'Example: plaid', file: 'examples/plaid.mdx', live: true, group: 'topics' },
  { slug: 'examples-portrait', title: 'Example: portrait', file: 'examples/portrait.mdx', live: true, group: 'topics' },
  { slug: 'examples-plate', title: 'Example: plate', file: 'examples/plate.mdx', live: true, group: 'topics' },
  { slug: 'examples-rose-window', title: 'Example: rose-window', file: 'examples/rose-window.mdx', live: true, group: 'topics' },
  { slug: 'examples-cellular-print', title: 'Example: cellular-print', file: 'examples/cellular-print.mdx', live: true, group: 'topics' },
  { slug: 'examples-territory', title: 'Example: territory', file: 'examples/territory.mdx', live: true, group: 'topics' },
  { slug: 'examples-island', title: 'Example: island', file: 'examples/island.mdx', live: true, group: 'topics' },
  { slug: 'examples-stones', title: 'Example: stones', file: 'examples/stones.mdx', live: true, group: 'topics' },
  { slug: 'examples-vessels', title: 'Example: vessels', file: 'examples/vessels.mdx', live: true, group: 'topics' },
  { slug: 'examples-respond', title: 'Example: respond', file: 'examples/respond.mdx', live: true, group: 'topics' },
  { slug: 'examples-network', title: 'Example: network', file: 'examples/network.mdx', live: true, group: 'topics' },
  { slug: 'examples-flow', title: 'Example: flow', file: 'examples/flow.mdx', live: true, group: 'topics' },
  { slug: 'examples-terrain', title: 'Example: terrain', file: 'examples/terrain.mdx', live: true, group: 'topics' },
  { slug: 'examples-front', title: 'Example: front', file: 'examples/front.mdx', live: true, group: 'topics' },
  { slug: 'examples-colony', title: 'Example: colony', file: 'examples/colony.mdx', live: true, group: 'topics' },
  { slug: 'examples-flake', title: 'Example: flake', file: 'examples/flake.mdx', live: true, group: 'topics' },
  { slug: 'examples-shoal', title: 'Example: shoal', file: 'examples/shoal.mdx', live: true, group: 'topics' },
  { slug: 'examples-thicket', title: 'Example: thicket', file: 'examples/thicket.mdx', live: true, group: 'topics' },
  { slug: 'examples-between', title: 'Example: between', file: 'examples/between.mdx', live: true, group: 'topics' },
  { slug: 'examples-raking', title: 'Example: raking', file: 'examples/raking.mdx', live: true, group: 'topics' },
  { slug: 'examples-span', title: 'Example: span', file: 'examples/span.mdx', live: true, group: 'topics' },
  { slug: 'examples-reach', title: 'Example: reach', file: 'examples/reach.mdx', live: true, group: 'topics' },
  { slug: 'examples-nightfall', title: 'Example: nightfall', file: 'examples/nightfall.mdx', live: true, group: 'topics' },
  { slug: 'examples-glaze', title: 'Example: glaze', file: 'examples/glaze.mdx', live: true, group: 'topics' },
  { slug: 'examples-spindle', title: 'Example: spindle', file: 'examples/spindle.mdx', live: true, group: 'topics' },
  { slug: 'workshop-01', title: '1. Put marks on paper', file: 'workshop-01-marks.md', live: true, group: 'workshop' },
  { slug: 'workshop-02', title: '2. Turn a shape into something editable', file: 'workshop-02-material.md', live: true, group: 'workshop' },
  { slug: 'workshop-03', title: '3. Give geometry information', file: 'workshop-03-attributes.md', live: true, group: 'workshop' },
  { slug: 'workshop-04', title: '4. Make it change', file: 'workshop-04-change.md', live: true, group: 'workshop' },
  { slug: 'workshop-05', title: '5. Let lines notice each other', file: 'workshop-05-notice.md', live: true, group: 'workshop' },
  { slug: 'workshop-06', title: '6. Discover the spaces between lines', file: 'workshop-06-spaces.md', live: true, group: 'workshop' },
  { slug: 'workshop-07', title: '7. Read an invisible landscape', file: 'workshop-07-field.md', live: true, group: 'workshop' },
  { slug: 'workshop-08', title: '8. Put the ink where it matters', file: 'workshop-08-tone.md', live: true, group: 'workshop' },
  { slug: 'workshop-09', title: '9. Turn points into territory', file: 'workshop-09-territory.md', live: true, group: 'workshop' },
  { slug: 'workshop-10', title: '10. Let a drawing respond', file: 'workshop-10-respond.md', live: true, group: 'workshop' },
  { slug: 'workshop-11', title: '11. Make it work on paper', file: 'workshop-11-paper.md', live: true, group: 'workshop' },
  { slug: 'architecture', title: 'Architecture', file: 'architecture.md', live: false, group: 'developer' },
  { slug: 'device-notes', title: 'Device notes', file: 'device-notes.md', live: false, group: 'developer' },
  { slug: 'notes', title: 'Working notes', file: 'notes.md', live: false, group: 'developer' },
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
