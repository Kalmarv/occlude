# occlude reference

Every entry is a live example: the canvas below each snippet is rendered by
the same engine the studio uses, right now, in your browser — if a change
breaks an example, this page shows it. **Open in studio** loads the snippet
into the editor.

Coordinates are bare units (percent of the drawable's short side) unless
wrapped — `mm(1)` is physical. Examples use the default pen library.

## Shapes

### circle

`circle(x, y, r, opts?)` — centre-anchored. With `fill` it becomes opaque
and hides what's beneath (that's the house rule: fill means occlude).

```ts live
import { sketch, circle, hatch, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(7, (k, u) =>
    circle(12 + u * 76, 25, 10, { fill: hatch(u * 90, mm(0.8 + u)) }),
  ),
);
```

### rect

`rect(x, y, w, h, radius?, opts?)` — corner-anchored by default
(`mode: 'center'` or the sketch-wide `rectMode` flips it); `radius` rounds
the corners.

```ts live
import { sketch, rect, stipple } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) =>
  t.times(5, (k, u) => [
    rect(6 + u * 72, 8, 16, 34, u * 8, { fill: stipple(0.25 + u * 0.55) }),
  ]),
);
```

### line

`line(x1, y1, x2, y2, opts?)` — the humble open stroke; everything the
occlusion engine does is easiest to see with a field of them.

```ts live
import { sketch, line, circle } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  t.times(11, (k, u) => line(0, 5 + u * 40, 100, 5 + u * 40)),
  circle(50, 25, 16, { opaque: true }),
]);
```

### ellipse

`ellipse(x, y, rx, ry, rotation?, opts?)` — rotation in degrees, about its
own centre.

```ts live
import { sketch, ellipse } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(9, (k, u) => ellipse(50, 25, 44 - u * 4, 20 - u * 2, u * 22)),
);
```

### polygon

`polygon(x, y, sides, r, rotation?, opts?)` for regular n-gons, or
`polygon([[x, y], …], opts?)` with explicit points.

```ts live
import { sketch, polygon, hatch, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(6, (k) =>
    polygon(10 + k * 16, 25, 3 + k, 8, 90, { fill: hatch(45, mm(1)) }),
  ),
);
```

### path

`path()` is a mutable builder: `moveTo/lineTo/bezierTo/quadTo/arcTo/close`,
then `build(opts?)` snapshots a shape — and the builder stays extendable,
which the hidden-line ridge idiom depends on.

```ts live
import { sketch, path } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 11 }, (t) =>
  t.times(14, (k) => {
    const p = path().moveTo(0, 46 - k * 3);
    for (let x = 5; x <= 100; x += 5) {
      p.lineTo(x, 46 - k * 3 - t.noise(x * 0.05, k * 0.4) * 14);
    }
    return p.build();
  }),
);
```

### label

`label(str, x, y, h, opts?)` — single-stroke plotter text (A–Z 0–9 and
basic punctuation), cap height `h`. `align: 'center' | 'right'` anchors
`x`; `labelWidth(str, h)` measures. `unit: 'mm'` for physical placement.

```ts live
import { sketch, label, line } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  line(50, 2, 50, 48),
  label('LEFT', 50, 8, 6),
  label('CENTER', 50, 20, 6, { align: 'center' }),
  label('RIGHT', 50, 32, 6, { align: 'right' }),
]);
```

## Combinators

### group

`group(opts, ...children)` — transforms (`translate`, `rotate`, `scale`),
pen/z defaults, and modifier defaults for a subtree. Transforms pivot
around the user origin, so `translate` first sets the pivot.

```ts live
import { sketch, group, rect } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) =>
  t.times(12, (k) =>
    group({ translate: [50, 50], rotate: k * 30 }, rect(16, -3, 30, 6)),
  ),
);
```

### clip

`clip(shape, ...children)` — children restricted to the shape's region; the
region itself is neither drawn nor occluding. Nested clips intersect.

```ts live
import { sketch, clip, circle, line } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  clip(circle(50, 25, 20), t.times(19, (k, u) => line(0, u * 50, 100, u * 50))),
  circle(50, 25, 20),
]);
```

