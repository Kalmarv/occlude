# Fills

A fill is texture inside a closed shape: parallel lines, crossed lines, dots, or solid ink. This page covers the built-in patterns and their parameters, how texture lines up across neighbouring shapes, which pen draws the fill, what a filled shape does to geometry beneath it, and how to write and save a fill of your own.

Pass a fill through the shape's `fill` option. JavaScript patterns generate against the deformed outline and are then clipped and occluded. Native contour fill first constructs the visible area, including clip edges and holes left by occluders, and generates its paths in Rust.

```ts live
import { sketch, circle, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(5, (k, u) =>
    circle(24 + u * 152, 50, 20, { fill: fill('hatch', { angle: u * 72, spacing: mm(0.6 + u * 1.4) }) }),
  ),
);
```

## Spacing and angle

Every pattern takes its parameters as one object: `fill('hatch', { angle: 45, spacing: mm(1) })`. Spacing is a length. Bare numbers are drawable units, so `mm()` is the usual choice for texture, since a plotted line's weight comes from the pen and the gap between lines is what reads as tone. The default spacing is three times the fill pen's nib width.

Angle is in degrees, measured from the drawable's x axis. Tone comes from the ratio of nib width to spacing: below about two nib widths, rows touch and the texture reads as grey; near one nib width it reads as black.

```ts live
import { sketch, rect, fill, mm } from 'occlude';

// Same angle, spacing from 4 mm down to 0.4 mm.
export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(6, (k, u) =>
    rect(6 + k * 32, 15, 26, 70, { fill: fill('hatch', { angle: 30, spacing: mm(4 - u * 3.6) }) }),
  ),
);
```

## Patterns

| Fill | Parameters (defaults) | Marks |
|---|---|---|
| `fill('hatch', p)` | `angle: 0`, `spacing: mm(3 × nib)`, `offset: 0`, `align: 'paper'` | Parallel lines |
| `fill('crosshatch', p)` | `angles: [0, 90]`, `spacing`, `offset`, `align` | One hatch pass per angle |
| `fill('stipple', p)` | `density: 0…1`, `minDist: mm(2 × nib)` | Poisson-spaced dots, plotted as pen taps |
| `fill('contour', p)` | `spacing: mm(0.9 × nib)` | Nested contours with short, checked connections |
| `fill('solid', p)` | `angle: 0` | Rows at 0.9 × nib, so they overlap into full coverage |

### crosshatch

Each entry in `angles` is a full hatch pass at the same spacing, so tone builds by layering. Three passes at 60° intervals give a dense, even grey.

```ts live
import { sketch, rect, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, () => [
  rect(14, 20, 50, 60, { fill: fill('crosshatch', { angles: [45], spacing: mm(1.2) }) }),
  rect(75, 20, 50, 60, { fill: fill('crosshatch', { angles: [45, 135], spacing: mm(1.2) }) }),
  rect(136, 20, 50, 60, { fill: fill('crosshatch', { angles: [0, 60, 120], spacing: mm(1.2) }) }),
]);
```

### stipple

Dots are placed with a minimum distance of roughly `minDist / density`, so density 1 is the tightest packing and 0.1 is sparse. Each dot is a single pen tap. For image-driven halftones, keep the fill uniform and thin it with `decimate: { fill: field }` instead (see Fields & variation).

```ts live
import { sketch, circle, fill } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 12 }, (t) =>
  t.times(4, (k, u) =>
    circle(28 + u * 144, 50, 22, { fill: fill('stipple', { density: 0.15 + u * 0.75 }) }),
  ),
);
```

### solid

Solid is a hatch at 0.9 nib widths, aligned to the shape, so rows overlap and every shape fills the same way wherever it sits. `angle` sets the plotting direction. Add `bridge` to the shape to join the rows into one serpentine stroke and save the pen lifts.

```ts live
import { sketch, circle, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(4, (k, u) => [
    circle(28 + u * 144, 28, 15, { fill: fill('hatch', { spacing: mm(1) }) }),
    circle(28 + u * 144, 72, 15, { fill: fill('solid', { angle: u * 90 }), bridge: mm(2) }),
  ]),
);
```

### contour

`fill('contour')` follows the visible area's boundaries with complete nested loops. Short connections link successive loops into long pen-down runs. Holes grow outward as the outer boundary moves inward; disconnected islands stay separate. Small vector patches complete gaps where contour fronts meet or disappear.

The aim is less time lifting and lowering the pen. It is especially useful for dense fills and repeated small shapes. It is not always faster than bridged solid: tight turns and extra residual strokes also take time. Connections are intended fill ink and remain when `t.plan({ bridge: false })` disables generic gap bridging.

```ts live
import { sketch, circle, rect, mask, fill, mm } from 'occlude';

// A solid medallion and a wider-spaced cut-paper variation.
export default sketch({ aspect: [2, 1], margin: 8 }, () => [
  circle(48, 50, 35, { stroke: false, fill: fill('contour') }),
  mask(circle(48, 50, 13)),
  rect(112, 15, 72, 70, 15, {
    stroke: false, fill: fill('contour', { spacing: mm(1.4) }),
  }),
  mask(circle(138, 42, 13)),
  mask(circle(160, 66, 9)),
]);
```

