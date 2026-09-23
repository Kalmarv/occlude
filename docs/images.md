# Images & imports

Line art from SVG files, image assets, and image tone and direction turned into marks. Files come from the studio's Assets page and are named by string literal, so the studio can load them before the sketch runs. The image examples on this page use `ivy.png` from the docs assets.

## SVG line art

`svg(text, { x?, y?, width?, layers?, ...shapeOpts })` turns line art (polylines, `<line>` elements and paths of straight segments and Bézier curves) into ordinary open-path shapes: occluded, clipped, masked, modified and pen-assigned like anything else. `width` scales the drawing and height follows the aspect; `layers` filters by top-level `<g>` id. Affine `transform` attributes (translate, scale, rotate, skew, matrix, nested through groups) are applied exactly, and cubic and quadratic Béziers enter as the curves they are; elliptical arcs (`A`) have no exact form here and are rejected with an error rather than approximated. Hatch-dense imports benefit from the `bridge` option.

```ts live
import { sketch, svg, circle } from 'occlude';

const ART = `<svg viewBox="0 0 100 40">
  <g id="waves">
    <polyline points="0,10 20,4 40,16 60,6 80,14 100,8"/>
    <polyline points="0,22 25,16 50,26 75,18 100,24"/>
    <polyline points="0,34 30,28 60,36 100,30"/>
  </g></svg>`;

export default sketch({ aspect: [2, 1] }, () => [
  svg(ART, { x: 0, y: 10, width: 200 }),
  circle(100, 50, 24, { opaque: true }), // imported strokes are occluded like any others
]);
```

`asset('name.svg')` returns the text of an uploaded file:

```ts
const church = svg(t.asset('church.svg'), { width: b.w, bridge: mm(0.7) });
```

## OBJ models

