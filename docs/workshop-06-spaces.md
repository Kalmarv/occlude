# 6. Draw the spaces

**What can the spaces between lines become?** Lines that cross divide the sheet into regions, and once the material knows those regions they can be chosen, filled, measured and outlined as easily as the lines themselves. This is the drawing this chapter arrives at: a frame crossed by chords, most of them passing near one point so the cells crowd there and open out everywhere else; the small cells are hatched, darker the smaller, and the edge of the whole hatched cluster is drawn heavier. By the end you will be able to say what a crossing is and is not, read the areas a network encloses, choose some by a property, and outline the chosen ones as one shape.

```ts live
import { sketch, strokes, polygon, fill, mm, line, rect, append, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const chords = ui(18, { min: 4, max: 40, step: 1 });
  const limit = ui(90, { min: 10, max: 600, step: 10, label: 'area below' });
  const gap = ui(1.1, { min: 0.4, max: 3, step: 0.1, label: 'hatch (mm)' });
  const frame = t.material(rect(6, 6, 188, 88));
  const through = (x, y, angle) => t.sample(line(x - Math.cos(angle) * 300, y - Math.sin(angle) * 300, x + Math.cos(angle) * 300, y + Math.sin(angle) * 300), { count: 2 });
  const focus = [138, 58];
  const lines = t.times(chords, (k) => (k % 3 === 0
    ? through(t.rnd(6, 194), t.rnd(6, 94), t.rnd(Math.PI))
    : through(focus[0] + t.rnd(-26, 26), focus[1] + t.rnd(-18, 18), t.rnd(Math.PI))));
  const network = [frame, ...lines].reduce((a, b) => append(a, b));
  const cells = t.within(network.planarize().faces(), rect(6, 6, 188, 88));
  const chosen = cells.filter((f) => f.area < limit);
  const spacing = (f) => mm(gap * (0.4 + 0.6 * Math.sqrt(f.area / limit)));
  return [
    chosen.map((f) => polygon(f, { fill: fill('hatch', { angle: 45, spacing: spacing(f) }), stroke: false })),
    strokes(chosen.boundaryEdges, { pen: 'pigma-05-black' }),
    strokes(cells.edges, { pen: 'pigma-005-black' }),
  ];
});
```

Drag `area below` down to 10 and the drawing is a bare network; up to 600 and nearly everything is tone. The threshold is the drawing's decision, and it is one number.

## Same ink, different connections

A frame, its four corners kept by `t.material` as chapter 2 showed, and three chords that cross it and each other, sampled to two points each and put into one material with `append`. Left, as built: seven pieces of line laid over each other, crossing on paper and nowhere else. Right, the same material after `planarize()`: every place two connections cross has become a point they share, marked in blue, and the connections are split there. The ink is identical. The labels count the connections in each.

```ts live focus=8-9
import { sketch, strokes, circle, label, line, rect, append, group } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const chord = (x0, y0, x1, y1) => t.sample(line(x0, y0, x1, y1), { count: 2 });
  const network = [t.material(rect(10, 10, 80, 80)), chord(10, 34, 90, 62), chord(28, 10, 60, 90), chord(10, 74, 90, 26)]
    .reduce((a, b) => append(a, b));
  const planar = network.planarize();
  const junctions = planar.points.filter((p) => p.index >= network.n);
  return [
    strokes(network), label(`${network.edgeCount} connections`, 12, 6, 3.4),
    group({ translate: [100, 0] },
      strokes(planar), label(`${planar.edgeCount} connections`, 12, 6, 3.4),
      junctions.map((p) => circle(p.x, p.y, 1.6, { pen: 'stabilo-88-blue' })),
    ),
  ];
});
```

Before reading on: the right side has more connections than the left, and exactly as many as it needs. Where do the extra ones come from, and why are the chord ends on the frame not marked?

<details>
<summary>What to look for</summary>

Each crossing splits both connections that pass through it, so a chord crossed twice becomes three connections, and the frame's side is split where a chord meets it. The chord ends are not marked because they existed before: they lie on the frame's sides, and planarize makes them shared points of the frame as well, but the marks are only the points that are new. Open the right sketch in the studio and click a blue point in the Material layer: it has four connections, two from each line. That is the whole change. Nothing was drawn; something became connected.

