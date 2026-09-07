# Shapes & layout

Shapes and paths, groups and transforms, repetition and grids, clipping and masking, and the modifiers that change line character. Coordinates are drawable units unless wrapped in `mm()`: 1 unit is 1 % of the short side, so the 2:1 examples here run 0 to 200 across and 0 to 100 down.

## Shapes

Every shape takes a trailing options object; the table under Shape options lists what it accepts.

### circle

`circle(x, y, r, opts?)` is centre-anchored.

```ts live
import { sketch, circle, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(5, (k, u) =>
    circle(24 + u * 152, 50, 20, { fill: fill('hatch', { angle: u * 90, spacing: mm(0.8 + u) }) }),
  ),
);
```

### rect

`rect(x, y, w, h, radius?, opts?)` is corner-anchored by default; `mode: 'center'` on the shape or `rectMode: 'center'` in the config flips it. `radius` rounds the corners.

```ts live
import { sketch, rect, fill } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) =>
  t.times(5, (k, u) =>
    rect(12 + u * 148, 18, 28, 64, u * 14, { fill: fill('stipple', { density: 0.25 + u * 0.55 }) }),
  ),
);
```

### line

`line(x1, y1, x2, y2, opts?)` is an open stroke. A field of lines is the clearest way to see occlusion at work.

```ts live
import { sketch, line, circle } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  t.times(11, (k, u) => line(0, 8 + u * 84, 200, 8 + u * 84)),
  circle(100, 50, 30, { opaque: true }),
]);
```

### ellipse

`ellipse(x, y, rx, ry, rotation?, opts?)`, rotation in degrees about its own centre.

```ts live
import { sketch, ellipse } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(9, (k, u) => ellipse(100, 50, 88 - u * 8, 42 - u * 4, u * 22)),
);
```

### ngon

`ngon(x, y, sides, r, rotation?, opts?)` is a regular polygon: `sides` vertices on a circle of radius `r`, the first at `rotation` degrees.

```ts live
import { sketch, ngon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(5, (k) =>
    ngon(24 + k * 38, 50, 3 + k, 19, 90, { fill: fill('hatch', { angle: 45, spacing: mm(1) }) }),
  ),
);
```

### path

`path()` is a mutable builder: `moveTo`, `lineTo`, `bezierTo`, `quadTo`, `arcTo`, `close`, then `build(opts?)` snapshots a shape. The builder stays usable after `build()`, which the ridge below relies on: each ridge line is built once as a stroke, then extended down to the bottom edge and built again as a mask, so it hides the ridges behind it.

```ts live
import { sketch, path, mask } from 'occlude';

// Ridges. Later ones are lower on the page and drawn later, so their
// masks hide what lies behind them.
export default sketch({ aspect: [2, 1], seed: 11 }, (t) =>
  t.times(14, (k) => {
    const p = path().moveTo(0, 22 + k * 5);
    for (let x = 5; x <= 200; x += 4) {
      p.lineTo(x, 22 + k * 5 - Math.max(0, t.noise(x * 0.03, k * 0.4)) * 26);
    }
    const ridge = p.build();
    p.lineTo(200, 100).lineTo(0, 100).close();
    return [ridge, mask(p.build())];
  }),
);
```

### polygon

`polygon(contours, opts?)` makes one area from its boundaries: a single contour (`[[x, y], …]`) or several (`[[[x, y], …], …]`). Each contour is closed with a chord if it is not already. The result is one shape, so it clips, fills, masks and stamps as one thing. It takes plain points; records that carry points expose them (`polygon(blobs.map((c) => c.pts))`).

`winding` picks the fill rule where boundaries nest or cross. `'evenodd'` (default) makes every enclosed boundary a hole whatever its orientation, so a ring is an annulus and a pentagram has an empty centre. `'nonzero'` fills the pentagram solid.

```ts live
import { sketch, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, () => {
  const star = (cx) => [0, 1, 2, 3, 4].map((k) => {
    const a = -Math.PI / 2 + (k * 4 * Math.PI) / 5;
    return [cx + 40 * Math.cos(a), 52 + 40 * Math.sin(a)];
  });
  const hatch = fill('hatch', { angle: 45, spacing: mm(1) });
  return [
    polygon(star(55), { fill: hatch }),
    polygon(star(145), { fill: hatch, winding: 'nonzero' }),
  ];
});
```

### label

`label(str, x, y, h, opts?)` is single-stroke plotter text (A to Z, digits and basic punctuation) with cap height `h`. `align: 'center' | 'right'` anchors `x`; `labelWidth(str, h)` measures a string. `unit: 'mm'` places it in millimetres.

```ts live
import { sketch, label, line } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  line(100, 6, 100, 94),
  label('LEFT', 100, 16, 9),
  label('CENTER', 100, 42, 9, { align: 'center' }),
  label('RIGHT', 100, 68, 9, { align: 'right' }),
]);
```

