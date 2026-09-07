# 9. Turn points into territory

**How can a point arrangement become editable areas?** Every point claims the ground nearer to it than to any other point, and the claims meet along shared walls. Those walls are ordinary material: they can be selected, measured, stroked and, when two neighbours are alike, removed, so that a scatter of points becomes a map of regions. This is the drawing this chapter arrives at: a map with a town of small cells in open country, the town's edge found by the contrast between small cells and large, the fences of the country removed, and the country hatched lightly as one area. By the end you will be able to go from a point to its cell, from a cell to its site, from a wall to the two cells beside it, and decide which walls a map keeps.

```ts live
import { sketch, strokes, polygon, fill, mm, distance, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 12 }, (t) => {
  const centre = [ui(74, { min: 20, max: 180, step: 1, label: 'town x' }), 52];
  const edge = ui(6, { min: 1, max: 12, step: 0.5, label: 'edge sharpness' });
  const ratio = ui(2.6, { min: 1.2, max: 5, step: 0.1, label: 'area ratio' });
  const field = ui(90, { min: 20, max: 300, step: 5, label: 'countryside above area' });
  const density = (x, y) => 0.08 + 0.92 * Math.max(0, 1 - Math.pow(distance([x, y], centre) / 34, edge));
  const sites = t.relax(t.scatter(density, { spacing: 5 }), { iterations: 2, density });
  const diagram = t.voronoi(sites);
  const cells = diagram.faces();
  const contrast = (faces, e) => { const [a, b] = faces.facesOf(e); return b !== undefined ? Math.max(a.area, b.area) / Math.min(a.area, b.area) : 0; };
  const withOpen = diagram.edgeAttribute('open', (e) => { const [a, b] = cells.facesOf(e); return b !== undefined && a.area > field && b.area > field ? 1 : 0; });
  const marked = withOpen.edgeAttribute('border', (e) => (contrast(withOpen.faces(), e) > ratio ? 1 : 0));
  const cleared = marked.steps(1, (current, next) => next.disconnect((e) => e.attrs.open === 1));
  const country = cleared.faces().filter((f) => f.area > field);
  return [
    country.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: 20, spacing: mm(4.2) }), stroke: false })),
    strokes(cleared.edges.filter((e) => e.attrs.border === 1), { pen: 'pigma-05-black' }),
    strokes(cleared, { pen: 'pigma-005-black' }),
  ];
});
```

## Give each site a territory

Seven points, placed by hand, drawn large. `t.voronoi(sites)` builds the walls between their territories: every position on the sheet belongs to the nearest site, and a wall is where two sites are equally near. The walls are clipped to the drawable, so the outer cells end at the sheet's edge. What comes back is material, corners and walls, and `faces()` reads the cells the way chapter 6 read the cells of a network. Drag the control: one site moves, and every wall it shares moves with it, while the walls between other sites stay.

```ts live focus=4-6
import { sketch, strokes, circle, material, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const x = ui(96, { min: 20, max: 180, step: 1, label: 'fourth site x' });
  const sites = material([[40, 30], [150, 26], [70, 72], [x, 50], [170, 74], [120, 86], [24, 90]]);
  const diagram = t.voronoi(sites);
  return [strokes(diagram), sites.points.map((p) => circle(p.x, p.y, 1.8))];
});
```

Before dragging: which walls will change when the fourth site moves, and which cannot? A wall exists between two sites that are neighbours; move one of them and only its own walls, and the walls of the neighbours it gains or loses, are redrawn. The rest of the map does not know it happened.

## Follow the correspondence

The diagram remembers which site made which cell. `diagram.cellOf(site)` gives the face of a site's territory, and `diagram.siteOf(face)` the site of a face; both take views of the exact materials involved, the site material and the diagram's faces. Here the third site's cell is hatched through `cellOf`, and every cell is labelled with its site's row through `siteOf`, which is how a category on the sites becomes a drawing of the cells: `kind` is an attribute on the sites, and the hatch reads it through the correspondence.

