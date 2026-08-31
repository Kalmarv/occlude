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