## Groups, clipping and masking

### group

`group(opts, ...children)` applies transforms (`translate`, `rotate`, `scale`), pen and z defaults, and modifier defaults to a subtree. Transforms pivot around the origin, so `translate` first to set the pivot.

```ts live
import { sketch, group, rect } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) =>
  t.times(12, (k) =>
    group({ translate: [50, 50], rotate: k * 30 }, rect(16, -3, 30, 6)),
  ),
);
```

### clip

`clip(shape, ...children)` restricts the children to the shape's region. The region itself is neither drawn nor occluding. Nested clips intersect.

```ts live
import { sketch, clip, circle, line } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  clip(circle(100, 50, 40), t.times(19, (k, u) => line(0, u * 100, 200, u * 100))),
  circle(100, 50, 40),
]);
```

### invert

`invert(shape)` complements a clip region: `clip(invert(shape), …)` keeps the children's ink outside the shape. It is a region annotation, not a drawable, and is an error anywhere else. With `polygon()` this gives both sides of one boundary.

```ts live
import { sketch, clip, invert, polygon, circle } from 'occlude';

// One boundary from a noise level set; fat dots inside it, fine dots outside.
export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const blobs = t.isolines((x, y) => t.noise(x / 28, y / 28), 0.1, { close: true });
  const region = polygon(blobs.map((c) => c.pts));
  const dots = (r) => t.grid({ cols: 40, rows: 20 }).map((c) => circle(c.cx, c.cy, r));
  return [
    clip(region, dots(2.1)),
    clip(invert(region), dots(0.8)),
  ];
});
```

### mask

`mask(shape)` occludes and draws nothing. It is the hidden-line tool, and the eraser for stray strokes in imported art.

```ts live
import { sketch, mask, circle, line } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  t.times(19, (k, u) => line(0, u * 100, 200, u * 100)),
  mask(circle(70, 50, 30)),
  circle(140, 50, 30, { opaque: true }), // opaque draws its outline as well
]);
```

### modify

`modify([...mods], ...children)` applies an ordered modifier stack to a subtree. Stacks compose through nesting: the inner one runs first.

```ts live
import { sketch, modify, wobble, decimate, rect, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 3 }, (t) =>
  modify(
    [wobble(mm(0.6)), decimate(0.15)],
    t.times(9, (k, u) => rect(8 + u * 154, 18, 30, 64, 4)),
  ),
);
```

## Modifiers

A modifier changes line character. Each exists as a shorthand option on a shape (`{ wobble: mm(1) }`) and as a stack entry (`modify([wobble(mm(1))], …)` or `{ modifiers: [...] }`). Pre-stage modifiers deform the outline before the occlusion solve, so the deformed silhouette is what hides and fills follow it. Post-stage modifiers distress the surviving ink after the solve, so hidden-line logic is unaffected. All are seeded and deterministic.

| Modifier | Stage | Parameters (defaults) | Accepts a field |
|---|---|---|---|
| `decimate(p)` | post | `p` 0 to 1, or `{ stroke, fill }` | both probabilities |
| `wobble(amount)` | post | a length; `{ amount, wavelength: mm(25) }` | amount |
| `dash(len, gap, offset?)` | post | lengths; `gap` defaults to `len`; phase-continuous along an outline and period-snapped on closed contours; `offset` shifts the phase | no |
| `smooth(passes)` | pre | `passes = 2` | no |
| `roughen(amount, detail?)` | pre | jitter length; resample step `detail = mm(1.5)` | amount |
| `deform(field)` | pre | `(x, y) => [dx, dy]` in drawable units, or `{ field, detail: mm(2) }` | the field itself |

Order: a shape's own stack runs first, then `modify()` ancestors inside-out; shorthand options run after any explicit stack (decimate before wobble). Pre-stage modifiers flatten the wrapped shapes' curves into polylines for the solve, which costs more, so wrap only the shapes that need deforming. Fielded parameters and `align` are covered in Fields & variation.

### wobble

Seeded smooth-noise displacement, like hand tremor. `{ amount, wavelength }` sets the scale.

```ts live
import { sketch, line, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 7 }, (t) =>
  t.times(12, (k, u) => line(10, 8 + u * 84, 190, 8 + u * 84, { wobble: mm(u * 1.4) })),
);
```

### decimate

Drops a fraction of the final strokes, seeded. `{ stroke, fill }` targets outline and fill ink separately.

```ts live
import { sketch, circle, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) =>
  t.times(4, (k, u) =>
    circle(30 + u * 140, 50, 24, {
      fill: fill('hatch', { angle: 45, spacing: mm(0.7) }),
      decimate: { fill: u * 0.85 }, // erode the texture, keep the outline
    }),
  ),
);
```

### dash

`dash(len, gap, offset?)` cuts strokes into a dash pattern of physical lengths. It runs after occlusion, so dashes continue through hidden-line cuts.

