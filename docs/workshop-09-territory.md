# 9. Turn points into territory

**How can a point arrangement become editable areas?** Every point claims the ground nearer to it than to any other point, and the claims meet along shared walls. Those walls are ordinary material: they can be selected, measured, stroked and, when two neighbours are alike, removed, so that a scatter of points becomes a map of regions. This is the drawing this chapter arrives at: a field of cells whose sites were sorted into three kinds by a slow noise, one kind left as bare paper and the other two hatched at their own spacing, with the borders between unlike neighbours drawn heavy and the walls between like ones left fine. By the end you will be able to go from a point to its cell, from a cell to its site, from a wall to the two cells beside it, and decide which walls a map keeps.

```ts live
import { sketch, strokes, polygon, fill, mm, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 12 }, (t) => {
  const spacing = ui(9, { min: 5, max: 16, step: 0.5, label: 'site spacing' });
  const scale = ui(60, { min: 15, max: 120, step: 1, label: 'category scale' });
  const sites = t.relax(t.scatter({ spacing }), { iterations: 2 })
    .attribute('kind', (p) => Math.floor(3 * (0.5 + 0.5 * t.noise(p.x / scale, p.y / scale))) % 3);
  const diagram = t.voronoi(sites);
  const cells = diagram.faces();
  const kind = (face) => diagram.siteOf(face).kind;
  const border = cells.edges.filter((e) => { const [a, b] = cells.facesOf(e); return b !== undefined && kind(a) !== kind(b); });
  const angle = [0, 30, 120];
  const gap = [0, 2.2, 1.1];
  return [
    cells.groupBy(kind).map((group) => (group.key === 0 ? [] : group.map((f) => polygon(f.contours, { fill: fill('hatch', { angle: angle[group.key], spacing: mm(gap[group.key]) }), stroke: false })))),
    strokes(cells.edges, { pen: 'pigma-005-black' }),
    strokes(border, { pen: 'pigma-01-black' }),
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
    strokes(diagram), sites.points.map((p) => circle(p.x, p.y, 1.6, { pen: p.kind ? 'stabilo-88-blue' : 'pigma-01-black' })),
    group({ translate: [100, 0] }, regions.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: f.index ? 135 : 45, spacing: mm(1.4) }), stroke: false })), strokes(merged)),
  ];
});
```

Left, the diagram with its sites coloured by kind. Right, the walls between like neighbours gone, and the two regions that remain hatched from the new faces. The corners the removed walls met at are still points of the material, with two walls or none; they change nothing about the regions and are left alone. Before reading on: `merged` has two faces where `diagram` had eight. Which of the two materials can answer `siteOf`, and what would you do if you needed a region's kind?

<details>
<summary>What to look for</summary>

Only `diagram` can. `merged` is new material, and its faces are new faces that no site made. If a region's kind is needed after the edit, it has to be derived again from something that is still true: the sites are still where they were, and a region contains them, so the kind of the sites inside it is the honest answer, decided by a rule you write. For a drawing, though, the merging is often not needed at all, as the next section shows.

</details>

## Compose a map

More sites, from a relaxed scatter, and a kind for each from a slow noise, so neighbours tend to agree and the kinds come in patches. Two ways to draw the regions, and they are different things. The first never edits: a selection of the cells of one kind has `boundaryEdges`, the walls between that kind and the others, and drawing those outlines the regions while every cell is still a cell with a site. The second removes the walls, as above, and draws the network that remains; its regions are faces, which can be measured or filled, and its correspondence is gone. This is the drawing from the top of the page, in the first way: one kind blank, two hatched, every wall fine, the borders between kinds heavy. The blank kind is the map's open ground, and without it the drawing is all texture.

