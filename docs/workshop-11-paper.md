# 11. Make it work on paper

**Which version is worth plotting, and how will it run?** Everything before this page produced ink on a screen that behaves like paper. This page is about the last decisions: which of several drawings to keep, at what size, with which pen, in what order the machine will draw it, and what to save so that the plot can be made again exactly. There is no new geometry here. There is a way of looking at a drawing as a thing that will take an hour and a pen, which is a different way of looking. By the end you will be able to tell a saved sketch from a preserved drawing, judge a detail at its physical size, read a plan as an order, and choose a range of it on purpose.

## Choose a version

Two worked cases, because their costs and failure modes differ: a contour print from chapter 7 and a cellular print from chapter 6. Each below at two settings, and the question is not which is prettier but which has a reason: a clear hierarchy, blank space that is doing something, lines the eye can separate.

```ts live
import { sketch, strokes, group, rect, within } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const land = (x, y) => 0.5 + 0.5 * t.noise(x / 50, y / 50);
  const half = rect(0, 0, 98, 100);
  const sparse = t.isolines(within(land, half), t.times(5, (k) => (k + 1) / 6), { step: 1 });
  const dense = t.isolines(within(land, half), t.times(14, (k) => (k + 1) / 15), { step: 1 });
  return [strokes(sparse), group({ translate: [102, 0] }, strokes(dense))];
});
```

The sparse contour print says less and every line of it can be followed; the dense one describes the landscape more fully and reads, at this size, as a texture. On a large sheet with a fine pen the dense version would come into its own; on a small one it would be mud. That sentence is the whole page: a version is not good or bad until a size and a pen are attached to it.

```ts live
import { sketch, strokes, polygon, fill, mm, line, rect, append, group } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const build = (x0, count, patch) => {
    const frame = t.material(rect(x0 + 4, 4, 92, 92));
    const through = (x, y, angle) => t.sample(line(x - Math.cos(angle) * 300, y - Math.sin(angle) * 300, x + Math.cos(angle) * 300, y + Math.sin(angle) * 300), { count: 2 });
    const lines = t.times(count, (k) => (k % 3 === 0 ? through(x0 + t.rnd(4, 96), t.rnd(4, 96), t.rnd(Math.PI)) : through(x0 + 66 + t.rnd(-patch, patch), 58 + t.rnd(-patch, patch), t.rnd(Math.PI))));
    const inFrame = (f) => f.bounds.x >= x0 + 4 && f.bounds.y >= 4 && f.bounds.x + f.bounds.w <= x0 + 96 && f.bounds.y + f.bounds.h <= 96;
    const cells = [frame, ...lines].reduce((a, b) => append(a, b)).planarize().faces().filter(inFrame);
    const chosen = cells.filter((f) => f.area < 60);
    return [
      chosen.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: 45, spacing: mm(1.1 * (0.4 + 0.6 * Math.sqrt(f.area / 60))) }), stroke: false })),
      strokes(cells.edges, { pen: 'pigma-005-black' }), strokes(chosen.boundaryEdges, { pen: 'pigma-05-black' }),
    ];
  };
  return [build(0, 14, 20), build(100, 26, 20)];
});
```

The left cellular print has a cluster and quiet ground; the right has more of everything and its cluster is no longer the subject. Fourteen chords is the version. The choice is recorded by keeping the source that made it, with its seed: in the studio, Ctrl+S saves the sketch into the library, where every save is a version you can return to, and a snapshot freezes the source with the seed it rendered under. Both keep the recipe. Neither keeps the drawing, and that distinction is the last section of this page.

## Judge the physical size

The previews on these pages are drawn at nib width on the sheet named under them, which is what makes them honest, and the sheet can be chosen per example. The same contour print on A6 and on A3: the drawable scales with the paper, and so do the bare-unit coordinates; a hatch or a dot given in `mm()` does not. Look at the small one: the contours that were separable on the big sheet touch.

```ts live paper=A6 landscape
import { sketch, strokes } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const land = (x, y) => 0.5 + 0.5 * t.noise(x / 50, y / 50);
  const heights = t.times(14, (k) => (k + 1) / 15);
  return strokes(t.isolines(land, heights, { step: 1 }));
});
```

```ts live paper=A3 landscape
import { sketch, strokes } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const land = (x, y) => 0.5 + 0.5 * t.noise(x / 50, y / 50);
  const heights = t.times(14, (k) => (k + 1) / 15);
  return strokes(t.isolines(land, heights, { step: 1 }));
});
```

A print is judged at the size it will be, by a crop at that size, not by a thumbnail that fits the window. The cellular print at A6 with its hatch still at 1.1 mm: the small cells are now smaller than a few hatch lines, and some of them hold one line or none. The pen is the unit, and the pen does not scale.

