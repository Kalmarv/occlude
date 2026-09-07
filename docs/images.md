# Images & imports

Line art from SVG files, image assets, and image tone and direction as marks.

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
