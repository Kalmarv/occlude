# Images & imports

Line art from SVG files, image assets, and image tone and direction turned into marks. Files come from the studio's Assets page and are named by string literal, so the studio can load them before the sketch runs. The image examples on this page use `ivy.png` from the docs assets.

## SVG line art

`svg(text, { x?, y?, width?, layers?, ...shapeOpts })` turns machine-generated line art (polylines, `<line>` elements and straight-segment paths) into ordinary open-path shapes: occluded, clipped, masked, modified and pen-assigned like anything else. `width` scales the drawing and height follows the aspect; `layers` filters by top-level `<g>` id. Curves and transforms in the file are rejected with an error rather than approximated. Hatch-dense imports benefit from the `bridge` option.

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
const church = svg(asset('church.svg'), { width: b.w, bridge: mm(0.7) });
```

## Sampling an image

`image('name.png', { x, y, width })` never draws. Placement maps the pixels into drawable coordinates so that samples can drive marks. Each sampler takes a position and an optional `area`, a half-size in drawable units to average over; point samples are bilinear and area samples use summed-area tables, so any area costs the same. Average over the mark's own footprint whenever a mark covers more paper than a pixel.

| Sampler | Value |
|---|---|
| `img.lum(x, y, area?)` | luminance, 0 to 1 |
| `img.a(x, y, area?)` | alpha, so a transparent PNG masks its subject |
| `img.bands(x, y, n, area?)` | tone posterized into `n` levels, 0 the darkest |
| `img.edge(x, y, area?)` | luminance gradient magnitude, high at boundaries |
| `img.dir(x, y, area?)` | the gradient's angle |

Dots sized by darkness, averaged over each grid cell, with the alpha channel as the subject mask:

```ts live
import { sketch, circle, image } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const img = image('ivy.png', { x: 8, y: 2, width: 84 });
  return t.grid({ cols: 36, rows: 42 }).map((c) => {
    if (img.a(c.cx, c.cy, c.w / 2) < 0.5) return null;
    const dark = 1 - img.lum(c.cx, c.cy, c.w / 2);
    return dark > 0.04 ? circle(c.cx, c.cy, dark * c.w * 0.52) : null;
  });
});
```

Layered marks gated by tone band: one mark at the mid level, two at dark, three at the darkest.

```ts live
import { sketch, line, image } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const img = image('ivy.png', { x: 8, y: 2, width: 84 });
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

## Direction as marks

Strokes drawn perpendicular to the gradient follow the image's contours, so tone becomes flow.

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
    const a = img.dir(x, y, 1) + Math.PI / 2;
    const r = 0.6 + dark * 1.6;
    out.push(line(x - Math.cos(a) * r, y - Math.sin(a) * r, x + Math.cos(a) * r, y + Math.sin(a) * r));
  }
  return out;
});
```
