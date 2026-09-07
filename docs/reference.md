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
import { sketch, circle, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(7, (k, u) =>
    circle(12 + u * 76, 25, 10, { fill: fill('hatch', { angle: u * 90, spacing: mm(0.8 + u) }) }),
  ),
);
```

### rect

`rect(x, y, w, h, radius?, opts?)` — corner-anchored by default
(`mode: 'center'` or the sketch-wide `rectMode` flips it); `radius` rounds
the corners.

```ts live
import { sketch, rect, fill } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) =>
  t.times(5, (k, u) => [
    rect(6 + u * 72, 8, 16, 34, u * 8, { fill: fill('stipple', { density: 0.25 + u * 0.55 }) }),
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

### ngon

`ngon(x, y, sides, r, rotation?, opts?)` — a regular n-gon: `sides`
vertices on a circle of radius `r`, the first at `rotation` degrees.

```ts live
import { sketch, ngon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(6, (k) =>
    ngon(10 + k * 16, 25, 3 + k, 8, 90, { fill: fill('hatch', { angle: 45, spacing: mm(1) }) }),
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

### polygon

`polygon(contours, opts?)` — an area from its boundaries. One contour
(`[[x, y], …]`) or several (`[[[x, y], …], …]`); each is closed with a
chord if it isn't already. The result is ONE shape — it clips, fills,
masks, and stamps as one thing. Strictly points: wrapper records expose
theirs (`polygon(blobs.map((c) => c.pts))`). `winding` picks the fill
rule where boundaries nest or cross: `'evenodd'` (default) makes every
enclosed boundary a hole whatever its orientation — a ring is an annulus,
a pentagram has an empty pentagon; `'nonzero'` fills the pentagram solid.

```ts live
import { sketch, polygon, fill, mm } from 'occlude';

// The same pentagram under both rules. Evenodd (left) leaves the inner
// pentagon empty; nonzero (right) fills it — the outline is identical.
export default sketch({ aspect: [2, 1] }, () => {
  const star = (cx) => [0, 1, 2, 3, 4].map((k) => {
    const a = -Math.PI / 2 + (k * 4 * Math.PI) / 5;
    return [cx + 20 * Math.cos(a), 26 + 20 * Math.sin(a)];
  });
  const hatch = fill('hatch', { angle: 45, spacing: mm(1) });
  return [
    polygon(star(27), { fill: hatch }),
    polygon(star(73), { fill: hatch, winding: 'nonzero' }),
  ];
});
```

```ts live
import { sketch, polygon, circle } from 'occlude';

// One area from a whole level set — dots survive only inside the blobs.
export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const blobs = t.isolines((x, y) => t.noise(x / 14, y / 14), 0.1, { close: true });
  return t.clip(polygon(blobs.map((c) => c.pts)), t.grid({ cols: 40, rows: 20 }).map((c) =>
    circle(c.cx, c.cy, 1)));
});
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
Wrap the region in `invert()` to keep the OUTSIDE instead.

```ts live
import { sketch, clip, circle, line } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  clip(circle(50, 25, 20), t.times(19, (k, u) => line(0, u * 50, 100, u * 50))),
  circle(50, 25, 20),
]);
```

### invert

`invert(shape)` — complement a clip region: `clip(invert(shape), ...)`
splits the children's ink along the shape's boundary and keeps the
outside. A region annotation, not a drawable — it fails loudly anywhere
else. With `polygon()` this is the full split-and-keep-either-side pair:
same boundary, pick a side.

```ts live
import { sketch, clip, invert, polygon, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const blobs = t.isolines((x, y) => t.noise(x / 14, y / 14), 0.1, { close: true });
  const r = polygon(blobs.map((c) => c.pts));
  const dots = (rr) => t.grid({ cols: 40, rows: 20 }).map((c) => circle(c.cx, c.cy, rr));
  return [
    clip(r, dots(1.1)),           // inside: fat dots
    clip(invert(r), dots(0.45)),  // outside: fine dots
  ];
});
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
import { sketch, circle, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) =>
  t.times(4, (k, u) =>
    circle(14 + u * 72, 25, 11, {
      fill: fill('hatch', { angle: 45, spacing: mm(0.7) }),
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
import { sketch, modify, smooth, roughen, ngon, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, () => [
  ngon(16, 25, 5, 14),
  modify([smooth(3)], ngon(50, 25, 5, 14)),
  modify([roughen(mm(1.2), mm(3))], ngon(84, 25, 5, 14)),
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

### fill

Fills are sketch-space code, never engine features: `fill(name, params?)`
references a fill module by name (names are literals), and the engine
runs it between the render passes against the shape's FINAL outline —
post-deform — then clips and occludes the result like all ink. The
built-ins (`hatch`, `crosshatch`, `stipple`, `solid`) are ordinary
modules with no privileges; an inline function (`fill: (region, ctx) =>
[...]`) works too and receives the same region/ctx contract.

### fill('hatch')

`fill('hatch', { angle, spacing, offset, align })` — parallel lines.
Spacing is a length
(`mm()` for physical). The ruling is **paper-anchored by default**: one
paper-wide grid that every same-spec fill samples, so adjacent shapes
tile into continuous texture. For many small shapes (halftone dots) that
makes each shape's marks depend on where it sits — pass the object form
`align: 'shape'` to centre the ruling on each
shape instead: identical marks wherever the shape lands.

```ts live
import { sketch, circle, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(5, (k, u) => circle(12 + u * 76, 25, 10, { fill: fill('hatch', { angle: u * 72, spacing: mm(0.6 + u * 1.4) }) })),
);
```

### fill('crosshatch')

`fill('crosshatch', { angles, spacing })` — stacked hatch passes
(default 0° + 90°).
Tone by layering.

```ts live
import { sketch, rect, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, () => [
  rect(8, 10, 22, 30, { fill: fill('crosshatch', { angles: [45], spacing: mm(1.2) }) }),
  rect(39, 10, 22, 30, { fill: fill('crosshatch', { angles: [45, 135], spacing: mm(1.2) }) }),
  rect(70, 10, 22, 30, { fill: fill('crosshatch', { angles: [0, 60, 120], spacing: mm(1.2) }) }),
]);
```

### fill('stipple')

`fill('stipple', { density, minDist })` — Poisson-placed dots, plotted as
pen taps.
Density accepts the 0–1 range; pair with `decimate: { fill: field }` for
image-driven halftones.

```ts live
import { sketch, circle, fill } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 12 }, (t) =>
  t.times(4, (k, u) => circle(14 + u * 72, 25, 11, { fill: fill('stipple', { density: 0.15 + u * 0.75 }) })),
);
```

### fill('solid')

`fill('solid', { angle })` — unbroken ink: shape-aligned hatch at 0.9× the
fill
pen's nib, so rows overlap into full coverage and every shape fills
identically wherever it sits. The texture default (`hatch`) is airy on
purpose; `solid` is the "just make it black" fill. Rows follow `angle`
(plot direction); pair with `bridge` to serpentine them.

```ts live
import { sketch, circle, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(4, (k, u) => [
    circle(14 + u * 72, 15, 7, { fill: fill('hatch', { spacing: mm(1) }) }),  // texture
    circle(14 + u * 72, 35, 7, { fill: fill('solid', { angle: u * 90 }) }),    // ink
  ]),
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
  ctx.penWidth             // fill pen nib, mm
  ctx.rnd()                // seeded [0, 1)
  ctx.len(l)               // resolve a length to mm
  ctx.anchor               // { a, b, c, d, e, f, rotation }: shape-local mm → paper mm
}
```

A fill FILE's field params (`fill('grain', { field: f, align: 'shape' })`)
arrive already anchored: the runtime hands `generate` a sampler that takes
the region's paper-mm coordinates and maps them into the field's own
frame through the use's `align`, so a fill never converts coordinates
itself.

Strokes are records of the engine's stroke vocabulary — everything in the
pipeline lowers to lines, arcs, and cubics, so any drawable mark is
expressible. A `polyline` is one connected pen stroke, and the nib rule
judges it **whole** — a finely stepped 30 mm squiggle of 0.02 mm segments
is drawable ink, not crumbs — exactly as a traced outline is judged. Every
other record is a stroke of its own:

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

Every built-in takes its params as one object: `fill('hatch', { angle: 45,
offset: 3 })`, `fill('stipple', { density: 0.7, minDist })` — stipple dot
spacing
≈ `minDist / density`.

### rulings

`rulings(region, { spacing, angle, offset, align, anchor })` — the
primitive under `hatch`, `crosshatch`, and `solid`, exported for your own
fills: parallel lines across the region's bbox, overshooting it (the
engine clips exactly). Spacing is paper mm; `align: 'paper'` (default)
samples one paper-wide grid, `'shape'` anchors the ruling to the shape —
pass `ctx.anchor` and the direction turns (or mirrors) with the motif.
Vary it per shape and you have a tone ramp without touching the engine:

```ts live
import { sketch, circle, rulings } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(5, (k, u) =>
    circle(12 + u * 76, 25, 10, {
      fill: (region, ctx) =>
        rulings(region, { spacing: ctx.penWidth * (1.5 + 6 * (1 - u)), angle: 30 + k * 25, align: 'shape' }),
    }),
  ),
);
```

### fill files & the library

A **fill file** is a fill as a standalone module: declared params plus a
pure generator, importing nothing but occlude and capturing nothing —
which is exactly what makes it storable, shareable, and embeddable:

```ts
import { fillAsset, rulings, mm } from 'occlude';

