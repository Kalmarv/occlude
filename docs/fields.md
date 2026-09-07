# Fields & variation

Seeded randomness and noise, independent streams, remapping and shaping values, scalar and vector fields over the page, and the contours and flow lines that read them. A field is a function that returns a value at a position, `(x, y) => number` for scalars and `(x, y) => [dx, dy]` for vectors. Fields are called in drawable units.

## Randomness

All randomness derives from the sketch's seed (`seed` in the config, or `?seed=` in the URL). The same source and seed give the same geometry.

`t.rnd()` returns 0 to 1, `t.rnd(n)` 0 to n, `t.rnd(a, b)` a to b. `t.pick(arr)` returns one element and `t.chance(p)` a boolean.

```ts live
import { sketch, circle, rect } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 21 }, (t) =>
  t.times(90, () => {
    const x = t.rnd(8, 192);
    const y = t.rnd(8, 92);
    const r = t.rnd(2, 9);
    return t.chance(0.7) ? circle(x, y, r) : rect(x - r, y - r, r * 2, r * 2);
  }),
);
```

### noise

`t.noise(x, y?, z?)` is seeded smooth noise in the range −1 to 1. Sample it coarsely for terrain and finely for texture; within a seed the same coordinates always return the same value.

```ts live
import { sketch, path } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) =>
  t.times(16, (k) => {
    const p = path().moveTo(0, 92 - k * 5);
    for (let x = 0; x <= 200; x += 4) {
      p.lineTo(x, 88 - k * 5 - t.noise(x * 0.015 + k * 0.15, k * 0.5) * 14);
    }
    return p.build();
  }),
);
```

### Independent streams

`t.stream(name)` returns a random stream keyed off the seed, with its own `rnd`, `pick`, `chance` and `noise`. Parts of a drawing that read separate streams do not reshuffle one another when one of them changes: adding a star does not move the ridge.

```ts live
import { sketch, circle, path } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 14 }, (t) => {
  const stars = t.stream('stars');
  const ground = t.stream('ground');
  const ridge = path().moveTo(0, 100);
  for (let x = 0; x <= 200; x += 5) ridge.lineTo(x, 72 - ground.noise(x * 0.03) * 14);
  ridge.lineTo(200, 100).close();
  return [
    t.times(70, () => circle(stars.rnd(200), stars.rnd(60), stars.rnd(0.3, 1.2))),
    ridge.build({ opaque: true }),
  ];
});
```

## Remapping and easing

`map(v, a, b, c, d)` remaps a value from one range to another, `norm(v, a, b)` to 0 to 1, and `invertRange(v, max, min?)` mirrors a value within a range. The `ease` object holds the standard easing curves (`ease.cubicIn`, `ease.bounceOut`, `ease.backInOut` and the rest). When an eased value drives spacing, the local density is the curve's slope.

```ts live
import { sketch, line, ease } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  t.times(22, (k, u) => line(6, 6 + u * 40, 96, 6 + u * 40)),                                   // linear
  t.times(22, (k, u) => line(104, 6 + ease.cubicIn(u) * 40, 194, 6 + ease.cubicIn(u) * 40)),
  t.times(22, (k, u) => line(6, 54 + ease.bounceOut(u) * 40, 96, 54 + ease.bounceOut(u) * 40)),
  t.times(22, (k, u) => line(104, 54 + ease.backInOut(u) * 40, 194, 54 + ease.backInOut(u) * 40)),
]);
```

### shaper

`shaper(points, { method?, bounds? })` is the tone curve from image editors as a value: knots, a curve through them (Akima by default, `'cubic'` or `'linear'` on request), and the result is a function. The knots define the area: input runs from the first knot's x to the last's, and output stays between the lowest and highest knot. `[[0, 0], [1, 1]]` is a unit curve, `[[0, 0.65], [1, 3.75]]` turns a luminance straight into millimetres of spacing, `[[0, 1], [1, 0]]` inverts. Lift the middle and midtones rise; flatten an end and it clips; an S adds contrast.

In the studio the knot literal gets a curve editor beside the sliders. Drag a knot, double-click empty space to add one, double-click a knot to remove it; each change rewrites the array in the code. `bounds: [[x0, y0], [x1, y1]]` pins the area so it survives a knot being dragged to an edge.

