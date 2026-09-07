# 2. Turn a shape into something editable

**How can I change individual parts of a shape?** By the end of this chapter you can decide between keeping a shape's own points and sampling its outline, read a material's points and connections, and make a controlled edit to some of them. This is the drawing you are about to make: chapter 1's landscape, with the pond's shore now made of twenty-four points that have each been nudged a little.

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

## Start here

Chapter 1 ended here, and this is its code unchanged. A shape describes what to draw. You can fill it and hide with it, but you cannot ask it for one point of its edge, and you cannot move that point and leave the rest.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  return [sky, sun, farHill, nearHill, pond];
});
```

## Change it

**The pond as material.** `t.material(shape)` turns a shape into a material: its points, and the connections between them, as data you can read and edit. Keep the landscape; replace the pond with two lines.

```ts
const shore = t.material(pond);
return [sky, sun, farHill, nearHill, polygon(shore, { opaque: true }), shore.points.map((p) => circle(p.x, p.y, 0.9, { pen: 'stabilo-88-blue' }))];
```

`shore.points` is the list of its points. `.map((p) => …)` calls the function once per point and collects the results, like `t.times` did; each `p` has `p.x` and `p.y`, so the last entry is a blue dot on every point. `polygon(shore, …)` still draws the pond as an area: a material whose connections close into a loop is a boundary the drawing operations accept. Count the dots. An ellipse has no corners, and material is made of straight connections, so `t.material` flattened the curve at a tolerance of 0.05 mm and kept every point that needed: sixty-eight of them, a number you did not choose. The `opaque` option stayed with the shape; the material is only its outline, so the drawing says `opaque` again.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.material(pond);
  return [
    sky, sun, farHill, nearHill,
    polygon(shore, { opaque: true }),
    shore.points.map((p) => circle(p.x, p.y, 0.9, { pen: 'stabilo-88-blue' })),
  ];
});
```

**Own points or a chosen number of points.** There is a second way in. `t.sample(shape, { count })` walks the outline and places exactly `count` points at equal distances along it, wherever they land; `t.material` keeps the shape's own points instead. On a shape with corners the difference is plain. Four samples of a 70 by 50 rectangle start at the first corner and then fall 60 units apart along the outline, so two of them land on corners and two land part-way along the long sides. The same rectangle is drawn twice below; the right copy is only moved on the page, not remade.

```ts live
import { sketch, circle, rect, strokes, group } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const box = rect(15, 25, 70, 50);
  const corners = t.material(box);
  const samples = t.sample(box, { count: 4 });
  const dots = (m) => m.points.map((p) => circle(p.x, p.y, 1.4, { pen: 'stabilo-88-blue' }));
  return [
    strokes(corners), dots(corners),
    group({ translate: [100, 0] }, strokes(samples), dots(samples)),
  ];
});
```

`strokes(m)` draws a material's connections as pen strokes, hiding nothing. Which conversion to use is a choice: keep the shape's own points when they are the point of the shape, sample when you want to choose how many points an outline has. For the pond, choose: six points make a six-sided pond, with six dots. One line changes.

```ts
const shore = t.sample(pond, { count: 6 });
```

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 6 });
  return [
    sky, sun, farHill, nearHill,
    polygon(shore, { opaque: true }),
    shore.points.map((p) => circle(p.x, p.y, 1.2, { pen: 'stabilo-88-blue' })),
  ];
});
```

The last of the six connections joins the sixth point back to the first; no repeated endpoint is needed for a closed shore.

**Moving points.** Editing means asking for a new material with some points moved. `shore.steps(1, (current, next) => …)` does one edit. Inside, `current` is the material as it is, and `next` is the one being built. `next.move((p) => [dx, dy])` calls your function once per point of `current`, and each answer is a displacement, not a destination: `[0, -6]` moves every point up by 6 and leaves `x` alone. Keep `shore`, add the edit, and draw both: `shore` still exists, unchanged, and is drawn in blue behind the moved pond.

```ts
const raised = shore.steps(1, (current, next) => {
  next.move((p) => [0, -6]);
});
```

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, strokes } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 6 });
  const raised = shore.steps(1, (current, next) => {
    next.move((p) => [0, -6]);
  });
  return [sky, sun, farHill, nearHill, strokes(shore, { pen: 'stabilo-88-blue' }), polygon(raised, { opaque: true })];
});
```

