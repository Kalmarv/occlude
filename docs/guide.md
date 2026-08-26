# occlude guide

Worked examples, from first render to the modifier stack. Every code block
on this page is a complete sketch — paste it into the studio and it runs.
The [API reference](api.md) has the terse version of everything here.

## 1. Fill means occlude

The whole library is built on one idea: **a filled shape hides what's
beneath it**, computed exactly on the vector geometry — not by painting
over it. The plotter never draws a stroke that a filled shape covers.

```ts
import { sketch } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 7 }, ({ circle, hatch, times, rnd }) => [
  times(60, () => circle(rnd(100), rnd(100), rnd(3, 14), { fill: hatch(rnd(180)) })),
]);
```

Sixty hatched circles; every one hides the circles earlier in the tree.
Three things to internalise:

- **Tree order is draw order.** Later shapes sit on top. `z` overrides.
- **`fill` implies opaque.** So does `opaque: true` (occludes with no
  texture — only the outline draws). A shape with neither is transparent
  ink: it draws but never hides anything.
- **The cut is exact.** A stroke that dips behind a circle is split at the
  true intersection and only the visible pieces survive. Zoom into the
  studio preview — the seams are perfect at any magnification.

## 2. Masks: hidden-line drawing

`mask(shape)` occludes and draws *nothing*. That one combinator is the
whole hidden-line technique: draw a crest, then mask the region below it,
so everything drawn later (farther ridges) disappears behind it.

```ts
import { sketch } from 'occlude';

export default sketch({ aspect: [3, 2], margin: 6, seed: 41 }, ({ path, mask, bounds, noise, times }) => {
  const b = bounds();
  return times(11, (i) => {
    const baseY = b.h * (0.3 + (i / 10) * 0.62);          // far → near
    const crest = path().moveTo(0, baseY + noise(0, i * 3) * 9);
    for (let x = 2; x <= b.w; x += 2) {
      crest.lineTo(x, baseY + noise(x * 0.045, i * 3) * 9);
    }
    const ridgeLine = crest.build();                       // snapshot: the visible stroke
    const ridgeMask = mask(crest.lineTo(b.w, b.h).lineTo(0, b.h).close().build());
    return [ridgeMask, ridgeLine];
  });                                    // far ridges first; nearer ones (later) win
});
```

The trick in the middle: `build()` snapshots the path *and the builder
stays extendable*, so the same crest becomes both the drawn line and (after
closing it down to the bottom edge) the invisible occluder. Far ridges
come first in the tree, so each nearer ridge (later — later wins) hides
what's behind it.

## 3. Units, in practice

Positions and sizes are different animals. Bare numbers are percent of the
**short side** — perfect for sizes (a radius of `10` is the same millimetres
in x and y) and for coordinates on square aspects. On non-square aspects
the long axis runs past 100, which is the classic surprise:

```ts
import { sketch } from 'occlude';

export default sketch({ aspect: [2, 3], margin: 6, seed: 1 }, ({ rect, circle, bounds, w, h, mm }) => {
  const b = bounds();                 // { w: 100, h: 150, cx: 50, cy: 75 } on 2:3
  return [
    rect(0, 0, b.w, b.h),             // true full-bleed frame
    circle(b.cx, b.cy, 30),           // truly centred
    circle(w(90), h(90), mm(6)),      // 90% across each axis; radius in real mm
  ];
});
```

Rules of thumb: `bounds()` (or the toolkit's `width`/`height`/`cx`/`cy`
numbers) for extents; `w()`/`h()` for per-axis positions; `mm()` for
anything physical — hatch spacing, dash lengths, wobble amplitudes. Sizes
in bare numbers scale with the paper; sizes in `mm` don't.

## 4. Transforms and rosettes

Transforms live on groups (or per shape — same thing). They compose
through nesting and pivot around the **user origin**, so `origin: 'center'`
makes rotations spin in place — the rosette idiom:

```ts
import { sketch } from 'occlude';

export default sketch(
  { aspect: 'square', margin: 10, origin: 'center', seed: 5, rectMode: 'center' },
  ({ rect, times }) =>
    times(90, (k) =>
      rect(0, 0, 74, 10, 5, { rotate: k * 4, opaque: true })),
);
```

