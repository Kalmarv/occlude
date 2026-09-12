# 10. Let a drawing respond

**How can measurements become my own rule?** The standard operations of chapter 8 read a field and move points by rules that are theirs. A sketch can do the same thing with a rule that is yours: measure the regions its points own, decide what each point should do about what it finds, move it, and go round again. This is the drawing this chapter arrives at: sites drawn toward two patches of light and stopping, each for good, where its cell became bright enough, with the step each one stopped at recorded on it and drawn as the size of its ring; drawn once as walls and once as the sites with their record. By the end you will be able to point at the observation, the decision and the edit in code of your own, and know what each costs.

```ts live
import { sketch, strokes, circle, label, distance, sub, mul, group, rect, within, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const iterations = ui(16, { min: 0, max: 24, step: 1 });
  const bright = ui(0.12, { min: 0.02, max: 0.9, step: 0.02, label: 'bright enough to stop' });
  const half = { x: 0, y: 0, w: 100, h: 100 };
  const glow = (x, y) => Math.min(1, Math.max(0, 1 - distance([x, y], [30, 42]) / 30) + Math.max(0, 1 - distance([x, y], [72, 64]) / 22) * 0.9);
  const light = (x, y) => 0.005 + Math.pow(glow(x, y), 3);
  const sites = t.relax(t.scatter(within(() => 1, rect(0, 0, 100, 100)), { spacing: 7 }), { iterations: 2, bounds: half }).attribute('mobility', 1).attribute('stopped', -1);
  const started = Date.now();
  const settled = sites.steps(iterations, (current, next, k) => {
    const diagram = t.voronoi(current, { bounds: half });
    const measured = diagram.faces().measure(light, { resolution: 128 });
    next.move(current.points, (p) => { const cell = diagram.cellOf(p); const target = cell ? measured.forFace(cell).weightedCentroid : null; return target ? mul(sub(target, p), 0.8 * p.mobility) : [0, 0]; });
    next.set(current.points.filter((p) => { const cell = diagram.cellOf(p); return p.mobility === 1 && cell !== undefined && measured.forFace(cell).mean > bright; }), () => ({ mobility: 0, stopped: k }));
  });
  const took = Date.now() - started;
  const still = settled.points.filter((p) => p.stopped >= 0);
  return [
    strokes(t.voronoi(settled, { bounds: half })),
    group({ translate: [100, 0] }, settled.points.map((p) => circle(p.x, p.y, 0.5)), still.map((p) => circle(p.x, p.y, 1 + 0.25 * p.stopped, { pen: 'stabilo-88-blue' }))),
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
    next.move(current.points, (p) => {
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

The same rule for several steps, and each step's diagram is built from the sites the last step moved: the cells crowd toward the light, and their walls shorten there. How far a site moves each step is a fraction of the distance from the site itself to its cell's weighted centre. That distance depends on how much the light changes across the cell: for a site already at the centre of a small cell under an even light it is nearly nothing, and for a cell that straddles the edge of a bright patch it is a good fraction of the cell. With `move fraction` at 0.8 and a light with a hard edge, a dozen rounds is enough to see.

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
    next.move(current.points, (p) => {
      const cell = diagram.cellOf(p);
      const target = cell ? measured.forFace(cell).weightedCentroid : null;
      return target ? mul(sub(target, p), amount) : [0, 0];
    });
  });
  return [strokes(t.voronoi(gathered)), gathered.points.map((p) => circle(p.x, p.y, 0.7))];
});
```

That is one response to the measurement: go where the light is in your cell. It is the standard one, the thing `t.relax` does with a density, and it produces one kind of structure: cells that shrink toward the light and stretch away from it, smoothly, everywhere at once.

**The same observation, a different decision.** Keep every line of the observation and change only what a site does with it. Second response: a site whose cell is bright enough stops, for good. It needs to remember that it stopped, so the sites carry a `mobility` attribute, 1 to start, and the rule sets it to 0 when the cell's `mean` crosses `bright`; the move is scaled by `mobility`, so a stopped site stays put while the others keep coming. The rule also writes `stopped`, the step number at which it happened, which is only a record and changes nothing about the motion. One thing to read carefully: within a step, `next.move` reads `p.mobility` as it is in `current`, and `next.set` changes it for the next state, so a site that qualifies this step makes one last move and is still from the step after. The observation is identical: the diagram, the measurement, the same `mean` and `weightedCentroid` for every cell. Left, the first response; right, the second, from the same sites, drawn with the same marks so that only the positions differ.

