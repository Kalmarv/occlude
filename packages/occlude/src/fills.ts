/**
 * Fills. The engine generates NO patterns (it decides what survives to
 * paper, never what gets drawn): every fill is sketch-space code run
 * between the two render passes, against the shape's FINAL outline
 * (post-deform, post-cull), then clipped and occluded by the engine like
 * all ink.
 *
 * Two forms, one contract (fillModule.ts):
 * - `fill('hatch', { … })` references a fill MODULE by name — a
 *   capture-free `fillAsset` file with a declared parameter interface.
 *   Built-ins (src/fills/*.ts) resolve from the package and are
 *   ink-immutable; custom fills are loaded into the registry by the host
 *   (studio worker, node tools) from the studio's fill library.
 * - An inline function (`fill: (region, ctx) => …`) is a plain closure —
 *   it just works, since fills execute in the same runtime as the sketch.
 *
 * A mask is opaque with zero ink — the primitive of hidden-line rendering.
 */

import { positiveLength } from './guard.js';
import { mm, type L } from './units.js';
import { liveExampleToJs } from './docsExamples.js';
import type { CustomFillFn, FillAssetDef } from './fillModule.js';
import hatch from './fills/hatch.js';
import crosshatch from './fills/crosshatch.js';
import solid from './fills/solid.js';
import stipple from './fills/stipple.js';

export {
  fillAsset, rulings,
  type FillRegion, type FillCtx, type CustomFillFn, type CustomPrimitive,
  type FillAssetDef, type RulingOpts,
} from './fillModule.js';

export type FillSpec =
  | { type: 'use'; name: string; params: Record<string, unknown> }
  | { type: 'custom'; fn: CustomFillFn }
  | { type: 'mask' };

/**
 * Use a fill module by name with parameter overrides. Names are literals —
 * computed names defeat scanning and import rewiring.
 */
export function fill(name: string, params: Record<string, unknown> = {}): FillSpec {
  return { type: 'use', name, params };
}

/** Wrap an inline fill function. `.fill(f)` also accepts the function directly. */
export function customFill(fn: CustomFillFn): FillSpec {
  return { type: 'custom', fn };
}

// ---- resolution -------------------------------------------------------

type AnyFill = FillAssetDef<Record<string, unknown>>;

/** Built-ins resolve from the package — never from any store — and their
 * names are ink-immutable forever: an ink-affecting change needs a NEW
 * name, or a package upgrade would silently change every saved sketch. */
const BUILTIN_FILLS = new Map<string, AnyFill>([
  ['hatch', hatch as AnyFill],
  ['crosshatch', crosshatch as AnyFill],
  ['solid', solid as AnyFill],
  ['stipple', stipple as AnyFill],
]);

export const BUILTIN_FILL_NAMES: readonly string[] = [...BUILTIN_FILLS.keys()];

export function isBuiltinFill(name: string): boolean {
  return BUILTIN_FILLS.has(name);
}

/** Custom fills the host loaded for the current run (studio: fetched from
 * the fill library per render; node tools: read from disk). */
const customFills = new Map<string, AnyFill>();

/** Register a loaded custom fill module. Built-in names are refused: they
 * never live in a store and cannot be shadowed. */
export function registerFill(name: string, def: AnyFill): void {
  if (isBuiltinFill(name)) {
    throw new Error(`'${name}' is a built-in fill — clone it under a new name to change it`);
  }
  customFills.set(name, def);
}

export function clearFills(): void {
  customFills.clear();
}

/** Resolve a fill name: built-ins from the package, then the registry. */
export function resolveFill(name: string): AnyFill | undefined {
  return BUILTIN_FILLS.get(name) ?? customFills.get(name);
}

/**
 * Fill names a source references: `fill('name'` literals, including the
 * CommonJS indirect form `(0, x.fill)('name'` that transpilers emit.
 * Literal names are the contract — this scan is what the studio worker,
 * the node tools, and warn-on-edit all key on.
 */
export function scanFillNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\bfill\)?\(\s*['"]([^'"\n]+)['"]/g)) names.add(m[1]);
  return [...names];
}

/** Module specifiers a (type-stripped) fill source imports or requires:
 * `import … from '…'` statements (single- or multi-line, anchored at a
 * line start so prose like "cloned from 'hatch'" in a comment is not an
 * import), side-effect imports, dynamic imports, and require() calls. */
function importedSpecifiers(js: string): string[] {
  const out: string[] = [];
  for (const m of js.matchAll(/^\s*import\s[^;]*?\bfrom\s*['"]([^'"\n]+)['"]/gm)) out.push(m[1]);
  for (const m of js.matchAll(/^\s*import\s*['"]([^'"\n]+)['"]/gm)) out.push(m[1]);
  for (const m of js.matchAll(/\bimport\(\s*['"]([^'"\n]+)['"]/g)) out.push(m[1]);
  for (const m of js.matchAll(/\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

/**
 * Evaluate a fill file's JS and register it under `name`. `js` is the
 * fill's source with types stripped — ESM (`import … from 'occlude'`,
 * `export default fillAsset(…)`) or already-CommonJS; the same
 * import/export rewrite the docs examples use handles the ESM form. Fill
 * files import nothing but occlude (self-contained files are what make
 * export embedding complete): any other specifier is refused before a
 * line of it runs.
 */
export function loadFillModule(name: string, js: string): AnyFill {
  for (const spec of importedSpecifiers(js)) {
    if (spec !== 'occlude') {
      throw new Error(`fill '${name}' may import only from 'occlude' (found '${spec}')`);
    }
  }
  const cjs = liveExampleToJs(js);
  const module = { exports: {} as Record<string, unknown> };
  const require = (spec: string): unknown => {
    if (spec === 'occlude') return occludeModule();
    throw new Error(`fill '${name}' may import only from 'occlude' (tried '${spec}')`);
  };
  new Function('require', 'exports', 'module', cjs)(require, module.exports, module);
  const def = module.exports.default as Partial<AnyFill> | undefined;
  if (!def || typeof def !== 'object' || typeof def.generate !== 'function' ||
      !def.params || typeof def.params !== 'object') {
    throw new Error(
      `fill '${name}' must \`export default fillAsset({ params, generate })\``,
    );
  }
  registerFill(name, def as AnyFill);
  return def as AnyFill;
}

/** The package's public surface, as a fill file sees it via `require`. Set
 * once by index.ts (a fill file may use any pure export — rulings, mm,
 * ease, map — exactly what a sketch may). */
let occludeExports: Record<string, unknown> | null = null;
export function setOccludeModule(mod: Record<string, unknown>): void {
  occludeExports = mod;
}
function occludeModule(): Record<string, unknown> {
  if (!occludeExports) throw new Error('occlude module not initialised');
  return occludeExports;
}

/** Validate the L-typed params a fill use may carry (mid-edit transients). */
export function validateFillParams(name: string, params: Record<string, unknown>): void {
  for (const key of ['spacing', 'minDist'] as const) {
    if (key in params) positiveLength(name, params[key] as L | undefined);
  }
}

/** Default hatch spacing for a pen: 3× nib width, in mm. */
export function defaultHatchSpacing(penWidth: number): L {
  return mm(3 * penWidth);
}

/** Default stipple min distance for a pen: 2× nib width, in mm. */
export function defaultStippleMinDist(penWidth: number): L {
  return mm(2 * penWidth);
}
