# 11. Make it work on paper

**Which version is worth plotting, and how will it run?** Everything before this page produced ink on a screen that behaves like paper. This page takes one drawing from the workshop through what happens next: a first proof at the size it will be, the details that fail at that size, a revision aimed at them, the cost of each version measured the way the machine will pay it, and the preserved result. There is no new geometry here. There is a way of looking at a drawing as a thing that will take an hour and a pen, which is a different way of looking. By the end you will be able to find what is wrong with a proof, tell a saved sketch from a preserved drawing, read a plan as an order, and choose a range of it on purpose.

## A first proof

The cellular print from chapter 6, as it stood at the end of that page, put on the sheet it will be plotted on: A5, landscape, the fine pen at 0.2 mm and the border pen at 0.45 mm. This is the first proof. The preview draws it at nib width on that sheet, and the job now is to look at it as a print rather than as a drawing, and find what is wrong.

```ts live paper=A5 landscape
import { sketch, strokes, polygon, fill, mm, line, rect, append } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const frame = t.material(rect(6, 6, 188, 88));
  const through = (x, y, angle) => t.sample(line(x - Math.cos(angle) * 300, y - Math.sin(angle) * 300, x + Math.cos(angle) * 300, y + Math.sin(angle) * 300), { count: 2 });
  const lines = t.times(18, (k) => (k % 3 === 0 ? through(t.rnd(6, 194), t.rnd(6, 94), t.rnd(Math.PI)) : through(138 + t.rnd(-26, 26), 58 + t.rnd(-18, 18), t.rnd(Math.PI))));
  const cells = t.within([frame, ...lines].reduce((a, b) => append(a, b)).planarize().faces(), rect(6, 6, 188, 88));
  const chosen = cells.filter((f) => f.area < 90);
  const spacing = (f) => mm(1.1 * (0.4 + 0.6 * Math.sqrt(f.area / 90)));
  return [
    chosen.map((f) => polygon(f, { fill: fill('hatch', { angle: 45, spacing: spacing(f) }), stroke: false })),
    strokes(chosen.boundaryEdges, { pen: 'pigma-05-black' }),
    strokes(cells.edges, { pen: 'pigma-005-black' }),
  ];
});
```

Three things to find, and they are easier to see if you look for the smallest marks first. The slivers: wedge-shaped cells no wider than a hatch gap are hatched at the tightest spacing the rule allows, 0.44 mm, and on paper a 0.2 mm line at 0.44 mm spacing in a cell a millimetre wide is a black smear, not a tone. The corners: where a chord clips a corner of the frame it leaves a triangle a few millimetres across, which the area rule counts as a small cell and hatches solid, so the frame has dark specks in its corners that have nothing to do with the cluster. And the crowd: near the focus the walls are closer together than the hatch, and the hatch of one cell runs into the wall of the next, so the cluster's centre reads as a knot rather than as cells.

None of these is visible at the size of a thumbnail. All of them are visible at A5, and all three are the same mistake: the hatch rule reads only a cell's area, and a cell's area says nothing about whether the pen can draw a texture inside it.

## A targeted revision

The change is small and it is to the decision, not to the construction: a cell is hatched only if it is wide enough for the hatch to be a texture, three gaps across at least, and the spacing floor rises from 0.4 to 0.6 of the gap so no cell is ever hatched below the pen's own width times three. `narrow` measures a cell by the short side of its bounds, which is a proxy, and an honest one for wedges; a cell can be wide and thin along a diagonal and slip through. The chords are drawn once, as numbers, and both sides are built from them, so the two networks are the same network; left the proof's rule, right the revision's.

