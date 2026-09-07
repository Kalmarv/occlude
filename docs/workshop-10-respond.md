# 10. Let a drawing respond

**How can measurements become my own rule?** The standard operations of chapter 8 read a field and move points by rules that are theirs. A sketch can do the same thing with a rule that is yours: measure the regions its points own, decide what each point should do about what it finds, move it, and go round again. This is the drawing this chapter arrives at: a cellular arrangement that has crept toward two patches of light, cell by cell, while a share of its sites stayed pinned and kept the original structure showing through; drawn once as walls and once as the sites alone. By the end you will be able to point at the observation, the decision and the edit in code of your own, and know what each costs.

```ts live
import { sketch, strokes, circle, distance, sub, mul, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const iterations = ui(12, { min: 0, max: 20, step: 1 });
  const amount = ui(0.8, { min: 0, max: 1, step: 0.05, label: 'move fraction' });
  const mobile = ui(0.7, { min: 0, max: 1, step: 0.05, label: 'mobile share' });
  const glow = (x, y) => Math.min(1, Math.max(0, 1 - distance([x, y], [62, 42]) / 46) + Math.max(0, 1 - distance([x, y], [148, 64]) / 34) * 0.8);
  const light = (x, y) => 0.005 + Math.pow(glow(x, y), 4);
  const sites = t.relax(t.scatter({ spacing: 12 }), { iterations: 2 }).attribute('mobility', () => (t.chance(mobile) ? 1 : 0));
  const settled = sites.steps(iterations, (current, next) => {
    const diagram = t.voronoi(current);
    const measured = diagram.faces().measure(light, { resolution: 128 });
    next.move((p) => {
      const cell = diagram.cellOf(p);
      const target = cell ? measured.forFace(cell).weightedCentroid : null;
      return target ? mul(sub(target, p), amount * p.mobility) : [0, 0];
    });
  });
  return [strokes(t.voronoi(settled)), settled.points.filter((p) => p.mobility === 0).map((p) => circle(p.x, p.y, 0.9))];
});
```

## A sample is not a measurement

Chapter 8's scatter read the field at each point. A cell is an area, and the field can vary across it. One large cell in the middle of three sites, over a faint ramp with a bright patch that the control slides from left to right. Two numbers are written on it: the field at the site, and the mean of the field over the cell, from `diagram.faces().measure(field)`, which samples the field across every face on a raster and adds it up. `measured.forFace(cell)` looks one face up and gives its `area`, `integral` (the sum, in field units times area) and `mean` (the integral over the area).

```ts live focus=8-10
import { sketch, strokes, circle, label, material, distance, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const px = ui(70, { min: 50, max: 150, step: 1, label: 'patch x' });
  const patch = (x, y) => Math.max(0, 1 - distance([x, y], [px, 50]) / 14);
  const field = (x, y) => 0.15 * (x / 200) + patch(x, y);
  const sites = material([[100, 50], [16, 14], [184, 86]]);
  const diagram = t.voronoi(sites);
  const cell = diagram.cellOf(sites.points.at(0));
  const measured = diagram.faces().measure(field, { resolution: 128 });
  return [
    strokes(diagram), sites.points.map((p) => circle(p.x, p.y, 1.6)),
    strokes(t.isolines(patch, [0.3, 0.6], { step: 1 }), { pen: 'stabilo-88-blue' }),
    label(`at the site ${field(100, 50).toFixed(2)}`, 60, 72, 3.4),
    label(`mean over the cell ${measured.forFace(cell).mean.toFixed(2)}`, 60, 80, 3.4),
  ];
});
```

Slide the patch. When is the site's own reading large, and when does the cell's mean say the light is there while the site says it is not? A point sample sees what is under it; a measurement sees the cell. Every rule on this page reads the measurement. The measurement is a raster sum, and `resolution` is how fine the raster is: it is not an exact integral, and a patch narrower than a raster cell can slip between samples.

## Find a useful target

A cell has a centroid, its centre of area, and `measure` gives it. With a field it also gives a `weightedCentroid`: the centre of the field over the cell, which sits where the light is. The two differ when the light is uneven across the cell, and the weighted one is the target a light-seeking site wants. It needs a field that is not negative and not zero over the cell; where the total is zero there is no centre to find and the target is `null`, which a rule has to handle. Slide the patch again and watch the blue target leave the black centroid.