### mask

`mask(shape)` — occludes and draws **nothing**: the hidden-line renderer's
workhorse, and the eraser for imported art's stray strokes.

```ts live
import { sketch, mask, circle, line } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  t.times(19, (k, u) => line(0, u * 50, 100, u * 50)),
  mask(circle(38, 25, 16)),
  circle(66, 25, 16, { opaque: true }), // compare: opaque draws its outline
]);
```

### modify

`modify([...mods], ...children)` — an ordered modifier stack over a
subtree. Stacks compose through nesting: inner runs before outer.

```ts live
import { sketch, modify, smooth, wobble, decimate, rect, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 3 }, (t) =>
  modify(
    [wobble(mm(0.6)), decimate(0.15)],
    t.times(9, (k, u) => rect(4 + u * 72, 8, 20, 34, 4)),
  ),
);
```

## Modifiers

Modifiers exist in two forms: shorthand opts on a shape
(`{ wobble: mm(1) }`) and stack entries (`modify([wobble(mm(1))], …)`).
Post-stage modifiers run on **final visible strokes, after occlusion** —
line character changes, hidden-line logic doesn't.

### wobble

Hand-tremor: seeded smooth-noise displacement.
`{ amount, wavelength }` sets the tremor scale; amount accepts a field.

```ts live
import { sketch, line, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 7 }, (t) =>
  t.times(12, (k, u) => line(5, 6 + u * 38, 95, 6 + u * 38, { wobble: mm(u * 1.4) })),
);
```

### decimate

Drop a fraction of final strokes — seeded, deterministic, field-aware.
`{ stroke, fill }` targets outline and fill ink separately.

```ts live
import { sketch, circle, hatch, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) =>
  t.times(4, (k, u) =>
    circle(14 + u * 72, 25, 11, {
      fill: hatch(45, mm(0.7)),
      decimate: { fill: u * 0.85 }, // erode the texture, keep the outline
    }),
  ),
);
```

### dash

`dash(len, gap, offset?)` — cut strokes into a dash pattern (physical
lengths). Runs after occlusion, so dashes flow through hidden-line cuts.

```ts live
import { sketch, modify, dash, circle, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  modify(
    [dash(mm(3), mm(2))],
    t.times(5, (k, u) => circle(50, 25, 6 + u * 14)),
  ),
);
```

### smooth / roughen

`smooth(passes)` relaxes corners toward curves; `roughen(amp, detail)`
crumbles clean edges into jitter. Both are pre-stage (they deform the
contour before the solve, so fills and occlusion follow the new outline).

```ts live
import { sketch, modify, smooth, roughen, polygon, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, () => [
  polygon(16, 25, 5, 14),
  modify([smooth(3)], polygon(50, 25, 5, 14)),
  modify([roughen(mm(1.2), mm(3))], polygon(84, 25, 5, 14)),
]);
```

### deform

`deform(vectorField)` — displace contours by an `(x, y) => [dx, dy]` field
before the solve. `noiseField(amount, wavelength?)` makes a ready-made one.

```ts live
import { sketch, modify, deform, noiseField, rect } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 2 }, (t) =>
  modify(
    [deform(noiseField(5, 18))],
    t.times(8, (k, u) => rect(6 + u * 74, 10, 14, 30)),
  ),
);
```

### bridge

Not a stack modifier — a shape/group **opt**. Joins the opted strokes'
endpoints pen-down across gaps up to the tolerance after occlusion:
hatch rows serpentine into single strokes, trading tiny connectors for
most of a plot's pen lifts. Opt-in per shape; connectors only span blank
paper; Debug view in the studio highlights them red.

```ts live
import { sketch, line, mm, group } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  // left: 14 strokes = 14 pen lifts. right: bridged into ONE stroke.
  t.times(14, (k) => line(6, 5 + k * 3, 42, 5 + k * 3)),
  group({ bridge: mm(3.5) }, t.times(14, (k) => line(58, 5 + k * 3, 94, 5 + k * 3))),
]);
```

## Fills

Fills draw texture inside a closed shape and **imply opaque**. The fill
pen defaults to the shape's pen; `fillPen` overrides.