`spacing` is the only contour parameter. It must be positive and finite; bare numbers use drawable units and `mm()` uses paper millimetres. The default is 0.9 times the **fill pen's** width. Wider-than-nib spacing is a contour texture, with visible gaps. Draft quality coarsens spacing, so use final quality to assess coverage or plot time.

The first regular loop sits approximately half a nib inside the visible boundary. Round nibs cannot exactly fill every sharp mathematical corner while remaining entirely inside it; thin features use the usual centerline clipping and nib judging rules. Native geometry uses a total construction tolerance of `min(0.01 mm, nib / 20, spacing / 10)`, with absolute insets to avoid cumulative drift. Difficult offset components use a local native hatch fallback; exhausted geometry budgets produce a render error rather than silently increasing spacing.

Dash, decimation and wobble still apply and may break a run. Clipping never rejoins an intentional gap. Whole-chain selections become coarser when a contour fill produces a long run. The Fills page marks contour as **native · read-only**: it has no JavaScript generator to clone; existing JavaScript patterns remain cloneable.

## Alignment across shapes

By default a hatch is anchored to the paper: one ruling covers the whole sheet, and every shape with the same spacing and angle samples it. Adjacent shapes then tile into continuous texture, which is what a hatched map or a tiled floor wants. The cost is that each shape's marks depend on where it sits, so a field of small hatched dots looks uneven.

`align: 'shape'` anchors the ruling to the shape's own centre and axes instead. Every shape then carries identical marks, and the ruling turns with the shape's `rotate`.

```ts live
import { sketch, rect, fill, mm } from 'occlude';

// Left: paper-aligned, the hatch runs through the joints. Right: shape-aligned,
// each square carries the same marks and turns with its own rotation.
export default sketch({ aspect: [2, 1] }, (t) => {
  const paper = fill('hatch', { angle: 45, spacing: mm(1.4) });
  const shape = fill('hatch', { angle: 45, spacing: mm(1.4), align: 'shape' });
  return [
    t.grid({ cols: 3, rows: 3 }).map((c) => rect(8 + c.i * 27, 8 + c.j * 27, 26, 26, { fill: paper })),
    t.grid({ cols: 3, rows: 3 }).map((c) =>
      rect(118 + c.i * 27, 8 + c.j * 27, 26, 26, { fill: shape, rotate: c.i * 15, translate: [131 + c.i * 27, 21 + c.j * 27] }),
    ),
  ];
});
```

## Fill pens

The outline is drawn with the shape's `pen`; the fill uses the same pen unless `fillPen` names another. `stroke: false` drops the outline and leaves the texture alone. The examples on this site use the default pen library, so the pen names below resolve; a sketch of your own uses whatever the studio's pen page defines.

```ts live
import { sketch, circle, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, () => [
  circle(40, 50, 30, { fill: fill('hatch', { angle: 20, spacing: mm(1) }) }),
  circle(100, 50, 30, { pen: 'pigma-01-black', fillPen: 'stabilo-88-blue', fill: fill('hatch', { angle: 20, spacing: mm(1) }) }),
  circle(160, 50, 30, { fillPen: 'stabilo-88-green', stroke: false, fill: fill('crosshatch', { spacing: mm(1.5) }) }),
]);
```

## Filled shapes and what lies beneath

In the current version a fill makes the shape opaque: anything earlier in the tree that lies under the shape's area is hidden, texture or not. `opaque: true` without a fill hides in the same way and draws only the outline. There is no way today to draw a texture that does not hide what is beneath it; overlapping textures always resolve to whichever shape comes later.

This is a known disagreement with the project's design notes, which describe fill and opacity as independent settings. The intended behaviour has not been implemented, and this page documents what the code does now. If the independent form ships, filled shapes in existing sketches will keep hiding by default and a non-hiding texture will be an explicit option.

```ts live
import { sketch, circle, rect, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, () => [
  rect(20, 20, 70, 60, { fill: fill('hatch', { angle: 0, spacing: mm(1.2) }) }),
  circle(90, 50, 28, { fill: fill('hatch', { angle: 90, spacing: mm(1.2) }) }),   // hides the rect under it
  circle(150, 50, 28, { opaque: true }),                                            // hides, no texture
  rect(120, 20, 70, 60, { fill: fill('hatch', { angle: 0, spacing: mm(1.2) }) }),  // later, so it hides the plain circle
]);
```

## A composition

Overlapping leaves, each hatched along its own axis. Later leaves hide earlier ones, and shape alignment keeps every leaf's grain parallel to its length.

```ts live
import { sketch, ellipse, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) =>
  t.times(26, (k) => {
    const x = t.rnd(20, 180);
    const y = t.rnd(20, 80);
    const a = t.rnd(360);
    return ellipse(x, y, t.rnd(16, 26), t.rnd(6, 10), a, {
      fill: fill('hatch', { angle: a, spacing: mm(0.7 + t.rnd(0.9)), align: 'shape' }),
    });
  }),
);
```

