# Fields & variation

Seeded randomness and noise, remapping and shaping values, scalar and vector fields over the page, and the contours and flow lines that read them.

## Randomness

All randomness is seeded by the sketch (`seed` in the config, or the URL's
`?seed=`): the same seed always draws the same picture — on screen and on
paper.

### rnd / pick / chance

`rnd()` 0–1, `rnd(n)` 0–n, `rnd(a, b)`; `pick(arr)` one element;
`chance(p)` a boolean.

```ts live
import { sketch, circle, rect } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 21 }, (t) =>
  t.times(60, () => {
    const x = t.rnd(4, 96);
    const y = t.rnd(4, 46);
    const r = t.rnd(1, 5);
    return t.chance(0.7) ? circle(x, y, r) : rect(x - r, y - r, r * 2, r * 2);
  }),
);
```

### noise

`noise(x, y?, z?)` — seeded smooth noise in −1…1. Sample it at a coarse
scale for terrain, fine for texture; the same coordinates always return
the same value within a seed.

```ts live
import { sketch, path } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) =>
  t.times(16, (k) => {
    const p = path().moveTo(0, 48);
    for (let x = 0; x <= 100; x += 2.5) {
      p.lineTo(x, 44 - k * 2.4 - t.noise(x * 0.03 + k * 0.15, k * 0.5) * 9);
    }
    return p.build();
  }),
);
```

### stream

`stream(name)` — an independent random stream keyed off the master seed
(`rnd/pick/chance/noise` on it). Parts of a composition that draw from
their own streams don't reshuffle each other when you edit one — iterate
the stars without moving the mountains.

```ts live
import { sketch, circle, path } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 14 }, (t) => {
  const stars = t.stream('stars');
  const ground = t.stream('ground');
  const ridge = path().moveTo(0, 50);
  for (let x = 0; x <= 100; x += 4) ridge.lineTo(x, 38 - ground.noise(x * 0.06) * 8);
  return [
    t.times(40, () => circle(stars.rnd(100), stars.rnd(26), stars.rnd(0.2, 0.7))),
    ridge.build(),
  ];
});
```

### map / norm / invertRange & ease

`map(v, a, b, c, d)` remaps ranges; `norm` to 0–1; `invertRange(v, max,
min?)` mirrors a value within a range (`invert` now complements clip
regions — see Combinators).
`ease.*` reshapes a normalised t — when t drives spacing, local density is
the curve's slope.

```ts live
import { sketch, line, ease } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  t.times(22, (k, u) => line(4, 3 + u * 20, 48, 3 + u * 20)),                 // linear
  t.times(22, (k, u) => line(52, 3 + ease.cubicIn(u) * 20, 96, 3 + ease.cubicIn(u) * 20)),
  t.times(22, (k, u) => line(4, 27 + ease.bounceOut(u) * 20, 48, 27 + ease.bounceOut(u) * 20)),
  t.times(22, (k, u) => line(52, 27 + ease.backInOut(u) * 20, 96, 27 + ease.backInOut(u) * 20)),
]);
```

### shaper

`shaper(points, { method? })` — the tone curve from image editors as a
value: knots, a curve through them (Akima by default; `'cubic'` or
`'linear'`), and the result is a function. **The knots define the area**:
the input runs from the first knot's x to the last's, the output stays
between the lowest and highest knot. `[[0, 0], [1, 1]]` is a unit tone
curve; `[[0, 0.65], [1, 3.75]]` turns a 0–1 luminance straight into
millimetres of spacing; `[[0, 1], [1, 0]]` inverts. Lift the middle and
midtones rise, flatten an end and it clips, an S adds contrast. Generic,
not image-specific: a field's contrast, an easing for a sweep, streamline
spacing by tone. In the studio the knot literal gets a curve editor beside
the `ui()` sliders, its corners labelled with the area — drag a knot,
double-click empty space to add one, double-click a knot to remove it —
and every change rewrites the array in the code, so the sketch stays the
spec. The editor's box is the knots' span as written, fixed while you
drag; give `{ bounds: [[x0, y0], [x1, y1]] }` to pin the area explicitly
(the input runs x0–x1, the output is clamped to y0–y1) so it survives
knots being dragged to the edge — and with bounds, every knot moves
freely inside the box.