```ts live focus=10-11
import { sketch, strokes, circle, line, material, distance, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const px = ui(70, { min: 50, max: 150, step: 1, label: 'patch x' });
  const patch = (x, y) => Math.max(0, 1 - distance([x, y], [px, 50]) / 14);
  const field = (x, y) => 0.15 * (x / 200) + patch(x, y);
  const sites = material([[100, 50], [16, 14], [184, 86]]);
  const diagram = t.voronoi(sites);
  const cell = diagram.cellOf(sites.points.at(0));
  const m = diagram.faces().measure(field, { resolution: 128 }).forFace(cell);
  const target = m.weightedCentroid;
  return [
    strokes(diagram), sites.points.map((p) => circle(p.x, p.y, 1.6)),
    circle(m.centroid[0], m.centroid[1], 1.2), line(m.centroid[0] - 2, m.centroid[1], m.centroid[0] + 2, m.centroid[1]),
    target ? [circle(target[0], target[1], 1.2, { pen: 'stabilo-88-blue' }), line(100, 50, target[0], target[1], { pen: 'stabilo-88-blue' })] : [],
  ];
});
```

## Move once

Now every site, one step: build the diagram, measure every cell, and move each site part of the way toward its cell's weighted centre. The blue lines are the displacements as they were before the move; the walls are the diagram built again from the moved sites. Three parts, in order: the observation (`voronoi`, `measure`), the decision (`target`, and `[0, 0]` when there is none), and the edit (`next.move`).

```ts live focus=8-14
import { sketch, strokes, circle, line, distance, sub, mul, add, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const amount = ui(0.8, { min: 0, max: 1, step: 0.05, label: 'move fraction' });
  const light = (x, y) => 0.005 + Math.pow(Math.max(0, 1 - distance([x, y], [100, 50]) / 60), 4);
  const sites = t.relax(t.scatter({ spacing: 12 }), { iterations: 2 });
  const arrows = [];
  const moved = sites.steps(1, (current, next) => {
    const diagram = t.voronoi(current);
    const measured = diagram.faces().measure(light, { resolution: 128 });
    next.move((p) => {
      const cell = diagram.cellOf(p);
      const target = cell ? measured.forFace(cell).weightedCentroid : null;
      const step = target ? mul(sub(target, p), amount) : [0, 0];
      arrows.push(line(p.x, p.y, ...add(p, step), { pen: 'stabilo-88-blue' }));
      return step;
    });
  });
  return [strokes(t.voronoi(moved), { pen: 'pigma-005-black' }), arrows, moved.points.map((p) => circle(p.x, p.y, 0.8))];
});
```

`diagram` is built from `current` inside the rule, so `cellOf(p)` is asked of the state `p` belongs to. That is the ownership rule from chapters 3 and 9 doing useful work: a diagram of the previous step would refuse these points, and rightly, since its cells are not theirs.

## Repeat, then change the response

The same rule for several steps, and each step's diagram is built from the sites the last step moved: the cells crowd toward the light, and their walls shorten there. The light never changes; the measurement is the same question each time; the rule is the reader's, so the first thing to change is the response. A `mobility` attribute on the sites, 1 or 0, decided by a seeded coin, scales each site's move, so some sites go and some stay, and the pinned ones hold the original spacing around them.

```ts live focus=8,13
import { sketch, strokes, circle, distance, sub, mul, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const iterations = ui(12, { min: 0, max: 20, step: 1 });
  const amount = ui(0.8, { min: 0, max: 1, step: 0.05, label: 'move fraction' });
  const mobile = ui(0.7, { min: 0, max: 1, step: 0.05, label: 'mobile share' });
  const light = (x, y) => 0.005 + Math.pow(Math.max(0, 1 - distance([x, y], [100, 50]) / 60), 4);
  const sites = t.relax(t.scatter({ spacing: 12 }), { iterations: 2 }).attribute('mobility', () => (t.chance(mobile) ? 1 : 0));
  const settled = sites.steps(iterations, (current, next) => {
    const diagram = t.voronoi(current);
    const measured = diagram.faces().measure(light, { resolution: 128 });
    next.move((p) => {
      const cell = diagram.cellOf(p);
      const target = cell ? measured.forFace(cell).weightedCentroid : null;
      return target ? mul(sub(target, p), amount * p.mobility) : [0, 0];
    });
  });
  return [strokes(t.voronoi(settled)), settled.points.filter((p) => p.mobility === 0).map((p) => circle(p.x, p.y, 0.9))];
});
```

Set `mobile share` to 1 and the whole arrangement flows to the light and the edges of the sheet empty out into long cells. At 0.7 the pinned sites, marked, keep a lattice of the original structure between the clusters. Before you drag `move fraction` to 1: does a full move each step settle faster, or does something else happen?

<details>
<summary>What to look for</summary>

