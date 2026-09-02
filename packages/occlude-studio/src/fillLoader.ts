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
    // The draft first: a draft titled with a built-in name must fail
    // loudly ("clone it") rather than silently preview the built-in.
    if (draft && draft.name === name) {
      loadFillModule(name, draft.js);
      continue;
    }
    if (isBuiltinFill(name)) continue;
    const res = await fetch(`/api/fills/${encodeURIComponent(name)}/js`);
    // Not in the library (or not a library name): encode reports "unknown
    // fill" if the sketch really uses it.
    if (res.status === 404 || res.status === 400) continue;
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `fill '${name}' failed to load (${res.status})`);
    }
    loadFillModule(name, await res.text());
  }
}
