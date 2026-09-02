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
  /** A fill module held by value (a `fillAsset` defined in the sketch
   * itself): resolves in place, no library involved. */
  | { type: 'asset'; def: FillAssetDef<Record<string, unknown>>; params: Record<string, unknown> }
  | { type: 'custom'; fn: CustomFillFn }
  | { type: 'mask' };

/**
 * Use a fill module with parameter overrides — by NAME (a literal: computed
 * names defeat scanning and import rewiring; the stored/referenced form)
 * or by VALUE (a `fillAsset` defined right in the sketch — the declared-
 * params form without a library; execution and storage are separate
 * concerns).
 */
export function fill<P extends Record<string, unknown>>(
  asset: FillAssetDef<P>,
  params?: Partial<P>,
): FillSpec;
export function fill(name: string, params?: Record<string, unknown>): FillSpec;
export function fill(
  ref: string | FillAssetDef<Record<string, unknown>>,
  params: Record<string, unknown> = {},
): FillSpec {
  if (typeof ref === 'string') return { type: 'use', name: ref, params };
  return { type: 'asset', def: ref, params };
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

/** The fill-name grammar — a `fill('name')` literal and a library file
 * name in one: no spaces, no quotes, no path separators. The server's
 * fill-store.mjs carries the same regex (plain node); a test keeps them
 * equal. */
export const FILL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Fill names a source references: well-formed `fill('name'` literals,
 * including the CommonJS indirect form `(0, x.fill)('name'` that
 * transpilers emit. Literal names are the contract — this scan is what
 * the studio worker, the node tools, and warn-on-edit all key on. A
 * literal outside the grammar is not a name (nothing fetches it; encode
 * reports it as unknown if the sketch really uses it).
 */
export function scanFillNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/\bfill\)?\(\s*['"]([^'"\n]+)['"]/g)) {
    if (FILL_NAME_RE.test(m[1])) names.add(m[1]);
  }
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
  // Dynamic import takes any expression — a fill file has no use for it,
  // so its mere presence is refused rather than pattern-matched.
  if (/\bimport\s*\(/.test(js)) {
    throw new Error(`fill '${name}' may not use dynamic import()`);
  }
  const cjs = liveExampleToJs(js);
  // Only the named-import form is rewritten; a surviving ESM statement
  // (namespace or default import) would fail inside Function() with a
  // message pointing nowhere.
  if (/^\s*import\b/m.test(cjs)) {
    throw new Error(
      `fill '${name}' must import as \`import { … } from 'occlude'\` (namespace/default imports are not supported)`,
    );
  }
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

/** The package's surface as a fill file sees it via `require`: every pure
 * export (rulings, mm, ease, map, shapes …) and none of the host
 * integration (seed/pen/paper setters, the registry, the render entry
 * points) — a fill is a pure function of (region, params, ctx) and gets
 * no handle on the runtime around it. Provided lazily by index.ts, since
 * the namespace is only complete once the module graph has evaluated. */
let occludeProvider: (() => Record<string, unknown>) | null = null;
let occludeExports: Record<string, unknown> | null = null;
export function setOccludeModule(provider: () => Record<string, unknown>): void {
  occludeProvider = provider;
  occludeExports = null;
}
function occludeModule(): Record<string, unknown> {
  if (!occludeExports) {
    if (!occludeProvider) throw new Error('occlude module not initialised');
    occludeExports = occludeProvider();
  }
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