### hatch

`hatch(angle?, spacing?, offset?)` — parallel lines. Spacing is a length
(`mm()` for physical). The ruling is **paper-anchored by default**: one
paper-wide grid that every same-spec fill samples, so adjacent shapes
tile into continuous texture. For many small shapes (halftone dots) that
makes each shape's marks depend on where it sits — pass the object form
`hatch({ angle, spacing, align: 'shape' })` to centre the ruling on each
shape instead: identical marks wherever the shape lands.

```ts live
import { sketch, circle, hatch, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(5, (k, u) => circle(12 + u * 76, 25, 10, { fill: hatch(u * 72, mm(0.6 + u * 1.4)) })),
);
```

### crosshatch

`crosshatch(angles?, spacing?)` — stacked hatch passes (default 0° + 90°).
Tone by layering.

```ts live
import { sketch, rect, crosshatch, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, () => [
  rect(8, 10, 22, 30, { fill: crosshatch([45], mm(1.2)) }),
  rect(39, 10, 22, 30, { fill: crosshatch([45, 135], mm(1.2)) }),
  rect(70, 10, 22, 30, { fill: crosshatch([0, 60, 120], mm(1.2)) }),
]);
```

### stipple

`stipple(density?, minDist?)` — Poisson-placed dots, plotted as pen taps.
Density accepts the 0–1 range; pair with `decimate: { fill: field }` for
image-driven halftones.

```ts live
import { sketch, circle, stipple } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 12 }, (t) =>
  t.times(4, (k, u) => circle(14 + u * 72, 25, 11, { fill: stipple(0.15 + u * 0.75) })),
);
```

### custom fills

A custom fill is a plain function passed as `fill:`. It runs inside the
render for the shape being filled, and it returns **raw ink strokes, not
shapes** — no pens, opacity, or z at this level, because the output *is*
the fill ink of that one shape: drawn with the fill pen, clipped exactly
to the region (overshooting is fine), and occluded like the built-in
fills. **Coordinates are paper millimetres**, and `ctx.rnd()` is seeded
per-shape from the sketch seed — use it instead of `Math.random()`.

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

Strokes are records of the engine's stroke vocabulary — everything in the
pipeline lowers to lines, arcs, and cubics, so any drawable mark is
expressible (`polyline` is just a compact form for a connected line run):

```ts
{ type: 'line',  x1, y1, x2, y2 }
{ type: 'arc',   cx, cy, r, start, sweep }        // full circle: start 0, sweep 2π
{ type: 'cubic', x1, y1, cx1, cy1, cx2, cy2, x2, y2 }
{ type: 'polyline', pts: [[x, y], ...] }
```

This is deliberately the low-level escape hatch, not the tool for
arbitrary content in a region: to bound real shapes — with their own
fills, modifiers, and occlusion among themselves — use
[`clip`](#clip)`(region, ...children)` instead ("fill this blob with
little hatched circles" is a clip, not a custom fill).

Every built-in fill also takes an object form: `hatch({ angle: 45,
offset: 3 })`, `stipple({ density: 0.7, minDist })` — stipple dot spacing
≈ `minDist / density`.

Variable-radius dot shading — tiny full circles as single arcs, sized by
distance from a light source:

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 3 }, () =>
  circle(50, 25, 20, {
    fill: (region, ctx) => {
      const b = region.bbox;
      const dots = [];
      while (dots.length < 400) {
        const x = b.x + ctx.rnd() * b.w;
        const y = b.y + ctx.rnd() * b.h;
        if (!region.contains(x, y)) continue;
        const shade = Math.hypot(x - (b.x + b.w * 0.35), y - (b.y + b.h * 0.3)) / (b.w * 0.8);
        dots.push({ type: 'arc', cx: x, cy: y, r: 0.1 + shade * shade * 1.8,
                    start: 0, sweep: Math.PI * 2 });
      }
      return dots;
    },
  }),
);
```

## SVG & assets

### svg

`svg(text, { x?, y?, width?, layers?, ...shapeOpts })` — machine-generated
line art (polylines, `<line>`s, straight-segment paths) as ordinary
open-path shapes: occluded, clipped, masked, modified, pen-assigned.
`width` scales (height follows the aspect); `layers` filters by top-level
`<g>` id; curves and transforms are rejected loudly. Pair with the
`bridge` opt on hatch-dense imports.

```ts live
import { sketch, svg, circle } from 'occlude';

