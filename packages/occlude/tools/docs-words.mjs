/**
 * Two standing checks on the docs, both of them greps.
 *
 *   pnpm --filter occlude docs:words
 *
 * 1. **A word that is documented on a page is used on that page.** Every
 *    `<include>/_sig/…</include>` must appear in at least one `ts live`
 *    fence of the same page. A section with a signature, prose and no
 *    example is how `rows()`, `sel.in()` and `faceAttribute` came to be
 *    documented and used by nothing — each of them newer than the fences
 *    that would have used it, and each invisible to every other gate.
 *
 * 2. **A fence does not shadow a drawing verb.** A sketch that binds
 *    `dots` to a helper drawing stroked circles teaches the opposite of
 *    what the word does, and copying two lines out of it into a sketch
 *    that imports `dots` changes the drawing silently.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DOC_PAGES } from '../dist/docsExamples.js';

const root = resolve(new URL('../../..', import.meta.url).pathname);
const FENCE = /```ts live[^\n]*\n([\s\S]*?)```/g;
const INCLUDE = /<include>\/_sig\/([^<]+)\.mdx<\/include>/g;

/** The drawing verbs, by CLAUDE.md's own law. Shadowing one of these in an
 * example is the case worth catching: they are what make ink. */
const VERBS = ['strokes', 'stroke', 'polygon', 'dots'];

/** Words a live fence cannot show, with the reason. A fence returns a
 * drawing; these take a rendered plan and write a file, so the page can
 * only describe them. */
const NOT_LIVE = new Set(['exportSvg', 'exportPng', 'exportGcode', 'estimatePlanMs']);

let bad = 0;
for (const page of DOC_PAGES.filter((p) => p.live)) {
  const text = readFileSync(resolve(root, 'docs', page.file), 'utf8');
  const fences = [...text.matchAll(FENCE)].map((m) => m[1]);
  if (fences.length === 0) continue;
  const code = fences.join('\n');

  for (const [, sig] of text.matchAll(INCLUDE)) {
    // `Material.faceAttribute` is used as `.faceAttribute(`; `dots` as
    // `dots(`; a value word such as `t.cx` as `.cx`. A numbered overload
    // (`strokes.2`) is the same word.
    const word = sig.replace(/\.\d+$/, '');
    const last = word.split('.').pop();
    if (NOT_LIVE.has(last)) continue;
    if (new RegExp(`\\b${last}\\b`).test(code)) continue;
    console.log(`${page.file}: documents ${word} and no example uses it`);
    bad++;
  }

  for (const verb of VERBS) {
    // A BINDING of the name — not a call of it, and not the import that
    // brings it in.
    const shadow = new RegExp(`(?:const|let|var)\\s+${verb}\\b|\\(\\s*${verb}\\s*(?:,|\\)\\s*=>)`);
    for (const fence of fences) {
      const body = fence.replace(/^import\s*\{[^}]*\}\s*from\s*'[^']*';?$/gm, '');
      if (!shadow.test(body)) continue;
      console.log(`${page.file}: a fence binds '${verb}', which is a drawing verb`);
      bad++;
      break;
    }
  }
}
console.log(bad === 0 ? 'docs words: nothing to look at' : `docs words: ${bad} to look at`);
// A gate, not a report: a documented word with no drawing, or a fence that
// shadows a drawing verb, fails the build.
process.exit(bad === 0 ? 0 : 1);
