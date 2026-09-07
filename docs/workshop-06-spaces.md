# 6. Discover the spaces between lines

**Where are the spaces a drawing encloses, and how do I draw them?** By the end of this chapter you can turn a network that crosses itself into one whose crossings are shared points, read the regions it encloses, choose some of them, fill them, and outline them as one shape. This is the drawing you are about to make: the pockets between the reeds are hatched, the smaller the darker, and the edge of the whole reed bed is drawn in blue.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes, query } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape, the lake and the reeds from chapters 1 to 5 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  const seeds = lake.attribute('active', (p) => p.east).attribute('heading', -Math.PI / 2);
  const reeds = seeds.steps(14, (current, next, k) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      let h = p.heading + t.noise(p.x / 6, p.y / 6, k) * 0.5;
      const ahead = add(p, [Math.cos(h) * 3, Math.sin(h) * 3]);
      const near = lines.nearest(ahead, { within: 3, excludeIncident: p });
      if (near) {
        const side = Math.sign(Math.cos(h) * (near.position[1] - p.y) - Math.sin(h) * (near.position[0] - p.x)) || 1;
        h -= side * 0.4 * (1 - near.distance / 3);
      }
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h, east: 1 } }) };
      return { position: target, attributes: { active: 1, heading: h, east: p.east } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  // #endregion
  const net = reeds.planarize({ point: () => ({ active: 0, heading: 0, east: 0 }) });
  const pockets = net.faces().filter((f) => f.area < 100);
  return [
    sky, sun, farHill, nearHill,
    pockets.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: 30, spacing: mm(0.5 + 1.2 * Math.sqrt(f.area / 100)) }), stroke: false })),
    strokes(pockets.boundaryEdges, { pen: 'stabilo-88-blue' }),
    polygon(lake, { opaque: true, stroke: false }),
    strokes(net),
  ];
});
```

## Start here

Chapter 5 ended with the reed bed, one material with the shore. Where two reeds lean on each other they enclose a space between them and the shore. The drawing shows those spaces; the material does not know them yet. Ask it: `reeds.faces()`. It refuses, with a message naming two connections that cross without sharing a point. Two tips stepped across each other in one step, as chapter 5 said they might, and a region bounded by a crossing is not a region the material can walk around.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes, query } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape, the lake and the reeds from chapters 1 to 5 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  const seeds = lake.attribute('active', (p) => p.east).attribute('heading', -Math.PI / 2);
  const reeds = seeds.steps(14, (current, next, k) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      let h = p.heading + t.noise(p.x / 6, p.y / 6, k) * 0.5;
      const ahead = add(p, [Math.cos(h) * 3, Math.sin(h) * 3]);
      const near = lines.nearest(ahead, { within: 3, excludeIncident: p });
      if (near) {
        const side = Math.sign(Math.cos(h) * (near.position[1] - p.y) - Math.sin(h) * (near.position[0] - p.x)) || 1;
        h -= side * 0.4 * (1 - near.distance / 3);
      }
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h, east: 1 } }) };
      return { position: target, attributes: { active: 1, heading: h, east: p.east } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  // #endregion
  return [sky, sun, farHill, nearHill, polygon(lake, { opaque: true }), strokes(reeds)];
});
```

## Change it

**Make every crossing a point.** `reeds.planarize()` returns a new material in which every place two connections cross is a shared point, with the connections split there. Where two points meet in one, their attributes may disagree, and `point` says what the new point carries; it is only consulted where they do. Then `net.faces()` reads every enclosed region. Each face has an `area` and `contours`, the closed outlines `polygon` accepts, so every face can be hatched. The network is stroked once, after the hatch, so shared walls are drawn one time.

