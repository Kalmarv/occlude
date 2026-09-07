# 3. Give geometry information

**How can geometry remember something and influence its appearance?** By the end of this chapter you can declare an attribute on a material, inspect it, filter by it, and change how the drawing interprets it. This is the drawing you are about to make: chapter 2's landscape, where the pond's eastern shore has grown reeds and is drawn in blue, and the western shore has not, because each shore point remembers which side it was on.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, stroke, segmentRuns } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const nudged = shore.steps(1, (current, next) => {
    next.move((p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  const reeds = nudged.points.filter((p) => p.east === 1).map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  const pens = ['pigma-005-black', 'pigma-005-black', 'stabilo-88-blue'];
  return [
    sky, sun, farHill, nearHill,
    polygon(nudged, { opaque: true, stroke: false }),
    segmentRuns(nudged, (a, b) => a.east + b.east).map((run) => stroke(run, { pen: pens[run.key] })),
    reeds,
  ];
});
```

## Start here

Chapter 2 ended here: twenty-four shore points, each nudged by noise. Suppose the reeds should grow only on the eastern shore. Every point looks the same to the drawing, so nothing can pick out the eastern ones.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 });
  const nudged = shore.steps(1, (current, next) => {
    next.move((p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  return [sky, sun, farHill, nearHill, polygon(nudged, { opaque: true })];
});
```

## Change it

**Remember a side.** An attribute is a named number every point carries. `shore.attribute('east', (p) => …)` calls your function once per point and stores the answer under that name, returning a new material; `p.x >= 140 ? 1 : 0` is 1 at or east of the pond's middle and 0 west of it. It is written on the sampled shore, before the nudge, and the nudge carries it along: a point that started east stays marked east wherever the noise moves it. Then `nudged.points.filter((p) => p.east === 1)` reads the pond's points, keeps the ones marked east, and returns a selection of that material; map over it as over the whole. Two lines change and one is added.

```ts
const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
const eastern = nudged.points.filter((p) => p.east === 1);
return […, eastern.map((p) => circle(p.x, p.y, 1.2, { pen: 'stabilo-88-blue' }))];
```

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const nudged = shore.steps(1, (current, next) => {
    next.move((p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  const eastern = nudged.points.filter((p) => p.east === 1);
  return [
    sky, sun, farHill, nearHill,
    polygon(nudged, { opaque: true }),
    eastern.map((p) => circle(p.x, p.y, 1.2, { pen: 'stabilo-88-blue' })),
  ];
});
```

Open this one in the studio and switch on the Material layer in the debug menu. `shore` and `nudged` are listed by their variable names; choose `nudged`, colour its points by `east`, and the two sides light up without drawing anything. Clicking a point shows its row and its columns. That is inspection: it changes nothing and costs nothing when off.

**Both sides at once.** `groupBy` splits the points into one selection per distinct value of the key, and each selection remembers its `key`. The map over the groups returns, for each group, a map over its points: an array of arrays, which the drawing flattens like any other nesting. The eastern shore gets dots, the western gets shorter dashes; one expression instead of two filters.

```ts
nudged.points.groupBy((p) => p.east).map((side) => side.map((p) => (side.key ? circle(p.x, p.y, 1.2, { pen: 'stabilo-88-blue' }) : line(p.x, p.y, p.x, p.y - 2))))
```

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const nudged = shore.steps(1, (current, next) => {
    next.move((p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  return [
    sky, sun, farHill, nearHill,
    polygon(nudged, { opaque: true }),
    nudged.points.groupBy((p) => p.east).map((side) => side.map((p) => (side.key ? circle(p.x, p.y, 1.2, { pen: 'stabilo-88-blue' }) : line(p.x, p.y, p.x, p.y - 2)))),
  ];
});
```

**Reeds, and a shoreline that carries the attribute.** The reeds are lines rising from the eastern points. Then the shoreline itself: the points know their side, but the shore is drawn from the connections between points, and a connection has two ends. `segmentRuns(m, (a, b) => key)` looks at every connection with its two points, computes a key, and gathers consecutive connections with equal keys into runs, each drawn as one stroke. The key here is `a.east + b.east`: 2 where both ends are eastern, 1 where the shore crosses from one side to the other, 0 in the west. The pens array maps those keys to pens, so the eastern shore is blue and the two crossing connections stay black. The pond keeps hiding the hatch but no longer draws its own outline (`stroke: false`), since the runs draw it. This is the finished drawing from the top of the page.

```ts
const reeds = nudged.points.filter((p) => p.east === 1).map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
const pens = ['pigma-005-black', 'pigma-005-black', 'stabilo-88-blue'];
polygon(nudged, { opaque: true, stroke: false }),
segmentRuns(nudged, (a, b) => a.east + b.east).map((run) => stroke(run, { pen: pens[run.key] })),
```

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, stroke, segmentRuns } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const nudged = shore.steps(1, (current, next) => {
    next.move((p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  const reeds = nudged.points.filter((p) => p.east === 1).map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  const pens = ['pigma-005-black', 'pigma-005-black', 'stabilo-88-blue'];
  return [
    sky, sun, farHill, nearHill,
    polygon(nudged, { opaque: true, stroke: false }),
    segmentRuns(nudged, (a, b) => a.east + b.east).map((run) => stroke(run, { pen: pens[run.key] })),
    reeds,
  ];
});
```

## A selection belongs to one state

Materials never change; every operation returns a new one, and a selection is taken from one of them. Below, the pond is raised by a plain twelve units so the effect is easy to see, and `eastern` is filtered from `shore`, the material before the move. Its green dots sit on the original ellipse, where those points were, not on the raised pond. The blue dots come from filtering `raised` itself. If you want the eastern points of the pond as it is now, ask the pond as it is now. The same holds inside an edit: filter `current` there; a selection of another state is refused with a message that says so.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, strokes } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const raised = shore.steps(1, (current, next) => {
    next.move((p) => [0, -12]);
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

**Move the dividing line.** Predict: in the "remember a side" sketch, what happens to the dots if the attribute is written with `p.x >= 120` instead of `p.x >= 140`? Change it. Observe: the dots extend further west along both the top and bottom shore, from 13 points to 19. Explain: the attribute is computed when it is declared, from each point's position on the sampled ellipse; move the line and different points get the 1.

**Remember or recompute?** Predict: in the same sketch, replace `p.east === 1` in the filter with `p.x >= 140`, so the side is judged from the nudged position instead of the remembered one. Do the dots change? Observe: two dots disappear, the topmost and the bottommost. Both points started exactly on the line, and the noise pushed each a little west, one visibly, one by a hair; the other eleven are unchanged. Explain: the attribute remembers where a point started; the position says where it is now. Both are legitimate, and they are different questions. Only the remembered one survives a move.

## On your own

Mark the pond's northern shore instead: the points that were above the pond's middle, `y < 90`, on the sampled ellipse. Draw them as dots and leave the rest plain.

<details>
<summary>A possible solution</summary>

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('north', (p) => (p.y < 90 ? 1 : 0));
  const nudged = shore.steps(1, (current, next) => {
    next.move((p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  return [
    sky, sun, farHill, nearHill,
    polygon(nudged, { opaque: true }),
    nudged.points.filter((p) => p.north === 1).map((p) => circle(p.x, p.y, 1.2, { pen: 'stabilo-88-blue' })),
  ];
});
```

The attribute has a new name, the test reads `p.y`, and the filter asks for the new name. Everything else is chapter 2's drawing.

</details>

## Where to look things up

`attribute`, `filter` and `groupBy` are under *Making a material* and *Collections and selections* on [Materials](#/materials); the debug layer under *Inspecting a material*; `segmentRuns` under *Runs and bands*. The next chapter, on making the pond move and grow over many steps, is forthcoming.
