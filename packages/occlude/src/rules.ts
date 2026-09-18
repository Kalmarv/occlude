/**
 * One batch from several rules.
 *
 * A rule is not a kind of thing in this library. `steps` already hands a
 * pass the frozen state and an edit batch, and an edit over a selection
 * already applies to every match at once — so a "rule" is just a pass, and
 * a pattern is `cur.points.filter(...)` in front of the edit.
 *
 * The one distinction worth a word is batching, and existing syntax
 * carries it: a shorthand is an object and a pass is a function, so an
 * ARRAY is unambiguous. `steps(n, [a, b])` matches every pass against the
 * same frozen state. `steps(n, a, b)` is two passes, and the second reads
 * what the first committed.
 *
 * MATCHING is order-free inside one batch. EDITING is not, and
 * `stepOnce`'s rules decide it: moves add up, a later `set` overwrites an
 * earlier one, a later `connect` on an existing pair is dropped, and new
 * points keep the order the passes asked for them.
 */

import type { Material } from './material.js';
import type { Next, StepRule } from './steps.js';

/** @internal One batch from a list of passes: every pass matches the same
 * frozen state, and every edit lands in the same next state. */
export function oneBatch(rules: readonly StepRule[]): StepRule {
  for (const r of rules) if (typeof r !== 'function') throw new Error('steps: a list holds passes, and a pass is (prev, next, k) => void');
  return (cur: Material, next: Next, k: number) => {
    for (const r of rules) r(cur, next, k);
  };
}