const ART = `<svg viewBox="0 0 100 40">
  <g id="waves">
    <polyline points="0,10 20,4 40,16 60,6 80,14 100,8"/>
    <polyline points="0,22 25,16 50,26 75,18 100,24"/>
    <polyline points="0,34 30,28 60,36 100,30"/>
  </g></svg>`;

export default sketch({ aspect: [2, 1] }, () => [
  svg(ART, { x: 0, y: 5, width: 100 }),
  circle(50, 25, 12, { opaque: true }), // imported strokes occlude like any others
]);
```

### asset

`asset('name.svg')` — the text of a file uploaded on the **Assets** page,
by literal name (the studio preloads every literal before the sketch
runs, so names can't be computed). The usual pairing:

```ts
const church = svg(asset('church.svg'), { width: b.w, bridge: mm(0.7) });
```

### image — sampling

`image('name.png', { x, y, width })` never draws — placement maps pixels
into sketch coordinates so samples drive real features. Point samples are
bilinear; a third `area` argument averages over a box of that half-size
(summed-area tables: O(1) at any size), which is what you want whenever a
mark covers more paper than a pixel. With a transparent PNG, `img.a`
masks the subject.

```ts live
import { sketch, circle, image } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const img = image('ivy.png', { x: 8, y: 2, width: 84 });
  return t.grid({ cols: 36, rows: 42 }).map((c) => {
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    if (img.a(cx, cy, c.w / 2) < 0.5) return null;      // alpha = subject mask
    const dark = 1 - img.lum(cx, cy, c.w / 2);          // average over the cell
    return dark > 0.04 ? circle(cx, cy, dark * c.w * 0.52) : null;
  });
});
```

### image — bands

`img.bands(x, y, n, area?)` posterizes tone into `n` levels (0 = darkest)
— the gate for layered mark-making: more marks where the level is lower.

```ts live
import { sketch, line, image } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const img = image('ivy.png', { x: 8, y: 2, width: 84 });
  const out = [];
  for (let y = 2; y < 98; y += 1.4) {
    for (let x = 8; x < 92; x += 1.4) {
      if (img.a(x, y, 0.7) < 0.5) continue;
      const level = img.bands(x, y, 4, 0.7);
      if (level <= 2) out.push(line(x, y, x + 1.1, y));           // mid + dark
      if (level <= 1) out.push(line(x, y, x, y + 1.1));           // dark
      if (level === 0) out.push(line(x, y, x + 0.9, y + 0.9));    // darkest
    }
  }
  return out;
});
```

### image — edges and direction

`img.edge` is the luminance gradient magnitude (bright at boundaries);
`img.dir` its angle. Strokes drawn perpendicular to the gradient follow
contours — tone turns into flow.

```ts live
import { sketch, line, image } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 6 }, (t) => {
  const img = image('ivy.png', { x: 8, y: 2, width: 84 });
  const out = [];
  for (let i = 0; i < 2600; i++) {
    const x = t.rnd(8, 92);
    const y = t.rnd(2, 98);
    if (img.a(x, y) < 0.5) continue;
    const dark = 1 - img.lum(x, y, 1);
    if (dark < 0.25) continue;
    const a = img.dir(x, y, 1) + Math.PI / 2;  // along the contour
    const r = 0.6 + dark * 1.6;
    out.push(line(x - Math.cos(a) * r, y - Math.sin(a) * r,
                  x + Math.cos(a) * r, y + Math.sin(a) * r));
  }
  return out;
});
```

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

### map / norm / invert & ease

`map(v, a, b, c, d)` remaps ranges; `norm` to 0–1; `invert` flips.
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

## Layout & sequence

### times / range

`times(n, (k, u) => …)` calls n times (`u` normalised 0–1 across the run);
`range(n)` / `range(a, b, step?)` for plain integer sequences. Both are
guarded against runaway counts (a mid-edit `step = 0` errors instead of
freezing the tab).

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(9, (k, u) =>
    t.times(1 + k, (j, v) => circle(8 + u * 84, 42 - v * (6 + k * 3.4), 2.6 - u * 1.6)),
  ),
);
```