```ts live focus=17-22
import { sketch, strokes, circle, distance, sub, mul, group, rect, within, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const iterations = ui(12, { min: 0, max: 20, step: 1 });
  const bright = ui(0.35, { min: 0.05, max: 0.9, step: 0.05, label: 'bright enough to stop' });
  const half = { x: 0, y: 0, w: 100, h: 100 };
  const light = (x, y) => 0.005 + Math.pow(Math.max(0, 1 - distance([x, y], [50, 50]) / 34), 4);
  const sites = t.relax(t.scatter(within(() => 1, rect(0, 0, 100, 100)), { spacing: 8 }), { iterations: 2, bounds: half }).attribute('mobility', 1).attribute('stopped', -1);
  const respond = (stopping) => sites.steps(iterations, (current, next, k) => {
    const diagram = t.voronoi(current, { bounds: half });
    const measured = diagram.faces().measure(light, { resolution: 128 });
    next.move(current.points, (p) => {
      const cell = diagram.cellOf(p);
      const target = cell ? measured.forFace(cell).weightedCentroid : null;
      return target ? mul(sub(target, p), 0.8 * p.mobility) : [0, 0];
    });
    if (stopping) next.set(current.points.filter((p) => { const cell = diagram.cellOf(p); return p.mobility === 1 && cell !== undefined && measured.forFace(cell).mean > bright; }), () => ({ mobility: 0, stopped: k }));
  });
  const gathered = respond(false);
  const stopped = respond(true);
  const marks = (m) => m.points.map((p) => circle(p.x, p.y, 0.6));
  return [strokes(t.voronoi(gathered, { bounds: half })), marks(gathered), group({ translate: [100, 0] }, strokes(t.voronoi(stopped, { bounds: half })), marks(stopped))];
});
```

With the same marks the difference is in the positions alone, and it is modest: the right side's middle stays a little more open than the left's, because the sites that arrived there first stopped instead of packing further. Whether that difference is worth a rule depends on what the drawing is for; the point here is only that it comes from the decision and nothing else. Now the record. The same stopped result, with the sites that stopped drawn as rings whose size is the step they stopped at, small for early, large for late, so the order of arrival is visible rather than inferred.

```ts live focus=15-17
import { sketch, strokes, circle, distance, sub, mul, rect, within, ui } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 4 }, (t) => {
  const iterations = ui(12, { min: 0, max: 20, step: 1 });
  const bright = ui(0.2, { min: 0.05, max: 0.9, step: 0.05, label: 'bright enough to stop' });
  const light = (x, y) => 0.005 + Math.pow(Math.max(0, 1 - distance([x, y], [50, 50]) / 34), 4);
  const sites = t.relax(t.scatter({ spacing: 8 }), { iterations: 2 }).attribute('mobility', 1).attribute('stopped', -1);
  const stopped = sites.steps(iterations, (current, next, k) => {
    const diagram = t.voronoi(current);
    const measured = diagram.faces().measure(light, { resolution: 128 });
    next.move(current.points, (p) => { const cell = diagram.cellOf(p); const target = cell ? measured.forFace(cell).weightedCentroid : null; return target ? mul(sub(target, p), 0.8 * p.mobility) : [0, 0]; });
    next.set(current.points.filter((p) => { const cell = diagram.cellOf(p); return p.mobility === 1 && cell !== undefined && measured.forFace(cell).mean > bright; }), () => ({ mobility: 0, stopped: k }));
  });
  const still = stopped.points.filter((p) => p.stopped >= 0);
  return [
    strokes(t.voronoi(stopped), { pen: 'pigma-005-black' }),
    stopped.points.map((p) => circle(p.x, p.y, 0.5)),
    still.map((p) => circle(p.x, p.y, 1 + 0.35 * p.stopped, { pen: 'stabilo-88-blue' })),
  ];
});
```

At this seed and threshold nine sites stop. Most of the rings are small: those sites were in the light from the start and stopped at the first or second step. The one or two large rings are sites that began outside the bright patch, moved inward for several steps, and crossed the threshold late; they sit at the edge of the group, where they arrived. That is the whole record, and it is modest: a handful of early stops and a few late ones, not a shell. Set `bright enough to stop` high and only the innermost sites ever stop, all early, all small; set it low and more of the field qualifies at once, so more rings, still mostly small. The record is the evidence for the explanation: the positions alone showed a slightly more open middle, and the rings say which sites stopped when.

Before reading on: the stopping rule needed an attribute to remember with. Does the first response, which remembers nothing, have no history?

<details>
<summary>What to look for</summary>

It has plenty. Its positions are its memory: each step's diagram is built from where the last step left the sites, so the arrangement after twelve rounds depends on the whole sequence, and a different starting scatter under the same light gives a different final arrangement. What the attribute adds is not memory but a record that the drawing can read: the step a site stopped, kept as a number on the row, is something the geometry alone does not say. A rule can make structure out of its own history either way; only the second kind can show its history afterwards.