export default fillAsset({
  params: { spacing: mm(1.5), angle: 45 },
  generate(region, p, ctx) {
    return rulings(region, { spacing: ctx.len(p.spacing) * ctx.coarsen, angle: p.angle });
  },
});
```

A fill module can also live right in the sketch and be used by value —
`fill(myAsset, { angle: 60 })` — the declared-params form with no library
involved. Saved on the studio's **Fills** page under a name, it is used
exactly like a built-in: `fill('grain', { angle: 60 })` — the call site's literals
override the declared defaults, and the name is a literal (computed names
defeat the scan that loads fills, warns on edit, and rewires imports).
The render worker fetches referenced fill files per render and the
headless tools (plotstats, render, dump-scene) read the same library from
disk, so studio, node, and the docs page execute one source.

- **Built-ins are ink-immutable.** `hatch`, `crosshatch`, `stipple`, and
  `solid` resolve from the package, never from the library, and open
  read-only. An ink-affecting change to a shipped fill needs a new name —
  otherwise a package upgrade would silently change every saved sketch
  that says `fill('hatch')`. *Clone* copies one into a file you own.
- **Warn-on-edit.** Saving a fill that saved sketches reference is,
  transitively, an edit to those sketches: the page scans the sketch
  library at that moment and lists them, with *Clone* (save under a fresh
  name) as the default and *Edit anyway* the deliberate choice. Your
  sketches are never edited for you — point them at the clone when you
  mean to. Drafts and unreferenced fills save silently. No versioning,
  no locks.
- **Exports travel complete.** *Download .ts* appends the source of every
  custom fill the sketch uses in a comment-only block at the end of the
  file; *Import .ts* restores them: identical content reuses the name,
  a genuine mismatch imports under a fresh name and the sketch's
  `fill('…')` literal follows it. Never a prompt, never an overwrite.
- **Determinism is contract.** A fill is a pure function of (region,
  params, ctx) — `ctx.rnd()` is its seeded sub-stream; anything else is a
  preview/plot mismatch waiting to happen.

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

## Layout & sequence

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
(`{ x, y, w, h, cx, cy, i, j }` each; `cx`/`cy` is the centre). The
workhorse of specimen sheets and halftones.

```ts live
import { sketch, circle, rect, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 18 }, (t) =>
  t.grid({ cols: 9, rows: 4, gap: 2 }).map((c) =>
    t.chance(0.5)
      ? circle(c.cx, c.cy, Math.min(c.w, c.h) * 0.42, { fill: fill('hatch', { angle: t.rnd(180), spacing: mm(1) }) })
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

## Points

Point distributions as composable values. `t.scatter` makes them,
refinement verbs reshape them, and the geometric duals turn them into
drawable structure. The named algorithms are recipes, not API:
`scatter(field).settle(n)` **is** weighted Linde-Buzo-Gray stippling.
Everything is seeded; `relax`/`settle` return new sets.

### scatter

`t.scatter(field?, { spacing })` — field-modulated Poisson-disk points:
local spacing tightens where the field (0–1) is high, empty where it's 0.
Returns an array-like set of `{ x, y, w }` (w ≈ local demand).
Every island of the field is sampled — a field made of separate bright
patches gets points in all of them, whatever the seed.

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const field = (x, y) => Math.max(0, 1 - Math.hypot(x - 50, (y - 25) * 2) / 45);
  return t.scatter(field, { spacing: 1.7 }).map((p) => circle(p.x, p.y, 0.35 + p.w * 0.45));
});
```

### relax / settle

`.relax(n)` — Lloyd relaxation toward field-weighted cell centroids:
spacing evens out, count stays fixed. `.settle(n)` adds population
control — overloaded cells split their point, starved ones lose theirs —
so the count converges to the field's ink budget (the LBG stipple).
Verbs work on ANY lifted array via `t.points(arr, { field?, spacing? })`
— here a plain grid reorganises itself into tone-following blue noise:

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const dark = (x, y) => Math.max(0.03, 1 - Math.hypot(x - 55, (y - 24) * 1.8) / 50);
  const gridPts = t.grid({ cols: 30, rows: 15 }).map((c) => [c.x + c.w / 2, c.y + c.h / 2]);
  return t
    .points(gridPts, { field: dark, spacing: 2.4 })
    .settle(12)
    .map((p) => circle(p.x, p.y, 0.35 + p.w * 0.4));
});
```

### cells / mesh

`.cells()` — the Voronoi cells of the set (one `{ site, pts }` per
point, clipped to the drawable); `.mesh()` — the Delaunay triangulation.
`site` is the input point itself (a scatter point keeps its `w`); `pts`
is the cell's boundary loop. Both return plain data to edit, filter, and
stamp however you like; both also exist as pure imports
(`voronoi(points, bounds)`, `triangulate(points)`) over arbitrary arrays.

```ts live
import { sketch, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const pts = t.scatter({ spacing: 7 }).relax(3);
  return pts.cells().map((c) =>
    polygon(c.pts, t.chance(0.25) ? { fill: fill('hatch', { angle: t.rnd(180), spacing: mm(1.1) }) } : {}),
  );
});
```