At 1 each site jumps to its cell's weighted centre in one step, and the next step's cells are different enough that the centres move back part of the way: the arrangement settles by overshooting a little. At 0.8 it converges nearly as fast and more evenly. Below 0.5 nothing goes wrong, but the light is faint in its effect: each step moves a site only a fraction of an already small distance, because the weighted centre is never far from the plain centre of a cell, and twelve rounds are not enough to show it. This response is slow by nature; the move fraction and the contrast of the light are what make it visible.

</details>

## Compose and compare

Two patches of light, unequal, raised to a high power so the light is a bright pool with dark surroundings rather than a slope, and a modest population. A gentle light barely moves the cells: the weighted centre of a cell sits close to its plain centre unless the light changes a lot across it, so this response is slow by nature, and the contrast is what makes it visible in a dozen rounds. The `mobile share` is what gives the composition its two layers: the moving sites cluster into the light and the pinned ones hold the ground between. Drawn as walls, the drawing is about the cells; drawn as marks at the same final sites, it is about the crowding, and chapter 8's tone comes back without any field being scattered. The label reports what the rule cost.

```ts live focus=6-9,19-22
import { sketch, strokes, circle, label, distance, sub, mul, group, rect, within, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const iterations = ui(12, { min: 0, max: 20, step: 1 });
  const mobile = ui(0.7, { min: 0, max: 1, step: 0.05, label: 'mobile share' });
  const glow = (x, y) => Math.min(1, Math.max(0, 1 - distance([x, y], [30, 42]) / 30) + Math.max(0, 1 - distance([x, y], [72, 64]) / 22) * 0.8);
  const light = (x, y) => 0.005 + Math.pow(glow(x, y), 4);
  const half = { x: 0, y: 0, w: 100, h: 100 };
  const sites = t.relax(t.scatter(within(() => 1, rect(0, 0, 100, 100)), { spacing: 11 }), { iterations: 2, bounds: half }).attribute('mobility', () => (t.chance(mobile) ? 1 : 0));
  const started = Date.now();
  const settled = sites.steps(iterations, (current, next) => {
    const diagram = t.voronoi(current, { bounds: half });
    const measured = diagram.faces().measure(light, { resolution: 128 });
    next.move((p) => {
      const cell = diagram.cellOf(p);
      const target = cell ? measured.forFace(cell).weightedCentroid : null;
      return target ? mul(sub(target, p), 0.8 * p.mobility) : [0, 0];
    });
  });
  const took = Date.now() - started;
  return [
    strokes(t.voronoi(settled, { bounds: half })),
    group({ translate: [100, 0] }, settled.points.map((p) => circle(p.x, p.y, 0.7))),
    label(`${iterations} rounds, ${sites.n} sites, ${took} ms`, 4, 6, 3),
  ];
});
```

Of the two, the marks are the stronger drawing at this seed: the walls draw every cell with the same weight and the light reads only as a change of cell size, while the marks make the light a density and the pinned lattice a texture, which is two kinds of information in one kind of ink. The walls would come into their own with chapter 9's borders, or chapter 6's selection of the small cells.

## What it costs

`t.relax` does the plain version of this, sites to weighted centres, in a kernel that never builds a diagram, and it is many times faster than a round of `voronoi` plus `measure` plus a move. This chapter's rule is not an improvement on it; it is the same idea with the cells and the measurements exposed, which is what makes a different response possible: pinning, stopping, moving only some kinds, or pulling toward something other than the centre. When the response is the standard one, use the standard operation. The label above is the cost of having a choice.

## On your own

Write a different response from the same measurements. Three that work: a site that finds its cell bright enough stops moving for good; only sites of one kind, by an attribute you declare, move at all; a site whose cell holds too little light is pulled toward a fixed point instead of its cell's centre. Each is a change to the decision, not to the observation or the edit.

<details>
<summary>A hint, and one possible answer</summary>

The decision is the line that computes `target`, and it can read `measured.forFace(cell).mean` as easily as `weightedCentroid`. To stop for good, a site needs to remember that it stopped: an attribute, set with `next.set` in the same rule when the mean crosses a threshold, and read the next step so the move is `[0, 0]`. One answer:

```ts
next.set((p) => ({ mobility: 0 }), { where: current.points.filter((p) => { const c = diagram.cellOf(p); return c && measured.forFace(c).mean > 0.5; }) });
```

placed before the move inside the rule, with `mobility` declared as 1 on every site. The move line does not change; the sites that reached the light stay, and the ones still in the dark keep coming.

</details>

## Where to look things up

`measure`, `forFace` and the fields of a measurement are under *Faces and boundaries* on [Materials](#/materials); `t.voronoi`, `cellOf` and the standard refinements under *Point distributions*; `steps`, `move` and `set` under *Movement and growth*. Next, chapter 11: choosing a drawing worth plotting, and getting it onto paper.