## Writing a fill

A fill is a function of the region to be filled. Pass it inline as `fill: (region, ctx) => strokes`. It runs during the render for that one shape and returns raw strokes in paper millimetres. The engine draws them with the fill pen, clips them to the region exactly (overshooting is fine), and occludes them like every other mark. Strokes carry no pen, opacity or z of their own.

```ts
(region, ctx) => {
  region.bbox              // { x, y, w, h } in mm
  region.contains(x, y)    // point test, respecting the winding rule
  region.path              // the outline as contours of exact primitives
  ctx.penWidth             // fill pen nib, mm
  ctx.rnd()                // seeded [0, 1), a sub-stream per shape
  ctx.len(l)               // resolve a length (mm(), w(), bare units) to mm
  ctx.coarsen              // draft-quality hint, 1 = exact; multiply spacing by it
  ctx.anchor               // shape-local mm → paper mm affine, plus .rotation
}
```

Use `ctx.rnd()` rather than `Math.random()`, so the fill is reproducible from the sketch seed. The return value is an array of stroke records:

```ts
{ type: 'line',  x1, y1, x2, y2 }
{ type: 'arc',   cx, cy, r, start, sweep }        // full circle: start 0, sweep 2π
{ type: 'cubic', x1, y1, cx1, cy1, cx2, cy2, x2, y2 }
{ type: 'polyline', pts: [[x, y], ...] }
```

A polyline is one connected pen stroke, and the nib rule judges it as a whole: a finely stepped squiggle is drawable ink, not a series of sub-nib crumbs.

Variable-radius dots, sized by distance from a light source. Each dot is a full-circle arc.

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 3 }, () =>
  circle(100, 50, 42, {
    fill: (region, ctx) => {
      const b = region.bbox;
      const dots = [];
      while (dots.length < 900) {
        const x = b.x + ctx.rnd() * b.w;
        const y = b.y + ctx.rnd() * b.h;
        if (!region.contains(x, y)) continue;
        const shade = Math.hypot(x - (b.x + b.w * 0.35), y - (b.y + b.h * 0.3)) / (b.w * 0.8);
        dots.push({ type: 'arc', cx: x, cy: y, r: 0.1 + shade * shade * 1.8, start: 0, sweep: Math.PI * 2 });
      }
      return dots;
    },
  }),
);
```

A custom fill is for marks, not for content. To put real shapes inside a region, with their own fills, modifiers and occlusion among themselves, use `clip(region, ...children)` from Shapes & layout.

### rulings

`rulings(region, { spacing, angle, offset, align, anchor })` is the line generator under hatch, crosshatch and solid, exported for fills of your own. It returns parallel lines across the region's bounding box. Spacing is in paper millimetres here, so scale a declared length with `ctx.len`. Pass `align: 'shape'` with `anchor: ctx.anchor` to turn the ruling with the shape.

```ts live
import { sketch, circle, rulings } from 'occlude';

// Spacing per shape, from six nib widths down to one and a half.
export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(5, (k, u) =>
    circle(24 + u * 152, 50, 20, {
      fill: (region, ctx) =>
        rulings(region, { spacing: ctx.penWidth * (1.5 + 6 * (1 - u)), angle: 30 + k * 25, align: 'shape', anchor: ctx.anchor }),
    }),
  ),
);
```

### Fill files and the library

A fill file is a fill as a standalone module: declared parameters plus a generator that imports nothing but occlude and captures nothing. That is what makes it storable and shareable.

```ts
import { fillAsset, rulings, mm } from 'occlude';

export default fillAsset({
  params: { spacing: mm(1.5), angle: 45 },
  generate(region, p, ctx) {
    return rulings(region, { spacing: ctx.len(p.spacing) * ctx.coarsen, angle: p.angle });
  },
});
```

A fill module can be used by value in the sketch that defines it: `fill(myAsset, { angle: 60 })`. Saved on the studio's Fills page under a name, it is used like a built-in: `fill('grain', { angle: 60 })`. Call-site parameters override the declared defaults. The name must be a string literal, because the studio scans sketches for fill names to load them, warn on edits, and rewire imports. The render worker, the headless tools and this site all read the same library.

Field parameters declared by a fill file arrive already anchored: the runtime hands the generator a sampler in the region's paper-millimetre coordinates, mapped through the use's `align`, so the fill never converts coordinates itself.

Rules the library keeps:

- The built-in fills resolve from the package, never from the library, and open read-only. Changing a shipped fill's ink would change every saved sketch that names it, so an altered version needs a new name. Clone copies a built-in into a file you own.
- Saving a fill that saved sketches reference is, in effect, an edit to those sketches. The Fills page lists them at save time and offers Clone (a fresh name) as the default and Edit anyway as the deliberate choice. Your sketches are never rewritten for you.
- Download .ts appends the source of every custom fill the sketch uses in a comment block at the end of the file. Import .ts restores them: identical content reuses the name, and a mismatch imports under a fresh name and updates the sketch's fill literal to match.
- A fill must be a pure function of region, parameters and context. Anything else can differ between preview and plot.