```ts live
import { sketch, polygon } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 11 }, (t) => {
  const field = (x, y) => Math.max(0.05, 1 - Math.hypot(x - 50, (y - 25) * 2) / 48);
  return t.scatter(field, { spacing: 4.2 }).mesh().map((tri) => polygon(tri));
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

### ui

`ui(value, { min?, max?, step?, label? })` — a tweakable value. In the
studio, every `ui()` call with a **literal** number or boolean gets a
slider in a panel over the preview; dragging it **edits the literal in
your code** (highlighted while you drag), so the tuned sketch saves,
shares, and replots exactly as seen. The label defaults to the assigned
name (`const rows = ui(12)` → "rows"). At render time `ui()` just returns
its value — headless tools and this page see the literal.

Every other number is tweakable too, without wrapping it: **Alt-drag any
number literal in the editor** to scrub it (Shift ×10, Ctrl ÷10 and one
more decimal). The step follows the literal's own precision, and the edit
lands in the code the same way — `ui()` is for the values you want a
labelled control for.

```ts live
import { sketch, circle, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const rings = ui(9, { min: 1, max: 30, step: 1 });
  const spread = ui(0.6);
  return t.times(rings, (k, u) => circle(50, 25, 3 + u * 20 * (1 + spread)));
});
```

### probe

`t.probe(label, value)` — the variable inspector. Returns `value`
unchanged and records it, so after the render the studio's controls
panel shows what the label actually ran through: count, min, mean, max,
and a small histogram. Wrap any number anywhere — a field's return, a
loop variable, something inside a fill — to learn the range before you
ease or map it. Deterministic and free to leave in: it never changes a
value.

```ts
const density = (x, y) => {
  const s = t.probe('s', d(x, y));                 // read the range, then choose the falloff
  return s <= 0 ? 0 : t.probe('p', ease.smooth(1 - s / 12));
};
```

## Material

Geometry you can hold, connect, step, resample and reinterpret. A `Material`
is vertices — `x`, `y` and any named attribute columns — plus an edge
list. A ring, an open chain, a branching tree and an unconnected cloud
are all materials; a `Curve` is a chain the material hands back for drawing.
Meshes are values: every operation returns a new one, so an evolution can
be kept and any state chosen later. Indices are rows of one state, not
identities. Five layers, kept apart:

| layer | what |
|---|---|
| material | `t.sample(shape)`, `material(points)`, `curve(pts)`; `connect.*`; `.attribute()`, `.resample()` |
| numbers | `add sub mul length distance unit limit perp sum sumBy` — tuples out, either spelling in, nothing mutated |
| rules | `.steps(n, (current, next, k) => …)` with collection edits; forces prepared once, evaluated at a point |
| selection | `.selectPoints()`, `.selectEdges()` — source-bound, fixed; `.extract()` for independent material; `connectedPoints`, `components`, `meanBy` |
| drawing | `.curves()`, `segmentRuns`, `extent`, `banding` — then `stroke`, `polygon`, `circle` |

All pure imports except `t.sample`, which reads the paper. The exact
shapes stay exact through the engine; sampling is the one, explicit,
lossy step into this world.

### material

`t.sample(shape, { count | spacing, tolerance? })` — each outline of the
shape becomes a chain: a closed outline a ring, an open one a chain from
end to end, several outlines separate chains in one material. `material(points,
{ edges?, ...columns })` — from tuples or `{x, y}` objects (a scatter
point's `w` becomes a column), unconnected unless edges are given.
`curve(pts, { closed?, ...columns })` — a ring or chain from positions.
`m.attribute(name, constant | p => value, { transfer? })` adds a point
column (with an optional `'nearest'` transfer policy for categorical
values) and returns a new material; `m.edgeAttribute(name, constant | e
=> value)` adds an EDGE column — each edge its own row, so a junction's
three edges can carry three different rest lengths, read as
`edge.attrs.rest`. Access: `m.points` (vertex views `{ index, x, y, ...attrs }`),
`m.pts` (tuples), `m.x`/`m.y`/`m.attrs.age` (the columns), `m.connected(i)`,
`m.degree(i)`, `m.edges`, `m.curves()`.

```ts live
import { sketch, stroke, polygon, circle, material, fill, mm } from 'occlude';

// Attributes ride with the geometry: a scatter's `w` becomes a column,
// a derived `far` column is added, and two interpretations read the same
// material — dots sized by w on the left, the far ones ringed on the right.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const cloud = material(t.scatter((x, y) => 1 - Math.hypot(x - 25, y - 25) / 30, { spacing: 3 }))
    .attribute('far', (p) => Math.hypot(p.x - 25, p.y - 25) > 14 ? 1 : 0);
  return [
    cloud.points.map((p) => circle(p.x, p.y, 0.3 + p.w)),
    cloud.points.filter((p) => p.far).map((p) => circle(p.x + 50, p.y, 1.5)),
  ];
});
```

### connect

`connect.chain(m)` and `connect.ring(m)` join consecutive rows in the
given order (no route is inferred). `connect.nearest(m, { count })` joins
each vertex to its `count` nearest others — undirected, no duplicates,
self excluded, ties to the lower row. `connect.pairs(a, b)` joins row i of
`a` to row i of `b` in one material, lengths must match, coincident points stay
distinct. `connect.triangulate(m)` adds the Delaunay edges. `append(a, b)`
puts two materials in one. (`t.scatter(...).cells()` and `.mesh()` remain the
polygon views: Voronoi cells and Delaunay triangles as loops to stamp.)

```ts live
import { sketch, stroke, circle, material, connect } from 'occlude';

// Two ways to connect one cloud: nearest-3 on the left, Delaunay on the
// right — each edge drawn once through curves().
export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const pts = t.scatter({ spacing: 5 }).map((p) => [p.x / 2 + 2, p.y]);
  const left = connect.nearest(material(pts), { count: 3 });
  const right = connect.triangulate(material(pts.map(([x, y]) => [x + 50, y])));
  return [left, right].flatMap((m) => m.curves().map((c) => stroke(c)));
});
```

### vectors

Vectors are tuples `[x, y]`. Every operation accepts either spelling
(`[x, y]` or `{ x, y }`, so a vertex view goes straight in), returns a
fresh tuple, and never mutates an argument. `unit([0, 0])` is `[0, 0]`:
coincident points contribute no direction and no NaN. `mul` is scalar
multiplication only. `limit(v, max)` caps a length. `sumBy(items, fn)` is
the vector total of your function over a collection, accumulated in order.

```ts live
import { sketch, line, circle, sub, mul, unit, length, sumBy } from 'occlude';

// A field of arrows: each one is the sum of pulls toward three anchors,
// each pull a plain function on the vocabulary.
export default sketch({ aspect: [2, 1] }, (t) => {
  const anchors = [{ x: 20, y: 25 }, { x: 60, y: 12 }, { x: 80, y: 40 }];
  const pull = (p, q) => mul(unit(sub(q, p)), 30 / (length(sub(q, p)) + 10));
  return [
    anchors.map((a) => circle(a.x, a.y, 1.5)),
    t.grid({ cols: 20, rows: 10 }).map((c) => {
      const f = sumBy(anchors, (a) => pull(c, a));
      return line(c.cx, c.cy, c.cx + f[0], c.cy + f[1]);
    }),
  ];
});
```

### forces

A force is prepared once with its sources, then evaluated at a point to a
vector; nothing moves until the rule says so. Two callback shapes cover
the field. `p => vector` — wind, drift, a vector field — works in `sum`
as it is. `(p, q) => vector` — an interaction with another point — goes
through `force.nearby`, which finds every source `q` within a radius of
`p` (spatial index built once, for that frozen state) and sums your
contributions:

```ts
const repel = force.nearby(sources, { radius }, (p, q) => {
  const delta = sub(p, q);
  return mul(unit(delta), radius - length(delta));
});
next.move((p) => mul(repel(p), speed));
```

`sources` is a material (then `q` is a vertex view) or any list of points —
the material being moved, or obstacles that stay put. A vertex of the source
material never interacts with itself: membership in that state decides, not
coordinates or an index from another collection. Nothing else is skipped
unless you say so — `excludeConnected: true` on the recipes, or `skip:
force.adjacent(m)` on `nearby`, is the explicit "not what I'm connected
to". The named recipes are short ordinary functions on this mechanism;
copy one beside your own and change it.

| recipe | prepare with | evaluate | vector |
|---|---|---|---|
| `force.tension(m, { rest })` | the state; reads connections | `pull(p)` | toward each connected neighbour by the gap beyond `rest` (slack, not a spring) |
| `force.separation(sources, { radius, excludeConnected? })` | any points; index once | `repel(p)` | away from every source within the radius, linearly to zero at the edge, `radius` when touching |
| `force.attract(sources, { radius, strength?, excludeConnected? })` | any points; index once | `pull(p)` | toward each source, `strength` when touching, zero at the radius |
| `force.drift(noise, { amount, frequency?, rate? })` | a noise function — pass `t.noise`, it owns no seed | `wander(p, k)` | a direction read from the noise, turning slowly with the iteration (`rate`, default 0.0004: the noise's z axis is steep) |
| `force.boundary(loops, { radius, strength? })` | boundary loops, as `distanceTo` takes them | `keep(p)` | inward within `radius` of the edge and everywhere outside; zero deeper in |
| `force.vortex(centre, { strength, falloff? })` | a point | `swirl(p)` | tangential around the centre, fading as `1 / (1 + d / falloff)` |
| `force.field(vectorField, { strength? })` | a `grad`/`curl`/hand-written field | `flow(p)` | the field at p — the adapter into `sum` |
| `force.relax(m, { amount? })` | the state; reads connections | `smooth(p)` | toward the mean of the connected neighbours (Laplacian smoothing) |
| `force.nearby(sources, { radius, skip? }, (p, q) => v)` | any points; index once | `f(p)` | the sum of your contributions |

```ts live
import { sketch, stroke, circle, force, sub, unit, length, sum, mul } from 'occlude';

