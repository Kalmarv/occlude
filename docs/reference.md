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
(`mm()` for physical).

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
