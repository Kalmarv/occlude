# 10. Let a drawing respond

**How can measurements become my own rule?** The standard operations of chapter 8 read a field and move points by rules that are theirs. A sketch can do the same thing with a rule that is yours: measure the regions its points own, decide what each point should do about what it finds, move it, and go round again. This is the drawing this chapter arrives at: sites drawn toward two patches of light and stopping, each for good, where its cell became bright enough, so that shells form around the light out of the order in which they arrived; drawn once as walls and once as the sites alone. By the end you will be able to point at the observation, the decision and the edit in code of your own, and know what each costs.

```ts live
import { sketch, strokes, circle, label, distance, sub, mul, group, rect, within, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const iterations = ui(16, { min: 0, max: 24, step: 1 });
  const bright = ui(0.12, { min: 0.02, max: 0.9, step: 0.02, label: 'bright enough to stop' });
  const half = { x: 0, y: 0, w: 100, h: 100 };
  const glow = (x, y) => Math.min(1, Math.max(0, 1 - distance([x, y], [30, 42]) / 30) + Math.max(0, 1 - distance([x, y], [72, 64]) / 22) * 0.9);
  const light = (x, y) => 0.005 + Math.pow(glow(x, y), 3);
  const sites = t.relax(t.scatter(within(() => 1, rect(0, 0, 100, 100)), { spacing: 7 }), { iterations: 2, bounds: half }).attribute('mobility', 1);
  const started = Date.now();
  const settled = sites.steps(iterations, (current, next) => {
    const diagram = t.voronoi(current, { bounds: half });
    const measured = diagram.faces().measure(light, { resolution: 128 });
    next.move((p) => { const cell = diagram.cellOf(p); const target = cell ? measured.forFace(cell).weightedCentroid : null; return target ? mul(sub(target, p), 0.8 * p.mobility) : [0, 0]; });
    next.set(() => ({ mobility: 0 }), { where: current.points.filter((p) => { const cell = diagram.cellOf(p); return cell !== undefined && measured.forFace(cell).mean > bright; }) });
  });
  const took = Date.now() - started;
  return [
    strokes(t.voronoi(settled, { bounds: half })),
    group({ translate: [100, 0] }, settled.points.map((p) => circle(p.x, p.y, p.mobility ? 0.5 : 1))),
    label(`${iterations} rounds, ${sites.n} sites, ${took} ms`, 104, 97, 2.6),
  ];
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

## Repeat, and then decide differently

The same rule for several steps, and each step's diagram is built from the sites the last step moved: the cells crowd toward the light, and their walls shorten there. How far a site moves each step is the distance from its cell's plain centre to its weighted one, and that distance depends on how much the light changes across the cell: nearly nothing for a small cell under an even light, a good fraction of the cell for a cell that straddles the edge of a bright patch. With `move fraction` at 0.8 and a light with a hard edge, a dozen rounds is enough to see.

```ts live focus=8-13
import { sketch, strokes, circle, distance, sub, mul, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const iterations = ui(12, { min: 0, max: 20, step: 1 });
  const amount = ui(0.8, { min: 0, max: 1, step: 0.05, label: 'move fraction' });
  const light = (x, y) => 0.005 + Math.pow(Math.max(0, 1 - distance([x, y], [100, 50]) / 60), 4);
  const sites = t.relax(t.scatter({ spacing: 12 }), { iterations: 2 });
  const gathered = sites.steps(iterations, (current, next) => {
    const diagram = t.voronoi(current);
    const measured = diagram.faces().measure(light, { resolution: 128 });
    next.move((p) => {
      const cell = diagram.cellOf(p);
      const target = cell ? measured.forFace(cell).weightedCentroid : null;
      return target ? mul(sub(target, p), amount) : [0, 0];
    });
  });
  return [strokes(t.voronoi(gathered)), gathered.points.map((p) => circle(p.x, p.y, 0.7))];
});
```

That is one response to the measurement: go where the light is in your cell. It is the standard one, the thing `t.relax` does with a density, and it produces one kind of structure: cells that shrink toward the light and stretch away from it, smoothly, everywhere at once.

**The same observation, a different decision.** Keep every line of the observation and change only what a site does with it. Second response: a site whose cell is bright enough stops, for good. It needs to remember that it stopped, so the sites carry a `mobility` attribute, 1 to start, and the rule sets it to 0 when the cell's `mean` crosses `bright`; the move is scaled by `mobility`, so a stopped site stays put while the others keep coming. The observation is identical: the diagram, the measurement, the same `mean` and `weightedCentroid` for every cell. Left, the first response; right, the second, from the same sites.

```ts live focus=17-21
import { sketch, strokes, circle, distance, sub, mul, group, rect, within, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const iterations = ui(12, { min: 0, max: 20, step: 1 });
  const bright = ui(0.35, { min: 0.05, max: 0.9, step: 0.05, label: 'bright enough to stop' });
  const half = { x: 0, y: 0, w: 100, h: 100 };
  const light = (x, y) => 0.005 + Math.pow(Math.max(0, 1 - distance([x, y], [50, 50]) / 34), 4);
  const sites = t.relax(t.scatter(within(() => 1, rect(0, 0, 100, 100)), { spacing: 8 }), { iterations: 2, bounds: half }).attribute('mobility', 1);
  const respond = (stopping) => sites.steps(iterations, (current, next) => {
    const diagram = t.voronoi(current, { bounds: half });
    const measured = diagram.faces().measure(light, { resolution: 128 });
    next.move((p) => {
      const cell = diagram.cellOf(p);
      const target = cell ? measured.forFace(cell).weightedCentroid : null;
      return target ? mul(sub(target, p), 0.8 * p.mobility) : [0, 0];
    });
    if (stopping) next.set(() => ({ mobility: 0 }), { where: current.points.filter((p) => { const cell = diagram.cellOf(p); return cell !== undefined && measured.forFace(cell).mean > bright; }) });
  });
  const gathered = respond(false);
  const stopped = respond(true);
  const marks = (m) => m.points.map((p) => circle(p.x, p.y, p.mobility ? 0.6 : 1.1));
  return [strokes(t.voronoi(gathered, { bounds: half })), marks(gathered), group({ translate: [100, 0] }, strokes(t.voronoi(stopped, { bounds: half })), marks(stopped))];
});
```

Watch the right side as `iterations` climbs. The first sites to stop are the ones already in the light, and they stop early, before they have crowded; the sites arriving from the dark cross the threshold at the edge of the bright patch and stop there, one after another, so a ring forms where the light becomes bright enough, and the middle stays as it was. The left side has no ring: its sites keep sliding inward until they pack against each other. Lower `bright enough to stop` and the ring grows outward and thins; raise it and only the innermost sites ever stop, and the two drawings converge. The larger marks are the stopped sites.

Before reading on: the stopped sites make a shell. Is that shell a fact about the light, or about the order in which sites arrived?

<details>
<summary>What to look for</summary>

Both, which is why it is interesting. Where the shell is, is a fact about the light: it lies along the contour of the light where a cell's mean crosses the threshold. What the shell is made of is a fact about history: the sites that reached it first stopped first, and the ones behind stopped behind them, so the shell has a thickness that the light alone does not have. A rule that only reads the present, like the first response, can only reproduce the light. A rule with memory, an attribute it writes, can make a structure the light does not contain. That is what a custom decision buys.

</details>

## Compose

The second response, on a modest population with two patches of light, drawn twice from the same final sites: as walls, where the shells show as rings of small cells with open cells inside them; and as marks of two sizes, the stopped sites larger. The label reports what the rule cost, and the standard response is left out on purpose: at this point the decision is the drawing.

```ts live focus=8-16
import { sketch, strokes, circle, label, distance, sub, mul, group, rect, within, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const iterations = ui(16, { min: 0, max: 24, step: 1 });
  const bright = ui(0.12, { min: 0.02, max: 0.9, step: 0.02, label: 'bright enough to stop' });
  const half = { x: 0, y: 0, w: 100, h: 100 };
  const glow = (x, y) => Math.min(1, Math.max(0, 1 - distance([x, y], [30, 42]) / 30) + Math.max(0, 1 - distance([x, y], [72, 64]) / 22) * 0.9);
  const light = (x, y) => 0.005 + Math.pow(glow(x, y), 3);
  const sites = t.relax(t.scatter(within(() => 1, rect(0, 0, 100, 100)), { spacing: 7 }), { iterations: 2, bounds: half }).attribute('mobility', 1);
  const started = Date.now();
  const settled = sites.steps(iterations, (current, next) => {
    const diagram = t.voronoi(current, { bounds: half });
    const measured = diagram.faces().measure(light, { resolution: 128 });
    next.move((p) => { const cell = diagram.cellOf(p); const target = cell ? measured.forFace(cell).weightedCentroid : null; return target ? mul(sub(target, p), 0.8 * p.mobility) : [0, 0]; });
    next.set(() => ({ mobility: 0 }), { where: current.points.filter((p) => { const cell = diagram.cellOf(p); return cell !== undefined && measured.forFace(cell).mean > bright; }) });
  });
  const took = Date.now() - started;
  return [
    strokes(t.voronoi(settled, { bounds: half })),
    group({ translate: [100, 0] }, settled.points.map((p) => circle(p.x, p.y, p.mobility ? 0.5 : 1))),
    label(`${iterations} rounds, ${sites.n} sites, ${took} ms`, 104, 97, 2.6),
  ];
});
```

Two lights of different size give two shells of different radius, and the smaller, weaker patch stops fewer sites, so its shell is thinner. Between the marks and the walls, the marks make the shells legible as rings of large dots with the arriving sites inside; the walls show the same rings as belts of small cells. Which to keep depends on whether the drawing is about the sites or about the space between them, and the two can be plotted in two pens on one sheet, which is chapter 11's business.

## What it costs

`t.relax` does the first response, sites to weighted centres, in a kernel that never builds a diagram, and it is many times faster than a round of `voronoi` plus `measure` plus a move. The custom rule is not an improvement on it; it is the same observation with the cells and the measurements exposed, which is what made the second response possible. When the response is the standard one, use the standard operation. The label above is the cost of having a choice, and the shells are what the choice bought.

## On your own

Write a third response from the same measurements, and say what structure it makes that the first two cannot. Two that work: only sites of one kind, by an attribute you declare, move at all, so the light sorts a mixed population; or a site whose cell holds too little light is pulled toward a fixed point instead of its cell's centre, so the dark has a direction of its own. Each is a change to the decision, not to the observation or the edit.

<details>
<summary>A hint, and one possible answer</summary>

The decision is the line that computes `target`, and it can read anything the measurement holds. For the mixed population, declare `kind` on the sites as chapter 9 did and multiply the move by `p.kind`; the unmoved kind stays as a lattice and the moved kind gathers through it, which is a structure with two layers. For the dark's direction, `target` is a choice between two points: `mean < dim ? somewhere : weightedCentroid`, and `somewhere` is a fixed position, so the dark sites drain toward a corner while the lit ones gather, and the sheet divides into a place things go and a place they come from.

</details>

## Where to look things up

`measure`, `forFace` and the fields of a measurement are under *Faces and boundaries* on [Materials](#/materials); `t.voronoi`, `cellOf` and the standard refinements under *Point distributions*; `steps`, `move` and `set` under *Movement and growth*. Next, chapter 11: choosing a drawing worth plotting, and getting it onto paper.