```ts live focus=8-10
import { sketch, strokes, circle, polygon, fill, mm, label, material } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const sites = material([[40, 30], [150, 26], [70, 72], [96, 50], [170, 74], [120, 86], [24, 90]])
    .attribute('kind', (p) => (p.x < 100 ? 0 : 1));
  const diagram = t.voronoi(sites);
  const cells = diagram.faces();
  const third = diagram.cellOf(sites.points.at(2));
  const eastern = cells.filter((f) => diagram.siteOf(f).kind === 1);
  return [
    polygon(third.contours, { fill: fill('hatch', { angle: 45, spacing: mm(1.2) }), stroke: false }),
    eastern.map((f) => polygon(f.contours, { fill: fill('hatch', { angle: 135, spacing: mm(2.4) }), stroke: false })),
    strokes(diagram),
    sites.points.map((p) => circle(p.x, p.y, 1.8)),
    cells.map((f) => label(String(diagram.siteOf(f).index), f.bounds.x + 3, f.bounds.y + 3, 3)),
  ];
});
```

The correspondence belongs to this diagram, frozen as it was built. Edit the diagram, by moving a corner or removing a wall, and the result is new material that knows nothing of sites; ask it `siteOf` and it says so. That is not a limitation to work around but the same rule chapter 3 gave for selections: a relationship is a fact about one state.

## Ask what is on either side

A wall separates two cells, and `cells.facesOf(wall)` says which two. A wall along the sheet's edge has one cell beside it, and `facesOf` returns one face. Choose a wall by its row with the control; its two cells are hatched, and the label says how many it has.

```ts live focus=6-7
import { sketch, strokes, circle, polygon, fill, mm, label, material, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const wall = ui(6, { min: 0, max: 30, step: 1, label: 'wall row' });
  const sites = material([[40, 30], [150, 26], [70, 72], [96, 50], [170, 74], [120, 86], [24, 90]]);
  const diagram = t.voronoi(sites);
  const cells = diagram.faces();
  const chosen = diagram.edge(Math.min(wall, diagram.edgeCount - 1));
  const beside = cells.facesOf(chosen);
  return [
    beside.map((f) => polygon(f.contours, { fill: fill('hatch', { angle: 45, spacing: mm(1.4) }), stroke: false })),
    strokes(diagram, { pen: 'pigma-005-black' }),
    strokes(diagram.edges.filter((e) => e.index === chosen.index), { pen: 'stabilo-88-blue' }),
    sites.points.map((p) => circle(p.x, p.y, 1.8)),
    label(`${beside.length} beside this wall`, 4, 6, 3.4),
  ];
});
```

This is a relationship of any planar network, not a Voronoi convenience: chapter 6's chords have it too. With `siteOf` on each side, a wall can be asked whether the two territories it separates are alike.

## Remove a wall on purpose

Two neighbouring sites of the same kind are one region; the wall between them is a wall the map does not need. Removing it is an edit, and an edit happens in `steps`, on a copy of the diagram that has no correspondence, so the decision is made first, on the diagram that has it, and written onto the walls as an edge attribute: `same` is 1 where both cells beside a wall have the same kind. The rule then reads only that number. After the edit, `faces()` is asked again, and the merged regions are the faces of the new material.

```ts live focus=8-11
import { sketch, strokes, circle, polygon, fill, mm, material, group } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const sites = material([[20, 30], [70, 26], [35, 72], [56, 50], [85, 74], [60, 90], [14, 90], [88, 12]])
    .attribute('kind', (p) => (p.x + p.y < 110 ? 0 : 1));
  const diagram = t.voronoi(sites, { bounds: { x: 0, y: 0, w: 100, h: 100 } });
  const cells = diagram.faces();
  const kind = (face) => diagram.siteOf(face).kind;
  const marked = diagram.edgeAttribute('same', (e) => { const [a, b] = cells.facesOf(e); return b !== undefined && kind(a) === kind(b) ? 1 : 0; });
  const merged = marked.steps(1, (current, next) => next.disconnect((e) => e.attrs.same === 1));
  const regions = merged.faces();
  return [
    strokes(diagram), sites.points.map((p) => circle(p.x, p.y, 1.6, { pen: p.kind ? 'stabilo-88-blue' : 'pigma-05-black' })),
    group({ translate: [100, 0] }, regions.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: f.index ? 135 : 45, spacing: mm(1.4) }), stroke: false })), strokes(merged)),
  ];
});
```