Crossing is a fact about ink. Connection is a decision about the material, and `planarize` is that decision made for every crossing at once. Chapter 5 made it one crossing at a time, with `firstHit`, and chose to make some crossings joins and leave others as they were.

</details>

## Reveal the areas

`planar.faces()` reads the regions a connected network encloses: each one a face with an `area` and its own closed outline, which `polygon` takes as it is. Hatched at a different angle each, they show themselves. Two frames, each with one chord and one more line: on the left the second line reaches both sides; on the right it stops short of the frame by a few units. Count the faces on each side before you check the label.

```ts live focus=7-8
import { sketch, strokes, polygon, fill, mm, label, line, rect, append, group } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const chord = (x0, y0, x1, y1) => t.sample(line(x0, y0, x1, y1), { count: 2 });
  const build = (second) => [t.material(rect(10, 10, 80, 80)), chord(10, 50, 90, 50), second].reduce((a, b) => append(a, b));
  const reaching = build(chord(50, 10, 50, 90)).planarize().faces();
  const short = build(chord(50, 16, 50, 84)).planarize().faces();
  const show = (cells) => [
    cells.map((f, k) => polygon(f, { fill: fill('hatch', { angle: (k * 50) % 180, spacing: mm(1.2) }), stroke: false })),
    strokes(cells.source),
    label(`${cells.length} faces`, 12, 6, 3.4),
  ];
  return [show(reaching), group({ translate: [100, 0] }, show(short))];
});
```

<details>
<summary>What to look for</summary>

Four faces on the left, two on the right. The short line crosses the horizontal chord and is connected to it there, but its ends hang free inside the frame, so what look like two cells on each side of it are one region with a line lying in it: you can walk from one side to the other around the line's end. A face needs a closed walk, and a gap of a few units is as open as a gap of forty. This is not a fault to be corrected; a line inside a region is a thing drawings have. It is only that it does not divide.

</details>

## Choose by a property

A face collection filters like the point collections of chapter 3: `cells.filter((f) => f.area < limit)` is a selection of the faces below a threshold, and the threshold is live. The chosen faces are hatched; every wall is still drawn, lightly, so the unchosen cells stay visible.

```ts live focus=7-9
import { sketch, strokes, polygon, fill, mm, line, rect, append, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const limit = ui(120, { min: 10, max: 800, step: 10, label: 'area below' });
  const chord = (x0, y0, x1, y1) => t.sample(line(x0, y0, x1, y1), { count: 2 });
  const network = [t.material(rect(6, 6, 188, 88)), ...t.times(9, () => chord(t.rnd(6, 194), 6, t.rnd(6, 194), 94)), ...t.times(4, () => chord(6, t.rnd(6, 94), 194, t.rnd(6, 94)))].reduce((a, b) => append(a, b));
  const cells = network.planarize().faces();
  const chosen = cells.filter((f) => f.area < limit);
  const hatch = fill('hatch', { angle: 45, spacing: mm(1.2) });
  return [
    chosen.map((f) => polygon(f, { fill: hatch, stroke: false })),
    strokes(cells.edges, { pen: 'pigma-005-black' }),
  ];
});
```

Selecting and styling are two decisions. The hatch above is the same in every chosen cell; below, its spacing comes from the cell's area through a named function, so a small cell is dark and a cell near the threshold is barely toned. Change `spacing` and nothing about which cells are chosen changes.

```ts live focus=10-11
import { sketch, strokes, polygon, fill, mm, line, rect, append, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const limit = ui(120, { min: 10, max: 800, step: 10, label: 'area below' });
  const gap = ui(1.1, { min: 0.4, max: 3, step: 0.1, label: 'hatch (mm)' });
  const chord = (x0, y0, x1, y1) => t.sample(line(x0, y0, x1, y1), { count: 2 });
  const network = [t.material(rect(6, 6, 188, 88)), ...t.times(9, () => chord(t.rnd(6, 194), 6, t.rnd(6, 194), 94)), ...t.times(4, () => chord(6, t.rnd(6, 94), 194, t.rnd(6, 94)))].reduce((a, b) => append(a, b));
  const cells = network.planarize().faces();
  const chosen = cells.filter((f) => f.area < limit);
  const spacing = (f) => mm(gap * (0.4 + 0.6 * Math.sqrt(f.area / limit)));
  return [
    chosen.map((f) => polygon(f, { fill: fill('hatch', { angle: 45, spacing: spacing(f) }), stroke: false })),
    strokes(cells.edges, { pen: 'pigma-005-black' }),
  ];
});
```