```ts live
import { sketch, circle, shaper } from 'occlude';

// Dot sizes through a drawn curve: an S pushes the mids apart.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const tone = shaper([[0, 0], [0.3, 0.12], [0.7, 0.88], [1, 1]]);
  return t.grid({ cols: 24, rows: 12 }).map((c) => {
    const v = tone(t.noise(c.x / 22, c.y / 22) * 0.5 + 0.5);
    return v > 0.03 ? circle(c.x + c.w / 2, c.y + c.h / 2, v * c.w * 0.48) : null;
  });
});
```

### isolines

`isolines(field, at, { step?, close? })` — contours of `field ≥ at` by
marching squares over the drawable: the bridge from scalar fields to
stampable geometry (noise blobs, metaballs via SDF fields, tonal bands
from `image()` samplers). Returns plain contour data `{ pts, closed }`:
`polygon(c.pts)` stamps one loop; `polygon(blobs.map((c) => c.pts))`
lifts a whole level set into ONE shape (holes respected) for
`clip`/`mask`/fills. A contour that exits the drawable edge comes back
open (`closed: false`); pass `close: true` to close every region along
the edge — the form `clip` and fills want. `stroke(c)` strokes a contour
with the right seams and open ends (`polygon` always closes; a bare
`[x, y][]` traces open). An array of levels marches
them all over one shared field sampling. The step defaults to ~mm(1);
crossings are edge-interpolated, so positional accuracy is far finer
than the grid.

```ts live
import { sketch, polygon, fill, mm } from 'occlude';

// Posterized tone: each level is opaque, so the denser inner hatch
// REPLACES the coarse one where they overlap — fill means occlude.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const field = (x, y) => t.noise(x / 16, y / 16);
  return [
    t.isolines(field, 0.15, { close: true }).map((c) =>
      polygon(c.pts, { fill: fill('hatch', { angle: 30, spacing: mm(1.6) }) })),
    t.isolines(field, 0.5, { close: true }).map((c) =>
      polygon(c.pts, { fill: fill('hatch', { angle: 120, spacing: mm(0.7) }) })),
  ];
});
```

### streamlines

`t.streamlines(field, { spacing?, minSpacing?, step?, seeds? })` — evenly
spaced streamlines of a vector field over the drawable (Jobard & Lefer):
the bridge from vector fields to stampable geometry, the twin of
`isolines` for flow. Returns open contours `{ pts, closed: false }`, so
`stroke(c)` stamps them. Lines stop at the drawable edge, at a `within()`
bound, and half a spacing from ink already laid, so they never cross or
bunch. `spacing` is a length (default mm(1); at the nib width the result
is a flow-following solid) **or a field of lengths**, `(x, y) => mm(…)` or
bare units — density as tone, direction as flow; `minSpacing` (default
mm(0.3)) is its floor.
Deterministic: no seed, a pure function of the fields. Long continuous
lines with few lifts are the cheapest ink a plotter can draw.

```ts live
import { sketch, stroke, curl } from 'occlude';

// The flow-field look: streamlines of the curl of noise never converge.
export default sketch({ aspect: [3, 2], seed: 4 }, (t) => {
  const flow = curl((x, y) => t.noise(x / 30, y / 30));
  return t.streamlines(flow, { spacing: 1.6 }).map((c) => stroke(c));
});
```