// nearby — sources need not be the moving geometry: a ring grows among
// six fixed posts that shove it away, so it flows around them. One
// interaction written in place; the posts are drawn as what they are.
export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const posts = [[20, 12], [50, 8], [80, 14], [22, 38], [52, 42], [80, 36]];
  const shove = force.nearby(posts, { radius: 9 }, (p, q) => {
    const delta = sub(p, q);
    return mul(unit(delta), (9 - length(delta)) * 0.9);
  });
  const wander = force.drift(t.noise, { amount: 0.1 });
  const grown = t.sample(circle(50, 25, 4), { count: 30 }).steps(210, (cur, next, k) => {
    const pull = force.tension(cur, { rest: 1 });
    const repel = force.separation(cur, { radius: 2.2, excludeConnected: true });
    next.move((p) => mul(sum(pull(p), repel(p), shove(p), wander(p, k)), 0.18));
    next.splitEdges((e) => e.length > 1.1 && t.chance(0.3), { attributes: {} });
  });
  return [posts.map(([x, y]) => circle(x, y, 2)), stroke(grown.contour)];
});
```

```ts live
import { sketch, stroke, curve, force, mul } from 'occlude';

// tension — an open chain pulled taut: the slack pull only acts where a
// link is stretched beyond `rest`, so the zigzag straightens link by link
// while the ends, which have one neighbour each, follow. Every 4th state.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const zigzag = t.times(21, (i) => [8 + i * 4.2, 25 + (i % 2 ? 9 : -9) + t.rnd(-2, 2)]);
  const chain = curve(zigzag, { closed: false });
  const pulled = chain.steps(48, (cur, next) => {
    const pull = force.tension(cur, { rest: 3 });
    next.move((p) => mul(pull(p), 0.05));
  }, { every: 8 });
  return pulled.history.map((h) => stroke(h.material.contour));
});
```

```ts live
import { sketch, circle, material, force, mul } from 'occlude';

// separation — a clump spreads itself into an even, blue-noise scatter:
// each dot moves away from every other within the radius. Left the
// start, right after 40 steps.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const start = material(t.times(120, () => {
    const a = t.rnd(Math.PI * 2); const r = 9 * Math.sqrt(t.rnd());
    return [25 + Math.cos(a) * r, 25 + Math.sin(a) * r];
  }));
  const spread = start.steps(40, (cur, next) => {
    const repel = force.separation(cur, { radius: 7 });
    next.move((p) => mul(repel(p), 0.12));
  });
  return [start.points.map((p) => circle(p.x, p.y, 0.5)), spread.points.map((p) => circle(p.x + 50, p.y, 0.5))];
});
```

```ts live
import { sketch, stroke, circle, material, force, mul } from 'occlude';

// attract — dots gather toward three anchors; each dot's path over 120
// small steps is drawn from the history, so the pull is visible as a trail.
export default sketch({ aspect: [2, 1], seed: 7 }, (t) => {
  const anchors = [[22, 25], [55, 11], [80, 38]];
  const toward = force.attract(anchors, { radius: 42, strength: 1 });
  const dots = material(t.scatter({ spacing: 5 }).map((p) => [p.x, p.y / 2]));
  const gathered = dots.steps(120, (cur, next) => next.move((p) => mul(toward(p), 0.08)), { every: 1 });
  const trail = (i) => gathered.history.map((h) => [h.material.x[i], h.material.y[i]]);
  return [
    anchors.map(([x, y]) => circle(x, y, 1.5)),
    dots.points.map((p) => stroke(trail(p.index))),
  ];
});
```

```ts live
import { sketch, stroke, material, force } from 'occlude';

// drift — the same trails under noise alone: each dot wanders along a
// seeded noise direction that turns slowly with the iteration.
export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const wander = force.drift(t.noise, { amount: 0.16, frequency: 0.03 });
  const dots = material(t.scatter({ spacing: 11 }).map((p) => [p.x, p.y / 2]));
  const wandered = dots.steps(110, (cur, next, k) => next.move((p) => wander(p, k)), { every: 1 });
  const trail = (i) => wandered.history.map((h) => [h.material.x[i], h.material.y[i]]);
  return dots.points.map((p) => stroke(trail(p.index)));
});
```

```ts live
import { sketch, stroke, rect, curl, force, sum, mul } from 'occlude';

// vortex + field — the other shape, p => vector, needs no helper. A
// rectangle's outline is carried by a vortex and a curl field with no
// growth at all: the same `.steps()` verb, a different rule. Every 10th
// state is drawn, so the drift reads as nested frames.
export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const swirl = force.vortex({ x: 50, y: 25 }, { strength: 1.6, falloff: 30 });
  const flow = force.field(curl((x, y) => t.noise(x / 30, y / 30) * 3));
  const carried = t.sample(rect(22, 8, 56, 34), { spacing: 1 }).steps(40, (cur, next) => {
    next.move((p) => mul(sum(swirl(p), flow(p)), 0.35));
  }, { every: 10 });
  return carried.history.map((h) => stroke(h.material.contour));
});
```

```ts live
import { sketch, stroke, curve, force, mul } from 'occlude';

// relax — Laplacian smoothing as a force: a rough closed outline settles
// toward the mean of its neighbours, corners first. Every 6th state,
// outermost the roughest.
export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const rough = curve(t.times(40, (i) => {
    const a = (i / 40) * Math.PI * 2;
    const r = 18 + t.rnd(-5, 5);
    return [50 + Math.cos(a) * r * 1.6, 25 + Math.sin(a) * r];
  }));
  const settled = rough.steps(24, (cur, next) => {
    const smooth = force.relax(cur, { amount: 0.5 });
    next.move((p) => mul(smooth(p), 1));
  }, { every: 6 });
  return settled.history.map((h) => stroke(h.material.contour));
});
```

```ts live
import { sketch, stroke, circle, rect, force, sum, mul } from 'occlude';