## Outline the selection as a whole

A selection of faces has two sets of connections. `chosen.edges` is every connection any chosen face touches, the walls between two chosen cells included. `chosen.boundaryEdges` is the connections between the chosen union and everything else: walls between two chosen cells are left out, so it outlines the union as one shape. The same nine-cell grid, the same selection, all cells but the middle one; left `edges`, right `boundaryEdges`.

```ts live focus=8-10
import { sketch, strokes, polygon, fill, mm, line, rect, append, group } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const chord = (x0, y0, x1, y1) => t.sample(line(x0, y0, x1, y1), { count: 2 });
  const grid = [t.material(rect(10, 10, 80, 80)), chord(36, 10, 36, 90), chord(64, 10, 64, 90), chord(10, 36, 90, 36), chord(10, 64, 90, 64)].reduce((a, b) => append(a, b));
  const cells = grid.planarize().faces();
  const ring = cells.filter((f) => f.bounds.x !== 36 || f.bounds.y !== 36);
  const hatch = fill('hatch', { angle: 45, spacing: mm(1.4) });
  const shade = ring.map((f) => polygon(f, { fill: hatch, stroke: false }));
  return [
    shade, strokes(ring.edges, { pen: 'stabilo-88-blue' }),
    group({ translate: [100, 0] }, shade, strokes(ring.boundaryEdges, { pen: 'stabilo-88-blue' })),
  ];
});
```

The boundary on the right is two loops: the frame, and the middle cell's outline, which is a hole in the union. An outline is not a hull; it is every place the chosen and the unchosen meet, and a hole is such a place. `ring.boundaries()` gives the same loops as closed contours, for when the union should be filled as one area rather than outlined.

## Make a cellular print

The finished drawing. The frame is a rectangle's four corners. A chord is made by `through(x, y, angle)`: a line through a point at an angle, sampled to two points far beyond the frame, so that after planarizing it is cut wherever it crosses the frame or another chord. Two thirds of the chords pass through a patch around one point, `focus`; the rest are anywhere. The size of the patch decides whether the cluster is a burst of thin wedges or a cluster of small polygons; try `t.rnd(-6, 6)` in both and see the difference. The chords also cross each other outside the frame and enclose slivers there, so `t.within(cells, frame)` keeps only the faces that belong to it — a cell whose wall lies along the frame's edge is in, and one the frame cuts through is kept whole (`{ faces: 'centroid' }` asks for that last reading instead); the parts of the chords that border no kept cell are left out by `cells.edges`, which is why nothing has to be clipped.

The composition has three controls, and each is a different kind of decision: `chords` changes the construction, `area below` changes the selection, `hatch` changes only the drawing. The heavy pen on `chosen.boundaryEdges` is what makes the cluster read as one thing, and it goes down before the fine walls: the boundary walls are also walls, and a stroke laid where ink already is does not draw, so drawn second the heavy pen would be dropped and the outline would come out fine. Order is a rule of the page, from chapter 1, and here it decides which pen a shared line gets.

