/**
 * Load the custom fills a sketch references (`fill('name')` literals) into
 * the occlude registry BEFORE the sketch executes — in the render worker,
 * beside the assets. Built-ins resolve from the package and are skipped.
 * The server hands back type-stripped JS (fill-transpile.mjs) and
 * `loadFillModule` does the rest — the same path the node tools take.
 * Fetched per render, no cache: fill sources are small, and a stale copy
 * after a save would be a correctness bug, not a slowdown.
 */

import { clearFills, isBuiltinFill, loadFillModule, scanFillNames } from 'occlude';

/** An unsaved fill being drafted in the editor, already emitted to JS by
 * the editor's TypeScript worker (the main thread emits; it never runs). */
export interface DraftFill {
  name: string;
  js: string;
}

export async function preloadFills(source: string, draft?: DraftFill): Promise<void> {
  clearFills();
  for (const name of scanFillNames(source)) {
    if (isBuiltinFill(name)) continue;
    if (draft && draft.name === name) {
      loadFillModule(name, draft.js);
      continue;
    }
    const res = await fetch(`/api/fills/${encodeURIComponent(name)}/js`);
    if (res.status === 404) continue; // encode reports "unknown fill" if really used
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `fill '${name}' failed to load (${res.status})`);
    }
    loadFillModule(name, await res.text());
  }
}
