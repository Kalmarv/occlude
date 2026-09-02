/**
 * Headless custom-fill loading for the CLI tools: every `fill('name')` a
 * sketch references that is not a built-in is read from the studio's fill
 * library (../../occlude-studio/fills/<name>.ts), type-stripped with the
 * same node builtin the studio server uses, and registered through the
 * same `loadFillModule` the studio worker calls — one path for all
 * consumers. A missing file is left unregistered; the render then fails
 * with the usual "unknown fill" only if the sketch really uses it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error plain-JS module shared with the studio server
import { stripFillTypes } from '../../occlude-studio/fill-transpile.mjs';
import { clearFills, isBuiltinFill, loadFillModule, scanFillNames } from '../src/index.js';

const fillsDir = fileURLToPath(new URL('../../occlude-studio/fills/', import.meta.url));

export function preloadFillsFromDisk(source: string): void {
  clearFills();
  for (const name of scanFillNames(source)) {
    if (isBuiltinFill(name)) continue;
    let src: string;
    try {
      src = readFileSync(`${fillsDir}${name}.ts`, 'utf8');
    } catch {
      continue;
    }
    loadFillModule(name, (stripFillTypes as (s: string) => string)(src));
  }
}