Left, the diagram with its sites coloured by kind. Right, the walls between like neighbours gone, and the two regions that remain hatched from the new faces. The corners the removed walls met at are still points of the material, with two walls or none; they change nothing about the regions and are left alone. Before reading on: `merged` has two faces where `diagram` had eight. Which of the two materials can answer `siteOf`, and what would you do if you needed a region's kind?

<details>
<summary>What to look for</summary>

Only `diagram` can. `merged` is new material, and its faces are new faces that no site made. If a region's kind is needed after the edit, it has to be derived again from something that is still true: the sites are still where they were, and a region contains them, so the kind of the sites inside it is the honest answer, decided by a rule you write. For a drawing, though, the merging is often not needed at all, as the next section shows.

</details>

## Develop a map

**Every cell alike.** Sites from a relaxed, even scatter make cells that are all about the same size, and the drawing is a tiling: pleasant, and nowhere in particular. Nothing on it is a place. This is where a map starts, and the first decision is where the places are.

```ts live focus=4-5
import { sketch, strokes } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 12 }, (t) => {
  const sites = t.relax(t.scatter({ spacing: 9 }), { iterations: 2 });
  return strokes(t.voronoi(sites));
});
```

**Large and small territories.** Chapter 8's scatter takes a density, and a density that is high in one region and low elsewhere makes sites that crowd there and thin out away from it. The cells follow: small where the sites are dense, large where they are sparse. Now the map has a town and a countryside, and the eye goes to the town. `town x` and `town y` are where it is; `edge sharpness` is the shape of its density, from a gentle hill at 1 to a plateau with a cliff at 12.

```ts live focus=4-7
import { sketch, strokes, distance, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 12 }, (t) => {
  const centre = [ui(74, { min: 20, max: 180, step: 1, label: 'town x' }), ui(52, { min: 15, max: 85, step: 1, label: 'town y' })];
  const edge = ui(6, { min: 1, max: 12, step: 0.5, label: 'edge sharpness' });
  const density = (x, y) => 0.08 + 0.92 * Math.max(0, 1 - Math.pow(distance([x, y], centre) / 34, edge));
  const sites = t.relax(t.scatter(density, { spacing: 5 }), { iterations: 2, density });
  return strokes(t.voronoi(sites));
});
```

Slide `edge sharpness` down to 1 and the town fades into the country with no edge anywhere; up to 12 and it ends at a line. Neither is the map yet, but the next decision depends on it, and it is worth knowing which you want before drawing any borders.

**Which borders matter.** Every wall is drawn the same above, so the town's edge is only a change of texture. A border is a wall the drawing chooses to emphasise, and the choice here is not a category but a fact about the two cells beside the wall: where a small cell meets a large one, the town meets the country. `facesOf` gives both cells; the ratio of their areas is the test, and `ratio` is the control. The chosen walls go in the heavy pen, drawn before the fine walls, because a stroke on a line that already has ink is dropped: heavy first, or the border comes out fine.

```ts live focus=9-12
import { sketch, strokes, distance, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 12 }, (t) => {
  const ratio = ui(2.6, { min: 1.2, max: 5, step: 0.1, label: 'area ratio' });
  const centre = [74, 52];
  const density = (x, y) => 0.08 + 0.92 * Math.max(0, 1 - Math.pow(distance([x, y], centre) / 34, 6));
  const sites = t.relax(t.scatter(density, { spacing: 5 }), { iterations: 2, density });
  const diagram = t.voronoi(sites);
  const cells = diagram.faces();
  const contrast = (e) => { const [a, b] = cells.facesOf(e); return b !== undefined ? Math.max(a.area, b.area) / Math.min(a.area, b.area) : 0; };
  const border = cells.edges.filter((e) => contrast(e) > ratio);
  return [strokes(border, { pen: 'pigma-05-black' }), strokes(cells.edges, { pen: 'pigma-005-black' })];
});
```

