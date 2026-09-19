#!/usr/bin/env node
/**
 * A small Simplified Technical English check for the docs prose.
 *
 *   node tools/ste-lint.mjs [glob…]        default: docs/reference and docs/examples
 *
 * Flags a sentence that is long (over 22 words), passive, joined with a
 * semicolon or a dash, or built on a word STE avoids (however, which, so
 * that, per, whether …). Code spans, fences, tables, headings and MDX
 * tags are skipped. It is a prompt for the writer, not a gate: occlude's
 * own words and the odd sentence that reads better as it is are allowed.
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve } from 'node:path';

const PASSIVE = /\b(is|are|was|were|be|been|being)\s+(\w+ed|drawn|given|kept|made|read|written|split|built|hidden|thrown|known|seen|done|put|set|left|cut|held|run|begun|shown|taken|chosen|joined|lost|found|meant|bound|won|met)\b/;
const BAD = /\b(however|therefore|thus|hence|whereas|nevertheless|in order to|so that|as well as|rather than|instead of|whether|which|whilst|though|although|via|per|i\.e\.|e\.g\.)\b/i;
const prose = (md) => md
  .replace(/```[\s\S]*?```/g, '')
  .replace(/^---[\s\S]*?---/, '')
  .replace(/^\s*<include>.*<\/include>\s*$/gm, '')
  .replace(/<[^>]+>/g, '')
  .replace(/^\|.*$/gm, '')
  // A directive marker is not prose, and it is not a full stop either: left
  // in, it glues the last sentence of a note to the first one after it.
  .replace(/^:::.*$/gm, '')
  .replace(/^#.*$/gm, '')
  .replace(/`[^`]*`/g, 'CODE')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

const root = resolve(new URL('../../..', import.meta.url).pathname);
const patterns = process.argv.slice(2).length ? process.argv.slice(2) : ['docs/reference/*.mdx', 'docs/examples/*.mdx'];
let total = 0;
for (const pattern of patterns) {
  for (const file of globSync(pattern, { cwd: root }).sort()) {
    const sentences = prose(readFileSync(resolve(root, file), 'utf8')).split(/(?<=[.!?])\s+|\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    const flagged = [];
    for (const s of sentences) {
      const why = [];
      const n = s.split(/\s+/).length;
      if (n > 22) why.push(`${n} words`);
      if (PASSIVE.test(s)) why.push('passive');
      const bad = BAD.exec(s);
      if (bad) why.push(`word: ${bad[0]}`);
      if (s.includes(';') || s.includes('—')) why.push('punctuation');
      if (why.length) flagged.push([why.join(', '), s.replace(/\s+/g, ' ').slice(0, 160)]);
    }
    total += flagged.length;
    console.log(`${file}: ${flagged.length}/${sentences.length} flagged`);
    for (const [why, s] of flagged) console.log(`  - ${why} | ${s}`);
  }
}
console.log(total === 0 ? 'STE: nothing flagged' : `STE: ${total} sentence(s) to look at`);