Ninety opaque rounded rects, each rotated a little further; each hides the
ones beneath, so what survives is the layered fan. Per-shape
`{ translate, rotate, scale }` is identical to wrapping the shape in a
`group` with the same ops (applied translate → rotate → scale). Rotation
and uniform scale keep circles as exact arcs; only non-uniform scale lowers
them to curves.

## 5. The modifier stack

Every shape carries an ordered list of modifiers, applied around the
occlusion solve. The solve is the fixed point in the middle:

```
geometry → [pre-stage: smooth, roughen, deform] → OCCLUSION SOLVE
         → [post-stage: decimate, wobble, dash] → ink on paper
```

**Pre-stage** modifiers change the actual geometry, so they change *what is
hidden* — the modified silhouette occludes, and fills follow it.
**Post-stage** modifiers only distress the surviving ink — the scene is
untouched. Everything is seeded: the same seed always plots the same
drawing.

Every modifier has a dual form — with children it wraps a subtree, bare it
returns a value for an explicit stack:

```ts
wobble(mm(1), circle(50, 50, 20))                    // combinator form
modify([wobble(mm(1)), decimate(0.2)], ...shapes)    // stack form — order is yours
circle(50, 50, 20, { modifiers: [wobble(mm(1))] })   // per shape
```

### wobble — hand tremor (post)

Displaces final strokes with smooth noise. The hidden-line result is
computed exactly first; only the ink trembles. Layer two wavelengths for
the most convincing hand-drawn line:

```ts
import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 9 }, ({ rect, times, modify, wobble }) =>
  times(12, (k) =>
    modify(
      [wobble({ amount: mm(1.2), wavelength: mm(45) }),   // slow drift
       wobble({ amount: mm(0.25), wavelength: mm(6) })],  // fine jitter
      rect(8 + k * 3.5, 8 + k * 3.5, 84 - k * 7, 84 - k * 7))),
);
```

`amount` is the displacement (try `mm(0.3)`–`mm(1.5)`); `wavelength` is
the tremor scale — short reads nervous, long reads relaxed (default
`mm(25)`). The noise field is global over the page, so shapes that touch
tremble together and seams stay sealed.

### decimate — seeded deletion (post)

Deletes a fraction of the final visible strokes. `{ stroke, fill }`
targets outline and fill ink separately:

```ts
import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 3 }, ({ rect, hatch, decimate }) => [
  rect(10, 10, 35, 80, { fill: hatch(45, mm(1.4)), decimate: { fill: 0.55 } }), // eroded texture, crisp frame
  decimate(0.35, rect(55, 10, 35, 80, { fill: hatch(45, mm(1.4)) })),           // everything distressed
]);
```

### dash — chop by length (post)

Cuts strokes into dashes by physical length, *after* occlusion — so dashes
never straddle a hidden region, and the cuts are exact sub-ranges: a
dashed circle is still made of true arcs, not segments.

```ts
import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 2 }, ({ circle, times, dash, modify, decimate }) => [
  times(6, (k) => dash(mm(2 + k), mm(1.5), circle(50, 50, 12 + k * 6))),
  // dash → decimate deletes individual dashes: a broken, stippled ring
  modify([dash(mm(1.2), mm(0.8)), decimate(0.4)], circle(50, 50, 44)),
]);
```

### smooth — Chaikin rounding (pre)

Rounds corners *before* the solve; a few passes approach a spline. The
smoothed outline is what occludes. It turns jagged generated paths into
calm ones:

```ts
import { sketch } from 'occlude';

export default sketch({ aspect: 'square', margin: 10, seed: 19 }, ({ path, smooth, stream, times }) => {
  const walk = stream('walk');
  return times(7, (i) => {
    const p = path().moveTo(4, 14 + i * 12);
    let y = 14 + i * 12;
    for (let x = 10; x <= 96; x += 6) {
      y += walk.rnd(-9, 9);
      p.lineTo(x, y);
    }
    return smooth(3, p.build());     // raw random walk → flowing line
  });
});
```

### roughen — fracture (pre)

The opposite: resamples edges at `detail` spacing and jitters the
vertices — jagged where wobble is smooth. Torn paper, stone, coastlines:

```ts
import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 10, seed: 8 }, ({ rect, roughen, hatch, times }) =>
  times(4, (k) =>
    roughen(mm(1), mm(2),
      rect(12 + k * 6, 12 + k * 6, 76 - k * 12, 76 - k * 12,
        { fill: k === 3 ? hatch(30, mm(1.6)) : undefined, opaque: true }))),
);
```