**Moving some points.** The function sees each point, so it can answer differently for different points. Widen the pond: points left of `x = 140` move left, the others move right. Only the displacement line changes.

```ts
next.move((p) => [p.x < 140 ? -8 : 8, 0]);
```

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, strokes } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 6 });
  const wide = shore.steps(1, (current, next) => {
    next.move((p) => [p.x < 140 ? -8 : 8, 0]);
  });
  return [sky, sun, farHill, nearHill, strokes(shore, { pen: 'stabilo-88-blue' }), polygon(wide, { opaque: true })];
});
```

**A shore with more points, nudged by position.** Six points can only make a six-sided pond. Sample twenty-four instead, then move each by an amount that depends on where it is. `t.noise(x, y)` is a smooth random function of position: it returns a value between about −1 and 1, and nearby inputs give nearby values, so neighbouring shore points move together and the outline bends rather than jitters. Dividing by 12 sets how quickly the value changes across the sheet; `* 2` sets how far a point can move, less than the six units between neighbouring shore points. The sketch gets a `seed` so the noise is the same on every run. Two lines change: the count and the displacement.

```ts
const shore = t.sample(pond, { count: 24 });
next.move((p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
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
  const shore = t.sample(pond, { count: 24 });
  const nudged = shore.steps(1, (current, next) => {
    next.move((p) => [t.noise(p.x / 12, p.y / 12) * 2, t.noise(p.x / 12 + 30, p.y / 12) * 2]);
  });
  return [sky, sun, farHill, nearHill, polygon(nudged, { opaque: true })];
});
```

This is the finished drawing from the top of the page, and chapter 3 starts from it. One thing to be clear about: the move keeps the connections, so the shore is still a closed loop, but nothing guarantees that the loop does not cross itself. A displacement larger than the gap between neighbouring points can fold the outline over, and `polygon` will then fill it with a twist. Keep displacements smaller than the point spacing, or look at the result.

## Experiments

**Raise the pond onto the far hill.** Predict: in the "moving points" sketch, what happens if `[0, -6]` becomes `[-60, -34]`? Change it. Observe: the pond sits on the far hill and hides that hill's hatch inside it, exactly as it hid the near hill's, and it cuts into the sun's left edge too; the blue original stays where it was. Explain: the displacement applies to every point of `current`, and `shore` was never changed, only used to build `raised`. Hiding is decided by drawing order: the pond still comes last, so it hides hatch and sun alike.

**Fewer points, larger nudges.** Predict: in the last sketch, what does the shore look like with `{ count: 6 }`, and then with `{ count: 24 }` and `* 12` in both displacements instead of `* 2`? Change one at a time. Observe: six points make a six-sided pond whose sides bend nowhere, because the noise moves the points, not the straight connections between them. Twelve units of movement with twenty-four points folds the outline across itself on this seed, and the area shows the twist. Explain: the outline stays closed either way; what changes is whether it is a simple boundary. Noise gives a smooth displacement, not a safe one.

## On your own

Move only the pond's western shore, the points with `x < 140`, ten units to the left, and leave every other point where it is. Start from the "moving some points" sketch.

<details>
<summary>A possible solution</summary>

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, strokes } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 6 });
  const west = shore.steps(1, (current, next) => {
    next.move((p) => [p.x < 140 ? -10 : 0, 0]);
  });
  return [sky, sun, farHill, nearHill, strokes(shore, { pen: 'stabilo-88-blue' }), polygon(west, { opaque: true })];
});
```

A displacement of `[0, 0]` is how a point stays put; every point gets an answer.

</details>

## Where to look things up

`t.material`, `t.sample` and their options are under *Making a material* on [Materials](#/materials); `steps` and the edits `next` accepts are under *Movement and growth*; `t.noise` is on [Fields & variation](#/fields). Next, chapter 3: the shore's points are all alike, so nothing can be drawn differently for some of them. An attribute changes that.
