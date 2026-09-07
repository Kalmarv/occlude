# 1. Put marks on paper

A sun, a ruled sky and two hatched hills. Small, but it already uses the four things every drawing here is made of: a drawable with units, repetition, pens, and the rule that decides what hides what. This is what you are about to make; the code is editable, and edits re-render in place.

```ts live
import { sketch, circle, line, path, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const sky = t.times(9, (k, u) => line(0, 8 + u * 50, 200, 8 + u * 50));
  const sun = circle(140, 44, 22, { pen: 'stabilo-88-blue' });
  const hill = (base, height, angle) => {
    const p = path().moveTo(0, 100);
    for (let x = 0; x <= 200; x += 4) p.lineTo(x, base - t.noise(x / 40, base) * height);
    return p.lineTo(200, 100).close().build({ fill: fill('hatch', { angle, spacing: mm(1.2) }) });
  };
  return [sky, sun, hill(70, 22, 60), hill(86, 14, 120)];
});
```

## Start here

One sun and one horizon. The sketch function receives a toolkit `t` and returns shapes; an array is a fine tree. The sheet is 2:1, so bare numbers run 0 to 200 across and 0 to 100 down: a bare number is a percentage of the short side.

```ts live
import { sketch, circle, line } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  line(0, 58, 200, 58),
  circle(140, 44, 22),
]);
```

## Change it

**A ruled sky.** `t.times(n, (k, u) => …)` calls back `n` times with the index `k` and a fraction `u` from 0 to 1, and collects what you return. Nine lines from near the top to just below the horizon. The spacing is in bare units here, so it scales with the sheet; the hatch later uses `mm()` because a texture's gap should stay the same on any paper.

```ts live
import { sketch, circle, line } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => [
  t.times(9, (k, u) => line(0, 8 + u * 50, 200, 8 + u * 50)),
  circle(140, 44, 22),
]);
```

**Hills that hide.** A hill is a closed path with a hatch fill. It is drawn after the sun, and a filled shape hides everything earlier in the tree that lies under it, so the sun sets behind the hill and the ruled lines stop at its ridge. Nothing is clipped by hand: the engine computes the visible strokes. A `fill` is texture inside a closed shape; `mm(1.2)` is its line gap.

```ts live
import { sketch, circle, line, path, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const hill = (base, height) => {
    const p = path().moveTo(0, 100);
    for (let x = 0; x <= 200; x += 4) p.lineTo(x, base - t.noise(x / 40, base) * height);
    return p.lineTo(200, 100).close().build({ fill: fill('hatch', { angle: 60, spacing: mm(1.2) }) });
  };
  return [
    t.times(9, (k, u) => line(0, 8 + u * 50, 200, 8 + u * 50)),
    circle(140, 44, 22),
    hill(70, 22),
  ];
});
```

**A second pen and a second hill.** Every shape can name its pen; the sun goes blue. The nearer hill comes last, so it hides part of the far one, and its hatch runs at a different angle so the two read as two. The pens named here are the docs' own; in the studio they are added to your library for the session when you open a sketch from this page.

```ts live
import { sketch, circle, line, path, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const hill = (base, height, angle) => {
    const p = path().moveTo(0, 100);
    for (let x = 0; x <= 200; x += 4) p.lineTo(x, base - t.noise(x / 40, base) * height);
    return p.lineTo(200, 100).close().build({ fill: fill('hatch', { angle, spacing: mm(1.2) }) });
  };
  return [
    t.times(9, (k, u) => line(0, 8 + u * 50, 200, 8 + u * 50)),
    circle(140, 44, 22, { pen: 'stabilo-88-blue' }),
    hill(70, 22, 60),
    hill(86, 14, 120),
  ];
});
```

## Try changing this

Move the sun to the end of the array, after both hills. Something changes and something does not: the sun's outline now crosses the hatch, but the hatch is still all there. Then give the sun `opaque: true`. What does the sun hide now, and why did its outline alone never hide anything?

## Something that will surprise you

Only area hides. A shape occludes what lies beneath it when it has a fill or is marked `opaque`; a stroke never hides anything, however late it is drawn, and its width does not widen the hidden region. That is why the ruled lines stop at the hills but the sun's outline, drawn last, only adds ink. The full rules are four sentences on [Getting started](#/getting-started), under *How shapes hide each other*; the one to keep is that ink and area are different things.

## The whole sketch

```ts live
import { sketch, circle, line, path, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 4 }, (t) => {
  const sky = t.times(9, (k, u) => line(0, 8 + u * 50, 200, 8 + u * 50));
  const sun = circle(140, 44, 22, { pen: 'stabilo-88-blue' });
  const hill = (base, height, angle) => {
    const p = path().moveTo(0, 100);
    for (let x = 0; x <= 200; x += 4) p.lineTo(x, base - t.noise(x / 40, base) * height);
    return p.lineTo(200, 100).close().build({ fill: fill('hatch', { angle, spacing: mm(1.2) }) });
  };
  return [sky, sun, hill(70, 22, 60), hill(86, 14, 120)];
});
```

Where to look things up: the shapes and their options on [Shapes & layout](#/shapes), the patterns and what spacing does to tone on [Fills](#/fills), units and seeds on [Getting started](#/getting-started). Next: the hill is a shape, and a shape is sealed. [Chapter 2](#/workshop-02) turns one into something you can edit.