Because roughen is pre-stage, each torn frame genuinely occludes the ones
behind it along its torn edge — and the hatch fills the torn region, not
the original rect.

### deform — displace the form itself (pre)

Moves the geometry through a vector field before the solve. This is the
one wobble can't imitate: the deformed silhouette decides visibility, so
shapes behind it peek through the wiggles.

```ts
import { sketch } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 6 }, ({ line, circle, times, deform, noiseField }) => [
  times(30, (k) => line(0, k * (100 / 29), 100, k * (100 / 29))),
  deform(noiseField(4, 22), circle(50, 50, 26, { opaque: true })),
]);
```

`noiseField(amount, wavelength)` is the ready-made tremor field; any
`(x, y) => [dx, dy]` (user units) works. A custom field is just math —
here a pinch toward the centre, strongest far away:

```ts
import { sketch } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 13 }, ({ rect, deform, times }) => {
  const pinch = (x: number, y: number): [number, number] => {
    const d = Math.hypot(x - 50, y - 50);
    const k = Math.min(1, d / 60) * 0.25;
    return [(50 - x) * k, (50 - y) * k];
  };
  return times(10, (i) =>
    times(10, (j) => deform(pinch, rect(i * 10 + 1, j * 10 + 1, 8, 8))));
});
```

Deform (and all pre-stage ops) flatten curves into polylines entering the
solve — heavier, but only the wrapped shapes pay. Reach for `wobble` when
you want line quality; reach for `deform` when the *shape* should tremble.

### Order is authored

Stacks run first-to-last, and the order is part of the design:

```ts
import { sketch, mm } from 'occlude';

export default sketch({ aspect: [2, 1], margin: 8, seed: 12 }, ({ rect, modify, smooth, roughen }) => [
  modify([smooth(2), roughen(mm(1), mm(2))], rect(8, 15, 70, 70)),   // rounded, then torn: crisp fracture
  modify([roughen(mm(1), mm(2)), smooth(2)], rect(122, 15, 70, 70)), // torn, then relaxed: soft waves
]);
```

Nesting composes in function-application order — a shape's own
`modifiers` run first, then `modify()` ancestors inside-out. The
`{ decimate }` / `{ wobble }` shorthands still work exactly as before
(nearest declaration wins) and run after any explicit stack.

## 6. Fields: parameters that vary over the page

Anywhere a modifier takes a probability or an amount, it also takes
`(x, y) => number` — evaluated in your sketch's coordinates and rasterised
over the page at render time. One concept, many doors:

```ts
import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 14 }, ({ line, times, modify, dash, decimate, wobble }) => [
  // dissolve: chop into dashes first so the field erodes granularly —
  // intact at the top, dust by the bottom
  modify([dash(mm(3), mm(0.8)), decimate((x, y) => y / 80)],
    times(46, (k, t) => line(2, 2 + t * 60, 98, 2 + t * 60))),
  // calm left, shaky right
  wobble({ amount: (x) => (x / 100) * 2.5, wavelength: mm(9) },
    times(14, (k, t) => line(2, 68 + t * 30, 98, 68 + t * 30))),
]);
```

Fields + composition replace whole feature categories. A halftone is just
hatch, chopped by `dash`, eroded by a brightness field:

```ts
import { sketch, mm } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 21 }, ({ rect, hatch, modify, dash, decimate, noise }) => {
  // "brightness": bright ring around the centre, dark elsewhere
  const bright = (x: number, y: number): number => {
    const d = Math.hypot(x - 50, y - 50);
    return Math.max(0, 1 - Math.abs(d - 26) / 22) * 0.95 + noise(x / 18, y / 18) * 0.05;
  };
  return modify(
    [dash(mm(1.3), mm(0.9)), decimate(bright)],
    rect(2, 2, 96, 96, { fill: hatch(45, mm(1.3)), stroke: false }),
  );
});
```

The same recipe with `stipple` and `{ decimate: { fill: field } }` gives
dot-density halftones. Fielded parameters today: `decimate` probabilities,
`wobble` amount, `roughen` amount; `deform` takes the vector flavour.

Field functions run at render time with the full toolkit available —
`noise` inside a field is seeded and reproducible like everything else.

## 7. Custom fills