`obj(text, { up?, objects? })` from `occlude/3d` turns a Wavefront OBJ file into a mesh: viewed, occluded and hatched like a box. Upload the file on the Assets page and read it with `t.asset('name.obj')`. The signature and a live example are on the [3D primitives](/docs/reference/3d/primitives#obj) page.

## Sampling an image

`image('name.png', { x, y, width })` never draws. Placement maps the pixels into drawable coordinates so that samples can drive marks. Each sampler takes a position and an optional `area`, a half-size in drawable units to average over; point samples are bilinear and area samples use summed-area tables, so any area costs the same. Average over the mark's own footprint whenever a mark covers more paper than a pixel.

| Sampler | Value |
|---|---|
| `img.lum(x, y, area?)` | luminance, 0 to 1 |
| `img.a(x, y, area?)` | alpha, so a transparent PNG masks its subject |
| `img.bands(x, y, n, area?)` | tone posterized into `n` levels, 0 the darkest |
| `img.edge(x, y, area?)` | luminance gradient magnitude, high at boundaries |
| `img.dir(x, y, area?)` | the gradient's angle |
| `img.field(channel?, { area? })` | a channel as a scalar field: `'lum'` (the default), `'dark'` for `1 − lum`, `'a'`, `'edge'` |

A field is what the rest of the toolkit reads, so `img.field` puts an image behind any of them without a wrapper: contours of tone with `t.isolines`, stipples that crowd where it is dark with `t.scatter`, flow along its edges with `t.streamlines(curl(img.field()))`, or a modifier amount. Outside the placed rectangle the field is 0.

```ts live
import { sketch, strokes, curl, circle } from 'occlude';

// Tone as contours, and streamlines along the edges where the picture is dark.
export default sketch({ aspect: [1, 1], seed: 2 }, (t) => {
  const img = t.image('ivy.png', { x: 8, y: 2, width: 84 });
  const tone = img.field('lum', { area: 0.8 });
  const dark = img.field('dark', { area: 0.8 });
  return [
    strokes(t.isolines(tone, [0.3, 0.5, 0.7])),
    strokes(t.streamlines(t.within(curl(tone), circle(50, 50, 46)), { spacing: (x, y) => 0.8 + (1 - dark(x, y)) * 5 })),
  ];
});
```

Dots sized by darkness, averaged over each grid cell, with the alpha channel as the subject mask:

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const img = t.image('ivy.png', { x: 8, y: 2, width: 84 });
  return t.grid({ cols: 36, rows: 42 }).map((c) => {
    if (img.a(c.cx, c.cy, c.w / 2) < 0.5) return null;
    const dark = 1 - img.lum(c.cx, c.cy, c.w / 2);
    return dark > 0.04 ? circle(c.cx, c.cy, dark * c.w * 0.52) : null;
  });
});
```

Layered marks gated by tone band: one mark at the mid level, two at dark, three at the darkest.

```ts live
import { sketch, line } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const img = t.image('ivy.png', { x: 8, y: 2, width: 84 });
  const out = [];
  for (let y = 2; y < 98; y += 1.4) {
    for (let x = 8; x < 92; x += 1.4) {
      if (img.a(x, y, 0.7) < 0.5) continue;
      const level = img.bands(x, y, 4, 0.7);
      if (level <= 2) out.push(line(x, y, x + 1.1, y));
      if (level <= 1) out.push(line(x, y, x, y + 1.1));
      if (level === 0) out.push(line(x, y, x + 0.9, y + 0.9));
    }
  }
  return out;
});
```

## The direction the picture runs

`img.dir(x, y)` is the gradient angle at one point: it says which way the
picture changes *across* an edge, and it is honest about every speck of noise,
so marks laid out along it stumble wherever the picture is busy or flat.

`img.flow({ radius?, iterations? })` is a vector field of the direction the
picture's structure **runs** — along hair, drapery, bark, the edge of a leaf,
not across it. It is the gradient turned a quarter turn and then made to agree
with itself: each cell is replaced by the sum of the cells around it, every
one flipped into the same half-plane first (a direction here has no head or
tail), weighted by a kernel that falls off with distance, by how strong that
neighbour's edge is, and by how much its direction already agrees. Repeat, and
a flat region takes its direction from the nearest real boundary instead of
from noise.

| Option | Meaning |
|---|---|
| `radius` | how far that agreement reaches, in sketch units. Default the image's width / 64 |
| `iterations` | how many times it is applied. Default 3; 0 is the bare turned gradient |

There is no resolution option, because it would not be independent of
`radius`: a finer grid needs a proportionally wider neighbourhood to reach the
same distance, so the two together would make the cost grow with the fourth
power of one number. The working grid is derived from `radius` instead — four
cells across it — so halving the radius quadruples the work, and a radius so
small that the grid would pass four million cells is refused by name rather
than attempted.

Vectors are unit length inside the picture and `[0, 0]` outside it, so
`t.streamlines` stops at the edge of the placed rect. A patch with no
structure within reach also reports `[0, 0]`: no structure, no direction, and
a stroke ends rather than being invented. It is an ordinary vector field, so
`t.within`, `t.streamlines` and arithmetic on its result all apply.

```ts live
import { sketch, strokes, group } from 'occlude';

// The same picture read two ways. Left: `img.dir` turned a quarter turn, the
// raw gradient, which traces every contour and stumbles wherever the picture
// is noisy. Right: `img.flow`, the same direction after the neighbourhood has
// been made to agree with itself — long strokes that keep running along a
// boundary instead of wandering across it.
export default sketch({ aspect: [2, 1], seed: 2 }, (t) => {
  const img = t.image('ivy.png', { x: 2, y: 2, width: 96 });
  const raw = (x, y) => { const a = img.dir(x, y, 0.6) + Math.PI / 2; return [Math.cos(a), Math.sin(a)]; };
  return [
    strokes(t.streamlines(raw, { spacing: 1.4 })),
    group({ translate: [100, 0] }, strokes(t.streamlines(img.flow(), { spacing: 1.4 }))),
  ];
});
```

A drawing made only of direction and tone. Every stroke runs along the
structure it sits on, so the fur, the ears and the edge of the face are
described by the way the ink lies rather than by any outline, and the spacing
carries the tone.

```ts live
import { sketch, strokes, circle } from 'occlude';