// Kept on the page: `boundary` turns the growth back a little inside the
// frame's edge, `attract` draws it toward three anchors, and the rest is
// the ordinary ring rule. The frame and anchors are drawn as what they are.
export default sketch({ aspect: [2, 1], seed: 12 }, (t) => {
  const frame = rect(4, 4, 92, 42);
  const keep = force.boundary(t.polylines(frame), { radius: 6, strength: 2 });
  const anchors = [[16, 24], [50, 9], [84, 40]];
  const toward = force.attract(anchors, { radius: 40, strength: 0.5 });
  const wander = force.drift(t.noise, { amount: 0.2 });
  const grown = t.sample(circle(50, 25, 4), { count: 30 }).steps(240, (cur, next, k) => {
    const pull = force.tension(cur, { rest: 1 });
    const repel = force.separation(cur, { radius: 2.2, excludeConnected: true });
    next.move((p) => mul(sum(pull(p), repel(p), keep(p), toward(p), wander(p, k)), 0.18));
    next.splitEdges((e) => e.length > 1.1 && t.chance(0.3), { attributes: {} });
  });
  return [frame, anchors.map(([x, y]) => circle(x, y, 1.2)), stroke(grown.contour)];
});
```

### steps

`m.steps(n, (current, next, k) => …, { every? })` — THE iteration
operation: run a rule `n` times and return the final material, ready for
further operations. Growth, relaxation, deformation and erosion are
different rules for this one verb; `.steps(1, rule)` is a single
transition. The rule reads `current` (frozen — every callback sees the
same state, no edit changes what a later one reads) and describes `next`,
which starts as a copy:

| edit | meaning |
|---|---|
| `next.move(p => vector, { where? })` / `next.move(ref, vector)` | displacement; several moves add up |
| `next.set(p => attrs, { where? })` / `next.set(ref, attrs)` | write point attributes; the last write of a field wins |
| `next.setEdges(e => attrs, { where? })` / `next.setEdge(edge, attrs)` | write edge attributes; the last write of a field wins |
| `next.addPoint(position, attributes)` → handle | a new vertex; the handle names it within this batch |
| `next.connect(a, b, edgeAttributes?)` | one undirected edge between rows, views or handles; an existing pair is left as it is and needs no attributes |
| `next.disconnect(edge \| e => bool)` | remove an edge, both points stay; repeating it is a no-op |
| `next.remove(ref \| p => bool)` | delete a point and its incident edges; neighbours are never joined; repeating it is a no-op |
| `next.split(edge, { at?, point?, edges? })` → handle | replace an edge with two through a new vertex; at 0 or 1, the existing endpoint. Options are recorded as they are at the call (records copied, callbacks kept) |
| `next.splitEdges(e => bool, { at?, point?, edges? })` | bulk split on the MOVED edges — moves first, then `where` sees each edge as it will be |
| `next.extend(p => spec \| spec[], { where? })` | for each selected vertex, a new child `{ position, attributes }` or a connection `{ to }`, joined to it |

A reference is a row of the current state, a vertex view of the current
state, or a handle from this batch — never a bare number meaning an edge;
edges are passed as views (`cur.edge(i)`, `cur.edges`, a query result).
Views and handles are checked for ownership, not just range: a view of
another material, or a handle from another step, is an error even when
its row happens to exist.

A new point or edge must name every declared column — inheriting is not
a default for something with no source. A split has a source: the
inserted vertex inherits its point attributes by each column's transfer
policy (interpolate unless declared `nearest`), the child edges copy the
parent's edge attributes, and `point` / `edges` overrides merge on top —
a record, or a callback of the moved parent edge (and, for `edges`, the
child's `{ from, to, fraction }` interval). Halve only at a midpoint; for
other parameters conserve a length-like attribute with `fraction`. (The
older `attributes` option is `point` by another name; `parent`, which
rewrote the start vertex, is kept only for the old "edge attribute on
its start vertex" idiom — real edge columns use `edges`.)

Order and conflicts, so a batch is predictable: callbacks and selectors
read the frozen current state; moves and attribute writes apply first;
bulk split predicates and split transfer callbacks read that moved
state; then removals, disconnections, splits (sorted along each original
edge, equal parameters sharing one vertex), added points and connections
resolve, and rows compact once. A removed point that is also moved, set,
split or connected in the same step is a conflict, as are splitting and
disconnecting one edge, or setting attributes on an edge being
disconnected; an explicit disconnect of an edge dying with its point is
allowed. Two different child-edge definitions on one parent in one batch
conflict; the same definition again is fine. A conflicting or malformed
batch throws and publishes nothing.

By default only the final state is kept. `{ every: m }` also captures
iteration 0, every m-th iteration, and the final one — each once, labelled
— on the result's `history` as `{ iteration, material }`; nothing a later
step does can disturb a snapshot, and `iteration` keeps counting across
calls. Each sketch run recomputes from the start: scrubbing an iteration
control re-runs the growth to that point.

```ts live
import { sketch, stroke, circle, force, sum, mul } from 'occlude';

// Differential growth in ten lines: tension + separation + seeded drift,
// split the stretched edges, keep going. This is the ring study.
export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const wander = force.drift(t.noise, { amount: 0.12, frequency: 0.1 });
  const grown = t.sample(circle(50, 25, 4), { count: 24 }).attribute('age', 0).steps(150, (cur, next, k) => {
    const pull = force.tension(cur, { rest: 0.8 });
    const repel = force.separation(cur, { radius: 2, excludeConnected: true });
    next.move((p) => mul(sum(pull(p), repel(p), wander(p, k)), 0.15));
    next.set((p) => ({ age: p.age + 1 }));
    next.splitEdges((e) => e.length > 0.9 && t.chance(0.3), { attributes: { age: 0 } });
  });
  return stroke(grown.contour);
});
```

```ts live
import { sketch, stroke, circle, material, add } from 'occlude';

// Branching through ordinary edits: active tips extend along their
// heading (bent by noise, pulled back toward up), fork now and then, and
// hand their activity to the children. Junctions are just vertices with
// three edges; curves() walks each arm once. Tips are drawn as dots.
export default sketch({ aspect: [2, 1], seed: 21 }, (t) => {
  const seed = material([[50, 49]], { active: 1, heading: -Math.PI / 2, depth: 0 });
  const tree = seed.steps(30, (cur, next, k) => {
    next.extend((p) => {
      const turn = t.noise(p.x / 7, p.y / 7, k) * 0.3 - (p.heading + Math.PI / 2) * 0.1;
      const fork = p.depth < 4 && t.chance(0.3);
      const headings = fork ? [p.heading - 0.5 + turn, p.heading + 0.5 + turn] : [p.heading + turn];
      return headings.map((h) => ({
        position: add(p, [Math.cos(h) * 1.6, Math.sin(h) * 1.6]),
        attributes: { active: 1, heading: h, depth: p.depth + (fork ? 1 : 0) },
      }));
    }, { where: (p) => p.active === 1 && p.y > 3 && p.x > 3 && p.x < 97 });
    next.set(() => ({ active: 0 }), { where: (p) => p.active === 1 });
  });
  return [tree.curves().map((c) => stroke(c)), tree.points.filter((p) => p.active).map((p) => circle(p.x, p.y, 0.5))];
});
```

```ts live
import { sketch, stroke, circle, material, curl, force, sum, mul } from 'occlude';

// A point cloud, no topology at all: forces still work, and the wall
// that deflects it is a separate sampled outline that never moves. A
// band of dots streams left to right on a light noise wind and parts
// around the wall; `mobility`, an ordinary column, scales how far each
// one goes. Sampled obstacle repulsion is not the continuous `boundary`.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const cloud = material(t.scatter({ spacing: 2 }).map((p) => [p.x / 5 + 2, p.y]))
    .attribute('mobility', (p) => 0.6 + 0.4 * t.noise(p.y / 6));
  const wall = t.sample(circle(46, 25, 8), { spacing: 0.8 });
  const avoid = force.separation(wall, { radius: 9 });
  const gusts = force.field(curl((x, y) => t.noise(x / 25, y / 25) * 2));
  const moved = cloud.steps(160, (cur, next) => {
    next.move((p) => mul(sum(avoid(p), gusts(p), [2, 0]), p.mobility * 0.18));
  });
  return [stroke(wall.contour), moved.points.map((p) => circle(p.x, p.y, 0.35))];
});
```

### structure and queries

Structural helpers are ordinary functions over the edit interface;
nothing registers them. Three that come up:

```ts
// prune: drop the tips older than a lifespan, edges and all
next.remove((p) => p.degree === 1 && p.age > lifespan);   // (degree is the sketch's own column)

// replace an edge with a bend through a new junction
function fork(next, edge, position) {
  next.disconnect(edge);
  const junction = next.addPoint(position, { age: 0 });
  next.connect(edge.a, junction, { rest: edge.attrs.rest / 2 });
  next.connect(junction, edge.b, { rest: edge.attrs.rest / 2 });
  return junction;                      // a third branch can connect here
}

