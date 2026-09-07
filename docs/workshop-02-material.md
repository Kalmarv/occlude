# 2. Turn a shape into something editable

A hexagon on the left, a circle sampled into 36 points in the middle, and on the right those 36 points pushed about by noise into an irregular ring, hatched as a pond. The first two are shapes made editable; the third is what editing looks like. This is what you are about to make.

```ts live
import { sketch, ngon, circle, strokes, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const hex = t.material(ngon(34, 50, 6, 26));
  const round = t.sample(circle(100, 50, 26), { count: 36 });
  const pond = t.sample(circle(166, 50, 26), { count: 36 }).steps(1, (cur, next) => {
    next.move((p) => [t.noise(p.x / 9, p.y / 9) * 7, t.noise(p.x / 9 + 30, p.y / 9) * 7]);
  });
  const dots = (m) => m.points.map((p) => circle(p.x, p.y, 1.1, { pen: 'stabilo-88-blue' }));
  return [
    strokes(hex), dots(hex),
    strokes(round), dots(round),
    polygon(pond, { fill: fill('hatch', { angle: 20, spacing: mm(1.4) }) }),
  ];
});
```

## Start here

Chapter 1's hills were shapes. A shape is sealed: you can fill it, hide with it, transform it, but you cannot ask for its third corner or move it. Start with a plain hexagon, drawn as a shape.

```ts live
import { sketch, ngon } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => [
  ngon(50, 50, 6, 34),
]);
```

## Change it

**The same hexagon as material.** `t.material(shape)` keeps the shape's own vertices: the six corners, joined in a ring. The result is a material, which is geometry as data: points you can read, edges between them, and operations that return new materials. `strokes(m)` draws its edges; `m.points` is a collection you can map over, so the corners become dots. The drawing is the same hexagon, but now it is six rows and six edges.

```ts live
import { sketch, ngon, circle, strokes } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const hex = t.material(ngon(50, 50, 6, 34));
  return [
    strokes(hex),
    hex.points.map((p) => circle(p.x, p.y, 1.3, { pen: 'stabilo-88-blue' })),
  ];
});
```

**Exact corners or a chosen number of samples.** There are two ways into material, and they answer different questions. `t.material` keeps what the shape has: a hexagon's six corners, and for a circle a flattened outline with as many points as its tolerance needs. `t.sample(shape, { count })` walks the outline by arc length and places exactly the points you ask for, wherever they land. Six samples of a hexagon need not sit on its corners. Left: the hexagon's own corners. Right: six samples of the same hexagon, rotated off the corners.

```ts live
import { sketch, ngon, circle, strokes } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const exact = t.material(ngon(50, 50, 6, 30));
  const sampled = t.sample(ngon(150, 50, 6, 30), { count: 6 });
  const dots = (m) => m.points.map((p) => circle(p.x, p.y, 1.3, { pen: 'stabilo-88-blue' }));
  return [strokes(exact), dots(exact), strokes(sampled), dots(sampled)];
});
```

**Moving the points.** Editing a material means asking for a new one with the points moved. `m.steps(1, (current, next) => …)` is the verb: it reads `current` and describes `next`, here with one edit, a displacement for every point. Chapter 4 is about this verb; use it here as one edit and no more. Thirty-six samples of a circle, each pushed by a noise read at its own position, become an irregular ring. `t.noise` is smooth, so neighbouring points move together and the ring stays a ring.

```ts live
import { sketch, circle, strokes } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) => {
  const round = t.sample(circle(50, 50, 34), { count: 36 });
  const pond = round.steps(1, (current, next) => {
    next.move((p) => [t.noise(p.x / 9, p.y / 9) * 8, t.noise(p.x / 9 + 30, p.y / 9) * 8]);
  });
  return [
    strokes(round, { pen: 'stabilo-88-blue' }),
    strokes(pond),
    pond.points.map((p) => circle(p.x, p.y, 1.1)),
  ];
});
```

**Strokes or an area.** A material draws two ways. `strokes(m)` inks its edges and hides nothing. `polygon(m)` makes one area from a closed chain, so it takes a fill and hides what lies under it, exactly as the hills did. Same ring, both readings.

```ts live
import { sketch, circle, strokes, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const pond = (cx) => t.sample(circle(cx, 50, 28), { count: 36 }).steps(1, (current, next) => {
    next.move((p) => [t.noise((p.x - cx) / 9, p.y / 9) * 8, t.noise((p.x - cx) / 9 + 30, p.y / 9) * 8]);
  });
  return [
    strokes(pond(52)),
    polygon(pond(148), { fill: fill('hatch', { angle: 20, spacing: mm(1.4) }) }),
  ];
});
```

## Try changing this

In the moving sketch, sample the circle with 6 points, then 12, then 60, under the same noise. At what count does it stop reading as a polygon and start reading as a shoreline? Then replace `t.sample(circle(…), { count: 36 })` with `t.material(circle(…))` and count the dots. You did not choose that number; what did?

## Something that will surprise you

Two things about closed chains. A ring has no seam: a closed outline becomes as many vertices as it has corners, with the last edge joining back to the first, so a hexagon is six points and six edges, not seven points. And `t.material` of a curve is already flattened: a circle arrives as a polyline at a tolerance (0.05 mm unless you pass one), because material is made of straight edges. That is the one lossy step into this vocabulary; shapes stay exact until you cross it. The precise contracts are under *Making a material* on [Materials](#/materials).

## The whole sketch

```ts live
import { sketch, ngon, circle, strokes, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const hex = t.material(ngon(34, 50, 6, 26));
  const round = t.sample(circle(100, 50, 26), { count: 36 });
  const pond = t.sample(circle(166, 50, 26), { count: 36 }).steps(1, (cur, next) => {
    next.move((p) => [t.noise(p.x / 9, p.y / 9) * 7, t.noise(p.x / 9 + 30, p.y / 9) * 7]);
  });
  const dots = (m) => m.points.map((p) => circle(p.x, p.y, 1.1, { pen: 'stabilo-88-blue' }));
  return [
    strokes(hex), dots(hex),
    strokes(round), dots(round),
    polygon(pond, { fill: fill('hatch', { angle: 20, spacing: mm(1.4) }) }),
  ];
});
```

Reference: *Making a material* and *Collections and selections* on [Materials](#/materials). Next: the ring's points are all alike. [Chapter 3](#/workshop-03) gives them information and draws them by it.
