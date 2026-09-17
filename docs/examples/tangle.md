---
title: Tangle
description: A nest of strands grown by a rule, wobbled, and told which one is on top.
---

Three operations that know nothing about each other. Each strand is a tip with a heading, extruded one step at a time and steered toward the curl of a noise field; nothing in the rule keeps a strand off another, so they run over one another; a tip that reaches the edge of the frame simply stops. `oscillate` gives each a wobble. `interlace` then decides, at every crossing that made, which strand is on top and breaks the other.

Leans on: [steps](/docs/reference/faces) with `extrude`, `curl`, `oscillate`, `interlace`.

```ts live
import { sketch, strokes, material, curl, oscillate, interlace, add, mul, fromAngle } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 6 }, (t) => {
  const flow = curl((x, y) => t.noise(x / 40, y / 40));
  const seeds = material(
    t.times(26, (k) => { const a = (k / 26) * Math.PI * 2; return [100 + Math.cos(a) * 44, 50 + Math.sin(a) * 24]; }),
    { heading: t.times(26, (k) => (k / 26) * Math.PI * 2 + Math.PI), tip: 1 },
  );
  const grown = seeds.steps(150, (cur, next) => {
    const tips = cur.points.filter((p) => p.tip === 1 && p.x > 3 && p.x < 197 && p.y > 3 && p.y < 97);
    next.extrude(tips, (p) => {
      const [dx, dy] = flow(p.x, p.y);
      const heading = p.heading * 0.75 + Math.atan2(dy, dx) * 0.25;
      return { position: add(p, mul(fromAngle(heading), 1.1)), attributes: { heading, tip: 1 } };
    });
    next.set(tips, { tip: 0 });
  });
  const wobbled = oscillate(grown, { wavelength: 13, amplitude: 1.6 });
  return strokes(interlace(wobbled, { gap: 2.2 }));
});
```
