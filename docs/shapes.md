# Shapes & layout

Shapes, paths, groups and transforms, repetition, clipping and masking, and the modifiers that change line character. Coordinates are bare units — 1 unit is 1 % of the drawable's short side, so a 2:1 drawable is 200 × 100 units — unless wrapped in `mm()`. See Getting started for the sketch function and units.

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