</details>

## Compose

The second response, on a modest population with two patches of light, drawn twice from the same final sites: as walls, where the light shows as two groups of smaller cells; and as marks of one size with the stopped sites ringed and the rings sized by the step they stopped at, as above. The label reports what the rule cost.

```ts live focus=8-16
import { sketch, strokes, circle, label, distance, sub, mul, group, rect, within, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const iterations = ui(16, { min: 0, max: 24, step: 1 });
  const bright = ui(0.12, { min: 0.02, max: 0.9, step: 0.02, label: 'bright enough to stop' });
  const half = { x: 0, y: 0, w: 100, h: 100 };
  const glow = (x, y) => Math.min(1, Math.max(0, 1 - distance([x, y], [30, 42]) / 30) + Math.max(0, 1 - distance([x, y], [72, 64]) / 22) * 0.9);
  const light = (x, y) => 0.005 + Math.pow(glow(x, y), 3);
  const sites = t.relax(t.scatter(within(() => 1, rect(0, 0, 100, 100)), { spacing: 7 }), { iterations: 2, bounds: half }).attribute('mobility', 1).attribute('stopped', -1);
  const started = Date.now();
  const settled = sites.steps(iterations, (current, next, k) => {
    const diagram = t.voronoi(current, { bounds: half });
    const measured = diagram.faces().measure(light, { resolution: 128 });
    next.move(current.points, (p) => { const cell = diagram.cellOf(p); const target = cell ? measured.forFace(cell).weightedCentroid : null; return target ? mul(sub(target, p), 0.8 * p.mobility) : [0, 0]; });
    next.set(current.points.filter((p) => { const cell = diagram.cellOf(p); return p.mobility === 1 && cell !== undefined && measured.forFace(cell).mean > bright; }), () => ({ mobility: 0, stopped: k }));
  });
  const took = Date.now() - started;
  const still = settled.points.filter((p) => p.stopped >= 0);
  return [
    strokes(t.voronoi(settled, { bounds: half })),
    group({ translate: [100, 0] }, settled.points.map((p) => circle(p.x, p.y, 0.5)), still.map((p) => circle(p.x, p.y, 1 + 0.25 * p.stopped, { pen: 'stabilo-88-blue' }))),
    label(`${iterations} rounds, ${sites.n} sites, ${took} ms`, 104, 97, 2.6),
  ];
});
```

Both patches stop the sites nearest them early, so both groups are mostly small rings. The stronger, larger patch also gathers a few late arrivals from further out, the two large rings at its edge; the weaker patch is small enough that nothing beyond its edge ever qualifies, so it has none. Between the walls and the marks, the marks with the record show the arrival; the walls show the same sites as cells that stopped shrinking. Which to keep depends on whether the drawing is about the sites or about the space between them, and the two can be plotted in two pens on one sheet, which is chapter 11's business.

## What it costs

`t.relax` does the first response, sites to weighted centres, in a kernel that never builds a diagram, and it is many times faster than a round of `voronoi` plus `measure` plus a move. The custom rule is not an improvement on it; it is the same observation with the cells and the measurements exposed, which is what made the second response possible. When the response is the standard one, use the standard operation. The label above is the cost of having a choice, and the record of arrival is what the choice bought.

## On your own

Write a third response from the same measurements, and say what structure it makes that the first two cannot. Two that work: only sites of one kind, by an attribute you declare, move at all, so the light sorts a mixed population; or a site whose cell holds too little light is pulled toward a fixed point instead of its cell's centre, so the dark has a direction of its own. Each is a change to the decision, not to the observation or the edit.

<details>
<summary>A hint, and one possible answer</summary>

The decision is the line that computes `target`, and it can read anything the measurement holds. For the mixed population, declare `kind` on the sites as chapter 9 did and multiply the move by `p.kind`; the unmoved kind stays as a lattice and the moved kind gathers through it, which is a structure with two layers. For the dark's direction, `target` is a choice between two points: `mean < dim ? somewhere : weightedCentroid`, and `somewhere` is a fixed position, so the dark sites drain toward a corner while the lit ones gather, and the sheet divides into a place things go and a place they come from.

</details>

## Where to look things up

`measure`, `forFace` and the fields of a measurement are under *Faces and boundaries* on [Materials](#/materials); `t.voronoi`, `cellOf` and the standard refinements under *Point distributions*; `steps`, `move` and `set` under *Movement and growth*. Next, chapter 11: choosing a drawing worth plotting, and getting it onto paper.