```ts live paper=A5 landscape focus=12-14
import { sketch, strokes, polygon, fill, mm, line, rect, append, group } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const chords = t.times(18, (k) => (k % 3 === 0 ? [t.rnd(4, 96), t.rnd(4, 96), t.rnd(Math.PI)] : [66 + t.rnd(-20, 20), 58 + t.rnd(-20, 20), t.rnd(Math.PI)]));
  const make = (x0) => {
    const frame = t.material(rect(x0 + 4, 4, 92, 92));
    const through = (x, y, angle) => t.sample(line(x - Math.cos(angle) * 300, y - Math.sin(angle) * 300, x + Math.cos(angle) * 300, y + Math.sin(angle) * 300), { count: 2 });
    const lines = chords.map(([x, y, angle]) => through(x0 + x, y, angle));
    return t.within([frame, ...lines].reduce((a, b) => append(a, b)).planarize().faces(), rect(x0 + 4, 4, 92, 92));
  };
  const gap = 1.1;
  const narrow = (f) => Math.min(f.bounds.w, f.bounds.h) < 3 * gap;
  const draw = (cells, revised) => {
    const chosen = cells.filter((f) => f.area < 60 && (!revised || !narrow(f)));
    const spacing = (f) => mm(gap * ((revised ? 0.6 : 0.4) + 0.6 * Math.sqrt(f.area / 60)));
    return [
      chosen.map((f) => polygon(f, { fill: fill('hatch', { angle: 45, spacing: spacing(f) }), stroke: false })),
      strokes(chosen.boundaryEdges, { pen: 'pigma-05-black' }),
      strokes(cells.edges, { pen: 'pigma-005-black' }),
    ];
  };
  return [draw(make(0), false), draw(make(100), true)];
});
```

The corners are clean, the wedges are lines again, and the cluster's centre is a group of cells with a texture in the ones that can hold one. Something was lost too: the darkest cells in the proof were the smallest, and the revision's darkest cells are a little larger and a little lighter, so the cluster's centre is less black. That is the trade, and it is a fair one on this sheet; on A3 the proof's rule would be the better one, because at twice the size those wedges hold a texture after all. A rule is not right or wrong until a size is attached to it.

## Compare the cost

A plotter does not care how a drawing looks; it cares how many times the pen goes down and how far it travels. The two versions, the proof and the revision at full size, measured with the same estimator the studio's Simulate and the export panel use, on A5 with these pens:

| version | chains | pen down (mm) | travel (mm) | estimate |
|---|---|---|---|---|
| proof | 434 | 3,140 | 1,080 | 4.1 min |
| revision | 317 | 2,830 | 933 | 3.2 min |

Measured with `pnpm --filter occlude plotstats <sketch> --seed 11 --paper A5 --landscape --pens docs` on this build; a chain is one pen-down run, so chains are lifts.

The revision draws less ink and lifts the pen less, because the hatch runs it removed were the shortest ones: a sliver's hatch is many lifts for a few millimetres of ink, the most expensive ink on the page. The estimate is the plan's guess from the machine profile, not a promise; what it is good for is the comparison, and the comparison says the better print is also the cheaper one, which is not always so.

## The same drawing on another sheet

The proof was judged at A5 because that is the sheet, and the revision is right for it. Put the revision on A6 and on A3: the drawable scales with the paper and so do the bare-unit coordinates, but a length given in `mm()`, the hatch gap here, does not, and the pen does not either. On A6 the cells that are still hatched hold two or three lines each and the print is at the edge of what the pen can do; on A3 the wedges the revision excluded would have held a texture after all, and the proof's rule would have been the better one. A rule is not right or wrong until a size is attached to it, and the sheet can be chosen per example on these pages, so the judgement can be made before anything is cut.