A fill can be any function from a region to primitives; it goes through
the same exact occlusion as everything else. Coordinates are **paper
millimetres**; use `ctx.rnd()` (seeded per shape), never `Math.random()`.

```ts
import { sketch } from 'occlude';

export default sketch({ aspect: 'square', margin: 10, seed: 17 }, ({ circle, times, rnd }) =>
  times(7, () =>
    circle(rnd(15, 85), rnd(15, 85), rnd(8, 20), {
      // concentric-ring fill: full circles as single exact arcs
      fill: (region, ctx) => {
        const { x, y, w, h } = region.bbox;
        const cx = x + w / 2;
        const cy = y + h / 2;
        const rings = [];
        for (let r = ctx.penWidth * 2; r < Math.max(w, h) / 2; r += ctx.penWidth * 2.6) {
          rings.push({ type: 'arc' as const, cx, cy, r, start: 0, sweep: Math.PI * 2 });
        }
        return rings;
      },
    })),
);
```

Overshooting the region is fine — every returned primitive is clipped
exactly to the boundary, and then occluded by whatever sits above. Rings,
spirals, variable-radius dots (`arc` with small `r`), scribbles
(`polyline`) — anything the plotter can draw.

## 8. Randomness you can steer

All randomness flows from the seed. The plain `rnd`/`noise` share one
stream, so *inserting a shape shifts every later value*. When you're
iterating on one part of a composition, give it a named stream and it
becomes immune to edits elsewhere:

```ts
import { sketch } from 'occlude';

export default sketch({ aspect: 'square', margin: 8, seed: 30 }, ({ stream, circle, rect, times }) => {
  const dots = stream('dots');       // stable no matter what else changes
  const frames = stream('frames');
  return [
    times(40, () => circle(dots.rnd(100), dots.rnd(100), dots.rnd(1, 3))),
    times(5, (k) => rect(frames.rnd(60), frames.rnd(60), 30, 30, { rotate: frames.rnd(-20, 20) })),
  ];
});
```

`times(n, (i, t) => …)` is the loop idiom — `t` runs 0…1 across the run,
so interpolating anything along a sequence is one expression. And because
`t` is normalised, the whole world of shaping functions plugs into it:
`ease` carries the easings.net catalog, and the thing to know is that
**spacing is the curve's slope** — where the easing is flat, elements
crowd; where it's steep, they spread.

```ts
import { sketch } from 'occlude';

export default sketch({ aspect: 'square', margin: 10, origin: 'center', seed: 9 }, ({ circle, times, map, ease }) => [
  times(40, (k, t) => circle(-26, 0, map(ease.quintOut(t), 0, 1, 4, 22))),  // dense rim
  times(40, (k, t) => circle(26, 0, map(ease.smooth(t), 0, 1, 4, 22))),    // dense both edges
]);
```

All curves pin (0,0) and (1,1), so mapped endpoints are hit exactly;
`back`/`elastic` overshoot in between by design (rings past the target
radius that settle back — a look, not a bug). `range(n)` /
`range(a, b, step)` give integer sequences for nesting. In the studio,
press the dice to re-roll `?seed=` — the URL is the reproduction recipe.

## 9. From screen to paper

- **Pens are real objects** — `{ name, width, color, feed, … }`. The nib
  `width` is the system's only tolerance: sub-nib detail is dropped,
  sub-nib gaps are inked. Unknown pen names throw.
- **Export** — SVG keeps exact curves (no flattening anywhere in the
  pipeline until here); G-code comes out one job per pen with a 2-opt
  optimised tour; PNG renders at any dpi. The studio's plot preview
  animates the actual toured path with real feed rates.
- **Draft plots** — `decimate(0.7, everything)` makes a fast structural
  test plot with the ink budget of a sketch; the seed keeps it
  reproducible when you re-plot the full version.

```ts
import { initOcclude, render, exportSvg, exportGcode } from 'occlude';
import def from './my-sketch.js';

await initOcclude();
const out = render(def, { paper: 'A4' });        // { frags, prims, stats, … }
const svg = exportSvg(def, { paper: 'A4', background: '#f6f2ea' });
const jobs = exportGcode(def, { paper: 'A4', profile: { zMode: true } });
```

Headless, from the repo: `pnpm --filter occlude render sketch.ts --seed 7
--paper A4 --out out.png`.