```ts live paper=A6 landscape
import { sketch, strokes, polygon, fill, mm, line, rect, append } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const frame = t.material(rect(6, 6, 188, 88));
  const through = (x, y, angle) => t.sample(line(x - Math.cos(angle) * 300, y - Math.sin(angle) * 300, x + Math.cos(angle) * 300, y + Math.sin(angle) * 300), { count: 2 });
  const lines = t.times(18, (k) => (k % 3 === 0 ? through(t.rnd(6, 194), t.rnd(6, 94), t.rnd(Math.PI)) : through(138 + t.rnd(-26, 26), 58 + t.rnd(-18, 18), t.rnd(Math.PI))));
  const inFrame = (f) => f.bounds.x >= 6 && f.bounds.y >= 6 && f.bounds.x + f.bounds.w <= 194 && f.bounds.y + f.bounds.h <= 94;
  const cells = [frame, ...lines].reduce((a, b) => append(a, b)).planarize().faces().filter(inFrame);
  const chosen = cells.filter((f) => f.area < 90);
  return [
    chosen.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: 45, spacing: mm(1.1 * (0.4 + 0.6 * Math.sqrt(f.area / 90))) }), stroke: false })),
    strokes(cells.edges, { pen: 'pigma-005-black' }), strokes(chosen.boundaryEdges, { pen: 'pigma-05-black' }),
  ];
});
```

Two ways to answer this. Change the drawing for the sheet: fewer chords, a higher area threshold, a wider hatch. Or change the sheet for the drawing. Either is a decision; scaling the thumbnail is not one.

## What will be drawn

Rendering resolves the ink: what each shape hides, and what happens where two strokes land on the same line. The rule, from chapter 1, is that a later opaque area hides the marks inside it; the rule this page adds is that ink laid where ink already is does not draw twice. Both together in one small example: an opaque disc over a hatch, and a second stroke exactly along the first.

```ts live
import { sketch, circle, rect, line, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  rect(20, 20, 70, 60, { fill: fill('hatch', { angle: 30, spacing: mm(1.6) }) }),
  circle(55, 50, 20, { opaque: true }),
  line(120, 30, 180, 70),
  line(120, 30, 180, 70, { pen: 'stabilo-88-blue' }),
]);
```

The disc's hatch is gone because the disc is opaque and later. The blue line is not drawn at all, because a black line already occupies its path: the second stroke on a path is dropped, whichever pen it names. In chapter 9 the borders between kinds were drawn heavy over the fine walls, and that worked because the heavy pen went down first: order decides which of two coincident strokes survives. The studio's debug menu can show the resolved fragments; the plan of the page is what will be drawn, the source is what asked for it.

## How it will be drawn

The resolved ink is fragments; the plan turns them into an order. Fragments that meet end to end are merged into chains, the chains are toured so the pen travels the shortest way it can find between them, and gaps smaller than a nib are bridged pen-down. `t.plan({ optimize, bridge })` sets the budget for the tour and the bridging distance. Simulate, in the studio, animates the result at the machine's speed, and it is the way to see an order rather than reason about it.

Two drawings already made say most of what there is to say. The flow study of chapter 7 is long chains, few lifts, and plots quickly for its ink. The light study of chapter 8 is a thousand pen taps, each a lift and a settle, and plots slowly for its ink; a stipple is expensive in time, not in pen. Neither is better; a plan's cost is a consequence of the interpretation, and it is worth knowing before choosing the interpretation.

## Choose a range

A plan is an order, and `t.draw` chooses a contiguous range of it: `{ progress: [0, 0.5] }` is the first half of the chains, `{ chains: [a, b] }` a range by number, `{ minutes: [0, 20] }` a slice of the estimated timeline, which needs a machine profile. A range is a fraction of chains, not of ink or area or time; the boundaries fall on whole chains; and dropping the later chains never reveals anything the earlier ink hid, because visibility was resolved before the plan existed. Slide the fraction and watch the preview ghost the rest.

```ts live focus=5-6
import { sketch, circle, rect, line, fill, mm, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const part = ui(0.5, { min: 0, max: 1, step: 0.05, label: 'fraction of the plan' });
  t.draw({ progress: [0, part] });
  return [
    t.times(24, (k, u) => line(10, 8 + u * 84, 190, 8 + u * 84)),
    circle(100, 50, 30, { opaque: true, pen: 'stabilo-88-blue' }),
    t.times(12, (k) => circle(20 + k * 15, 50, 5)),
  ];
});
```

The disc hides the middle of the ruled lines; at any fraction of the plan they stay hidden. The tour starts near the origin and works outward, so which chains fall in the first half is a fact about the plan, not about the page: a range is for plotting a drawing in sittings, or for a draft, and a draft that should look like the whole is `decimate`, not `t.draw`.

## Save the result

Saving the sketch keeps the recipe; the drawing is remade from it every time, by whatever version of the engine, pens and profile are current, and the engine changes. Save result, in the studio, keeps the drawing: exactly the selected chains, their SVG, the pens, paper and profile they were resolved with, and the source and seed as provenance. A saved result reopens frozen, exports and plots the same bytes, and cannot grow back into the part of the plan that was not selected. Export writes the same thing to a file: SVG of the plotted chains in plot order, G-code per pen, PNG at a chosen scale. What can be reopened exactly is the result; what has to be regenerated is everything else.

## The finish

Take one drawing from this workshop, or one of your own, and make a print of it: a stated paper size, a pen chosen for its nib, a version chosen for a reason you can say, a range if it needs one, a saved result, and a short note naming one artistic decision and one practical one. The simulation and the export finish the exercise without a machine; the plot is the optional last step, and the note is the part that carries to the next drawing.

## Where to look things up

Paper, pens, the plan, `t.draw`, export, simulation and saved results are all on [Plotting & saving](#/plotting); the overlap rules on [Getting started](#/getting-started); the machine and its calibration in the Device notes.