// attach a tip to the edge its next step would cross
const edges = query.edges(current);     // prepared once for this state
const hit = edges.firstHit(p, target, { excludeIncident: p });
if (hit) next.connect(p, next.split(hit.edge, { at: hit.t }));
```

`query.edges(material)` prepares a query over a frozen state's sampled
straight edges. `nearest(position, { within })` returns `{ edge,
position, t, distance }` or null — `within` inclusive, ties to the earlier
edge, a zero-length edge is a point with `t = 0`. `firstHit(from, to, {
excludeIncident? })` returns the first edge a straight move would meet,
`{ edge, position, t, along, distance, kind }`, by smallest `along` then
edge order; `kind` is `crossing`, `touch` (endpoint contact, or a
zero-length move) or `overlap` (collinear: the start of the overlapping
interval). `t` is along the source edge in stored a → b order. Queries
return information and never edit; results belong to the state they were
asked of, and the index does not see additions made in the same step.
Both walk every edge: about a millisecond per query on 20k edges.

```ts live
import { sketch, stroke, circle, material, query, add, mul, sub, unit } from 'occlude';

// Growing tips join what they meet: each active tip looks one step
// ahead with firstHit; a hit splits that edge and connects to it, a miss
// extends. Junctions are ordinary vertices; curves() walks each arm once.
export default sketch({ aspect: [2, 1], seed: 17 }, (t) => {
  const seeds = material(t.times(7, (i) => [12 + i * 12.5, 46]), { active: 1, heading: -Math.PI / 2 });
  const web = seeds.steps(34, (cur, next, k) => {
    const edges = query.edges(cur);
    next.extend((p) => {
      const h = p.heading + t.noise(p.x / 8, p.y / 8, k * 0.01) * 0.7;
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      const hit = edges.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: 0 } }) };
      return { position: target, attributes: { active: 1, heading: h } };
    }, { where: (p) => p.active === 1 && p.y > 4 });
    next.set(() => ({ active: 0 }), { where: (p) => p.active === 1 });
  });
  return [web.curves().map((c) => stroke(c)), web.points.filter((p) => p.active).map((p) => circle(p.x, p.y, 0.5))];
});
```

```ts live
import { sketch, stroke, circle, force, sum, mul } from 'occlude';

// Prune and re-knit: a grown ring loses every edge that stretched past a
// breaking length, then the loose ends reconnect to the nearest other
// end — remove, disconnect and connect as ordinary edits after growth.
export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const wander = force.drift(t.noise, { amount: 0.12, frequency: 0.1 });
  const grown = t.sample(circle(50, 25, 5), { count: 30 }).attribute('age', 0).steps(120, (cur, next, k) => {
    const pull = force.tension(cur, { rest: 0.9 });
    const repel = force.separation(cur, { radius: 2.2, excludeConnected: true });
    next.move((p) => mul(sum(pull(p), repel(p), wander(p, k)), 0.15));
    next.set((p) => ({ age: p.age + 1 }));
    next.splitEdges((e) => e.length > 1.1 && t.chance(0.3), { point: { age: 0 } });
  });
  const cut = grown.steps(1, (cur, next) => {
    next.disconnect((e) => e.length > 1.05);
    next.remove((p) => p.age < 4);
  });
  return cut.curves().map((c) => stroke(c));
});
```

### selections, extraction, relations

A selection names part of one state — the points or edges a predicate
picked — without copying positions or changing anything. The predicate
runs once; membership is then fixed. `.points` / `.edges` are the
source's own views (same row numbers, same ownership), so native array
methods do the rest. Independent material is made on purpose with
`extract()`.

| value | meaning |
|---|---|
| `m.selectPoints(p => bool)` / `m.selectEdges(e => bool)` | a source-bound selection: `source`, `size`, `indices` (source rows, ascending, frozen), `has(view)` |
| `sel.has(view)` | true for a selected view OF THE SOURCE; a view of another state is never a member; the other domain's view is an error |
| `sel.union(o)` / `intersect(o)` / `subtract(o)` | new selection, same domain and exact source only — equal rows in different states are not identities |
| `points.extract()` | the selected points and every point column, NO edges (edge columns stay declared, empty) |
| `points.inducedEdges()` | the source edges with both ends selected — existing connections, never new ones |
| `edges.extract()` | the selected edges, their endpoints and both attribute domains; stored orientation kept |
| `edges.points` | the endpoints, each once, source order (not every point of the source) |
| `edges.curves()` | the selected edges as chains, each once; junctions and ends of the SELECTED graph; `indices` are source rows |

Extracted material is a fresh evolution: iteration 0, no history, transfer
policies carried, rows compacted in source order. Nothing is merged,
welded, deduplicated or interpolated on the way. Point extraction keeps
isolated selections; `inducedEdges().extract()` drops a selected point
that has no selected edge — pick the one you mean.

Inside a rule, select from `current`; an outer selection is of another
state and its `has` answers false for `current`'s views. The one place a
current-state selection cannot vouch for a view is `splitEdges`, whose
predicate sees the MOVED edges: iterate `sel.edges` and call
`next.split(e)` per edge instead.

Relations are ordinary functions over what exists: `m.connectedPoints(p)`
is adjacency as views (no spatial search), `meanBy(items, fn)` the scalar
mean (0 of nothing; NaN propagates), `components(m)` one prepared
connected-components pass with `count`, a source-aligned `labels` column
and `label(vertex)`. Distance to other material is `query.edges(...)`
prepared once outside the attribute callback; nearby points are
`neighbours`. Connected and nearby are different questions.

```ts live
import { sketch, stroke, circle, connect, ui } from 'occlude';

// Selection: the edges longer than a threshold drawn heavy, the rest of
// the mesh lightly (the complement is a selection too), and the points
// the long edges touch as dots. Move `longest` and watch membership
// change; nothing is rebuilt.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const longest = ui(9, { min: 3, max: 14, step: 0.5 });
  const mesh = connect.triangulate(t.times(13 * 7, (i) => [6 + (i % 13) * 7.3 + t.rnd(-2.2, 2.2), 6 + Math.floor(i / 13) * 6.3 + t.rnd(-2, 2)]));
  const long = mesh.selectEdges((e) => e.length > longest);
  const rest = mesh.selectEdges(() => true).subtract(long);
  return [
    rest.curves().map((c) => stroke(c, { pen: 'pigma-005-black' })),
    long.curves().map((c) => stroke(c, { pen: 'stabilo-88-blue' })),
    long.points.map((p) => circle(p.x, p.y, 0.9, { pen: 'stabilo-88-blue' })),
  ];
});
```

```ts live
import { sketch, stroke, circle, force, mul, ui } from 'occlude';

// Extraction, left to right: the source ring with its selected arc heavy
// and the rest faint; the arc extracted as its own material, alone; the
// extracted arc relaxed on its own, over the faint remainder — the source
// never moves. `cut` is the selection's height.
export default sketch({ aspect: [3, 1], seed: 11 }, (t) => {
  const cut = ui(48, { min: 20, max: 80, step: 1 });
  const ring = t.sample(circle(50, 50, 34), { count: 48 }).steps(1, (_, next) => next.move((p) => [t.rnd(-4, 4), t.rnd(-4, 4)]));
  const arc = ring.selectEdges((e) => e.a.y < cut && e.b.y < cut);
  const rest = ring.selectEdges(() => true).subtract(arc).extract();
  const piece = arc.extract();                                       // iteration 0, no history, its own rows
  const smooth = piece.steps(60, (cur, next) => {
    const relax = force.relax(cur);
    next.move((p) => mul(relax(p), 0.5), { where: (p) => cur.degree(p.index) === 2 });
  });
  const at = (m, dx) => m.steps(1, (_, next) => next.move(() => [dx, 0]));
  const faint = (m) => m.curves().map((c) => stroke(c, { pen: 'pigma-005-black' }));
  const heavy = (m) => m.curves().map((c) => stroke(c, { pen: 'stabilo-88-blue' }));
  const ends = (m, dx) => m.points.filter((p) => m.degree(p.index) === 1).map((p) => circle(p.x + dx, p.y, 1.2));
  return [
    faint(rest), arc.curves().map((c) => stroke(c, { pen: 'stabilo-88-blue' })),
    heavy(at(piece, 100)), ends(piece, 100),
    faint(at(rest, 200)), heavy(at(smooth, 200)), ends(smooth, 200),
  ];
});
```

```ts live
import { sketch, stroke, connect, meanBy, segmentRuns, extent, banding } from 'occlude';

