# 3. Give geometry information

The ring from chapter 2, drawn three ways from one material: the youngest points as dots, the outline cut into segments coloured by the generation each grew out of, and the whole outline hatched as an area. Nothing is drawn three times; one material is read three times. This is what you are about to make.

```ts live
import { sketch, ngon, circle, strokes, stroke, polygon, fill, mm, group, segmentRuns } from 'occlude';

export default sketch({ aspect: [3, 1], seed: 5 }, (t) => {
  const ring = t.material(ngon(50, 50, 6, 30)).attribute('born', 0)
    .steps(1, (cur, next) => next.splitEdges(() => true, { point: { born: 1 } }))
    .steps(1, (cur, next) => next.splitEdges(() => true, { point: { born: 2 } }))
    .steps(1, (cur, next) => next.move((p) => [t.noise(p.x / 9, p.y / 9) * 7, t.noise(p.x / 9 + 30, p.y / 9) * 7]));
  const pens = ['pigma-01-black', 'stabilo-88-blue', 'stabilo-88-green'];
  return [
    strokes(ring, { pen: 'pigma-005-black' }),
    ring.points.filter((p) => p.born === 2).map((p) => circle(p.x, p.y, 1.2, { pen: 'stabilo-88-green' })),
    group({ translate: [100, 0] }, segmentRuns(ring, (a, b) => Math.min(a.born, b.born)).map((run) => stroke(run, { pen: pens[run.key] }))),
    group({ translate: [200, 0] }, polygon(ring, { fill: fill('hatch', { angle: 20, spacing: mm(1.4) }) })),
  ];
});
```

## Start here

These points were created at different times. The six corners came from the hexagon; the rest were inserted afterwards, by splitting every edge in the middle, twice. Can we draw the young ones differently? Not yet: the material knows their positions and nothing else. Every point looks the same.

```ts live
import { sketch, ngon, circle, strokes } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const ring = t.material(ngon(50, 50, 6, 34))
    .steps(1, (cur, next) => next.splitEdges(() => true))
    .steps(1, (cur, next) => next.splitEdges(() => true));
  return [strokes(ring), ring.points.map((p) => circle(p.x, p.y, 1.2))];
});
```

## Change it

**Write the birth down.** `m.attribute('born', 0)` adds a column and returns a new material with every corner born at 0. A split inserts a point, and the split can say what the new point carries: `{ point: { born: 1 } }`. Now each point has `p.born`, and `ring.points.filter(…)` picks the young ones. `filter` returns a selection: the same collection, bound to the same state, holding only those rows; map over it as before.

```ts live
import { sketch, ngon, circle, strokes } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const ring = t.material(ngon(50, 50, 6, 34)).attribute('born', 0)
    .steps(1, (cur, next) => next.splitEdges(() => true, { point: { born: 1 } }))
    .steps(1, (cur, next) => next.splitEdges(() => true, { point: { born: 2 } }));
  return [
    strokes(ring),
    ring.points.filter((p) => p.born === 2).map((p) => circle(p.x, p.y, 1.4, { pen: 'stabilo-88-green' })),
  ];
});
```

Open this one in the studio and turn on the Material layer in the debug menu: `ring` is listed by its variable name, and colouring its points by `born` shows the three generations without drawing anything. Clicking a point shows its row and columns. That is inspection: it changes nothing and costs nothing when off.

**Every generation its own mark.** `groupBy` splits the collection into selections by key, each carrying its `key`, so three generations become three groups without three filters. Dot size and pen per group.

```ts live
import { sketch, ngon, circle, strokes } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const ring = t.material(ngon(50, 50, 6, 34)).attribute('born', 0)
    .steps(1, (cur, next) => next.splitEdges(() => true, { point: { born: 1 } }))
    .steps(1, (cur, next) => next.splitEdges(() => true, { point: { born: 2 } }));
  const pens = ['pigma-01-black', 'stabilo-88-blue', 'stabilo-88-green'];
  return [
    strokes(ring, { pen: 'pigma-005-black' }),
    ring.points.groupBy((p) => p.born).map((gen) => gen.map((p) => circle(p.x, p.y, 2.4 - gen.key * 0.7, { pen: pens[gen.key] }))),
  ];
});
```

**Let the outline carry it.** Dots mark points; to colour the outline, the edges need the information, and an edge has two ends. `segmentRuns(m, (a, b) => key)` classifies every edge from its two vertices and gathers consecutive equal keys into runs, so together the runs redraw the outline once. The interpretation is yours, and it matters: the older end here, so each segment takes the pen of the generation it grew out of, and the outline reads as pairs of black and blue. Take the younger end instead and the whole ring turns green, because after two subdivisions every edge touches a generation-2 point. Then the ring is displaced, as in chapter 2, and the columns come along with the points.