### grid

`grid({ cols, rows, gap? })` — cell rectangles covering the whole drawable
(`{ x, y, w, h, i, j }` each). The workhorse of specimen sheets and
halftones.

```ts live
import { sketch, circle, rect, hatch, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 18 }, (t) =>
  t.grid({ cols: 9, rows: 4, gap: 2 }).map((c) =>
    t.chance(0.5)
      ? circle(c.x + c.w / 2, c.y + c.h / 2, Math.min(c.w, c.h) * 0.42, { fill: hatch(t.rnd(180), mm(1)) })
      : rect(c.x + 1, c.y + 1, c.w - 2, c.h - 2, 2),
  ),
);
```

### bounds

`bounds()` — the drawable extent in the sketch's own units:
`{ x, y, w, h, cx, cy }`. Bare units are percent of the SHORT side, so on
a non-square drawable the long axis runs past 100 — read `b.w`/`b.h`
instead of assuming.

```ts live
import { sketch, rect, line, label } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const b = t.bounds();
  return [
    rect(0, 0, b.w, b.h),
    line(0, 0, b.w, b.h),
    line(0, b.h, b.w, 0),
    label('W ' + Math.round(b.w) + '  H ' + Math.round(b.h), b.cx, b.cy - 3, 5, { align: 'center' }),
  ];
});
```

### noisyLine

`noisyLine(x1, y1, x2, y2, { amplitude?, scale?, points?, offset? })` — a
line with organic waver, endpoints exact (the falloff pins them).

```ts live
import { sketch } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) =>
  t.times(11, (k, u) =>
    t.noisyLine(4, 5 + u * 40, 96, 5 + u * 40, { amplitude: u * 5, offset: k * 7.3 }),
  ),
);
```

### ui

`ui(value, { min?, max?, step?, label? })` — a tweakable value. In the
studio, every `ui()` call with a **literal** number or boolean gets a
slider in a panel over the preview; dragging it **edits the literal in
your code** (highlighted while you drag), so the tuned sketch saves,
shares, and replots exactly as seen. The label defaults to the assigned
name (`const rows = ui(12)` → "rows"). At render time `ui()` just returns
its value — headless tools and this page see the literal.

```ts live
import { sketch, circle, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const rings = ui(9, { min: 1, max: 30, step: 1 });
  const spread = ui(0.6);
  return t.times(rings, (k, u) => circle(50, 25, 3 + u * 20 * (1 + spread)));
});
```

## Units

Bare numbers are percent of the drawable's short side — sketches stay
paper-independent. Wrappers pin other meanings: `mm(v)` physical
millimetres (nib-true detail), `w(v)`/`h(v)` percent of width/height,
`s(v)` percent of the long side. Mixed freely; resolved at render when
the paper is known.

```ts live
import { sketch, rect, label, mm, w } from 'occlude';

export default sketch({ aspect: [2, 1] }, () => [
  rect(2, 6, 25, 20),                 // bare: % of short side
  rect(35, 6, w(25), 20),             // w(): % of WIDTH — wider on 2:1
  rect(2, 32, mm(25), mm(10)),        // mm(): physical, same on any paper
  label('BARE', 3, 27.5, 3), label('W()', 36, 27.5, 3), label('MM', 3, 44, 3),
]);
```

## The sketch function

A sketch is a pure function from a toolkit to a tree of shape values —
nothing draws until it renders. The tree may nest arrays arbitrarily; it
is flattened, **tree order is draw order**, and falsy entries are skipped
(so `cond && shape` composes).

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
render/export. Everything random derives from the seed. Alongside its
functions, the toolkit carries the drawable extent as plain numbers —
`width`, `height`, `cx`, `cy` (the same values `bounds()` returns).