At a ratio of 1.2 nearly every wall is a border and the emphasis means nothing; at 5 only a handful of walls qualify and the town's edge is broken. Somewhere between, the heavy walls join up into an edge around the town with a few outliers, and that is the ratio to keep. Move it until the outline closes, then a little further, and watch where it breaks.

Now go back to the previous sketch and set `edge sharpness` to 1, then imagine this rule on that town. With a gentle hill of density, neighbouring cells differ by a fifth or so in area and no wall anywhere passes a ratio of 2; the rule finds nothing, and it is right to find nothing. A border by contrast needs an edge to exist. The decision about the town's shape and the decision about its border were one decision.

**Remove what is not needed.** The countryside is still drawn as cells, and its walls say nothing: two large cells side by side are two fields, and the drawing does not need the fence between them. The walls between two large cells go, by the same route as before: decided on the diagram as an edge attribute, removed in one edit. `countryside above area` is the area above which a cell counts as country. What remains is the town, the ring of walls where small cells meet large, and the sheet's edge.

```ts live focus=9-11
import { sketch, strokes, distance, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 12 }, (t) => {
  const field = ui(90, { min: 20, max: 300, step: 5, label: 'countryside above area' });
  const centre = [74, 52];
  const density = (x, y) => 0.08 + 0.92 * Math.max(0, 1 - Math.pow(distance([x, y], centre) / 34, 6));
  const sites = t.relax(t.scatter(density, { spacing: 5 }), { iterations: 2, density });
  const diagram = t.voronoi(sites);
  const cells = diagram.faces();
  const open = diagram.edgeAttribute('open', (e) => { const [a, b] = cells.facesOf(e); return b !== undefined && a.area > field && b.area > field ? 1 : 0; });
  const cleared = open.steps(1, (current, next) => next.disconnect((e) => e.attrs.open === 1));
  return strokes(cleared);
});
```

Drag `countryside above area` down and the clearing eats into the town; up past the largest cell and every fence returns. In between, the country is one open region, the town keeps every wall, and the edge between them is the last ring of small cells against the open ground: the edge the border found above, drawn now by absence instead of by a heavy pen. Clearing by a rule about *both* cells is what keeps the ring: a wall with a small cell on either side is never cleared.

**Keep the cells or change them, and say why.** Two drawings can look the same and be different materials. The border version keeps every cell: nothing was removed, the emphasis is a selection, and `diagram` can still say which site owns which cell, so the town's cells could be hatched by their sites' attributes or measured by chapter 10's rule. The cleared version changed the network: the open regions are faces of a new material with no sites, and they can be filled as areas, which the border version cannot do for a region that is many cells. Keep the cells when the drawing will go on asking about sites; change them when it needs the regions themselves. Below, both: left the border version with the town's cells hatched by distance from the centre; right the cleared version with the open country hatched lightly as one area, which only a cleared network can do.

```ts live focus=10-13
import { sketch, strokes, polygon, fill, mm, distance, group, rect, within } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 12 }, (t) => {
  const make = (x0) => {
    const centre = [x0 + 44, 52];
    const density = within((x, y) => 0.08 + 0.92 * Math.max(0, 1 - Math.pow(distance([x, y], centre) / 30, 6)), rect(x0, 0, 98, 100));
    const sites = t.relax(t.scatter(density, { spacing: 5 }), { iterations: 2, density, bounds: { x: x0, y: 0, w: 98, h: 100 } });
    const diagram = t.voronoi(sites, { bounds: { x: x0, y: 0, w: 98, h: 100 } });
    const cells = diagram.faces();
    return { centre, diagram, cells };
  };
  const left = make(0);
  const town = left.cells.filter((f) => f.area < 90);
  const right = make(102);
  const open = right.diagram.edgeAttribute('open', (e) => { const [a, b] = right.cells.facesOf(e); return b !== undefined && a.area > 90 && b.area > 90 ? 1 : 0; });
  const cleared = open.steps(1, (current, next) => next.disconnect((e) => e.attrs.open === 1));
  const country = cleared.faces().filter((f) => f.area > 90);
  return [
    town.map((f) => polygon(f.contours, { fill: fill('hatch', { angle: 45, spacing: mm(0.7 + 0.02 * distance([f.bounds.x, f.bounds.y], left.centre)) }), stroke: false })),
    strokes(town.boundaryEdges, { pen: 'pigma-05-black' }), strokes(left.cells.edges, { pen: 'pigma-005-black' }),
    country.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: 20, spacing: mm(4.2) }), stroke: false })),
    strokes(cleared, { pen: 'pigma-005-black' }),
  ];
});
```

