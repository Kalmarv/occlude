# 3. Give geometry information

**How can geometry remember something and influence its appearance?** By the end of this chapter you can declare an attribute on a material, inspect it, filter by it, and say why a remembered value and a recomputed one are different questions. This is the drawing you are about to make: chapter 2's landscape, where the pond's eastern shore has grown reeds, because each shore point remembers which side it was sampled on.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape from chapter 1 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  // #endregion
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const nudged = shore.steps(1, (current, next) => {
    next.move(current.points, (p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  const eastern = nudged.points.filter((p) => p.east === 1);
  const reeds = eastern.map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  return [sky, sun, farHill, nearHill, polygon(nudged, { opaque: true }), reeds];
});
```

## Start here

Chapter 2 ended here: twenty-four shore points, each nudged by noise. Suppose reeds should grow on the eastern shore only. The points are data, so the eastern ones can be picked out by position, as chapter 2 picked points by `p.x` inside a move. This chapter starts there and then asks a harder question: what if the points should remember that classification after they have moved?

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and pond from chapters 1 and 2 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 });
  const nudged = shore.steps(1, (current, next) => {
    next.move(current.points, (p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  // #endregion
  return [sky, sun, farHill, nearHill, polygon(nudged, { opaque: true })];
});
```

## Change it

**Pick points by where they are.** `nudged.points.filter((p) => p.x >= 140)` reads the pond's points, keeps the ones at or right of the pond's middle, and returns a selection of that material: the same kind of list, holding only those points, that you map over like the whole. Use it at once: a blue dot on each selected point.

```ts live focus=16,20
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and pond from chapters 1 and 2 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 });
  const nudged = shore.steps(1, (current, next) => {
    next.move(current.points, (p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  // #endregion
  const eastern = nudged.points.filter((p) => p.x >= 140);
  return [
    sky, sun, farHill, nearHill,
    polygon(nudged, { opaque: true }),
    eastern.map((p) => circle(p.x, p.y, 1.2, { pen: 'stabilo-88-blue' })),
  ];
});
```

**Let the selection change the drawing.** Reeds instead of dots: a short line rising from each selected point. The selection is the same; only what is drawn from it changes.

```ts live focus=17-18
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and pond from chapters 1 and 2 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 });
  const nudged = shore.steps(1, (current, next) => {
    next.move(current.points, (p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  // #endregion
  const eastern = nudged.points.filter((p) => p.x >= 140);
  const reeds = eastern.map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  return [sky, sun, farHill, nearHill, polygon(nudged, { opaque: true }), reeds];
});
```

**Remember the side instead.** That filter answers "which points are east now?". The nudge moved every point, so a point sampled on the east half may sit a little west of the line today, and the filter will not count it. If the reeds belong to the points that *were* sampled east, the side has to be written down before the move. An attribute does that: `shore.attribute('east', (p) => …)` calls your function once per point of the sampled shore, stores the answer under the name `east`, and returns a new material with that column. The nudge carries it along, so afterwards `p.east` still says where the point came from, and the filter reads `p.east === 1` instead of the position.

```ts live focus=12,16
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape from chapter 1 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  // #endregion
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const nudged = shore.steps(1, (current, next) => {
    next.move(current.points, (p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  const eastern = nudged.points.filter((p) => p.east === 1);
  const reeds = eastern.map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  return [sky, sun, farHill, nearHill, polygon(nudged, { opaque: true }), reeds];
});
```

This is the finished drawing from the top of the page. Open it in the studio and switch on the Material layer in the debug menu: `shore` and `nudged` are listed by their variable names. Choose `nudged` and colour its points by `east`; the two sides light up without anything being drawn, and clicking a point shows its row and its columns. That is inspection: it changes nothing and costs nothing when off.

**Remembered against recomputed.** Both answers on one drawing: blue dots for the points that remember being east, green rings for the points that are east now. Where they disagree, a point moved across the line.

```ts live focus=16-17,21-22
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape from chapter 1 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  // #endregion
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const nudged = shore.steps(1, (current, next) => {
    next.move(current.points, (p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  const remembered = nudged.points.filter((p) => p.east === 1);
  const recomputed = nudged.points.filter((p) => p.x >= 140);
  return [
    sky, sun, farHill, nearHill,
    polygon(nudged, { opaque: true }),
    remembered.map((p) => circle(p.x, p.y, 1, { pen: 'stabilo-88-blue' })),
    recomputed.map((p) => circle(p.x, p.y, 1.8, { pen: 'stabilo-88-green' })),
  ];
});
```

Thirteen points remember being east; eleven are east now. The two blue dots without a green ring, at the top and the bottom of the pond, started exactly on the line and were nudged a little west. Neither answer is wrong. The attribute says where a point came from; the position says where it is. Only the attribute survives a move, and that is what attributes are for: a fact about a point that the geometry alone no longer tells you.

## A selection belongs to one state

Materials never change; every operation returns a new one, and a selection is taken from one of them. Below, the pond is raised by a plain twelve units so the effect is easy to see, and `eastern` is filtered from `shore`, the material before the move. Its green dots sit on the original ellipse, where those points were, not on the raised pond. The blue dots come from filtering `raised` itself. If you want the eastern points of the pond as it is now, ask the pond as it is now. The same holds inside an edit: filter `current` there; a selection of another state is refused with a message that says so.

```ts live focus=16,21-22
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, strokes } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape from chapter 1 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  // #endregion
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const raised = shore.steps(1, (current, next) => {
    next.move(current.points, (p) => [0, -12]);
  });
  const eastern = shore.points.filter((p) => p.east === 1);
  return [
    sky, sun, farHill, nearHill,
    polygon(raised, { opaque: true }),
    strokes(shore, { pen: 'stabilo-88-green' }),
    eastern.map((p) => circle(p.x, p.y, 1.4, { pen: 'stabilo-88-green' })),
    raised.points.filter((p) => p.east === 1).map((p) => circle(p.x, p.y, 1.4, { pen: 'stabilo-88-blue' })),
  ];
});
```

## Experiments

**Move the dividing line.** Predict: in the "remember the side" sketch, what happens to the reeds if the attribute is written with `p.x >= 120` instead of `p.x >= 140`? Change it. Observe: reeds extend further west along both the top and bottom shore, on 19 points instead of 13. Explain: the attribute is computed when it is declared, from each point's position on the sampled ellipse; move the line and different points get the 1.

**A bigger nudge.** Predict: in the "remembered against recomputed" sketch, change both `* 2` to `* 8`. Which dots lose their green ring, and does any ring appear without a blue dot? Observe: the same two dots as before are without a ring, and the bottom one now sits well west of the middle, about six units from where it started; no ring appears on its own, because on this seed the noise pushes the whole middle of the pond westward, so no western point is carried east. Explain: the attribute did not change at all, only the positions did. How far the two answers drift apart depends on the movement, not on the attribute; change the seed and the count of disagreements changes with it.

## On your own

Mark the pond's northern shore instead: the points that were sampled above the pond's middle, `y < 90`, and draw a dot on each after the nudge.

<details>
<summary>A possible solution</summary>

```ts live focus=12,16
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape from chapter 1 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  // #endregion
  const shore = t.sample(pond, { count: 24 }).attribute('north', (p) => (p.y < 90 ? 1 : 0));
  const nudged = shore.steps(1, (current, next) => {
    next.move(current.points, (p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  const northern = nudged.points.filter((p) => p.north === 1);
  return [
    sky, sun, farHill, nearHill,
    polygon(nudged, { opaque: true }),
    northern.map((p) => circle(p.x, p.y, 1.2, { pen: 'stabilo-88-blue' })),
  ];
});
```

The attribute has a new name, the test reads `p.y`, and the filter asks for the new name. Everything else is chapter 2's drawing.

</details>

## If you want more

Two extensions, both optional. The chapter is complete without them.

**Both sides at once.** `groupBy` splits the points into one selection per distinct value of a key, and each selection remembers its `key`. Here the key is the attribute, so there are two groups: `side.key` is 0 for the west and 1 for the east. Each group is mapped to its own kind of mark, named step by step.

```ts live focus=16-20
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape from chapter 1 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  // #endregion
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const nudged = shore.steps(1, (current, next) => {
    next.move(current.points, (p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  const sides = nudged.points.groupBy((p) => p.east);
  const marks = sides.map((side) => {
    if (side.key === 1) return side.map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
    return side.map((p) => line(p.x, p.y, p.x, p.y - 2));
  });
  return [sky, sun, farHill, nearHill, polygon(nudged, { opaque: true }), marks];
});
```

`marks` is an array with one array per side; the drawing flattens nesting like any other.

**A shoreline that carries the attribute.** The points know their side, but the shore is drawn from the connections between points, and a connection has two ends. `segmentRuns(m, (a, b) => key)` looks at every connection with its two points, computes a key, and gathers consecutive connections with equal keys into runs, each drawn as one stroke. The key `a.east + b.east` is 2 where both ends are eastern, 1 where the shore crosses from one side to the other, 0 in the west; `pens[run.key]` turns that into a pen, so the eastern shore is blue and the two crossing connections stay black. The pond keeps hiding the hatch but no longer draws its own outline (`stroke: false`), since the runs draw it.

```ts live focus=17-20
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, stroke, segmentRuns } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape from chapter 1 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  // #endregion
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const nudged = shore.steps(1, (current, next) => {
    next.move(current.points, (p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  const reeds = nudged.points.filter((p) => p.east === 1).map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  const pens = ['pigma-005-black', 'pigma-005-black', 'stabilo-88-blue'];
  const runs = segmentRuns(nudged, (a, b) => a.east + b.east);
  const shoreline = runs.map((run) => stroke(run, { pen: pens[run.key] }));
  return [sky, sun, farHill, nearHill, polygon(nudged, { opaque: true, stroke: false }), shoreline, reeds];
});
```

## Where to look things up

`attribute` and `filter` are under *Making a material* and *Collections and selections* on [Materials](#/materials); the debug layer under *Inspecting a material*; `groupBy` and `segmentRuns` under *Collections and selections* and *Runs and bands*. Next, chapter 4 leaves the landscape behind: a bare ring, one small rule, and what happens when the rule acts forty times.
