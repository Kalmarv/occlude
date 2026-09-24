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
 * MATCHING is order-free inside one batch, and so is what the fold drops.
 * A pass in the list reads the records the passes before it asked for
 * (`next.edits`), and a pass that returns a list makes that list the batch:
 * `[rule, stage]` is a rule and a rewrite of its records.
 */

import type { Material } from './material.js';
import { adopt, type Next, type StepRule } from './steps.js';

/** @internal One batch from a list of passes: every pass matches the same
 * frozen state, and every edit lands in the same next state. */
export function oneBatch(rules: readonly StepRule[]): StepRule {
  for (const r of rules) if (typeof r !== 'function') throw new Error('steps: a list holds passes, and a pass is (prev, next, k) => void or a list of edits');
  return (cur: Material, next: Next, k: number) => {
    for (const r of rules) adopt(next, r(cur, next, k));
  };
}