```ts live focus=37-38,41-42
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes, query } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape, the lake and the reeds from chapters 1 to 5 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  const seeds = lake.attribute('active', (p) => p.east).attribute('heading', -Math.PI / 2);
  const reeds = seeds.steps(14, (current, next, k) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      let h = p.heading + t.noise(p.x / 6, p.y / 6, k) * 0.5;
      const ahead = add(p, [Math.cos(h) * 3, Math.sin(h) * 3]);
      const near = lines.nearest(ahead, { within: 3, excludeIncident: p });
      if (near) {
        const side = Math.sign(Math.cos(h) * (near.position[1] - p.y) - Math.sin(h) * (near.position[0] - p.x)) || 1;
        h -= side * 0.4 * (1 - near.distance / 3);
      }
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h, east: 1 } }) };
      return { position: target, attributes: { active: 1, heading: h, east: p.east } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  // #endregion
  const net = reeds.planarize({ point: () => ({ active: 0, heading: 0, east: 0 }) });
  const cells = net.faces();
  return [
    sky, sun, farHill, nearHill,
    cells.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: 30, spacing: mm(1) }), stroke: false })),
    strokes(net),
  ];
});
```

Fourteen faces. Two of them are the lake, cut in two by a reed that grew across the water and joined the far shore; the rest are pockets between reeds. `winding: 'evenodd'` is there for faces with holes, which these do not have, but it costs nothing and is the safe default for contours.

**Choose the pockets.** A face collection filters like the point collections did: `cells.filter((f) => f.area < 100)` keeps the small regions and drops the two halves of the lake. The hatch spacing now depends on each pocket's area, so the small ones read dark.

```ts live focus=38,41
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes, query } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape, the lake and the reeds from chapters 1 to 5 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  const seeds = lake.attribute('active', (p) => p.east).attribute('heading', -Math.PI / 2);
  const reeds = seeds.steps(14, (current, next, k) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      let h = p.heading + t.noise(p.x / 6, p.y / 6, k) * 0.5;
      const ahead = add(p, [Math.cos(h) * 3, Math.sin(h) * 3]);
      const near = lines.nearest(ahead, { within: 3, excludeIncident: p });
      if (near) {
        const side = Math.sign(Math.cos(h) * (near.position[1] - p.y) - Math.sin(h) * (near.position[0] - p.x)) || 1;
        h -= side * 0.4 * (1 - near.distance / 3);
      }
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h, east: 1 } }) };
      return { position: target, attributes: { active: 1, heading: h, east: p.east } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  // #endregion
  const net = reeds.planarize({ point: () => ({ active: 0, heading: 0, east: 0 }) });
  const pockets = net.faces().filter((f) => f.area < 100);
  return [
    sky, sun, farHill, nearHill,
    pockets.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: 30, spacing: mm(0.5 + 1.2 * Math.sqrt(f.area / 100)) }), stroke: false })),
    strokes(net),
  ];
});
```

Some pockets lie on the water: reeds growing up through the lake cut off patches of it, and those are faces like any other, so they are hatched too.

**Outline the bed, and put the water back.** `pockets.boundaryEdges` is a selection of the connections between the chosen pockets and everything else: the walls between two pockets are left out, so the selection outlines the reed bed as one shape. Drawn in blue, before the black network: where the two coincide, the pen rules keep the ink that is already there, so the blue survives and the black over it is dropped. And `polygon(lake, { opaque: true })` goes down after the hatch and the blue and before the network, so the hatch and the outline inside the water are hidden and the reeds standing in it are still drawn. Drawing order, from chapter 1, doing the selecting that geometry cannot. This is the finished drawing from the top of the page.

```ts live focus=42-44
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes, query } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape, the lake and the reeds from chapters 1 to 5 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  const seeds = lake.attribute('active', (p) => p.east).attribute('heading', -Math.PI / 2);
  const reeds = seeds.steps(14, (current, next, k) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      let h = p.heading + t.noise(p.x / 6, p.y / 6, k) * 0.5;
      const ahead = add(p, [Math.cos(h) * 3, Math.sin(h) * 3]);
      const near = lines.nearest(ahead, { within: 3, excludeIncident: p });
      if (near) {
        const side = Math.sign(Math.cos(h) * (near.position[1] - p.y) - Math.sin(h) * (near.position[0] - p.x)) || 1;
        h -= side * 0.4 * (1 - near.distance / 3);
      }
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h, east: 1 } }) };
      return { position: target, attributes: { active: 1, heading: h, east: p.east } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  // #endregion
  const net = reeds.planarize({ point: () => ({ active: 0, heading: 0, east: 0 }) });
  const pockets = net.faces().filter((f) => f.area < 100);
  return [
    sky, sun, farHill, nearHill,
    pockets.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: 30, spacing: mm(0.5 + 1.2 * Math.sqrt(f.area / 100)) }), stroke: false })),
    strokes(pockets.boundaryEdges, { pen: 'stabilo-88-blue' }),
    polygon(lake, { opaque: true, stroke: false }),
    strokes(net),
  ];
});
```