```ts live
import { sketch, circle, shaper } from 'occlude';

// Dot sizes through an S curve: the midtones spread apart.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const tone = shaper([[0, 0], [0.3, 0.12], [0.7, 0.88], [1, 1]]);
  return t.grid({ cols: 40, rows: 20 }).map((c) => {
    const v = tone(t.noise(c.x / 40, c.y / 40) * 0.5 + 0.5);
    return v > 0.03 ? circle(c.cx, c.cy, v * c.w * 0.48) : null;
  });
});
```

## Fields

Any `(x, y) => number` is a scalar field, and any `(x, y) => [dx, dy]` a vector field. Sketch-time consumers (`isolines`, `streamlines`, `scatter`, fills) call them directly. Engine-side modifier parameters marked as fielded in Shapes & layout (`decimate` probabilities, `wobble` amount, `roughen` amount, `deform`'s vector) also accept one; those are sampled onto a raster at encode time, so the value varies over the page while the render stays deterministic.

Four pure imports transform a field's sampling:

| Function | Effect |
|---|---|
| `within(f, shape)` | bounds the domain to the shape; outside it the field is absent (generators make nothing, modifiers touch nothing, contours end at the edge) |
| `rotate(f, deg)` | turns the sampling about the origin |
| `translate(f, dx, dy)` | moves it |
| `scale(f, s)` | scales it; `s` may be `[sx, sy]` |

Transformed fields stay plain callables. Vector fields follow the same rule as iron filings: wrap a custom one in `vectorField(fn)` and rotation turns its arrows too; magnitudes never scale, so a 2 mm displacement stays 2 mm at any motif size. `grad(f)` and `curl(f)` lift a scalar field to a vector one: the gradient points uphill, and the curl is the gradient turned 90°, so it runs along the contours of `f`.

```ts live
import { sketch, circle, stroke, rotate, within } from 'occlude';

// Grain bounded to a disc and rotated 30°. Contours end at the bound.
export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const grain = rotate((x, y) => t.noise(x / 8, y / 40), 30);
  const f = within(grain, circle(100, 50, 42));
  return [
    circle(100, 50, 42),
    t.isolines(f, [0.1, 0.35, 0.6], { step: 0.6 }).flat().map((c) => stroke(c)),
  ];
});
```

### Alignment

Every consumer of a field takes `align`. `'paper'` (the default) samples the field in drawable coordinates, so a shape sees whatever part of the field it sits on. `'shape'` anchors the field to the shape: the shape's own centre becomes the field's origin, and the field turns with the shape's transforms, so identical shapes see identical values wherever they land. On a fill it applies to the fill's field parameters and its ruling; on a modifier's parameter object (`decimate: { fill: f, align: 'shape' }`, `wobble: { amount, align }`, `deform({ field, align })`) it applies to that modifier. A thousand shape-aligned uses share one raster; the anchor is a per-use transform.

A field on a fill's decimate is a halftone. Here `dash` chops the hatch into short cells and a radial field erodes them away from the centre.

```ts live
import { sketch, rect, fill, modify, dash, decimate, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, () =>
  modify(
    [dash(mm(1.2), mm(0.8)), decimate((x, y) => Math.hypot(x - 100, (y - 50) * 2) / 105)],
    rect(4, 4, 192, 92, { fill: fill('hatch', { angle: 45, spacing: mm(1.1) }), stroke: false }),
  ),
);
```

The same erosion field used both ways. The left squares sample the page's radial gradient where they sit; the right squares are each eroded from their own centre and turned with their group.

```ts live
import { sketch, rect, fill, group, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const erode = (x, y) => Math.min(1, Math.hypot(x, y) / 18);
  const hatch = fill('hatch', { angle: 0, spacing: mm(0.7) });
  const onPaper = (x, y) =>
    rect(x, y, 28, 28, { fill: hatch, stroke: false, decimate: { fill: (px, py) => erode(px - 100, py - 50), align: 'paper' } });
  const onShape = (x, y) =>
    group({ rotate: 15 },
      rect(x, y, 28, 28, { fill: fill('hatch', { angle: 0, spacing: mm(0.7), align: 'shape' }), stroke: false, decimate: { fill: erode, align: 'shape' } }));
  return [
    t.times(3, (k) => onPaper(10 + k * 30, 36)),
    t.times(3, (k) => onShape(112 + k * 26, 8 + k * 6)),
  ];
});
```

## Contours

### isolines

`t.isolines(field, at, { step?, close? })` traces the contours where `field ≥ at` by marching squares over the drawable, and returns plain contour records `{ pts, closed }`. `polygon(c.pts)` stamps one loop; `polygon(blobs.map((c) => c.pts))` makes a whole level set into one shape with holes respected, for clipping, masking and filling. `stroke(c)` strokes a contour with its open ends kept. A contour that leaves the drawable comes back open; `close: true` closes every region along the edge, which is the form clips and fills want. An array of levels marches all of them over one sampling. `step` defaults to about 1 mm; crossings are edge-interpolated, so accuracy is finer than the grid.

```ts live
import { sketch, polygon, fill, mm } from 'occlude';

// Posterized tone. Each level is a filled shape and therefore opaque, so
// the denser inner hatch replaces the coarse one where they overlap.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const field = (x, y) => t.noise(x / 32, y / 32);
  return [
    t.isolines(field, 0.15, { close: true }).map((c) =>
      polygon(c.pts, { fill: fill('hatch', { angle: 30, spacing: mm(1.6) }) })),
    t.isolines(field, 0.5, { close: true }).map((c) =>
      polygon(c.pts, { fill: fill('hatch', { angle: 120, spacing: mm(0.7) }) })),
  ];
});
```

### distanceTo

`distanceTo(loops)` builds a signed distance field from boundary loops: positive inside, zero on the boundary, negative outside. `isolines(d, 2)` therefore traces a ring 2 units inside the boundary and `isolines(d, -2)` a halo 2 units outside; there is no separate offset function. Insideness is even-odd over the loops, so nesting makes holes and orientation does not matter. Open loops are closed with a chord. Distances come back in the units of the input points, and the field composes anywhere a field goes: scatter densities, decimate and deform parameters, not only contours.

`t.polylines(shape, { tolerance? })` turns any shape into its polylines in drawable units, through the same lowering the shape is inked with (rect anchoring, arcs, the shape's own transforms, curves flattened at `tolerance`, default 0.05 mm). It is the bridge from shapes to everything that takes points.

```ts live
import { sketch, polygon, stroke, distanceTo } from 'occlude';

// A blob echoed inward every 5 units and haloed once outside. Contours
// that leave the drawable come back open, and stroke() draws them as such.
export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const blob = t.isolines((x, y) => t.noise(x / 28, y / 28), 0.3, { close: true, step: 1 });
  const d = distanceTo(blob.map((c) => c.pts));
  return [
    polygon(blob.map((c) => c.pts)),
    t.isolines(d, [5, 10, 15, 20, 25], { step: 0.7 }).flat().map((c) => stroke(c)),
    t.isolines(d, -5, { step: 0.7 }).map((c) => stroke(c)),
  ];
});
```

```ts live
import { sketch, rect, stroke } from 'occlude';

// Rings around a rotated rectangle: its outline as polylines, then a
// distance field, then contours. No geometry written by hand.
export default sketch({ aspect: [2, 1] }, (t) => {
  const box = rect(100, 50, 56, 26, { rotate: 20, mode: 'center' });
  const d = t.distanceTo(t.polylines(box));
  return [box, t.isolines(d, [-6, -12, -18, -24, -30], { step: 0.6 }).flat().map((c) => stroke(c))];
});
```

## Flow lines

`t.streamlines(field, { spacing?, minSpacing?, step?, seeds? })` traces evenly spaced streamlines of a vector field over the drawable, after Jobard and Lefer. It returns open contours for `stroke()`. Lines stop at the drawable edge, at a `within()` bound, and half a spacing from ink already laid, so they never cross or bunch. `spacing` is a length (default 1 mm) or a field of lengths, which turns density into tone; `minSpacing` (default 0.3 mm) is its floor. The result is a pure function of the fields, with no seed involved. Long continuous lines with few pen lifts are the cheapest ink a plotter draws.

```ts live
import { sketch, stroke, curl } from 'occlude';

// Streamlines of the curl of noise run along its contours and never converge.
export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const flow = curl((x, y) => t.noise(x / 60, y / 60));
  return t.streamlines(flow, { spacing: 1.6 }).map((c) => stroke(c));
});
```

```ts live
import { sketch, circle, stroke, curl, within, distanceTo } from 'occlude';

// Hatch that wraps a form: the curl of its distance field runs along the
// outline, and spacing grows with the distance so the hatch fades out.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const form = circle(100, 50, 22);
  const d = distanceTo(t.polylines(form));
  const around = within(curl(d), circle(100, 50, 48));
  return [
    form,
    t.streamlines(around, { spacing: (x, y) => 0.7 + Math.abs(d(x, y)) * 0.12 }).map((c) => stroke(c)),
  ];
});
```