```ts live focus=8-15,18-21
import { sketch, strokes, polygon, fill, mm, line, rect, append, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const chords = ui(18, { min: 4, max: 40, step: 1 });
  const limit = ui(90, { min: 10, max: 600, step: 10, label: 'area below' });
  const gap = ui(1.1, { min: 0.4, max: 3, step: 0.1, label: 'hatch (mm)' });
  const frame = t.material(rect(6, 6, 188, 88));
  const through = (x, y, angle) => t.sample(line(x - Math.cos(angle) * 300, y - Math.sin(angle) * 300, x + Math.cos(angle) * 300, y + Math.sin(angle) * 300), { count: 2 });
  const focus = [138, 58];
  const lines = t.times(chords, (k) => (k % 3 === 0
    ? through(t.rnd(6, 194), t.rnd(6, 94), t.rnd(Math.PI))
    : through(focus[0] + t.rnd(-26, 26), focus[1] + t.rnd(-18, 18), t.rnd(Math.PI))));
  const network = [frame, ...lines].reduce((a, b) => append(a, b));
  const cells = t.within(network.planarize().faces(), rect(6, 6, 188, 88));
  const chosen = cells.filter((f) => f.area < limit);
  const spacing = (f) => mm(gap * (0.4 + 0.6 * Math.sqrt(f.area / limit)));
  return [
    chosen.map((f) => polygon(f, { fill: fill('hatch', { angle: 45, spacing: spacing(f) }), stroke: false })),
    strokes(chosen.boundaryEdges, { pen: 'pigma-05-black' }),
    strokes(cells.edges, { pen: 'pigma-005-black' }),
  ];
});
```

Three readings of one network, with the same selection. All the walls, as a line drawing: the tone is wherever the lines crowd, which is the cluster, so the subject is there without any selection at all. The boundary of the chosen cells alone: an outline around the cluster with the network gone, the decision with nothing else on the page. And the chosen cells filled with the walls faint, which is the print above. Look at where your eye settles in each and how long it stays: in the first it finds the cluster and then reads the lines; in the second it has only the outline to hold; in the third it has the cluster, a texture inside it and quiet around it. Any of the three could be the print. What differs is how much the drawing decides for you and how much it leaves to the lines.

```ts live focus=18-20
import { sketch, strokes, polygon, fill, mm, line, rect, append, group } from 'occlude';

export default sketch({ aspect: [3, 1], seed: 11 }, (t) => {
  const frame = t.material(rect(4, 4, 92, 92));
  const through = (x, y, angle) => t.sample(line(x - Math.cos(angle) * 300, y - Math.sin(angle) * 300, x + Math.cos(angle) * 300, y + Math.sin(angle) * 300), { count: 2 });
  const focus = [68, 58];
  const lines = t.times(18, (k) => (k % 3 === 0
    ? through(t.rnd(4, 96), t.rnd(4, 96), t.rnd(Math.PI))
    : through(focus[0] + t.rnd(-20, 20), focus[1] + t.rnd(-20, 20), t.rnd(Math.PI))));
  const network = [frame, ...lines].reduce((a, b) => append(a, b));
  const cells = t.within(network.planarize().faces(), rect(4, 4, 92, 92));
  const chosen = cells.filter((f) => f.area < 60);
  const spacing = (f) => mm(1.1 * (0.4 + 0.6 * Math.sqrt(f.area / 60)));
  const shade = chosen.map((f) => polygon(f, { fill: fill('hatch', { angle: 45, spacing: spacing(f) }), stroke: false }));
  return [
    strokes(cells.edges),
    group({ translate: [100, 0] }, strokes(chosen.boundaryEdges, { pen: 'pigma-05-black' })),
    group({ translate: [200, 0] }, shade, strokes(chosen.boundaryEdges, { pen: 'pigma-05-black' }), strokes(cells.edges, { pen: 'pigma-005-black' })),
  ];
});
```

## On your own

Make a bright passage through a dense drawing: raise the chord count until the cells are small everywhere, then choose which cells stay blank so that an unhatched path runs from one edge of the frame to the other, connected all the way. Area alone will not do it; the cells on the passage are as small as their neighbours. Two of this page's ideas and one of chapter 3's are enough.

<details>
<summary>A hint, not the answer</summary>

A face has a `bounds` and `contours`, so it has a position; a filter can ask where a cell is as well as how big it is. Distance from a line you choose, `Math.abs(…)` of something, keeps a band of cells blank. Then look at `chosen.boundaryEdges` for the passage: if the outline of the hatched cells has two separate loops, the passage is connected; if it is one loop, somewhere a hatched cell bridges it, and the band is too narrow there.

</details>

## Where to look things up

`planarize`, `faces`, face selections, `edges`, `boundaryEdges` and `boundaries()` are under *Faces and boundaries* on [Materials](#/materials); `append` under *Making a material*. Next, chapter 7 starts from something with no lines at all: a function that gives a number at every point.