// Relational attributes: the same mesh twice. Left, every vertex has a
// random `age` and the edges are banded on it — salt and pepper. Right,
// `neighbourAge` is the mean over connected vertices, and the bands
// become patches. Same geometry, one column derived from its neighbours.
export default sketch({ aspect: [2, 1], seed: 21 }, (t) => {
  const pts = t.times(9 * 8, (i) => [4 + (i % 9) * 5 + t.rnd(-1.4, 1.4), 4 + Math.floor(i / 9) * 6 + t.rnd(-1.6, 1.6)]);
  const raw = connect.triangulate(pts).attribute('age', () => t.rnd(0, 1));
  const smoothed = raw.attribute('neighbourAge', (p) => meanBy(raw.connectedPoints(p), (q) => q.age));
  const right = smoothed.steps(1, (_, next) => next.move(() => [52, 0]));
  const bands = (col) => { const [lo, hi] = extent(col); return banding({ min: lo, max: hi, count: 3 }); }; // each column on its own range
  const rawBand = bands(raw.attrs.age);
  const meanBand = bands(right.attrs.neighbourAge);
  const pens = ['stabilo-88-blue', 'pigma-005-black', 'stabilo-88-green'];
  return [
    segmentRuns(raw, (a, b) => rawBand((a.age + b.age) / 2)).map((r) => stroke(r, { pen: pens[r.key] })),
    segmentRuns(right, (a, b) => meanBand((a.neighbourAge + b.neighbourAge) / 2)).map((r) => stroke(r, { pen: pens[r.key] })),
  ];
});
```

```ts live
import { sketch, stroke, circle, material, append, connect, components, segmentRuns } from 'occlude';

// Components: separate chains, a ring, and lone points in one material.
// components() labels each piece once; the pen cycles by label and a
// tally of label + 1 dots sits by the piece's first vertex, so every
// label is readable even where the pens repeat. Isolated vertices are
// pieces too.
export default sketch({ aspect: [2, 1], seed: 14 }, (t) => {
  const chain = (x, y, n) => connect.chain(t.times(n, (k) => [x + k * 3.2, y + t.noise(x + k, y) * 6]));
  let all = append(chain(6, 10, 8), chain(40, 8, 10));
  all = append(all, chain(72, 12, 7));
  all = append(all, chain(10, 34, 12));
  all = append(all, connect.ring(t.times(12, (k) => [66 + Math.cos(k / 12 * Math.PI * 2) * 8, 34 + Math.sin(k / 12 * Math.PI * 2) * 8])));
  all = append(all, material([[50, 22], [88, 42], [30, 46], [92, 20]]));
  const pieces = components(all);
  const labelled = all.attribute('piece', (p) => pieces.label(p), { transfer: 'nearest' });
  const pens = ['pigma-01-black', 'stabilo-88-blue', 'stabilo-88-green'];
  const first = t.times(pieces.count, (label) => labelled.points.find((p) => p.piece === label));
  return [
    segmentRuns(labelled, (a) => a.piece).map((r) => stroke(r, { pen: pens[r.key % 3] })),
    labelled.points.filter((p) => labelled.degree(p.index) === 0).map((p) => circle(p.x, p.y, 0.5, { pen: pens[p.piece % 3] })),
    first.map((p) => t.times(p.piece + 1, (k) => circle(p.x + k * 1.5, p.y - 3.5, 0.45, { pen: pens[p.piece % 3] }))),
  ];
});
```

```ts live
import { sketch, stroke, circle, rect, query, material, append, ui } from 'occlude';

// Distance as a column: two obstacles' outlines are prepared once as an
// edge query, and every point of an even grid records its distance to
// the nearest sampled edge — a dot's size. Beyond `within` the query
// answers null and the artist's fallback shows as the largest dots.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const within = ui(12, { min: 3, max: 30, step: 1 });
  const box = t.sample(rect(14, 12, 24, 22), { spacing: 1 });
  const disc = t.sample(circle(68, 27, 11), { spacing: 1 });
  const edges = query.edges(append(box, disc));                    // once, outside the callback
  const grid = material(t.times(33 * 16, (i) => [2.5 + (i % 33) * 3, 2.5 + Math.floor(i / 33) * 3]));
  const measured = grid.attribute('distance', (p) => edges.nearest(p, { within })?.distance ?? within);
  return [
    stroke(box.contour), stroke(disc.contour),
    measured.points.filter((p) => p.distance > 0.6).map((p) => circle(p.x, p.y, 0.15 + 1.15 * (p.distance / within))),
  ];
});
```

### resample

`m.resample({ spacing | count, transfer? })` — redistribute a deformed
chain's vertices evenly by arc length. Chains only (a junction is an
error, for now). Open chains keep both endpoints, closed ones their seam
at the first vertex; separate chains stay separate. Corners are NOT
preserved: a new vertex lands on the old polyline, but a corner between
two new vertices is cut. Attributes carry over per `transfer`: linear
interpolation for every column by default; `'nearest'` (ties to the start
vertex), a constant, or a function `(a, b, t) => value` per column say
otherwise — a display curve may interpolate `age`, a simulation point may
want it reset. Each new edge takes the edge attributes of the source edge
under its midpoint. Splitting adds detail and keeps every vertex; resampling
may remove them. Neither smooths.

```ts live
import { sketch, stroke, circle, rect, force, mul } from 'occlude';

// A rectangle's outline pushed around by a vortex, then resampled evenly
// for the pen: left as deformed (vertices drawn), right resampled at 1.5.
export default sketch({ aspect: [2, 1], seed: 1 }, (t) => {
  const swirl = force.vortex({ x: 25, y: 25 }, { strength: 5, falloff: 6 });
  const bent = t.sample(rect(10, 10, 30, 30), { spacing: 3 }).steps(30, (cur, next) => {
    next.move((p) => mul(swirl(p), 0.3));
  });
  const even = bent.resample({ spacing: 1.5 });
  return [
    stroke(bent.contour), bent.points.map((p) => circle(p.x, p.y, 0.35)),
    stroke({ pts: even.pts.map(([x, y]) => [x + 50, y]), closed: true }),
    even.points.map((p) => circle(p.x + 50, p.y, 0.35)),
  ];
});
```

### segmentRuns, extent, banding

`extent(column)` is `[min, max]` (`[0, 0]` when empty). `banding({ min,
max, count })` is a classifier into `count` equal bands, clamped at both
ends, everything in band 0 for a constant range. `segmentRuns(m, (a, b)
=> key)` classifies every edge by its two vertices (a → b in stored
order) and gathers consecutive equal keys into runs, chain by chain: runs
end at endpoints and junctions, never split across a closed chain's seam,
and meet end to end so together they redraw every edge once; a uniform
closed chain is one closed run. The key type is whatever your classifier
returns. The classification is yours: a vertex attribute needs an
interpretation before it can own an edge — the start vertex's, the end's,
both, or their mean are different drawings. Measurement, classification
and pen assignment stay three separate lines.

```ts live
import { sketch, stroke, circle, force, sum, mul, segmentRuns, extent, banding } from 'occlude';