## Crossing is not connecting

Two strokes that cross on paper are not joined in the material, and no operation joins them for you, because whether crossing lines should meet is a decision about the drawing: a bridge over a river crosses it without touching. `planarize` is that decision made for the whole network at once; chapter 5's `firstHit` made it tip by tip during growth. Either way, a face exists only when the material can walk around it through shared points, which is why `faces()` refuses a network with an unshared crossing instead of guessing.

## Experiments

**A tighter idea of a pocket.** Predict: change `f.area < 100` to `f.area < 30` in both places it appears in the finished sketch. How many pockets stay hatched, and what happens to the blue outline? Change it. Observe: five faces remain, one of them a sliver too thin to show a hatch line, and the blue outline breaks into separate loops around them instead of one edge around the bed. Explain: the outline is the boundary of the selection, whatever the selection is. Choose fewer pockets and the "reed bed" they add up to is smaller and comes apart.

**Faces without planarize.** Predict: replace `net.faces()` with `reeds.faces()` in the finished sketch. What does the preview show? Change it. Observe: no drawing, and an error under the code naming two connections that cross without a shared vertex and telling you to planarize. Explain: the two crossings chapter 5 left behind are enough to stop every face from being read, because a region with a crossing on its border has no single outline to walk.

## On your own

Hatch each pocket at an angle of its own instead of 30 degrees everywhere, so neighbouring pockets read apart: use the face's `index`, for example `angle: (f.index * 40) % 180`.

<details>
<summary>A possible solution</summary>

```ts live focus=41
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes, query } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape, the lake and the reeds from chapters 1 to 5 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  const seeds = lake.attribute('active', (p) => p.east).attribute('heading', -Math.PI / 2);
  const reeds = seeds.steps(14, (current, next, k) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      let h = p.heading + t.noise(p.x / 6, p.y / 6, k) * 0.5;
      const ahead = add(p, [Math.cos(h) * 3, Math.sin(h) * 3]);
      const near = lines.nearest(ahead, { within: 3, excludeIncident: p });
      if (near) {
        const side = Math.sign(Math.cos(h) * (near.position[1] - p.y) - Math.sin(h) * (near.position[0] - p.x)) || 1;
        h -= side * 0.4 * (1 - near.distance / 3);
      }
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h, east: 1 } }) };
      return { position: target, attributes: { active: 1, heading: h, east: p.east } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  // #endregion
  const net = reeds.planarize({ point: () => ({ active: 0, heading: 0, east: 0 }) });
  const pockets = net.faces().filter((f) => f.area < 100);
  return [
    sky, sun, farHill, nearHill,
    pockets.map((f) => polygon(f.contours, { winding: 'evenodd', fill: fill('hatch', { angle: (f.index * 40) % 180, spacing: mm(0.5 + 1.2 * Math.sqrt(f.area / 100)) }), stroke: false })),
    strokes(pockets.boundaryEdges, { pen: 'stabilo-88-blue' }),
    polygon(lake, { opaque: true, stroke: false }),
    strokes(net),
  ];
});
```

`index` is the face's row in the collection, a fine source of variety and nothing more; chapter 4 said rows are not identities, and that holds for faces too.

</details>

## Where to look things up

`planarize`, `faces`, face selections, `boundaryEdges` and `boundaries()` are under *Faces and boundaries* on [Materials](#/materials); the pen rules for ink on ink under *How shapes hide each other* on [Getting started](#/getting-started). Next, chapter 7 leaves the reeds and starts from a field: contours and flowing lines across the whole landscape.
