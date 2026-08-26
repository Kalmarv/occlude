# occlude API reference

A sketch is a pure function from a toolkit to a tree of shape values:

```ts
import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8 }, ({ circle, hatch, bounds, rnd }) => {
  const b = bounds();
  return Array.from({ length: 24 }, () =>
    circle(rnd(b.w), rnd(b.h), rnd(6, 22), {
      fill: hatch({ angle: rnd(180), spacing: mm(rnd(0.6, 2)) }),
    }));
});
```

Shapes are plain values — nothing draws until the sketch is rendered. The
tree may nest arrays arbitrarily; it is flattened, **tree order is draw
order**, and falsy entries are skipped (so `cond && shape` composes).

The occlusion contract, in four rules:

1. **Later wins.** Opaque shapes hide everything before them in the tree;
   `z` overrides the ordering, ties break by tree order.
2. **Only fills/opacity occlude.** Strokes never hide anything, and stroke
   width never dilates an occluder.
3. **On the boundary counts as visible.** Ink lying exactly on an occluder's
   edge survives (shared edges draw once — duplicates are removed).
4. **The nib is the only tolerance.** Visible detail shorter than the pen
   width is dropped; hidden gaps shorter than the pen width are inked (a pen
   can't plot either one).

## sketch(config, fn)

```ts
sketch({
  aspect: [3, 2],        // [w, h] | 'square' | 'paper' (default)
  margin: 6,             // percent inset from the paper edge
  seed: 'url',           // 'url' reads ?seed= (default); or a number/string
  pen: 'pigma-005-black',// default pen for shapes that don't set one
  origin: 'topLeft',     // or 'center'
  yUp: false,
  rectMode: 'corner',    // or 'center' — p5-style rect anchoring default
}, (toolkit) => tree)
```

Fixed aspects are letterboxed onto whatever paper is selected at
render/export. Everything random derives from the seed — `rnd`, `noise`,
named `stream()`s, and stipple placement (decorrelated per shape, still
fully determined by the seed).

The `fn` receives the whole toolkit and returns the tree. Export the
definition (`export default` preferred); the studio and CLI render it.
Alongside the functions, the toolkit carries the drawable extent as plain
numbers — `width`, `height`, `cx`, `cy` (the same values `bounds()`
returns), so `({ rect, width, height }) => rect(0, 0, width, height)` is a
full-bleed rect with no ceremony.

## Shapes

Every shape takes a trailing opts object:

```ts
{ pen, fill, fillPen, opaque, stroke, z }
```

| Opt | Meaning |
|---|---|
| `pen` | Pen for the stroke and (by default) the fill texture. |
| `fill` | Fill texture — **implies opaque** (the shape hides what's beneath). |
| `fillPen` | Pen for the fill, when different from `pen`. |
| `opaque: true` | Hides what's beneath with **no texture** — only the stroke draws. |
| `stroke: false` | No outline. A pen name instead overrides the stroke pen. |
| `z` | Stacking override; default is tree order. |
| `mode` | rect only: anchor (x, y) at the `'corner'` (default) or the `'center'` — p5's rectMode, per shape. The config's `rectMode` sets the sketch-wide default. Circles, ellipses and n-gons are always centre-anchored. |
| `translate`, `rotate`, `scale` | Per-shape transform, identical to wrapping the shape in a `group` with the same op (order within the op: translate → rotate → scale). |
| `decimate` | Drop this fraction (0…1) of the shape's final visible strokes, after occlusion — seeded, deterministic. A number applies to everything; `{ stroke, fill }` targets outline and fill ink separately (`{ fill: 0.5 }` erodes the texture, keeps the outline crisp). Accepts a field. |
| `wobble` | Hand-tremor: displace the shape's final visible strokes with seeded smooth noise, after occlusion. A length is the amplitude (`wobble: mm(0.8)`); `{ amount, wavelength }` also sets the tremor scale (default wavelength `mm(25)` — smaller = jitterier). Amount accepts a field. |
| `modifiers` | Ordered modifier stack (see **Modifiers**): `{ modifiers: [smooth(2), wobble(mm(1)), decimate(0.2)] }` — entries run first-to-last. |

```ts
circle(x, y, r, opts?)
ellipse(x, y, rx, ry, rotation?, opts?)     // rotation in degrees
rect(x, y, w, h, radius?, opts?)            // radius rounds the corners; opts.mode anchors
line(x1, y1, x2, y2, opts?)
polygon(x, y, sides, r, rotation?, opts?)   // regular n-gon
polygon([[x, y], ...], opts?)               // explicit points
```

The path builder is mutable while you feed it; `build(opts?)` snapshots into
a shape value, and the builder stays extendable — the hidden-line ridge
idiom depends on this:

```ts
path({ winding? })
  .moveTo(x, y).lineTo(x, y)
  .bezierTo(c0x, c0y, c1x, c1y, x, y)
  .quadTo(cx, cy, x, y)
  .arcTo(x, y, r)              // minor arc; sign of r picks the side
  .close()
  .build(opts?)                // → Shape value
```

## Combinators

```ts
mask(shape)                    // { ...shape, opaque: true, stroke: false }
group(opts, ...children)       // transform / pen / z defaults for children
clip(shape, ...children)       // children restricted to shape's region
modify([...mods], ...children) // ordered modifier stack for the subtree
```

- `mask(shape)` occludes and draws **nothing** — the hidden-line renderer's
  workhorse.
- `group({ translate: [x, y], rotate: deg, scale: s, pen, z }, ...)` —
  transforms compose through nesting and pivot around the user origin
  (`origin: 'center'` → rotations spin in place). Rotation and uniform scale
  keep arcs exact; non-uniform scale lowers arcs to cubics.
- `clip` restricts children to the region; the region itself is not drawn
  and does not occlude. Nested clips intersect.

## Modifiers

Every shape carries an ordered **modifier stack**, applied around the
occlusion solve. The solve is the fixed point: **pre-stage** modifiers
deform the shape's geometry before it (they change *what is hidden* — the
modified silhouette occludes, and fills follow it); **post-stage**
modifiers distress the surviving ink afterwards (the scene is unchanged,
only the drawing changes). All are seeded and deterministic.

Each modifier is a plain value with a dual form: called bare it returns a
stack entry; called with children it wraps the subtree.

```ts
// post-stage: run on the FINAL visible strokes, after occlusion
decimate(p)                    // drop fraction p (0…1); { stroke, fill } targets ink kinds
wobble(amount)                 // hand-tremor; { amount, wavelength } sets tremor scale
dash(len, gap = len, offset?)  // chop strokes by length — phase-continuous, seamless on closed shapes

// pre-stage: deform the geometry BEFORE the solve
smooth(passes = 2)             // Chaikin corner-rounding (→ spline as passes grow)
roughen(amount, detail?)       // midpoint fracture: jagged edges (vs wobble's smooth tremor)
deform(vectorField)            // displace geometry by a field — occluded shapes peek through

// stacks
modify([dash(mm(2)), decimate(0.3)], ...shapes)   // order is authored: first-to-last
rect(…, { modifiers: [smooth(2), wobble(mm(1))] }) // per shape
```

Order matters and is yours: `smooth → wobble` reads as a careful hand,
`wobble → smooth` as lazy flowing ink; two `wobble`s at different
wavelengths layer into natural hand-drawn line quality; `dash` then
`decimate` deletes individual dashes (broken, stippled lines) while
`decimate` then `dash` deletes whole strokes first. Stacks compose in
function-application order — a shape's own list runs first, then `modify()`
ancestors inside-out. The `{ decimate }` / `{ wobble }` shorthand opts and
their combinator forms still work (nearest declaration wins, decimate
before wobble) and run after any explicit stack.

Pre-stage is the conscious performance choice: wrapped shapes' curves
flatten into polylines entering the solve, so only they pay for the heavier
solve. `deform` takes `(x, y) => [dx, dy]` in user units — write your own
or use `noiseField(amount, wavelength?)` for trembling *forms* (compare
post-`wobble`, which trembles only the ink and never reveals anything).

### Fields

Any scalar modifier parameter marked "accepts a field" also takes
`(x, y) => number` — called in user coordinates and rasterised over the
page at encode time, so the value varies spatially. Deterministic and
plotter-reproducible; anything goes inside (math, `noise`, image lookups).

```ts
decimate((x, y) => y / 100, ...shapes)             // dissolves toward the bottom
wobble({ amount: (x, y) => 2 * noise(x / 30, y / 30) }, ...shapes)
// halftone: dash chops the hatch, a field erodes it by position
modify([dash(mm(1.2), mm(0.8)), decimate((x, y) => brightness(x, y))],
  rect(0, 0, 100, 100, { fill: hatch(45, mm(1.2)) }))
```

Fielded params: `decimate` probabilities, `wobble` amount, `roughen`
amount. A field on `{ decimate: { fill } }` over a stipple fill is a
halftone — image-driven density through composition.

### Modifier reference

| Modifier | Stage | Parameters (defaults) | Fielded |
|---|---|---|---|
| `decimate(p)` | post | `p` 0…1, or `{ stroke, fill }` | both probabilities |
| `wobble(amount)` | post | amount (length); `{ amount, wavelength: mm(25) }` | amount |
| `dash(len, gap, offset?)` | post | lengths; `gap` defaults to `len`; pattern is phase-continuous along outlines and period-snapped on closed contours (no seam); `offset` shifts it | — |
| `smooth(passes)` | pre | `passes = 2` | — |
| `roughen(amount, detail?)` | pre | jitter length; resample `detail = mm(1.5)` | amount |
| `deform(field)` | pre | `(x, y) => [dx, dy]` user units, or `{ field, detail: mm(2) }` | the field itself |

The [guide](guide.md) walks through each with a runnable example.

Hidden-line terrain in a few lines:

```ts
sketch({ aspect: [3, 2], margin: 5 }, ({ path, mask, bounds, noise }) => {
  const b = bounds();
  return Array.from({ length: 9 }, (_, i) => {
    const baseY = b.h * (0.35 + (i / 8) * 0.6);          // far → near
    const crest = path().moveTo(0, baseY + noise(0, i) * 8);
    for (let x = 2; x <= b.w; x += 2) crest.lineTo(x, baseY + noise(x * 0.03, i * 3) * 8);
    const ridgeLine = crest.build();
    const ridgeMask = mask(crest.lineTo(b.w, b.h).lineTo(0, b.h).close().build());
    return [ridgeMask, ridgeLine];   // nearer ridges occlude farther ones
  });
});
```

## Units

There are two kinds of numbers, and mixing them up is the classic mistake:

- **Positions** want to be axis-relative — "80% across the page" is per-axis.
- **Sizes and distances** (radii, spacing, offsets) want to be **isotropic** —
  the same number must mean the same millimetres in x and y, or circles
  squash and "square" cells stretch.

| Wrapper | Reference | Use for |
|---|---|---|
| bare number | percent of the **short side** | sizes, and coordinates on square aspects |
| `w(n)` | percent of drawable width — `w(0)` left edge, `w(100)` right edge | x positions |
| `h(n)` | percent of drawable height — `h(0)` top, `h(100)` bottom | y positions |
| `s(n)` | percent of the **long side** (isotropic) — `s(100)` spans the long axis | sizes that scale with the sheet; coordinates |
| `mm(n)` | real millimetres | anything physical (hatch spacing, nib-relative things) |

`long(n)` is an alias of `s(n)`. On a square aspect all of bare/`w`/`h`/`s`
coincide.

Bare-number pitfall: percent-of-short-side means the **long axis runs past
100** whenever the drawable isn't square (A4 portrait: y runs 0→~141).
`bounds()` gives the real extent in bare units, and `grid()` tiles it:

```ts
const b = bounds();          // { w, h, cx, cy } — short side is always 100
rect(0, 0, b.w, b.h)         // true full-bleed rect
circle(b.cx, b.cy, 40)       // truly centred
```

For a fixed `aspect` this is exact; for `aspect: 'paper'` it reflects the
paper about to be rendered.

## Fills

Fills are texture, not solid black. All spacing/distance defaults derive
from the fill pen's nib width.

```ts
hatch(angle = 0, spacing = mm(3 × penWidth), offset = 0)   // parallel lines
crosshatch(angles = [0, 90], spacing?, offset = 0)          // n hatch passes
stipple(density = 0.5, minDist = mm(2 × penWidth))          // Poisson-disk dots
```

Every fill also takes an object form: `hatch({ angle: 45, offset: 3 })`,
`crosshatch({ angles: [0, 60, 120] })`, `stipple({ density: 0.7 })`.
Stipple density scales the Poisson disk: dot spacing ≈ `minDist / density`.

### Custom fills

A custom fill is a plain function passed as `fill:`; it goes through the
normal occlusion path. **Coordinates are paper millimetres**, and `ctx.rnd()`
is seeded per-shape from the sketch seed — use it instead of `Math.random()`.

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

Primitives it may return (overshooting the region is fine — everything is
clipped exactly to the boundary):

```ts
{ type: 'line',  x1, y1, x2, y2 }
{ type: 'arc',   cx, cy, r, start, sweep }        // full circle: start 0, sweep 2π
{ type: 'cubic', x1, y1, cx1, cy1, cx2, cy2, x2, y2 }
{ type: 'polyline', pts: [[x, y], ...] }          // one entry instead of n-1 lines
```

```ts
// Variable-radius dot shading: tiny full circles as single arcs.
circle(50, 50, 30, {
  fill: (region, ctx) => {
    const dots = [];
    while (dots.length < 400) {
      const x = region.bbox.x + ctx.rnd() * region.bbox.w;
      const y = region.bbox.y + ctx.rnd() * region.bbox.h;
      if (!region.contains(x, y)) continue;
      dots.push({ type: 'arc', cx: x, cy: y, r: 0.3 + ctx.rnd() * 1.2,
                  start: 0, sweep: Math.PI * 2 });
    }
    return dots;
  },
})
```

## Toolkit: randomness & layout

```ts
rnd()            // [0, 1)        rnd(n) → [0, n)      rnd(a, b) → [a, b)
pick(arr)        chance(p)       prob(p, fn, elseFn?)
noise(x, y?, z?) // seeded simplex, ~[-1, 1]
map(v, a, b, c, d); norm(v, a, b); invert(v, max, min = 0)
times(n, (i, t) => shape)    // the loop idiom: n results; t runs 0…1
range(n) / range(a, b, step?)  // integer sequences for mapping/nesting
bounds()         // drawable extent in bare units
grid({ cols, rows, gap? })   // cells tiling the whole drawable
noisyLine(x1, y1, x2, y2, { points, scale, amplitude, offset }, opts?)
stream(name)     // independent random stream keyed off the master seed
```

The plain `rnd`/`noise` share one stream, so inserting a shape shifts every
later value. When iterating on one part of a composition, give it a **named
stream** — immune to edits elsewhere:

```ts
const ridges = stream('ridges');
ridges.rnd(); ridges.noise(x, y);
```

`times` is the tree model's `for` loop — the normalised `t` makes
interpolating along the run one expression:

```ts
times(40, (k, t) =>
  rect(0, 0, 200, 20, 1, { translate: [width * 0.4, t * height], rotate: -t * 25 }))
```

## Render & export

```ts
await initOcclude();                         // once, before the first render
const out  = render(def, { paper: 'A4' });   // out.frags, out.prims, out.stats
const jobs = exportGcode(def, { paper: 'A4', profile: { zMode: true } });
const svg  = exportSvg(def, { paper: 'A4', background: '#f6f2ea', onlyPen: 0 });
const png  = exportPng(def, { paper: 'A4', scale: 11.81 });  // ≈ 300 dpi
```

- `render` options: `paper` (preset name or `{ paper, landscape }`),
  `coarsen` (preview coarsening; 1 = exact), `stretch` (fill the paper,
  non-uniform), `unbounded` (skip the paper clip).
- `exportGcode` returns one job per pen:
  `{ pen, penName, gcode, inkMm, travelMm, estSeconds }`. `optimize` sets
  the 2-opt tour budget (`false` disables, a number overrides).
- Headless CLI: `pnpm --filter occlude render <sketch.ts> --seed N --paper A4
  --out x.png [--svg x.svg]`.
- A `Fragment` is `{ origin, t0, t1, pen, shape, dot, geom }` — a sub-range
  of an original primitive with exact geometry in paper mm.
  `drawFragments(ctx, frags, pens)` paints them on a Canvas 2D context
  scaled to 1 unit = 1 mm.

## Pens & paper

- Pens: `{ name, width, color, feed, penDown, penUp, penDelay }` — width in
  mm is the system's one tolerance. Unknown pen names throw, so shared
  sketches fail loudly. `DEFAULT_PENS` ships a starter set; the studio
  persists its own library server-side and injects it via
  `setPenLibrary(pens)`.
- Papers: `PAPERS` has A3–A6, Letter, Square20; custom sizes via
  `{ paper: { w, h } }`.