// The picture drawn as its own grain: every stroke runs along the structure
// it sits on, so the fur, the ears and the edge of the face are described by
// the direction of the ink and not by any outline. Spacing carries the tone,
// so the strokes crowd where the picture is dark and open out where it is not.
export default sketch({ aspect: [1, 1], seed: 3 }, (t) => {
  const img = t.image('ivy.png', { x: 2, y: 2, width: 96 });
  const dark = img.field('dark', { area: 0.7 });
  const flow = t.within(img.flow({ radius: 1.5 }), circle(50, 50, 47));
  return strokes(t.streamlines(flow, { spacing: (x, y) => 0.42 + Math.pow(1 - dark(x, y), 2) * 3.2 }));
});
```

Composed with the rest of the toolkit: the flow says which way each stroke
runs, the tone says how close together they run, and the same tone tells every
stroke how hard to bristle. Three readings of one photograph, which therefore
cannot disagree.

```ts live
import { sketch, strokes, circle } from 'occlude';

// Composed: the flow says which way each stroke runs, the tone says how close
// together they run, and the same tone then tells every stroke how hard to
// bristle. The fur stands up where the picture is dark and lies flat where it
// is light, and none of the three readings can disagree — they are the same
// photograph asked three questions.
export default sketch({ aspect: [1, 1], seed: 8 }, (t) => {
  const img = t.image('ivy.png', { x: 2, y: 2, width: 96 });
  const dark = img.field('dark', { area: 0.7 });
  const flow = t.within(img.flow({ radius: 1.6 }), circle(50, 50, 46));
  const lines = t.streamlines(flow, { spacing: (x, y) => 0.7 + Math.pow(1 - dark(x, y), 2) * 3.4 });
  return strokes(lines.oscillate({
    wavelength: (x, y) => 1.2 + (1 - dark(x, y)) * 4,
    amplitude: (x, y) => Math.max(0, dark(x, y) - 0.25) * 0.5,
  }));
});
```

Poked: the flow is a function returning a pair, so you can do arithmetic on
what it says. Turn each vector a quarter turn where it is read and the strokes
run straight across every edge instead — combing the fur the wrong way. Two
lines undo the whole point of the construction, which is the proof that it is
data and not a mode.

```ts live
import { sketch, strokes, circle, group } from 'occlude';

// Poked: the flow is a function returning a pair, so you can do arithmetic on
// what it says. Left, the strokes run ALONG the picture's structure, which is
// the whole point of building it. Right, each vector is turned a quarter turn
// where it is read, and they run straight across every edge instead — combing
// the fur the wrong way. Two lines undo the feature, which is the proof that
// it is data and not a mode.
export default sketch({ aspect: [2, 1], seed: 3 }, (t) => {
  const img = t.image('ivy.png', { x: 1, y: 2, width: 96 });
  const dark = img.field('dark', { area: 0.8 });
  const spacing = (x, y) => 0.5 + Math.pow(1 - dark(x, y), 2) * 3;
  const flow = img.flow({ radius: 1.6 });
  const across = (x, y) => { const [dx, dy] = flow(x, y); return [-dy, dx]; };
  const lens = circle(49, 50, 46);
  return [
    strokes(t.streamlines(t.within(flow, lens), { spacing })),
    group({ translate: [100, 0] }, strokes(t.streamlines(t.within(across, lens), { spacing }))),
  ];
});
```

And in three dimensions. Nothing here is a picture: every blade is the same
box on a plain lattice, and only which way it faces and how tall it stands are
read from the photograph. The likeness is a thousand blades agreeing, which is
only possible because the flow is coherent from one blade to the next — the
raw gradient would give a thousand arguments.

```ts live
import { sketch, pen, mm, degrees } from 'occlude';
import { grid, box, instanceOnPoints, view, perspective } from 'occlude/3d';