```ts live
import { sketch, circle, stroke, curl, within, distanceTo } from 'occlude';

// Hatch that wraps a form: the curl of a distance field runs along the
// outline, and density from the distance fades it with the distance.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const blob = circle(50, 25, 12);
  const d = distanceTo(t.polylines(blob));
  const around = within(curl(d), circle(50, 25, 24));
  return [
    blob,
    t.streamlines(around, { spacing: (x, y) => 0.6 + d(x, y) * 0.25 }).map((c) => stroke(c)),
  ];
});
```

`grad(f, h?)` and `curl(f, h?)` are pure imports that lift a scalar field to
a vector one: the gradient points uphill, the curl is the gradient turned
90°, so it runs along `f`'s contours and never converges. A `within()`
bound on `f` carries through. Streamlines of `curl(f)` at nib spacing are
the isolines of `f`, densely — one mechanism seen twice.

### fields

Fields — any `(x, y) => number` — are citizens: `within(f, shape)` bounds
a field's domain (outside it is ABSENT: generators make nothing there,
modifiers touch nothing); `rotate(f, deg)`, `translate(f, dx, dy)`, and
`scale(f, s)` transform the sampling explicitly (nothing is ambient —
wanting a paper-pinned texture under a rotated motif means NOT
transforming the field). Transformed fields stay plain callables, so
lambdas remain the composition language. Vector fields (deform) follow
the iron-filings rule — wrap custom ones in `vectorField(fn)` and
rotation turns the arrows too; magnitudes never scale (a 2mm wobble is
2mm at any motif size). Isoline contours truncate OPEN at a domain edge,
exactly like the paper edge.

**Anchoring at the point of use.** Every consumer of a field takes
`align`: `'paper'` (default) samples the field in paper coordinates;
`'shape'` anchors it to the shape — the shape's intrinsic bbox centre is
field (0, 0) and the field turns with the motif's explicit transforms
(group and shape-level `translate`/`rotate`/`scale`, mirrors included).
One meaning everywhere: on a fill use it applies to the fill's field
params and to the fill's own geometry (`ctx.anchor`), on a modifier's
param object (`decimate: { fill: f, align: 'shape' }`, `wobble: {
amount, align }`, `roughen({ amount, align })`, `deform({ field, align
})`) to that modifier. Coordinate-placed shapes see identical marks
wherever they sit (the halftone case); a thousand shape-aligned uses
share ONE raster — the anchor is a per-use transform, never a per-shape
grid. Engine-consumed modifier fields get `within()` bounds as exact
vector regions: a bounded wobble stops on the line, not in a fade band
(decimate judges each fragment once, at its midpoint — clip the ink with
`clip()` if a fragment must be cut at the edge).

```ts live
import { sketch, circle, stroke, rotate, within } from 'occlude';

// Grain bounded to a blob and rotated 30° — contours end at the bound.
export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const grain = rotate((x, y) => t.noise(x / 5, y / 22), 30);
  const f = within(grain, circle(50, 25, 18));
  return [
    circle(50, 25, 18),
    t.isolines(f, [0.1, 0.35, 0.6], { step: 0.4 }).flat().map((c) => stroke(c)),
  ];
});
```

### polylines

`t.polylines(shape, { tolerance? })` — any shape value as its polylines:
plain points in sketch coordinates, through the one lowerer (rectMode, arc
commands, the shape's own `translate`/`rotate`/`scale`, curves flattened
at `tolerance`, default 0.05 mm) — so the polylines are exactly what the
shape inks. The bridge from shapes to everything that eats points:
`distanceTo`, `polygon`, `stroke`, `points`. Closed shapes give closed
polylines; an open path gives an open one.

```ts live
import { sketch, circle, rect, stroke } from 'occlude';

// Rings around a rotated rect: the rect's own outline as polylines, then
// distanceTo, then isolines — no geometry written by hand.
export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const box = rect(50, 25, 26, 14, { rotate: 20, mode: 'center' });
  const d = t.distanceTo(t.polylines(box));
  return [box, t.isolines(d, [-3, -6, -9, -12], { step: 0.5 }).flat().map((c) => stroke(c))];
});
```