```ts live focus=9-11
import { sketch, strokes, polygon, fill, mm, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 12 }, (t) => {
  const spacing = ui(9, { min: 5, max: 16, step: 0.5, label: 'site spacing' });
  const scale = ui(60, { min: 15, max: 120, step: 1, label: 'category scale' });
  const sites = t.relax(t.scatter({ spacing }), { iterations: 2 })
    .attribute('kind', (p) => Math.floor(3 * (0.5 + 0.5 * t.noise(p.x / scale, p.y / scale))) % 3);
  const diagram = t.voronoi(sites);
  const cells = diagram.faces();
  const kind = (face) => diagram.siteOf(face).kind;
  const border = cells.edges.filter((e) => { const [a, b] = cells.facesOf(e); return b !== undefined && kind(a) !== kind(b); });
  const angle = [0, 30, 120];
  const gap = [0, 2.2, 1.1];
  return [
    cells.groupBy(kind).map((group) => (group.key === 0 ? [] : group.map((f) => polygon(f.contours, { fill: fill('hatch', { angle: angle[group.key], spacing: mm(gap[group.key]) }), stroke: false })))),
    strokes(cells.edges, { pen: 'pigma-005-black' }),
    strokes(border, { pen: 'pigma-01-black' }),
  ];
});
```

`site spacing` changes how many cells there are, `category scale` how large the patches of one kind are; they are independent, and the drawing changes character along each. Small cells with large patches read as a map of countries; large cells with small patches read as a mosaic. At the defaults the drawing sits between, and the heavy borders are what make it a map rather than a texture.

Three readings of one arrangement, from the same sites and the same kinds: every wall, as a plain cellular drawing; the borders between kinds alone, with the cells gone; and the map above. The plain cells are a texture with no subject. The borders alone are the subject with no texture, and the emptiest of the three is the one most worth plotting on its own: it has decided what it is about.

```ts live focus=14-16
import { sketch, strokes, polygon, fill, mm, group } from 'occlude';

export default sketch({ aspect: [3, 1], seed: 12 }, (t) => {
  const sites = t.relax(t.scatter({ spacing: 8 }), { iterations: 2 })
    .attribute('kind', (p) => Math.floor(3 * (0.5 + 0.5 * t.noise(p.x / 30, p.y / 45))) % 3);
  const diagram = t.voronoi(sites, { bounds: { x: 0, y: 0, w: 96, h: 100 } });
  const cells = diagram.faces();
  const kind = (face) => diagram.siteOf(face).kind;
  const border = cells.edges.filter((e) => { const [a, b] = cells.facesOf(e); return b !== undefined && kind(a) !== kind(b); });
  const angle = [0, 30, 120];
  const gap = [0, 2.2, 1.1];
  const shade = cells.groupBy(kind).map((group) => (group.key === 0 ? [] : group.map((f) => polygon(f.contours, { fill: fill('hatch', { angle: angle[group.key], spacing: mm(gap[group.key]) }), stroke: false }))));
  return [
    strokes(cells.edges),
    group({ translate: [102, 0] }, strokes(border, { pen: 'pigma-01-black' })),
    group({ translate: [204, 0] }, shade, strokes(cells.edges, { pen: 'pigma-005-black' }), strokes(border, { pen: 'pigma-01-black' })),
  ];
});
```

## On your own

Arrange a small number of sites yourself, by hand or from a shape, so the map has a deliberately dense centre and an open edge, then make two drawings from its shared walls that differ in what they are about. Sites sampled along a circle, or scattered with a density that falls off from the middle, are two places to start; chapter 8 has the density.

<details>
<summary>A hint, not the answer</summary>

`t.scatter(density, { spacing })` with a density of `1 - distance(...) / r` puts the sites where the density is, and `t.voronoi` does the rest: the cells are small in the middle and open at the edge without any further rule. For the two drawings, a wall has two cells beside it and each cell has an area; a border between a small cell and a large one is a different selection from a border between two kinds, and both are one `filter`.

</details>

## Where to look things up

`t.voronoi`, `cellOf` and `siteOf` are under *Point distributions* on [Materials](#/materials); `facesOf`, face selections and `boundaryEdges` under *Faces and boundaries*; `edgeAttribute` and `disconnect` under *Making a material* and *Movement and growth*. Next, chapter 10 lets the cells measure the light on them and move toward it.
