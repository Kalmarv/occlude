# 1. Put marks on paper

**How does my code become marks on this page?** By the end of this chapter you can place shapes where you mean them, repeat a mark, and say what happens where shapes overlap. This is the drawing you are about to make: a sun, a ruled sky, two hatched hills and a pond. The three chapters of this workshop build on it; the code is editable, and edits re-render in place.

```ts live
import { sketch, circle, ellipse, rect, clip, line, fill, mm } from 'occlude';

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

## Start here

A sketch is a function. It receives a toolkit, called `t` here, and returns what to draw; an array is a fine answer. This sheet is twice as wide as it is tall (`aspect: [2, 1]`), and a bare number is a percentage of the short side, so `x` runs from 0 to 200 and `y` from 0 to 100, with `y` growing downward. One sun and one horizon, so you can see where each number lands: the horizon at `y = 50`, the sun's centre at `(110, 58)`, just below it.

```ts live
import { sketch, circle, line } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  line(0, 50, 200, 50),
  circle(110, 58, 15),
]);
```

`line(x1, y1, x2, y2)` and `circle(x, y, radius)` are shapes: descriptions of what to draw. The engine turns them into pen strokes on the sheet named under the preview.

## Change it

**Repeat a mark.** Eight ruled lines would be eight nearly identical `line` calls. `t.times(8, …)` calls a function eight times and collects the results. The function is a callback: code you hand over to be called for you. It receives `k`, the count from 0, and `u`, the same count as a fraction from 0 to 1, so `6 + u * 54` spreads the lines from `y = 6` down to `y = 60`. Replace the single horizon with the sky.

```ts live
import { sketch, circle, line } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54)),
  circle(110, 58, 15),
]);
```

The array now holds an array (the eight lines) and a circle. Nesting is fine: the tree is flattened, and everything is drawn in the order it appears.

**A hill that hides the sun.** A hill is an ellipse centred near the bottom of the sheet: `ellipse(x, y, rx, ry)` with the centre at `(70, 95)` and a half-height of 45 puts the crest at `y = 50`, and most of the ellipse hangs below the sheet. `clip(region, shape)` keeps only the part inside a region, here a rectangle the size of the sheet, so the hill ends at the bottom edge. Its `fill` is texture inside the shape, parallel lines here, and `mm(1.4)` is their gap in millimetres, so it stays the same on any paper. Add the hill after the sun.

```ts live
import { sketch, circle, ellipse, rect, clip, line, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15);
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  return [sky, sun, farHill];
});
```

Nothing is cut by hand. A filled shape hides everything drawn before it that lies inside its outline: the lower half of the sun and the ends of the lowest ruled lines are gone because the hill came later in the array. That is the whole overlap rule: later wins, and only a shape with area, a fill or `opaque: true`, hides anything.

**A second hill, a pond, a second pen.** The near hill is another clipped ellipse, further right and lower, drawn after the far one so it hides part of it; its hatch runs at another angle so the two read apart. The pond is a flat ellipse with `opaque: true` and no fill: it draws only its outline, but it hides the hill's hatch inside, which is what still water looks like. The sun names its own pen. The pens named on these pages are the docs' own; when you open a sketch in the studio they are added to your library for the session.

```ts live
import { sketch, circle, ellipse, rect, clip, line, fill, mm } from 'occlude';

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

This is the finished drawing from the top of the page. Chapter 2 starts from exactly this code.

## Experiments

**The sun drawn last.** Predict: if the sun moves to the end of the return array, after both hills, what happens to the hatch where the sun's outline crosses it? Change `[sky, sun, farHill, nearHill, pond]` to `[sky, farHill, nearHill, pond, sun]`. Observe: the sun's full circle is drawn across the far hill, and every hatch line under it is still there. Explain: a stroke never hides anything. Hiding is done by area, and an unfilled circle has none; drawing it last only adds its ink.

**A transparent pond.** Predict: what does the pond look like without `opaque: true`? Remove that option. Observe: the near hill's hatch runs straight through the pond; the pond is an outline lying on the hill. Explain: without a fill or `opaque`, the ellipse has no area as far as hiding goes. `opaque: true` is the way to hide with a shape that draws only its outline.

## On your own

Add a third hill in front of the near one, low enough to cover the pond's bottom edge, with its own hatch angle. Where in the array does it have to go?

<details>
<summary>A possible solution</summary>

```ts live
import { sketch, circle, ellipse, rect, clip, line, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const bank = clip(sheet, ellipse(110, 120, 90, 27, 0, { fill: fill('hatch', { angle: 30, spacing: mm(1.4) }) }));
  return [sky, sun, farHill, nearHill, pond, bank];
});
```

The bank goes last: it must come after the pond to hide the pond's bottom edge.

</details>

## Where to look things up

Every shape and its options are on [Shapes & layout](#/shapes); the fill patterns and what spacing does to tone on [Fills](#/fills); units, seeds and the four overlap rules on [Getting started](#/getting-started). Next, chapter 2: the pond is a shape, so its outline cannot be edited point by point. Material changes that.