**The map.** The decisions in order: a town placed and given an edge, that edge found by the contrast of small cells against large, the fences cleared from the countryside so it is one open area, that area hatched lightly, the town's walls left fine and its edge heavy. This is the drawing from the top of the page. Every control is one of those decisions; the seed is not one of them, and a different seed gives a different town of the same kind.

```ts live focus=8-14
import { sketch, strokes, polygon, fill, mm, distance, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 12 }, (t) => {
  const centre = [ui(74, { min: 20, max: 180, step: 1, label: 'town x' }), 52];
  const edge = ui(6, { min: 1, max: 12, step: 0.5, label: 'edge sharpness' });
  const ratio = ui(2.6, { min: 1.2, max: 5, step: 0.1, label: 'area ratio' });
  const field = ui(90, { min: 20, max: 300, step: 5, label: 'countryside above area' });
  const density = (x, y) => 0.08 + 0.92 * Math.max(0, 1 - Math.pow(distance([x, y], centre) / 34, edge));
  const sites = t.relax(t.scatter(density, { spacing: 5 }), { iterations: 2, density });
  const diagram = t.voronoi(sites);
  const cells = diagram.faces();
  const contrast = (faces, e) => { const [a, b] = faces.facesOf(e); return b !== undefined ? Math.max(a.area, b.area) / Math.min(a.area, b.area) : 0; };
  const withOpen = diagram.edgeAttribute('open', (e) => { const [a, b] = cells.facesOf(e); return b !== undefined && a.area > field && b.area > field ? 1 : 0; });
  const marked = withOpen.edgeAttribute('border', (e) => (contrast(withOpen.faces(), e) > ratio ? 1 : 0));
  const cleared = marked.steps(1, (current, next) => next.disconnect((e) => e.attrs.open === 1));
  const country = cleared.faces().filter((f) => f.area > field);
  return [
    country.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: 20, spacing: mm(4.2) }), stroke: false })),
    strokes(cleared.edges.filter((e) => e.attrs.border === 1), { pen: 'pigma-05-black' }),
    strokes(cleared, { pen: 'pigma-005-black' }),
  ];
});
```

Each attribute is written on a material and read through that material's own faces: `open` on the diagram, `border` on the material that already carries `open`, because an edge view belongs to the state it was taken from and the faces have to be asked of that state. Both attributes then ride through the clearing, so the heavy walls are still the ones the ratio chose, on the material that no longer has the fences. That is the reason to write a decision down as data before an edit: it survives the edit, and the edit does not have to know about it.

## On your own

Make a map with two towns and a road. The towns are two centres of density; the road is a border you choose, a chain of walls that runs from one town to the other, and it needs a rule of its own for which walls it is made of. Then decide whether the map keeps its cells or clears them, and say why.

<details>
<summary>A hint, not the answer</summary>

Two densities add: `Math.max` of two hills is two towns. For the road, a wall has a position, its endpoints' `x` and `y`, and `distanceTo` from chapter 7 gives the distance from a line you draw between the towns; the walls closest to that line, chosen with a `filter`, are a road that follows the cells rather than cutting across them. Whether it reads as a road depends on how many you keep, and that is a control worth having.

</details>

## Where to look things up

`t.voronoi`, `cellOf` and `siteOf` are under *Point distributions* on [Materials](#/materials); `facesOf`, face selections and `boundaryEdges` under *Faces and boundaries*; `edgeAttribute` and `disconnect` under *Making a material* and *Movement and growth*. Next, chapter 10 lets the cells measure the light on them and move toward it.