// A field of blades, combed by a photograph. Nothing here is a picture: every
// blade is the same box, standing on a plain lattice. Only which way it faces
// and how tall it stands are read from the image, and the likeness is made by
// a thousand of them agreeing — which is only possible because the flow is
// coherent from one blade to the next.
export default sketch({ seed: 4, pens: { ink: pen({ width: mm(0.22), color: '#18202A' }) } }, (t) => {
  const img = t.image('ivy.png', { x: 0, y: 0, width: 100 });
  const dark = img.field('dark', { area: 1.6 });
  const flow = img.flow({ radius: 2.4 });
  const SPAN = 9;
  const toImage = (p) => [((p.x + SPAN / 2) / SPAN) * 100, ((p.y + SPAN / 2) / SPAN) * 100];
  const lawn = grid({ cols: 30, rows: 30, spacing: SPAN / 30 });
  const blades = instanceOnPoints(box([0.05, 0.23, 0.34]), lawn.points, {
    rotate: (p) => { const [dx, dy] = flow(...toImage(p)); return [0, 0, degrees(Math.atan2(dy, dx))]; },
    scale: (p) => [1, 1, 0.2 + dark(...toImage(p)) * 1.9],
  });
  return view(blades, {
    camera: perspective({ eye: [0.5, -9.5, 11], target: [0, 0.2, 0.2], fovDegrees: 40 }),
    stroke: 'ink',
  });
});
```

## Direction as marks

Strokes drawn perpendicular to the gradient follow the image's contours, so tone becomes flow.

```ts live
import { sketch, line } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 6 }, (t) => {
  const img = t.image('ivy.png', { x: 8, y: 2, width: 84 });
  const out = [];
  for (let i = 0; i < 2600; i++) {
    const x = t.rnd(8, 92);
    const y = t.rnd(2, 98);
    if (img.a(x, y) < 0.5) continue;
    const dark = 1 - img.lum(x, y, 1);
    if (dark < 0.25) continue;
    const a = img.dir(x, y, 1) + Math.PI / 2;
    const r = 0.6 + dark * 1.6;
    out.push(line(x - Math.cos(a) * r, y - Math.sin(a) * r, x + Math.cos(a) * r, y + Math.sin(a) * r));
  }
  return out;
});
```

## Colour as data

<!-- anchor: colour-as-data (img.field channels, img.palette, img.regions) -->

A picture is more than tone. `img.field` reads its colour as well. `'r'`,
`'g'` and `'b'` come out as the file stores them. `'c'`, `'m'`, `'y'` and
`'k'` come out as a printer wants them. The four printing channels have the
grey taken out. `k` is the tone all three inks share. Each of the other three
then carries only the ink that remains. So a grey area asks for black alone,
and four pens print the picture.

`img.palette(n)` fits `n` colours to the pixels, with a weighted k-means in
Lab space. The fit reads the picture and never the sketch's seed, so one file
gives one palette in every sketch. Name the colours yourself, as hex strings
or as pens. The fit then drops out, and each pixel takes the nearest colour
you named. Every entry is plain data. `share` says how much of the picture
the colour holds. `field()` is its membership as an ordinary scalar field,
and `contours(level)` turns that field into contours. A stipple, a hatch and an
outline all read the same entry. The toolkit needs no new word for any of
them.

`img.regions({ count, tolerance })` answers the other question. It cuts the
picture into flat colour areas and orders them lightest first. A patch
smaller than `tolerance` joins what surrounds it, so a separation reads as
areas and not as confetti. Draw the list in order with `opaque: true` and
each dark area hides the lighter ones under it. `count: 2` is a monochrome
trace, and a region answers `contours()`, so `polygon(region, …)` takes it as
it is.

How much paper one pen actually covers is a measured number, and occlude does
not hold that number yet. A palette entry counts pixels, not ink.

```ts live
import { sketch, dots, pen, mm } from 'occlude';