```ts live
import { sketch, modify, dash, circle, mm } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  modify(
    [dash(mm(3), mm(2))],
    t.times(5, (k, u) => circle(100, 50, 8 + u * 38)),
  ),
);
```

### smooth and roughen

`smooth(passes)` relaxes corners toward curves; `roughen(amount, detail)` breaks clean edges into jitter. Both deform the contour before the solve.

```ts live
import { sketch, modify, smooth, roughen, ngon, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, () => [
  ngon(35, 50, 5, 30),
  modify([smooth(3)], ngon(100, 50, 5, 30)),
  modify([roughen(mm(1.2), mm(3))], ngon(165, 50, 5, 30)),
]);
```

### deform

`deform(vectorField)` displaces contours by an `(x, y) => [dx, dy]` field before the solve. `noiseField(amount, wavelength?)` is a ready-made one.

```ts live
import { sketch, modify, deform, noiseField, rect } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 2 }, (t) =>
  modify(
    [deform(noiseField(6, 30))],
    t.times(8, (k, u) => rect(14 + u * 150, 20, 18, 60)),
  ),
);
```

### bridge

`bridge` is a shape or group option rather than a stack modifier. After occlusion it joins stroke endpoints pen-down across gaps up to the given length, so hatch rows become one serpentine stroke. Connectors only cross blank paper. The cost is the short connecting marks themselves; the studio's Debug view highlights them in red so you can judge whether a tolerance is too loose.

```ts live
import { sketch, line, mm, group } from 'occlude';

// Left: 14 separate strokes. Right: the same rows bridged into one stroke.
export default sketch({ aspect: [2, 1] }, (t) => [
  t.times(14, (k) => line(10, 30 + k * 3, 90, 30 + k * 3)),
  group({ bridge: mm(3.5) }, t.times(14, (k) => line(110, 30 + k * 3, 190, 30 + k * 3))),
]);
```

## Shape options

| Option | Meaning |
|---|---|
| `pen` | Pen for the stroke and, by default, the fill. |
| `fill` | Fill texture. In the current version a fill makes the shape opaque; see Fills. |
| `fillPen` | Pen for the fill when different from `pen`. |
| `opaque: true` | Hides what lies beneath with no texture; only the stroke draws. |
| `stroke: false` | No outline. A pen name instead overrides the stroke pen. |
| `z` | Stacking override; the default is tree order. |
| `mode` | rect only: anchor (x, y) at the `'corner'` (default) or `'center'`. Circles, ellipses and n-gons are always centre-anchored. |
| `translate`, `rotate`, `scale` | A per-shape transform, the same as wrapping the shape in a group (applied translate, then rotate, then scale). |
| `decimate`, `wobble` | Shorthand for the modifiers of the same name: `{ wobble: mm(0.8) }`, `{ decimate: { fill: 0.5 } }`. |
| `modifiers` | An ordered stack: `{ modifiers: [smooth(2), wobble(mm(1)), decimate(0.2)] }`, run first to last. |
| `bridge` | Pen-down joining across gaps up to this length. Inherited from a group. |

## Layout and repetition

### times and range

`t.times(n, (k, u) => …)` calls the function n times with the index `k` and `u` running from 0 to 1 across the run. `t.range(n)` and `t.range(a, b, step?)` give plain integer sequences. Both refuse runaway counts, so a mid-edit `step = 0` is an error rather than a frozen tab.

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) =>
  t.times(9, (k, u) =>
    t.times(1 + k, (j, v) => circle(12 + u * 176, 90 - v * (k * 7.5), 3.5 - u * 2)),
  ),
);
```

### grid

`t.grid({ cols, rows, gap? })` returns cell rectangles covering the whole drawable, each `{ x, y, w, h, cx, cy, i, j }`.

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

`t.bounds()` is the drawable extent in the sketch's units: `{ x, y, w, h, cx, cy }`. On a non-square drawable the long axis runs past 100, so read `b.w` and `b.h` rather than assuming.

```ts live
import { sketch, rect, line, label } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const b = t.bounds();
  return [
    rect(0, 0, b.w, b.h),
    line(0, 0, b.w, b.h),
    line(0, b.h, b.w, 0),
    label('W ' + Math.round(b.w) + '  H ' + Math.round(b.h), b.cx, b.cy - 4, 8, { align: 'center' }),
  ];
});
```

### noisyLine

`t.noisyLine(x1, y1, x2, y2, { amplitude?, scale?, points?, offset? })` is a line with organic waver whose endpoints stay exact. Here a horizon of them runs behind an opaque disc.

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => [
  t.times(17, (k, u) =>
    t.noisyLine(6, 8 + u * 84, 194, 8 + u * 84, { amplitude: 1 + u * 5, offset: k * 7.3 }),
  ),
  circle(140, 36, 20, { opaque: true }),
]);
```
