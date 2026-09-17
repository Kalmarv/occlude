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
import { sketch, circle, strokes, rotate } from 'occlude';

// Grain bounded to a disc and rotated 30°. Contours end at the bound.
export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const grain = rotate((x, y) => t.noise(x / 8, y / 40), 30);
  const f = t.within(grain, circle(100, 50, 42));
  return [
    circle(100, 50, 42),
    strokes(t.isolines(f, [0.1, 0.35, 0.6], { step: 0.6 })),
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

`t.isolines(field, at, { step?, close? })` traces the contours where `field ≥ at` by marching squares over the drawable and returns them as one material: each contour a chain (a ring when closed), separate contours separate, and every edge carrying its requested `level`. `strokes(m)` draws them; `polygon(m)` makes a whole level set into one area with holes respected, for clipping, masking and filling; `m.edges.filter((e) => e.attrs.level === 0.4)` picks a level and `m.edges.groupBy((e) => e.attrs.level)` splits them all; and `.steps()`, `.attribute()` and the rest of Materials apply as they do to any material. A contour that leaves the drawable comes back open; `close: true` closes every region along the edge, which is the form clips and fills want. An array of levels marches all of them over one sampling, in the order given; a level that produces nothing adds nothing. `step` defaults to about 1 mm; crossings are edge-interpolated, so accuracy is finer than the grid.

```ts live
import { sketch, polygon, fill, mm } from 'occlude';

// Posterized tone. Each contour is filled on its own and is therefore
// opaque, so the denser inner hatch replaces the coarse one where they
// overlap. polygon(material) would instead make one even-odd area of all
// the contours of a level, with nested contours as holes.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const field = (x, y) => t.noise(x / 32, y / 32);
  return [
    t.isolines(field, 0.15, { close: true }).curves().map((c) =>
      polygon(c, { fill: fill('hatch', { angle: 30, spacing: mm(1.6) }) })),
    t.isolines(field, 0.5, { close: true }).curves().map((c) =>
      polygon(c, { fill: fill('hatch', { angle: 120, spacing: mm(0.7) }) })),
  ];
});
```

Contour levels drawn differently. `edges.groupBy` splits the material into one selection per level, each carrying its level as `key`, and a selection is drawn or filled directly: here the lowest level is filled as an area, the middle one stroked, and the highest one softened for a few steps first, which is where an independent copy is made on purpose.

```ts live
import { sketch, strokes, polygon, fill, force, mul, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const contours = t.isolines((x, y) => t.noise(x / 30, y / 30), [0.1, 0.3, 0.5], { step: 1, close: true });
  const [low, mid, high] = contours.edges.groupBy((e) => e.attrs.level);
  const softened = high.extract().steps(12, (cur, next) => {
    const smooth = force.relax(cur, { amount: 0.5 });
    next.move(cur.points.filter((p) => cur.degree(p) === 2), (p) => mul(smooth(p), 1));
  });
  return [
    polygon(low, { fill: fill('hatch', { angle: 30, spacing: mm(2.4) }), stroke: false }),
    strokes(mid, { pen: 'pigma-005-black' }),
    strokes(softened, { pen: 'stabilo-88-blue' }),
  ];
});
```

### distanceTo

`distanceTo(boundary)` builds a signed distance field from a boundary: positive inside, zero on the boundary, negative outside. `isolines(d, 2)` therefore traces a ring 2 units inside the boundary and `isolines(d, -2)` a halo 2 units outside; there is no separate offset function. Insideness is even-odd over the loops, so nesting makes holes and orientation does not matter. Distances come back in the units of the input points, and the field composes anywhere a field goes: scatter densities, decimate and deform parameters, not only contours.

The boundary is whatever `polygon` and `force.boundary` also take: plain loops (`[[x, y], …]`, one or several), contour records such as a face's contours, or a chain material, which is how a shape gets there (`t.material(rect(…))`) and what `t.isolines` returns. A closed chain is a loop; an open chain is closed with a chord; separate components are separate loops; isolated points add nothing; and a material that branches is refused with the way out named, because a network has no single inside. Nothing is welded or planarized on the way.

```ts live
import { sketch, polygon, strokes, distanceTo } from 'occlude';

// A blob echoed inward every 5 units and haloed once outside. Contours
// that leave the drawable come back open, and strokes() draws them as such.
export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const blob = t.isolines((x, y) => t.noise(x / 28, y / 28), 0.3, { close: true, step: 1 });
  const d = distanceTo(blob);
  return [
    polygon(blob),
    strokes(t.isolines(d, [5, 10, 15, 20, 25], { step: 0.7 })),
    strokes(t.isolines(d, -5, { step: 0.7 })),
  ];
});
```

```ts live
import { sketch, rect, strokes } from 'occlude';

// Rings around a rotated rectangle: its boundary as material, then a
// distance field, then contours. No geometry written by hand.
export default sketch({ aspect: [2, 1] }, (t) => {
  const box = rect(100, 50, 56, 26, { rotate: 20, mode: 'center' });
  const d = t.distanceTo(t.material(box));
  return [box, strokes(t.isolines(d, [-6, -12, -18, -24, -30], { step: 0.6 }))];
});
```

## Flow lines

`t.streamlines(field, { spacing?, minSpacing?, step?, seeds? })` traces evenly spaced streamlines of a vector field over the drawable, after Jobard and Lefer, and returns them as one material of open chains: `strokes(m)` draws them, and a chain can carry attributes or be stepped like any material. Lines stop at the drawable edge, at a `within()` bound, and half a spacing from ink already laid, so they never cross or bunch. `spacing` is a length (default 1 mm) or a field of lengths, which turns density into tone; `minSpacing` (default 0.3 mm) is its floor. The result is a pure function of the fields, with no seed involved. Long continuous lines with few pen lifts are the cheapest ink a plotter draws.

```ts live
import { sketch, strokes, curl } from 'occlude';

// Streamlines of the curl of noise run along its contours and never converge.
export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const flow = curl((x, y) => t.noise(x / 60, y / 60));
  return strokes(t.streamlines(flow, { spacing: 1.6 }));
});
```

```ts live
import { sketch, circle, strokes, curl, distanceTo } from 'occlude';

// Hatch that wraps a form: the curl of its distance field runs along the
// outline, and spacing grows with the distance so the hatch fades out.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const form = circle(100, 50, 22);
  const d = distanceTo(t.material(form));
  const around = t.within(curl(d), circle(100, 50, 48));
  return [
    form,
    strokes(t.streamlines(around, { spacing: (x, y) => 0.7 + Math.abs(d(x, y)) * 0.12 })),
  ];
});
```

## Crest lines

`t.isolines` answers "where is the field this high". `t.ridges(field, { step? })`
answers a different question about the same field: **where does it run along a
top**. Those are not substitutes. Contours of a long smooth ridge are a nest of
ovals with nothing at all down the middle, which is exactly where the ridge is.

A point is on a crest when the field is at a maximum *across* the crest. With
the Hessian's eigenvalues `λ₁ ≤ λ₂` and unit eigenvectors `e₁, e₂`, that is
`∇f · e₁ = 0` with `λ₁ < 0`: `e₁` points the way the ground falls away
fastest, so it lies across the crest, and the condition says nothing at all
about the direction you walk along it. Valleys are the crests of the negated
field — `t.ridges((x, y) => -f(x, y))` — so there is no option for them.

The result is one material: each crest a chain (a ring when it closes, as a
crater rim does), separate crests separate, and **every vertex carrying two
columns**. `strength` is `-λ₁`, how sharply the ground falls away to either
side, in the field's units per square drawable unit; `height` is the field's
own value there. Nothing is thresholded — a weak crest is a real crest, and
which ones earn ink is the drawing's decision:
`m.points.filter((p) => p.strength > x).inducedEdges().extract()`.

`step` is not a quality setting. It is the distance the derivatives are taken
over, so it sets the **scale of the question**: a coarse grid finds the major
ranges and a fine one the spurs hanging off them, and both answers are true.
Deterministic, no seed. A `within()` bound arrives as non-finite samples, and a
node whose stencil touches one has no second derivative, so the crest stops at
the hole rather than guessing across it.

There is one place the operation earns its keep rather than saving you
typing. `∇f · e₁ = 0` looks like a level set, so it looks like
`t.isolines(g, 0)` with a hand-written `g` — and it is not, because `e₁` is a
**line, not a vector**. An eigenvector is defined up to sign, so `g` flips sign
arbitrarily from sample to sample and marching squares reads every flip as a
crossing: noise everywhere, the real crest lost inside it. Nor is there a
global repair, because at an umbilic point — where `λ₁ = λ₂` — the across
direction genuinely does not exist. What works is to fix the sign inside one
cell, from that cell's most sharply curved corner, and march there; the
crossing position on a shared edge does not depend on the convention, so
neighbouring cells still meet. A field that curves the same in every direction
everywhere, like a paraboloid of revolution, therefore returns nothing at all:
its ridge is its apex, which is a point and not a line.

```ts live
import { sketch, strokes } from 'occlude';

// Contours and crests of the same ground. The blue nest says how high the
// field is; the black lines say where it runs along a top — down the spine of
// every hill and through the passes between them.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const ground = (x, y) => t.noise(x / 44, y / 44);
  return [
    strokes(t.isolines(ground, [-0.4, -0.2, 0, 0.2, 0.4], { step: 1 }), { pen: 'stabilo-88-blue' }),
    strokes(t.ridges(ground, { step: 1 })),
  ];
});
```

### An island, drawn only by its own lines

```ts live paper=180x120
import { sketch, strokes, distanceTo, components } from 'occlude';

// The coast, the crests of the ranges, and the water that runs between them.
// No contours, no hatching, no shading — every stroke is a place where the
// terrain does something.
//
// The judging is per CREST, not per point. Filtering vertices by strength
// chops a crest into dashes wherever it dips; `components()` names each one,
// so a crest is kept or dropped whole, on its best stretch and its length.
// That is the difference between a range and a field of scratches.
export default sketch({ aspect: [3, 2], seed: 12 }, (t) => {
  const shore = (x, y) =>
    t.noise(x / 40, y / 40) + 0.78 -
    1.45 * Math.hypot((x - t.cx) / (t.width * 0.46), (y - t.cy) / (t.height * 0.44)) ** 2;
  const coast = t.isolines(shore, 0, { close: true, step: 1 });
  const inland = distanceTo(coast);
  const height = (x, y) =>
    Math.max(0, inland(x, y)) * 0.55 + 15 * t.noise(x / 21, y / 21) + 3.5 * t.noise(x / 8, y / 8);

  const keep = (m, minStrength, minRun) => {
    const c = components(m);
    const peak = new Float64Array(c.count);
    const run = new Int32Array(c.count);
    for (const p of m.points) {
      const k = c.label(p);
      peak[k] = Math.max(peak[k], p.strength);
      run[k]++;
    }
    const top = Math.max(...peak);
    return m.points
      .filter((p) => peak[c.label(p)] > top * minStrength && run[c.label(p)] >= minRun)
      .inducedEdges()
      .extract();
  };

  // Two passes at two steps. The step is the scale the derivatives are taken
  // at, so a coarse grid finds the major ranges and a fine one the spurs
  // hanging off them; drawing both is what gives the land its grain.
  const range = t.within(t.ridges(height, { step: 2.6 }), coast);
  const spurs = t.within(t.ridges(height, { step: 0.9 }), coast);
  const water = t.within(t.ridges((x, y) => -height(x, y), { step: 1.2 }), coast);

  return [
    strokes(coast, { pen: 'stabilo-88-blue' }),
    strokes(keep(spurs, 0.13, 9)),
    strokes(keep(range, 0.1, 6)),
    strokes(keep(water, 0.22, 14), { pen: 'stabilo-88-blue' }),
  ];
});
```

### One field, three questions

```ts live paper=180x120
import { sketch, strokes, polygon, material, connect, append, distanceTo, components } from 'occlude';

// Stones in a raked bed. One distance field does all three jobs: its level
// sets are the ripples raked around the stones, its crests inside each stone
// are that stone's spine, and the crests of its negation outside are the
// channels between them — the lines a stream would take.
//
// The stones are opaque, so the ripples they caused stop at them.
export default sketch({ aspect: [3, 2], seed: 6 }, (t) => {
  const seeds = t.relax(t.scatter(() => 1, { spacing: 46 }), { iterations: 5 });
  const stones = seeds.points
    .map((p, i) => {
      // one size per stone — drawn once, outside the loop, or every vertex
      // gets its own radius and the stone comes out a star
      const size = 11 + t.rnd(5);
      return connect.ring(
        material(
          t.times(64, (k) => {
            const a = (k / 64) * Math.PI * 2;
            // noise read around a small circle, so the wobble is smooth and
            // closes on itself
            const r = size * (1 + 0.2 * t.noise(Math.cos(a) * 0.55 + i * 9, Math.sin(a) * 0.55));
            return { x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r * 0.82 };
          }),
        ),
      );
    })
    .reduce((a, b) => append(a, b));

  const d = distanceTo(stones);
  const ripples = t.isolines(d, [-2.2, -4.4, -6.6, -8.8, -11], { step: 0.5 });
  const spines = t.ridges(d, { step: 2.4 });
  const channels = t.ridges((x, y) => -d(x, y), { step: 1.1 });
  // A crest is worth ink if it RUNS. Judged per component, so the numerical
  // hair a distance field grows along the middle of a smooth blob — dozens of
  // two-vertex ridges, all of them real — does not reach the paper, while the
  // spine does.
  const longRuns = (m, least) => {
    const c = components(m);
    const run = new Int32Array(c.count);
    for (const p of m.points) run[c.label(p)]++;
    return (p) => run[c.label(p)] > least;
  };
  const longChannel = longRuns(channels, 40);
  const longSpine = longRuns(spines, 6);

  return [
    strokes(ripples),
    strokes(
      channels.points.filter((p) => longChannel(p) && -d(p.x, p.y) > 4).inducedEdges().extract(),
      { pen: 'stabilo-88-blue' },
    ),
    polygon(stones, { opaque: true, stroke: false }),
    strokes(stones),
    strokes(spines.points.filter((p) => longSpine(p) && d(p.x, p.y) > 2).inducedEdges().extract(), { pen: 'stabilo-88-blue' }),
  ];
});
```

### A graph drawn by the ground

```ts live
import { sketch, strokes, circle, connect, components } from 'occlude';

// There is no landscape here. The field is the drawing itself, blurred — one
// soft bump per point and nothing else — and the black lines are its crests.
// A crest can only run from one bump to another over the saddle between them,
// so the ridge network IS a proximity graph: the terrain decides which points
// are neighbours, and it decides by how wide the bumps are.
//
// In blue, the same points joined by `connect.neighbours`, which asks a purely
// geometric question and never samples anything. They agree almost everywhere.
export default sketch({ aspect: [2, 1], seed: 21 }, (t) => {
  const pts = t.relax(t.scatter(() => 1, { spacing: 17 }), { iterations: 6 });
  const bumps = pts.points.map((p) => [p.x, p.y]);
  const width = 9;
  const blur = (x, y) => {
    // every bump, with no cut-off radius: a cut-off is a step in the field,
    // and a step is a ridge — the operation would have found the seam and
    // been right about it
    let s = 0;
    for (const [bx, by] of bumps) s += Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (2 * width * width));
    return s;
  };

  const crests = t.ridges(blur, { step: 1 });
  const c = components(crests);
  const run = new Int32Array(c.count);
  for (const p of crests.points) run[c.label(p)]++;

  return [
    strokes(connect.neighbours(pts, { room: 1.4 }), { pen: 'stabilo-88-blue' }),
    strokes(crests.points.filter((p) => run[c.label(p)] > 10 && blur(p.x, p.y) > 0.4).inducedEdges().extract()),
    pts.points.map((p) => circle(p.x, p.y, 1.1)),
  ];
});
```

### The range itself

```ts live paper=180x120
import { sketch, warp, components, pen, mm } from 'occlude';
import { plane, mapSurface, view, perspective, style } from 'occlude/3d';

// A landscape whose only lines are the ones the ground has: its crests, its
// watercourses, and the edge of the block. No contours, no hatch, no drawn
// silhouettes — and yet the hills are unmistakable, because a crest that has
// gone behind a ridge in front is gone.
//
// The crests are found flat, over the drawable, and the same height function
// displaces the mesh. Getting the one onto the other is `warp`: a chart is a
// unit square, the drawable is a rectangle, and a cage from one to the other
// is an affine map — which mean value coordinates reproduce exactly, so the
// lines land on the surface at the very places the field put them.
export default sketch({ aspect: [3, 2], seed: 17, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  water: pen({ width: mm(0.22), color: '#1B4FA0' }),
} }, (t) => {
  const height = (x, y) =>
    t.noise(x / 48, y / 48) + 0.45 * t.noise(x / 19, y / 19) + 0.14 * t.noise(x / 8, y / 8);

  const longest = (m, least) => {
    const c = components(m);
    const run = new Int32Array(c.count);
    for (const p of m.points) run[c.label(p)]++;
    return m.points.filter((p) => run[c.label(p)] > least).inducedEdges().extract();
  };
  // the drawable rectangle onto the chart's unit square: an affine cage
  const sheet = [[0, 0], [t.width, 0], [t.width, t.height], [0, t.height]];
  const chart = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const onChart = (m) => warp(m, { from: sheet, to: chart });

  const crest = onChart(longest(t.ridges(height, { step: 1.1 }), 11));
  const water = onChart(longest(t.ridges((x, y) => -height(x, y), { step: 1.1 }), 18));

  const ground = plane(4)
    .subdivide(6)
    .displace((p) => [0, 0, 0.62 * height(((p.x + 2) / 4) * t.width, ((p.y + 2) / 4) * t.height)])
    .style({ creaseAngle: 180 });

  return view(
    [
      ground,
      style(mapSurface(ground, crest), { stroke: 'ink' }),
      style(mapSurface(ground, water), { stroke: 'water' }),
    ],
    { camera: perspective({ eye: [0.2, -6.4, 2.5], target: [0, 0.15, -0.15], fovDegrees: 32 }), stroke: 'ink' },
  );
});
```