### distanceTo

`distanceTo(loops)` — the bridge back from stampable geometry to scalar
fields: a signed distance field from boundary loops. POSITIVE inside,
zero on the boundary, negative outside — so `isolines(d, 2)` traces a
ring 2 units deep (inset/offset IS this recipe; there is no `offset()`),
and `isolines(d, -2)` traces a halo 2 units out. Insideness is even-odd
over the loops like `polygon()`: nesting makes holes, orientation never
matters; open loops get their closing chord. Strictly loops — wrapper
records expose theirs (`distanceTo(blobs.map((c) => c.pts))`). Pure and
deterministic; distances come back in the units of the input points, and
it composes anywhere a field goes: scatter densities, decimate/deform
params, not just contours.

```ts live
import { sketch, polygon, path, distanceTo } from 'occlude';

// A blob filled with its own echo: rings every 2.5 units, plus a halo.
// Contours that exit the drawable come back open — stamp those as open
// paths (polygon() would close them with a chord across the page).
export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const stamp = (c) => {
    if (c.closed) return polygon(c.pts);
    const p = path().moveTo(...c.pts[0]);
    for (const pt of c.pts.slice(1)) p.lineTo(...pt);
    return p.build();
  };
  const blob = t.isolines((x, y) => t.noise(x / 14, y / 14), 0.3, {
    close: true, step: 1,
  });
  const d = distanceTo(blob.map((c) => c.pts));
  return [
    polygon(blob.map((c) => c.pts)),
    t.isolines(d, [2.5, 5, 7.5, 10, 12.5], { step: 0.7 }).flat().map(stamp),
    t.isolines(d, -2.5, { step: 0.7 }).map(stamp),
  ];
});
```

## Fields

Any scalar parameter marked "fielded" also takes `(x, y) => number` —
called in user coordinates and rasterised over the page at encode time, so
the value varies spatially. Deterministic and plotter-reproducible;
anything goes inside (math, `noise`, image lookups).

Fielded params: `decimate` probabilities, `wobble` amount, `roughen`
amount, `deform`'s vector field. Each takes `align` beside the field
(`'paper'` default, `'shape'` to anchor to the shape — see
[fields](#fields)). A field on a fill's decimate is a halftone — here
`dash` chops the hatch into cells and a radial field erodes them away
from the centre:

```ts live
import { sketch, rect, fill, modify, dash, decimate, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, () =>
  modify(
    [dash(mm(1.2), mm(0.8)), decimate((x, y) => Math.hypot(x - 50, (y - 25) * 2.1) / 52)],
    rect(2, 3, 96, 44, { fill: fill('hatch', { angle: 45, spacing: mm(1.1) }), stroke: false }),
  ),
);
```

Shape-anchored modifier fields travel with their motif. The same erosion
field, once paper-pinned (every square samples the paper's radial
gradient where it sits) and once shape-anchored (every square is eroded
from its own centre, turned with its group):

```ts live
import { sketch, rect, fill, group, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const erode = (x, y) => Math.min(1, Math.hypot(x, y) / 9);
  const sq = (x, y, align) =>
    rect(x, y, 14, 14, { fill: fill('hatch', { angle: 0, spacing: mm(0.7) }), stroke: false,
      decimate: { fill: (px, py) => erode(px - 50, py - 25), align: 'paper' } });
  const anchored = (x, y) =>
    group({ rotate: 15 }, rect(x, y, 14, 14, { fill: fill('hatch', { angle: 0, spacing: mm(0.7), align: 'shape' }),
      stroke: false, decimate: { fill: erode, align: 'shape' } }));
  return [
    t.times(3, (k) => sq(6 + k * 18, 6)),
    t.times(3, (k) => anchored(60 + k * 12, -12 + k * 2)),
  ];
});
```