// The same grown ring, cut into runs by age band: young edges in one pen,
// old ones in another — chosen after the growth, not inside it.
export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const wander = force.drift(t.noise, { amount: 0.1, frequency: 0.1 });
  const last = t.sample(circle(50, 25, 5), { count: 24 }).attribute('age', 0).steps(60, (cur, next, k) => {
    const pull = force.tension(cur, { rest: 0.8 });
    const repel = force.separation(cur, { radius: 2, excludeConnected: true });
    next.move((p) => mul(sum(pull(p), repel(p), wander(p, k)), 0.15));
    next.set((p) => ({ age: p.age + 1 }));
    next.splitEdges((e) => e.length > 0.9 && t.chance(0.3), { attributes: { age: 0 } });
  });
  const [young, old] = extent(last.attrs.age);
  const band = banding({ min: young, max: old, count: 2 });
  const pens = ['stabilo-88-blue', 'pigma-005-black'];
  return segmentRuns(last, (a, b) => band((a.age + b.age) / 2)).map((r) => stroke(r, { pen: pens[r.key] }));
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
(`rnd`/`noise`/`pick`/`chance`/`stream` read the seed), layout
(`bounds`/`grid`/`times` need the resolved paper), and point
distributions (`scatter`/`points` need both; their pure duals
`voronoi`/`triangulate` are imports). The toolkit also
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
  `{ pen, penName, gcode, inkMm, travelMm }`. `optimize` sets the 2-opt
  tour budget (`false` disables, a number overrides). Plot time is not on
  the job: `estimatePlanMs` over the toolpath is the one model (law 4),
  shared by the driver, the export panel, plotstats and the simulation.
- `exportSvg` is the plotted drawing, not the raw fragments: one `<path>` per
  chain the pen draws, in plot order, after the same merge → tour → bridge
  the G-code and the machine run (law 5 — preview, export and machine
  agree). Curves stay exact (arcs and cubics, no flattening); sub-nib gaps
  the nib physically spans are inked as bridges. `tourBudget` matches
  `optimize`; default 200 000.
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

- Pens: `{ name, width, color, feed, penDown, penUp, penDelay, reinkMm? }` —
  width in mm is the system's one tolerance. Unknown pen names throw, so shared
  sketches fail loudly. `DEFAULT_PENS` ships a starter set; the studio
  persists its own library server-side and injects it via
  `setPenLibrary(pens)`.
- Papers: `PAPERS` has A3–A6, Letter, Square20; custom sizes via
  `{ paper: { w, h } }`.
- Paper colour: the studio's Paper panel carries the stock you actually
  loaded (natural white through kraft and black, or any colour by hand).
  It paints under the ink in the preview AND in both exports — the preview
  is ink-truth, so a white gel pen on black stock reads on screen the way
  it will on paper. It changes nothing about the ink or the plot, so
  setting it never re-renders.

## The sketch library

Saved sketches live on the studio server as a git repository: every save
is a commit, so nothing is ever lost, and the **Sketches** page shows the
library as cards. Two moves beyond saving, both from the studio's top bar:

- **Fork** copies the current sketch into a new one (its first line
  records `// fork of <name> @ <commit>`) and opens it, so you can follow
  a different path without touching the original. Forks can fork; the
  page nests them under their parent.
- **Snapshot** freezes the current source together with the seed it
  rendered under — an annotated tag, immutable — for "I like this one"
  moments that don't deserve a whole new sketch. On the page a snapshot
  opens with its seed, or forks into a sketch of its own.

Thumbnails come from the studio's finished render on save and snapshot;
the page never renders. Each card opens into its forks, snapshots, and a
rail of its history.

## Plotting from the studio

The Plot panel drives an EBB-family (AxiDraw/iDraw) machine over Web
Serial. What's under the hood, briefly, so its knobs make sense:

- **Motion**: host-side look-ahead planning (junction deviation, min-cruise)
  emitted as hardware-interpolated constant-acceleration `LM` commands
  (25 kHz ramps in firmware; falls back to `XM` packets below firmware
  2.5.3 or via the checkbox). Separate acceleration for pen-up travel.
- **Pen cycles**: per-pen `feed` and `penDelay` (the settle at FULL lift).
  With a **lift map** on the machine profile, every travel takes the
  smallest lift that clears along its path (less a margin), and the
  **settle curve** scales the pen's settle down for that lift — the big
  lever on hatch/stipple plots, now per travel and per bed position rather
  than a fixed 40% hop within a distance. Driver and estimator price the
  cycle through one function (`settleAtLift`), so the ETA stays honest.
- **Re-ink pauses**: pens with a `reinkMm` budget (paint markers that need
  pumping, dip pens, brushes) auto-pause at the first stroke boundary past
  that many drawn mm: the carriage parks at the paper origin — the
  gantry's stiffest corner, clear of wet ink — and waits for Resume.
  Steppers stay energized while parked, so handling the pen won't shift
  registration; pump against a scrap sheet, or unclamp the pen and mark
  its clamp depth with a tape collar so it re-seats identically. 0 = off.
- **Position integrity**: the board's step counters are checked against
  dead reckoning at connect, every 500 chains, and at plot end — lost
  commands are healed automatically and flagged. Visible drift mid-plot:
  Pause → jog the pen onto the origin mark → Set origin → Resume (the
  interrupted stroke's remainder stays pen-up; the next chain re-inks).
- **Two origins**: *Set bed origin* zeroes the machine at the bed corner
  the lift map was measured from (same corner every time); *Set paper
  origin* records where the sheet is as an offset, without zeroing. Plots
  draw at the offset; the map reads bed coordinates; Home returns to the
  bed corner.
- **Resume**: progress (sketch, source hash, seed, pen, paper offset, chain
  reached) is saved on the server every few chains. After a stop, a crashed
  tab, or a power loss, *Resume saved plot* rebuilds the same plan and
  carries on from that chain at the saved offset — after a power loss,
  re-park at the bed corner and Set bed origin first. *Clear saved plot*
  forgets it. A board that stops answering mid-plot is recovered
  automatically (emergency stop, position re-read, the chain redone).
- **Pen changes**: no changer — multi-pen sketches plot one pen per run
  via the Plot-pen select; "all pens (one run)" runs a whole multi-pen
  plan with the installed pen, each chain using its own logical pen's
  feed/settle.
- **Diagnostics** (Machine page → Calibration): registration probe (step loss),
  backlash squares, corner ringing at three feeds (junction-deviation
  tuning), plus the `settle-sweep` sketch for finding a pen's true
  `penDelay` floor. **Download serial log** exports the full timestamped
  command transcript — the first artifact to grab when anything misbehaves.
- **Pen-height cards** (Machine page → Calibration, in run order): the servo is open loop and
  the gantry sags, so the only sensor is ink. Seat the pen on a shim the
  same way every time, then let the paper answer in pulse units: the
  **lift traverse** sweeps the raised pen across the whole bed at six lift
  pulses (ink between the edge ticks = where that lift dragged; minutes),
  the **lift grid** hops within each bed cell at the same pulses (a zigzag
  joining the dash ends = dragged; the last clean strip is that cell's
  clearance threshold; the slow truth for short hops), **settle × lift** finds the settle each
  lift needs, and the **down sweep** finds the pen-down pulse at which the
  horn fully releases the pen (first solid hatch patch). The cards are read
  by eye and pasted into the panel (diagonal counts per cell; settle per
  ladder column) to become the profile's `liftMap` and `settleCurve`.
  Machine profile fields are `penUpPulse` (SC,4) and `penDownPulse` (SC,5).
- **ETA**: totals come from the planner's actual trapezoids and blend
  toward measured throughput as the plot runs — the number is honest.
- **Draft plots**: `decimate(0.7, everything)` makes a fast structural
  test plot with a fraction of the ink budget; the seed keeps it
  reproducible when you re-plot the full version.

Real bridge numbers from a shaded A4 piece, for calibration: no bridge
≈ 34,000 lifts / ~11 h; `bridge: mm(0.5)` ≈ 4.4 h; `mm(0.7)` ≈ 2.9 h;
`mm(1)` ≈ 2.3 h — the Debug view's red connectors show what each
tolerance costs visually.