// A four-pen separation. The palette is fitted to the photograph, and each
// band is stippled in a pen of its own colour. The membership field is
// sharpened first, so a dot lands only where that colour clearly wins, and
// the four separations meet without overprinting each other.
export default sketch({ aspect: [1, 1], seed: 4, pens: {
  cream: pen({ width: mm(0.45), color: '#D5CFC4' }),
  tan: pen({ width: mm(0.45), color: '#AA9071' }),
  umber: pen({ width: mm(0.45), color: '#6A5C4D' }),
  soot: pen({ width: mm(0.45), color: '#2B2723' }),
} }, (t) => {
  const img = t.image('ivy.png', { x: 2, y: 2, width: 96 });
  const inks = ['cream', 'tan', 'umber', 'soot'];
  const tone = (hex) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
  const bands = img.palette(4).sort((a, b) => tone(b.color) - tone(a.color));
  return bands.map((e, i) => {
    const near = e.field({ area: 0.35 });
    return dots(t.scatter((x, y) => Math.max(0, near(x, y) * 2 - 1), { spacing: mm(0.5) }), { pen: inks[i] });
  });
});
```

## Tone as fold density

A space-filling line folds to fill an area. It never crosses itself, and one
pen-down stroke covers the whole picture. `t.spacefill(area, { spacing, field })`
draws that line, and the `field` is tone, 0 to 1. A dark cell divides again
and the folds crowd together. A light cell stays large and the paper shows
through. A cell with no tone at all lifts the pen. `spacing` is the finest
cell, so pick it for the nib. A 0.4 mm cell under a 0.2 mm nib reads as solid
black. `maxSpacing` is the coarsest cell. The palest fur then still folds,
and it does not lay one long chord across the sheet.

Shape the tone before `spacefill` reads it. Below, the alpha channel cuts the
background away and `norm` stretches the fur. The white muzzle stays blank
paper and the nose fills in solid. Every vertex carries the `level` it
stopped at, so `m.points` can send the deepest folds to a second pen.

```ts live
import { sketch, strokes, circle, mm, norm } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const img = t.image('ivy.png', { x: 8, y: 2, width: 84 });
  const dark = img.field('dark', { area: 0.9 });
  const tone = (x, y) => (img.a(x, y, 0.3) < 0.5 ? 0 : Math.max(0, norm(dark(x, y), 0.15, 0.88)) ** 2.2);
  const fold = t.spacefill(circle(50, 50, 44), { spacing: mm(0.4), maxSpacing: mm(2.4), field: tone });
  return strokes(fold, { pen: 'pigma-005-black' });
});
```

## Ink as a budget

<!-- anchor: ink-as-a-budget (t.residual, r.spend, r.total) -->

A field says how dark the paper must be. A word then puts marks on that
paper. Until now nothing measured what those marks paid for, so a second
pass could not know what the first one had already covered.
`t.residual(field, { spacing, area })` keeps that account. It holds the
target tone on a grid of cells. `r.spend(marks, { width })` takes the nib
footprint of the marks you drew off the grid, and answers with the tone it
took. `r.total()` is what the drawing still owes, so a loop can stop when
the debt is small.

A residual is also a field, so `t.scatter(r)`, `t.isolines(r, …)` and a
decimate amount read it like any other. `spend` changes it in place, because
a ledger must hold what the last stroke paid. `r.snapshot()` gives a frozen
copy.

The drawing below is one continuous line. It starts at the cell with the
deepest debt. At each step it looks at twelve short chords, and it takes the
chord with the most tone left along it. It pays for that chord at the width
of the nib, so the next step sees fresh paper only where no line has been.
The line stops when the debt falls under a tenth of where it started. The
tone it works against is the photograph's own, with the edges of the picture
added on top.

```ts live
import { sketch, strokes, curve, mm, norm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) => {
  const img = t.image('ivy.png', { x: 12, y: 3, width: 76 });
  const dark = img.field('dark', { area: 0.2 });
  const tone = (x, y) => img.a(x, y, 0.3) < 0.5 ? 0
    : Math.min(1, Math.max(0, norm(dark(x, y), 0.08, 0.95)) ** 1.5 + img.edge(x, y, 0.2));
  const r = t.residual(tone, { spacing: mm(0.7) });
  const stop = r.total() * 0.09;
  // Start where the debt is deepest.
  const first = t.grid({ cols: 48, rows: 48 }).reduce((a, c) => (r(c.cx, c.cy) > r(a.cx, a.cy) ? c : a));
  let at = [first.cx, first.cy];
  const pts = [at];
  for (let k = 0; k < 12000 && r.total() > stop; k++) {
    let best = null;
    let most = 0;
    for (let c = 0; c < 12; c++) {
      const a = t.rnd(Math.PI * 2);
      const len = t.rnd(1.2, 5);
      const end = [at[0] + Math.cos(a) * len, at[1] + Math.sin(a) * len];
      let sum = 0;
      for (let s = 1; s <= 5; s++) sum += r(at[0] + (end[0] - at[0]) * s / 5, at[1] + (end[1] - at[1]) * s / 5);
      if (sum > most) { most = sum; best = end; }
    }
    if (!best) break;
    r.spend([at, best], { width: mm(0.35) });
    pts.push(best);
    at = best;
  }
  return strokes(curve(pts, { closed: false }), { pen: 'pigma-005-black' });
});
```