```ts live paper=A6 landscape
import { sketch, strokes, polygon, fill, mm, line, rect, append } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const frame = t.material(rect(6, 6, 188, 88));
  const through = (x, y, angle) => t.sample(line(x - Math.cos(angle) * 300, y - Math.sin(angle) * 300, x + Math.cos(angle) * 300, y + Math.sin(angle) * 300), { count: 2 });
  const lines = t.times(18, (k) => (k % 3 === 0 ? through(t.rnd(6, 194), t.rnd(6, 94), t.rnd(Math.PI)) : through(138 + t.rnd(-26, 26), 58 + t.rnd(-18, 18), t.rnd(Math.PI))));
  const cells = t.within([frame, ...lines].reduce((a, b) => append(a, b)).planarize().faces(), rect(6, 6, 188, 88));
  const narrow = (f) => Math.min(f.bounds.w, f.bounds.h) < 3.3;
  const chosen = cells.filter((f) => f.area < 90 && !narrow(f));
  const spacing = (f) => mm(1.1 * (0.6 + 0.6 * Math.sqrt(f.area / 90)));
  return [
    chosen.map((f) => polygon(f, { fill: fill('hatch', { angle: 45, spacing: spacing(f) }), stroke: false })),
    strokes(chosen.boundaryEdges, { pen: 'pigma-05-black' }),
    strokes(cells.edges, { pen: 'pigma-005-black' }),
  ];
});
```

```ts live paper=A3 landscape
import { sketch, strokes, polygon, fill, mm, line, rect, append } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const frame = t.material(rect(6, 6, 188, 88));
  const through = (x, y, angle) => t.sample(line(x - Math.cos(angle) * 300, y - Math.sin(angle) * 300, x + Math.cos(angle) * 300, y + Math.sin(angle) * 300), { count: 2 });
  const lines = t.times(18, (k) => (k % 3 === 0 ? through(t.rnd(6, 194), t.rnd(6, 94), t.rnd(Math.PI)) : through(138 + t.rnd(-26, 26), 58 + t.rnd(-18, 18), t.rnd(Math.PI))));
  const cells = t.within([frame, ...lines].reduce((a, b) => append(a, b)).planarize().faces(), rect(6, 6, 188, 88));
  const narrow = (f) => Math.min(f.bounds.w, f.bounds.h) < 3.3;
  const chosen = cells.filter((f) => f.area < 90 && !narrow(f));
  const spacing = (f) => mm(1.1 * (0.6 + 0.6 * Math.sqrt(f.area / 90)));
  return [
    chosen.map((f) => polygon(f, { fill: fill('hatch', { angle: 45, spacing: spacing(f) }), stroke: false })),
    strokes(chosen.boundaryEdges, { pen: 'pigma-05-black' }),
    strokes(cells.edges, { pen: 'pigma-005-black' }),
  ];
});
```

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

The disc's hatch is gone because the disc is opaque and later. The blue line is not drawn at all, because a black line already occupies its path: the second stroke on a path is dropped, whichever pen it names. In chapters 6 and 9 the heavy borders are drawn before the fine walls for exactly this reason: a border is also a wall, and whichever pen reaches the line first keeps it, so the heavy pen goes first or the border comes out fine. Order decides which of two coincident strokes survives. The studio's debug menu can show the resolved fragments; the plan of the page is what will be drawn, the source is what asked for it.

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

## Keep the better one

The revision is the version. Two things to keep, and they are different. Saving the sketch, Ctrl+S in the studio, keeps the recipe with its seed: the drawing is remade from it every time, by whatever version of the engine, pens and profile are current, and the engine changes. Save result, in the studio's Export panel, keeps the drawing: exactly the selected chains, their SVG, the pens, paper and profile they were resolved with, and the source and seed as provenance. A saved result reopens frozen, exports and plots the same bytes, and cannot grow back into the part of the plan that was not selected. Export writes the same thing to a file: SVG of the plotted chains in plot order, G-code per pen, PNG at a chosen scale. What can be reopened exactly is the result; what has to be regenerated is everything else.

## The finish

Take one drawing from this workshop, or one of your own, and make a print of it: a stated paper size, a pen chosen for its nib, a version chosen for a reason you can say, a range if it needs one, a saved result, and a short note naming one artistic decision and one practical one. The simulation and the export finish the exercise without a machine; the plot is the optional last step, and the note is the part that carries to the next drawing.

## Where to look things up

Paper, pens, the plan, `t.draw`, export, simulation and saved results are all on [Plotting & saving](#/plotting); the overlap rules on [Getting started](#/getting-started); the machine and its calibration in the Device notes.