**Imports vs the toolkit:** everything pure — shape constructors, fills,
modifiers, units, `map`/`ease`, `ui`, `svg` — is importable from
`'occlude'` (and therefore usable in helper files). Everything that
depends on the *running sketch* lives only on the toolkit: randomness
(`rnd`/`noise`/`pick`/`chance`/`stream` read the seed) and layout
(`bounds`/`grid`/`times` need the resolved paper). The toolkit also
carries the pure functions, so destructuring `({ circle, rnd }) => …` is
an equivalent style.

The occlusion contract, in four rules:

1. **Later wins.** Opaque shapes hide everything before them in the tree;
   `z` overrides the ordering, ties break by tree order.
2. **Only fills/opacity occlude.** Strokes never hide anything, and stroke
   width never dilates an occluder.
3. **On the boundary counts as visible.** Ink lying exactly on an occluder's
   edge survives (shared edges draw once — duplicates are removed).
4. **The nib is the only tolerance.** Visible ink rounds to the nearest
   plottable mark. Closed outlines are judged whole: a tiny circle whose
   circumference still exceeds the nib is drawn as a ring (a solid dot of
   diameter 2r + nib — dot sizes stay continuous); below that it becomes a
   single pen tap — unless that ink is already laid down by a neighbouring
   stroke of the same pen, in which case it's redundant and dropped.
   Hidden gaps shorter than the pen width are inked — a pen can't plot a
   line or a gap finer than its own nib.

## Shape options

Every shape takes a trailing opts object:

| Opt | Meaning |
|---|---|
| `pen` | Pen for the stroke and (by default) the fill texture. |
| `fill` | Fill texture — **implies opaque** (the shape hides what's beneath). |
| `fillPen` | Pen for the fill, when different from `pen`. |
| `opaque: true` | Hides what's beneath with **no texture** — only the stroke draws. |
| `stroke: false` | No outline. A pen name instead overrides the stroke pen. |
| `z` | Stacking override; default is tree order. |
| `mode` | rect only: anchor (x, y) at the `'corner'` (default) or `'center'`. The config's `rectMode` sets the sketch-wide default; circles, ellipses and n-gons are always centre-anchored. |
| `translate`, `rotate`, `scale` | Per-shape transform, identical to wrapping the shape in a `group` with the same op (order within the op: translate → rotate → scale). |
| `decimate`, `wobble` | Shorthand for the [modifiers](#decimate) of the same name — `{ wobble: mm(0.8) }`, `{ decimate: { fill: 0.5 } }`. |
| `modifiers` | Ordered [modifier stack](#modify): `{ modifiers: [smooth(2), wobble(mm(1)), decimate(0.2)] }` — entries run first-to-last. |
| `bridge` | Opt-in pen-down [endpoint joining](#bridge) across gaps up to this length. Group-inheritable. |

## Modifier stages

Modifiers apply around the occlusion solve: **pre-stage** deforms geometry
before it (the modified silhouette occludes; fills follow it), **post-stage**
distresses the surviving ink afterwards. All are seeded and deterministic.
Stacks compose in function-application order — a shape's own list first,
then `modify()` ancestors inside-out; shorthand opts run after any explicit
stack (nearest declaration wins, decimate before wobble).

| Modifier | Stage | Parameters (defaults) | Fielded |
|---|---|---|---|
| `decimate(p)` | post | `p` 0…1, or `{ stroke, fill }` | both probabilities |
| `wobble(amount)` | post | amount (length); `{ amount, wavelength: mm(25) }` | amount |
| `dash(len, gap, offset?)` | post | lengths; `gap` defaults to `len`; phase-continuous along outlines and period-snapped on closed contours (no seam); `offset` shifts it | — |
| `smooth(passes)` | pre | `passes = 2` | — |
| `roughen(amount, detail?)` | pre | jitter length; resample `detail = mm(1.5)` | amount |
| `deform(field)` | pre | `(x, y) => [dx, dy]` user units, or `{ field, detail: mm(2) }` | the field itself |

Pre-stage is the conscious performance choice: wrapped shapes' curves
flatten into polylines entering the solve, so only they pay for the
heavier solve.

## Fields

Any scalar parameter marked "fielded" also takes `(x, y) => number` —
called in user coordinates and rasterised over the page at encode time, so
the value varies spatially. Deterministic and plotter-reproducible;
anything goes inside (math, `noise`, image lookups).

Fielded params: `decimate` probabilities, `wobble` amount, `roughen`
amount. A field on a fill's decimate is a halftone — here `dash` chops the
hatch into cells and a radial field erodes them away from the centre:

```ts live
import { sketch, rect, hatch, modify, dash, decimate, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, () =>
  modify(
    [dash(mm(1.2), mm(0.8)), decimate((x, y) => Math.hypot(x - 50, (y - 25) * 2.1) / 52)],
    rect(2, 3, 96, 44, { fill: hatch(45, mm(1.1)), stroke: false }),
  ),
);
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
- A `Fragment` is `{ origin, t0, t1, pen, shape, dot, bridge, geom }` — a
  sub-range of an original primitive with exact geometry in paper mm
  (`bridge` marks connectors inserted by the bridge opt).
  `drawFragments(ctx, frags, pens)` paints them on a Canvas 2D context
  scaled to 1 unit = 1 mm.
- Plot statistics: `pnpm --filter occlude plotstats <sketch.ts…> [--seed N]`
  reports pen lifts, ink/travel mm, estimated plot time, and optimization
  bounds per sketch — the before/after oracle for toolpath changes.

## Pens & paper

- Pens: `{ name, width, color, feed, penDown, penUp, penDelay }` — width in
  mm is the system's one tolerance. Unknown pen names throw, so shared
  sketches fail loudly. `DEFAULT_PENS` ships a starter set; the studio
  persists its own library server-side and injects it via
  `setPenLibrary(pens)`.
- Papers: `PAPERS` has A3–A6, Letter, Square20; custom sizes via
  `{ paper: { w, h } }`.

## Plotting from the studio

The Plot panel drives an EBB-family (AxiDraw/iDraw) machine over Web
Serial. What's under the hood, briefly, so its knobs make sense:

- **Motion**: host-side look-ahead planning (junction deviation, min-cruise)
  emitted as hardware-interpolated constant-acceleration `LM` commands
  (25 kHz ramps in firmware; falls back to `XM` packets below firmware
  2.5.3 or via the checkbox). Separate acceleration for pen-up travel.
- **Pen cycles**: per-pen `feed` and `penDelay` (settle). **Quick hop**
  lifts the pen only ~40% for short travels with shorter settles — the
  big lever on hatch/stipple plots; 0 disables (needed on machines whose
  gantry sags at one side).
- **Position integrity**: the board's step counters are checked against
  dead reckoning at connect, every 500 chains, and at plot end — lost
  commands are healed automatically and flagged. Visible drift mid-plot:
  Pause → jog the pen onto the origin mark → Set origin → Resume (the
  interrupted stroke's remainder stays pen-up; the next chain re-inks).
- **Pen changes**: no changer — multi-pen sketches plot one pen per run
  via the Plot-pen select; "all pens (one run)" runs a whole multi-pen
  plan with the installed pen, each chain using its own logical pen's
  feed/settle.
- **Diagnostics** (in the panel): registration probe (step loss),
  backlash squares, corner ringing at three feeds (junction-deviation
  tuning), plus the settle × travel sweep sketch for finding a pen's true
  `penDelay` floor. **Download serial log** exports the full timestamped
  command transcript — the first artifact to grab when anything misbehaves.
- **ETA**: totals come from the planner's actual trapezoids and blend
  toward measured throughput as the plot runs — the number is honest.
- **Draft plots**: `decimate(0.7, everything)` makes a fast structural
  test plot with a fraction of the ink budget; the seed keeps it
  reproducible when you re-plot the full version.

Real bridge numbers from a shaded A4 piece, for calibration: no bridge
≈ 34,000 lifts / ~11 h; `bridge: mm(0.5)` ≈ 4.4 h; `mm(0.7)` ≈ 2.9 h;
`mm(1)` ≈ 2.3 h — the Debug view's red connectors show what each
tolerance costs visually.