```ts live
import { sketch, ngon, stroke, segmentRuns } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) => {
  const ring = t.material(ngon(50, 50, 6, 34)).attribute('born', 0)
    .steps(1, (cur, next) => next.splitEdges(() => true, { point: { born: 1 } }))
    .steps(1, (cur, next) => next.splitEdges(() => true, { point: { born: 2 } }))
    .steps(1, (cur, next) => next.move((p) => [t.noise(p.x / 9, p.y / 9) * 7, t.noise(p.x / 9 + 30, p.y / 9) * 7]));
  const pens = ['pigma-01-black', 'stabilo-88-blue', 'stabilo-88-green'];
  return segmentRuns(ring, (a, b) => Math.min(a.born, b.born)).map((run) => stroke(run, { pen: pens[run.key] }));
});
```

## Try changing this

In the second sketch, remove `{ point: { born: 1 } }` from the first split and look at the dots. The inserted points still have a `born`; what value did they get, and where did it come from? Then ask whether a birth date can be the average of two others. The default for an inserted point is interpolation between the edge's ends, which is right for a position or a temperature and wrong for a date; that is why the split says `born` explicitly.

## Something that will surprise you

A selection belongs to the state it was taken from. Below, `young` is filtered from the ring before it is displaced; then the ring moves. The green dots are drawn from `young` and sit where those points used to be, off the moved ring, because the selection still describes the earlier state. The blue dots come from filtering the moved ring again. Materials are frozen and every operation returns a new one, so a selection is a fact about one state, not a live query; the moved ring has its own points, and rows are not identities that follow a point from state to state. Inside a rule the same holds: filter `current` there, because a selection of another state is refused.

```ts live
import { sketch, ngon, circle, strokes } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) => {
  const split = t.material(ngon(50, 50, 6, 34)).attribute('born', 0)
    .steps(1, (cur, next) => next.splitEdges(() => true, { point: { born: 1 } }))
    .steps(1, (cur, next) => next.splitEdges(() => true, { point: { born: 2 } }));
  const young = split.points.filter((p) => p.born === 2);
  const moved = split.steps(1, (cur, next) => next.move((p) => [t.noise(p.x / 9, p.y / 9) * 9, t.noise(p.x / 9 + 30, p.y / 9) * 9]));
  return [
    strokes(split, { pen: 'pigma-005-black' }),
    strokes(moved),
    young.map((p) => circle(p.x, p.y, 1.4, { pen: 'stabilo-88-green' })),
    moved.points.filter((p) => p.born === 2).map((p) => circle(p.x, p.y, 1.4, { pen: 'stabilo-88-blue' })),
  ];
});
```

## The whole sketch

```ts live
import { sketch, ngon, circle, strokes, stroke, polygon, fill, mm, group, segmentRuns } from 'occlude';

export default sketch({ aspect: [3, 1], seed: 5 }, (t) => {
  const ring = t.material(ngon(50, 50, 6, 30)).attribute('born', 0)
    .steps(1, (cur, next) => next.splitEdges(() => true, { point: { born: 1 } }))
    .steps(1, (cur, next) => next.splitEdges(() => true, { point: { born: 2 } }))
    .steps(1, (cur, next) => next.move((p) => [t.noise(p.x / 9, p.y / 9) * 7, t.noise(p.x / 9 + 30, p.y / 9) * 7]));
  const pens = ['pigma-01-black', 'stabilo-88-blue', 'stabilo-88-green'];
  return [
    strokes(ring, { pen: 'pigma-005-black' }),
    ring.points.filter((p) => p.born === 2).map((p) => circle(p.x, p.y, 1.2, { pen: 'stabilo-88-green' })),
    group({ translate: [100, 0] }, segmentRuns(ring, (a, b) => Math.min(a.born, b.born)).map((run) => stroke(run, { pen: pens[run.key] }))),
    group({ translate: [200, 0] }, polygon(ring, { fill: fill('hatch', { angle: 20, spacing: mm(1.4) }) })),
  ];
});
```

Reference: attributes under *Making a material*, `filter` and `groupBy` under *Collections and selections*, the debug layer under *Inspecting a material*, and `segmentRuns` under *Runs and bands*, all on [Materials](#/materials). A side experiment: replace `Math.min(a.born, b.born)` with `Math.max(a.born, b.born)`, then with `banding.over(ring.attrs.born, { count: 2 })((a.born + b.born) / 2)`, and watch the same outline change pens under three readings of one column. Next: [Chapter 4](#/workshop-04) makes the ring move and grow over many steps.
