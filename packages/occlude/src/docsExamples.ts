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
    // A type-only import has nothing to require: the studio transpiles the
    // types away before it gets here, and a sketch written for the studio
    // must run unchanged in the node tools, so the line is dropped.
    .replace(/^[ \t]*import\s+type\s+[^'"]*from\s*['"][^'"]+['"];?[ \t]*\r?\n?/gm, '')
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

/** The pages whose `ts live` fences the docs checker renders and the ink
 * oracle hashes: the reference and the examples, the content of the docs
 * site (packages/occlude-docs). A key in docs-ink.json is `<slug>#<n>`. */
export const DOC_PAGES: { slug: string; file: string }[] = [
  { slug: 'reference-sketch', file: 'reference/sketch.mdx' },
  { slug: 'reference-shapes', file: 'reference/shapes.mdx' },
  { slug: 'reference-fills', file: 'reference/fills.mdx' },
  { slug: 'reference-random', file: 'reference/random.mdx' },
  { slug: 'reference-math', file: 'reference/math.mdx' },
  { slug: 'reference-fields', file: 'reference/fields.mdx' },
  { slug: 'reference-images', file: 'reference/images.mdx' },
  { slug: 'reference-material', file: 'reference/material.mdx' },
  { slug: 'reference-selections', file: 'reference/selections.mdx' },
  { slug: 'reference-points', file: 'reference/points.mdx' },
  { slug: 'reference-connect', file: 'reference/connect.mdx' },
  { slug: 'reference-faces', file: 'reference/faces.mdx' },
  { slug: 'reference-transforms', file: 'reference/transforms.mdx' },
  { slug: 'reference-steps', file: 'reference/steps.mdx' },
  { slug: 'reference-geometry', file: 'reference/geometry.mdx' },
  { slug: 'reference-synth', file: 'reference/synth.mdx' },
  { slug: 'reference-plotting', file: 'reference/plotting.mdx' },
  { slug: 'reference-3d-primitives', file: 'reference/3d/primitives.mdx' },
  { slug: 'reference-3d-view', file: 'reference/3d/view.mdx' },
  { slug: 'reference-3d-edits', file: 'reference/3d/edits.mdx' },
  { slug: 'reference-3d-curves', file: 'reference/3d/curves.mdx' },
  { slug: 'reference-3d-instances', file: 'reference/3d/instances.mdx' },
  { slug: 'reference-3d-surface', file: 'reference/3d/surface.mdx' },
  { slug: 'reference-3d-fields', file: 'reference/3d/fields.mdx' },
  { slug: 'examples-tangle', file: 'examples/tangle.mdx' },
  { slug: 'examples-terraces', file: 'examples/terraces.mdx' },
  { slug: 'examples-delta', file: 'examples/delta.mdx' },
  { slug: 'examples-bloom', file: 'examples/bloom.mdx' },
  { slug: 'examples-plaid', file: 'examples/plaid.mdx' },
  { slug: 'examples-portrait', file: 'examples/portrait.mdx' },
  { slug: 'examples-plate', file: 'examples/plate.mdx' },
  { slug: 'examples-rose-window', file: 'examples/rose-window.mdx' },
  { slug: 'examples-cellular-print', file: 'examples/cellular-print.mdx' },
  { slug: 'examples-territory', file: 'examples/territory.mdx' },
  { slug: 'examples-island', file: 'examples/island.mdx' },
  { slug: 'examples-stones', file: 'examples/stones.mdx' },
  { slug: 'examples-vessels', file: 'examples/vessels.mdx' },
  { slug: 'examples-respond', file: 'examples/respond.mdx' },
  { slug: 'examples-network', file: 'examples/network.mdx' },
  { slug: 'examples-flow', file: 'examples/flow.mdx' },
  { slug: 'examples-terrain', file: 'examples/terrain.mdx' },
  { slug: 'examples-front', file: 'examples/front.mdx' },
  { slug: 'examples-colony', file: 'examples/colony.mdx' },
  { slug: 'examples-flake', file: 'examples/flake.mdx' },
  { slug: 'examples-shoal', file: 'examples/shoal.mdx' },
  { slug: 'examples-thicket', file: 'examples/thicket.mdx' },
  { slug: 'examples-between', file: 'examples/between.mdx' },
  { slug: 'examples-raking', file: 'examples/raking.mdx' },
  { slug: 'examples-span', file: 'examples/span.mdx' },
  { slug: 'examples-reach', file: 'examples/reach.mdx' },
  { slug: 'examples-nightfall', file: 'examples/nightfall.mdx' },
  { slug: 'examples-glaze', file: 'examples/glaze.mdx' },
  { slug: 'examples-spindle', file: 'examples/spindle.mdx' },
  { slug: 'examples-slack', file: 'examples/slack.mdx' },
  { slug: 'examples-survey', file: 'examples/survey.mdx' },
  { slug: 'examples-datum', file: 'examples/datum.mdx' },
  { slug: 'examples-weft', file: 'examples/weft.mdx' },
  { slug: 'examples-fault', file: 'examples/fault.mdx' },
  { slug: 'examples-sounding', file: 'examples/sounding.mdx' },
  { slug: 'examples-cone', file: 'examples/cone.mdx' },
  { slug: 'examples-cantilever', file: 'examples/cantilever.mdx' },
  { slug: 'examples-lichen', file: 'examples/lichen.mdx' },
  { slug: 'examples-interval', file: 'examples/interval.mdx' },
  { slug: 'examples-squall', file: 'examples/squall.mdx' },
  { slug: 'examples-train', file: 'examples/train.mdx' },
  { slug: 'examples-fivefold', file: 'examples/fivefold.mdx' },
  { slug: 'examples-attempts', file: 'examples/attempts.mdx' },
  { slug: 'examples-leaf', file: 'examples/leaf.mdx' },
  { slug: 'examples-corridor', file: 'examples/corridor.mdx' },
  { slug: 'examples-addresses', file: 'examples/addresses.mdx' },
  { slug: 'examples-calls', file: 'examples/calls.mdx' },
  { slug: 'examples-hyperbolic-plane-and-disk', file: 'examples/hyperbolic-plane-and-disk.mdx' },
  { slug: 'examples-hyperbolic-chords-and-geodesics', file: 'examples/hyperbolic-chords-and-geodesics.mdx' },
  { slug: 'examples-hyperbolic-circles', file: 'examples/hyperbolic-circles.mdx' },
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
