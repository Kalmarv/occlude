# 4. Make it change

**How do I make geometry change over many steps?** By the end of this chapter you can run an edit repeatedly, combine a steady push with a force that keeps the shape in order, grow a shore by splitting stretched connections, and keep the intermediate states to draw. This is the drawing you are about to make: over forty steps the pond has swelled into a lake with a wrinkled shore, its earlier shores drawn faintly inside it, and the reeds still stand on the eastern side.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the sampled shore from chapters 1 to 3 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  // #endregion
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  }, { every: 10 });
  const reeds = lake.points.filter((p) => p.east === 1).map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  return [
    sky, sun, farHill, nearHill,
    polygon(lake, { opaque: true }),
    lake.history.map((h) => strokes(h.material, { pen: 'pigma-005-black' })),
    reeds,
  ];
});
```

## Start here

Chapter 3 ended here: one nudge, and reeds on the points that remember being east. The nudge is one call to `steps` with `1` as its count. Everything in this chapter comes from changing that number and what happens inside.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the sampled shore from chapters 1 to 3 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  // #endregion
  const nudged = shore.steps(1, (current, next) => {
    next.move((p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  const reeds = nudged.points.filter((p) => p.east === 1).map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  return [sky, sun, farHill, nearHill, polygon(nudged, { opaque: true }), reeds];
});
```

## Change it

**Do it forty times.** `steps(40, …)` runs the same edit forty times. Each run starts from the material the previous run produced: `current` is that material, and the noise is read at each point's new position, so the points follow the noise like leaves on a current. The noise is scaled down to `0.8` so forty small moves add up to about what one big one did. The `east` attribute rides along through every step, so the reeds still find their points.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the sampled shore from chapters 1 to 3 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  // #endregion
  const drifted = shore.steps(40, (current, next) => {
    next.move((p) => [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]);
  });
  const reeds = drifted.points.filter((p) => p.east === 1).map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  return [sky, sun, farHill, nearHill, polygon(drifted, { opaque: true }), reeds];
});
```

The pond drifts and deforms, but it does not get bigger: noise moves points about, it does not push them apart.

**Push outward.** To swell, every point moves a little away from a centre. `sub(p, [140, 94])` is the vector from that centre to the point, and `mul(v, 0.011)` scales it, so each step moves a point 1.1 percent further out. The centre sits a little below the pond's middle on purpose: the lake then grows up the hill more than off the bottom of the sheet. Two displacements are combined with `add`; all three helpers take and return `[x, y]` pairs, so the move is still a displacement.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the sampled shore from chapters 1 to 3 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  // #endregion
  const swollen = shore.steps(40, (current, next) => {
    next.move((p) => add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]));
  });
  const reeds = swollen.points.filter((p) => p.east === 1).map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  return [sky, sun, farHill, nearHill, polygon(swollen, { opaque: true }), reeds];
});
```

Look at the shore: it is the same twenty-four points, spread further apart, so the outline is a bigger polygon with longer straight sides. The lake has grown but the shore has not.

**Grow the shore where it stretches.** `next.splitEdges((e) => e.length > 6)` looks at every connection after the moves and inserts a point in the middle of each one longer than 6, so the shore gains points where it has been stretched, and the noise can bend the new, shorter connections. A force keeps the spacing from running away in the other direction: `force.tension(current, { rest: 4 })` is prepared once per step from `current` and gives, for a point, a pull toward each connected neighbour that is further than 4 away, by the extra distance, and nothing toward closer ones: a slack cord, not a spring. `pull(p)` is that vector, scaled by half and added to the move.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the sampled shore from chapters 1 to 3 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  // #endregion
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  const reeds = lake.points.filter((p) => p.east === 1).map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  return [sky, sun, farHill, nearHill, polygon(lake, { opaque: true }), reeds];
});
```

The force is prepared inside the rule, on `current`, because it reads the connections of the state being moved; a force prepared on `shore` would describe the pond before any step.

A new point sits on a connection with two ends, and it has to have an `east` too. By default a numeric attribute is interpolated between the two ends: 1 between two eastern points, 0 between two western ones, and 0.5 on the two connections where the shore crosses from one side to the other. The reeds ask for `p.east === 1`, so a half-eastern point grows no reed, which is a fair answer here. When it is not, the split can say what a new point carries; that is `point` in `splitEdges`, on [Materials](#/materials) under *Movement and growth*.

**Keep the states.** `{ every: 10 }` as a third argument records the state at iteration 0, every tenth iteration and the last, on the result's `history`. Each entry is a material of its own, so the earlier shores can be drawn faintly inside the lake: growth rings. This is the finished drawing from the top of the page.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the sampled shore from chapters 1 to 3 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  // #endregion
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  }, { every: 10 });
  const reeds = lake.points.filter((p) => p.east === 1).map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  return [
    sky, sun, farHill, nearHill,
    polygon(lake, { opaque: true }),
    lake.history.map((h) => strokes(h.material, { pen: 'pigma-005-black' })),
    reeds,
  ];
});
```

## Rows are not points

After growth the lake has more points than the shore had, and they are numbered afresh in every state. `lake.points.at(3)` is whatever sits in row 3 of the lake, not "the point that was row 3 of the shore". Anything you want to follow from state to state has to be an attribute, which is why `east` was written on the shore in chapter 3 and still means the same thing on the lake. Open the final sketch in the studio, switch on the Material layer, and compare `shore` and `lake` coloured by `east`: same sides, different rows.

## Experiments

**No split.** Predict: in the "grow the shore" sketch, delete the `splitEdges` line. What does the lake look like after forty steps? Change it. Observe: a smooth, slightly lumpy lake of the same size with no wrinkles, and the same thirteen reeds as the pond had. Explain: without splitting the shore keeps its twenty-four points, whose connections stretch to about 8; tension pulls but never adds, and noise bends a long connection much less than a short one. Growth of the shore, as opposed to the lake, is the split.

**No tension.** Predict: put the split back and instead delete `, mul(pull(p), 0.5)` from the move, so nothing pulls the points together. Change it. Observe: the shore explodes into a ragged blob of over two hundred points, with reeds everywhere, spilling over the hill and the sheet. Explain: every step the noise stretches some connection past 6, the split adds a point, and nothing ever shortens a connection again, so the count runs away. Tension is what makes the growth settle: the lake has 46 points with it and 227 without.

## On your own

Make the swelling slow down as the steps go on: the rule's third argument, `k`, is the step number from 0. Scale the outward push by `(1 - k / 40)` so the last steps barely push and the noise and tension tidy the shore.

<details>
<summary>A possible solution</summary>

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the sampled shore from chapters 1 to 3 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  // #endregion
  const lake = shore.steps(40, (current, next, k) => {
    const pull = force.tension(current, { rest: 4 });
    const calm = 1 - k / 40;
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011 * calm), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  const reeds = lake.points.filter((p) => p.east === 1).map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  return [sky, sun, farHill, nearHill, polygon(lake, { opaque: true }), reeds];
});
```

`calm` goes from 1 down to nearly 0, so the lake ends a little smaller than before and its last steps are all wrinkle and no swell.

</details>

## Where to look things up

The full table of edits `next` accepts, `every` and `history`, and every force recipe are under *Movement and growth* on [Materials](#/materials); the vector helpers under *Vectors*. Next, chapter 5: the shore grows on its own. Chapter 5 grows lines that have to notice each other.
