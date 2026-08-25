# occlude API reference

Everything a sketch imports comes from `'occlude'`. Shapes record immediately;
nothing is clipped until `render()`.

## Sketch setup

```ts
sketch({ aspect: [3, 2], seed: 'url', origin: 'topLeft', yUp: false });
margin(5);                 // percent inset; coords measure inside it
pen('pigma-005-black');    // current pen; throws on unknown names
pen({ name: 'wide', width: 0.7, color: '#223388' });  // ad-hoc pen, this sketch only
```

- `aspect`: `[w, h]` | `'square'` | `'paper'` (default). Fixed aspects are
  letterboxed onto whatever paper is selected at render/export.
- `seed`: `'url'` reads `?seed=` (falls back to random and logs it), or pass a
  number/string directly. One stream drives `rnd`, `noise`, and stipple.
- `origin`: `'topLeft'` (default) or `'center'`. `yUp` flips the y axis.

## Units

A bare number is **percent of the short side** of the drawable area.
Tagged wrappers resolve when paper is known:

| Wrapper | Meaning |
|---|---|
| `w(n)` | percent of drawable width |
| `h(n)` | percent of drawable height |
| `long(n)` | percent of the long side |
| `mm(n)` | real millimetres — for anything physical |

Bare-number pitfall: percent-of-short-side means the **long axis runs past
100** whenever the drawable isn't square (A4 portrait: y runs 0→~141).
`bounds()` gives the real extent in the same bare units:

```ts
const b = bounds();          // { w, h, cx, cy } — short side is always 100
rect(0, 0, b.w, b.h);        // true full-bleed rect
circle(b.cx, b.cy, 40);      // truly centred
```

For a fixed `aspect` this is exact; for `aspect: 'paper'` it reflects the
paper the studio is about to render (A4 portrait when running standalone).

## Shapes

All return a `Shape` and record it. Positional args are the primary form.

```ts
circle(x, y, r)
ellipse(x, y, rx, ry, rotation?)          // rotation in degrees
rect(x, y, w, h, radius?)                 // radius rounds the corners
line(x1, y1, x2, y2)
polygon(x, y, sides, r, rotation?)        // regular n-gon
polygon([[x, y], ...])                    // explicit points
path({ winding? })                        // builder, see below
  .moveTo(x, y).lineTo(x, y)
  .bezierTo(c0x, c0y, c1x, c1y, x, y)
  .quadTo(cx, cy, x, y)
  .arcTo(x, y, r)                         // minor arc; sign of r picks the side
  .close()
```

Chainable methods (mutate in place, return the shape):

| Method | Effect |
|---|---|
| `.fill(spec?, pen?)` | Makes the shape opaque — it now hides what's beneath it. Throws on open paths. Pen defaults to the current pen. |
| `.fill(false)` | Opaque with **zero ink**: occludes, draws no fill; the stroke stays. |
| `.mask()` | Occludes and draws *nothing* — no fill, no stroke. The hidden-line renderer's workhorse. |
| `.stroke(pen \| false)` | Outline pen; `false` for fill-only. |
| `.noStroke()` | Alias for `.stroke(false)`. |
| `.pen(p)` | Sets stroke and fill pen together. |
| `.z(n)` | Stacking override; default z is draw index. Ties break by draw order. |
| `.clone()` | Records a duplicate (same geometry, transform, clips, pens) at the current draw position and returns it for further chaining. On a `path()` shape the clone keeps the builder API, so you can extend the copy. |

Hidden-line rendering in three lines — the mask is why occlusion exists:

```ts
const ridge = path().moveTo(0, 60).lineTo(30, 30).lineTo(70, 55).lineTo(100, 40);
ridge.clone().lineTo(100, 100).lineTo(0, 100).close().mask();  // hides everything below the crest
// … later shapes drawn "behind" the ridge now vanish beneath it.
```

## Fills

Fills are texture, not solid black. All spacing/distance defaults derive from
the fill pen's nib width.

```ts
hatch(angle = 0, spacing = mm(3 × penWidth), offset = 0)   // parallel lines
crosshatch(angles = [0, 90], spacing?, offset = 0)          // n hatch passes
stipple(density = 0.5, minDist = mm(2 × penWidth))          // Poisson-disk dots
```

Every fill also takes an object form, so you can set one option without
spelling out the ones before it:

```ts
hatch({ angle: 45, offset: rnd(3) })
crosshatch({ angles: [0, 60, 120], spacing: mm(1.2) })
stipple({ density: 0.7 })
```

### Custom fills

Custom fills are plain functions and go through the normal occlusion path.
**Coordinates are paper millimetres**, not sketch units, and `ctx.rnd()` is
seeded per-shape from the sketch seed — use it instead of `Math.random()` so
plots stay reproducible from the URL.

The region argument carries the real geometry, not just a box:

```ts
(region, ctx) => {
  region.bbox              // { x, y, w, h } in mm
  region.contains(x, y)    // point test (respects the winding rule)
  region.path              // the actual outline: contours of exact primitives
  region.area              // mm², holes subtracted
  ctx.penWidth             // fill pen nib, mm
  ctx.rnd()                // seeded [0, 1)
}
```

The full primitive set a custom fill may return:

```ts
{ type: 'line',  x1, y1, x2, y2 }
{ type: 'arc',   cx, cy, r, start, sweep }        // full circle: start 0, sweep 2π
{ type: 'cubic', x1, y1, cx1, cy1, cx2, cy2, x2, y2 }
{ type: 'polyline', pts: [[x, y], ...] }          // one entry instead of n-1 lines
```

Overshooting the region is fine — everything is clipped exactly to the
boundary afterwards; `contains` is for generation efficiency. Two idioms:

```ts
// Variable-radius dot shading: tiny full circles as single arcs.
circle(50, 50, 30).fill((region, ctx) => {
  const dots = [];
  while (dots.length < 400) {
    const x = region.bbox.x + ctx.rnd() * region.bbox.w;
    const y = region.bbox.y + ctx.rnd() * region.bbox.h;
    if (!region.contains(x, y)) continue;
    dots.push({ type: 'arc', cx: x, cy: y, r: 0.3 + ctx.rnd() * 1.2,
                start: 0, sweep: Math.PI * 2 });
  }
  return dots;
});

// Dense wander: one polyline instead of thousands of line objects.
rect(10, 10, 60, 40).fill((region, ctx) => {
  const pts = [[region.bbox.x, region.bbox.y + region.bbox.h / 2]];
  for (let i = 0; i < 2000; i++) {
    const [px, py] = pts[pts.length - 1];
    pts.push([px + region.bbox.w / 2000, py + (ctx.rnd() - 0.5) * 2]);
  }
  return [{ type: 'polyline', pts }];
});
```

## Transforms & clipping

```ts
push({ translate: [x, y], rotate: deg, scale: s }, () => { ... });
clip(circle(50, 50, 40), () => { ... });
```

- `push` scopes a transform to the callback; nesting composes; no unbalanced
  push/pop is possible. Within one op the order is translate → rotate → scale.
- `clip` restricts everything created inside to the region. The clip shape is
  not drawn and does not occlude.
- Rotation/uniform scale keep arcs exact; non-uniform scale lowers arcs to
  cubics automatically.

## Random & noise

```ts
rnd()            // [0, 1)
rnd(n)           // [0, n)
rnd(a, b)        // [a, b)
pick(arr)        // random element
chance(p)        // boolean
prob(p, fn, elseFn?)
noise(x, y?, z?) // seeded simplex, ~[-1, 1]
map(v, a, b, c, d); norm(v, a, b); invert(v, max, min = 0)
```

The module-level functions share one stream, so inserting a shape shifts
every later value. When iterating on one part of a composition, give it its
own **named stream** — independent, keyed off the master seed, immune to
edits elsewhere:

```ts
const ridges = stream('ridges');
const trees  = stream('trees');
ridges.rnd(); ridges.noise(x, y); trees.pick(species);
// Reordering the sketch or drawing more from `trees` never shifts `ridges`.
```

## Layout helpers

```ts
grid({ cols, rows, gap? })   // → { x, y, w, h, i, j }[] inside the margin
noisyLine(x1, y1, x2, y2, { points, scale, amplitude, offset })
```

## Render & export

```ts
await initOcclude();                     // once, before the first render
const out = render({ paper: 'A4' });     // out.frags, out.prims, out.stats, out.pens
const jobs = exportGcode({ paper: 'A4', profile: { zMode: true } });
const svg  = exportSvg({ paper: 'A4', background: '#f6f2ea', onlyPen: 0 });
```

- `render` options: `paper` (preset name or `{ paper, landscape }`),
  `coarsen` (hatch/stipple coarsening for preview; 1 = exact),
  `stretch` (fill the paper, non-uniform), `unbounded` (skip the paper clip).
- `exportGcode` returns one job per pen:
  `{ pen, penName, gcode, inkMm, travelMm, estSeconds }`. `optimize` sets the
  2-opt tour budget (`false` disables, a number overrides).
- A `Fragment` is `{ origin, t0, t1, pen, shape, dot, geom }` — a sub-range of
  an original primitive with exact geometry in paper mm. `drawFragments(ctx,
  frags, pens)` paints them on a Canvas 2D context scaled to 1 unit = 1 mm.

## Pens & paper

- Pens: `{ name, width, color, feed, penDown, penUp, penDelay }` — width in mm
  is the system's one tolerance (detail below one nib width is dropped).
  `DEFAULT_PENS` ships a starter set; the studio persists its own library and
  injects it via `setPenLibrary(pens)`.
- Papers: `PAPERS` has A3–A6, Letter, Square20; custom sizes via
  `{ paper: { w, h } }`.
