# 8. Put the ink where it matters

**How can the arrangement of points make tone?** A pen draws lines of one weight. Grey comes from how close the marks are, and a drawing of identical dots can carry a full range of light and shade if the dots are placed by a rule that reads the tone it wants. This is the drawing this chapter arrives at: a light study of a round form lit from the upper left, its bright side almost empty and its shadow a dense curved crescent, made of dots of one size, each one where the density asked for it. By the end you will be able to choose between scattering, relaxing and settling for a reason, and say which quantity each one reads and which it writes.

```ts live
import { sketch, circle, distance, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const spacing = ui(2.2, { min: 1.2, max: 5, step: 0.1 });
  const iterations = ui(12, { min: 0, max: 30, step: 1, label: 'settle rounds' });
  const contrast = ui(1.6, { min: 0.5, max: 3, step: 0.1 });
  const body = (x, y) => distance([x, y], [100, 50]) < 42;
  const light = (x, y) => Math.max(0, 1 - distance([x, y], [82, 34]) / 58);
  const shade = (x, y) => (body(x, y) ? 0.06 + 0.94 * Math.pow(1 - light(x, y), contrast) : 0);
  const seeds = t.scatter(shade, { spacing });
  const settled = t.settle(seeds, { density: shade, spacing, iterations });
  return settled.points.map((p) => circle(p.x, p.y, 0.45));
});
```

Drag `contrast` from 0.5 to 3 with the rest fixed: the same form and the same light, and the dots move to say something different about them.

## Size or placement

Two ways to make a ramp of tone, side by side. Left: a regular grid of marks whose radius grows with the value, the way chapter 7's grid showed a field. Right: marks of one size, placed by `t.scatter(field, { spacing })`, which puts more of them where the field is high. Both read as a ramp; neither is the other. The field is bounded to the left half with `within`, from chapter 7, so the scatter stops there before it is moved over.

```ts live focus=6-7
import { sketch, circle, group, rect, within } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const ramp = within((x, y) => x / 100, rect(0, 0, 100, 100));
  const sized = t.grid({ cols: 20, rows: 20 }).filter((c) => c.cx < 100).map((c) => circle(c.cx, c.cy, 0.2 + ramp(c.cx, c.cy) * 1.8));
  const placed = t.scatter(ramp, { spacing: 2.4 }).points.map((p) => circle(p.x, p.y, 0.55));
  return [sized, group({ translate: [100, 0] }, placed)];
});
```

Which side would plot as a smoother grey, and why? A plotter draws every dot as the same nib touching paper: the left side's small dots become the same size as its large ones, and its tone collapses. The right side's tone is in the spacing, which the nib cannot change. That is why this chapter is about placement.

## Scatter from a field

`t.scatter(density, { spacing })` places points so that where the density is 1 they are about `spacing` apart, where it is lower they are further apart in proportion, and where it is 0 there are none. The field is read, not stored; the material it returns is point-only, with one column, `density`, holding the value the field had at each point. The `show field` control draws the field's contours underneath, faintly, as a check on what the dots are following.

```ts live focus=6-7
import { sketch, circle, strokes, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const spacing = ui(2.4, { min: 1.2, max: 6, step: 0.1 });
  const showField = ui(false, { label: 'show field' });
  const ramp = (x, y) => x / 200;
  const dots = t.scatter(ramp, { spacing });
  return [
    showField ? strokes(t.isolines(ramp, [0.2, 0.4, 0.6, 0.8], { step: 1 }), { pen: 'stabilo-88-blue' }) : [],
    dots.points.map((p) => circle(p.x, p.y, 0.55)),
  ];
});
```

`spacing` is a distance, not a count. Halve it and there are roughly four times as many dots, because the same area is tiled twice as finely in each direction; the drawing does not promise an exact number, and the count on this seed is in the next sketch's label. Where the ramp is 0, at the left edge, the dots stop entirely: zero density is empty paper, not sparse paper.

## Improve an arrangement without changing it

A scatter is random within its rule, so its dots have the slight clumping of anything random. `t.relax(points, { density, iterations })` moves each point toward the centre of the region that is nearer to it than to any other, weighted by the density, and does that a number of times. The count never changes; only positions. The label proves it as the rounds go up.

```ts live focus=7
import { sketch, circle, label, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const iterations = ui(0, { min: 0, max: 20, step: 1, label: 'relax rounds' });
  const ramp = (x, y) => x / 200;
  const dots = t.scatter(ramp, { spacing: 2.4 });
  const relaxed = t.relax(dots, { density: ramp, iterations });
  return [relaxed.points.map((p) => circle(p.x, p.y, 0.55)), label(`${relaxed.n} points`, 4, 6, 3.4)];
});
```

Watch the right edge as the rounds go up. What does relaxation take away, and is that always what you want?

<details>
<summary>What to look for</summary>

The clumps and gaps even out; by ten rounds the dots sit in a nearly regular, slightly hexagonal arrangement wherever the density is even, and the ramp reads as a clean gradient. What went is the texture: a scatter has grain, a relaxed scatter has none. For a smooth tonal study that is a gift; for a drawing that wants the paper to look handled, two or three rounds are enough, and zero is a choice too. The count stays at 1,106 on this seed throughout: relaxation reads the density and moves points, and writes nothing.

</details>

## Let the population respond

Relaxation cannot fix a scatter that placed too few points in a dark region or too many in a light one; it can only spread what it has. `t.settle(points, { density, spacing, iterations })` moves points like relaxation and also adds and removes them: a point whose region holds more density than one point should carry, at this spacing, splits into two, and a point whose region is nearly empty is dropped. The measure it uses is written on the result as `demand`, the density a point's region holds relative to what one point should carry; near 1 the population has settled. Same start as before; compare the counts and the right edge. Before you drag: will the count go up or down?

```ts live focus=7
import { sketch, circle, label, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const iterations = ui(0, { min: 0, max: 20, step: 1, label: 'settle rounds' });
  const ramp = (x, y) => x / 200;
  const dots = t.scatter(ramp, { spacing: 2.4 });
  const settled = t.settle(dots, { density: ramp, spacing: 2.4, iterations });
  return [settled.points.map((p) => circle(p.x, p.y, 0.55)), label(`${settled.n} points`, 4, 6, 3.4)];
});
```

<details>
<summary>What to look for</summary>

Up, and by a lot: from 1,106 points to about 2,500 after ten rounds on this seed, most of them added on the dark side, where the scatter's rule had placed fewer points than the density asks a settled arrangement to hold. Settling and scattering agree about where the tone is and disagree about how much ink it takes; the settled count is the one the spacing actually implies. On the light side a few points are dropped instead. After ten rounds the count barely moves, which is what settled means.

</details>

Three quantities, and they are not interchangeable: `density` is what the field says at a point, `demand` is what a settled point's region holds, and the dot's radius is a drawing decision that neither of them makes. The dots above are all the same size, and the tone is entirely theirs.

## Compose tone

A round form on plenty of paper, lit from a point above and to its left. `body` says whether a position is on the form at all; `light` is 1 at the light's centre and falls off with distance; the shade is darkest where the light is weakest, with a floor of 0.06 so the bright side is not empty paper. `contrast` raises that to a power, which pushes the middle tones darker or lighter without moving the light. The dots are settled to the field at the chosen spacing. This is the drawing from the top of the page; the controls are its three decisions, and mark size is deliberately not one of them.

```ts live focus=7-9,11
import { sketch, circle, distance, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const spacing = ui(2.2, { min: 1.2, max: 5, step: 0.1 });
  const iterations = ui(12, { min: 0, max: 30, step: 1, label: 'settle rounds' });
  const contrast = ui(1.6, { min: 0.5, max: 3, step: 0.1 });
  const body = (x, y) => distance([x, y], [100, 50]) < 42;
  const light = (x, y) => Math.max(0, 1 - distance([x, y], [82, 34]) / 58);
  const shade = (x, y) => (body(x, y) ? 0.06 + 0.94 * Math.pow(1 - light(x, y), contrast) : 0);
  const seeds = t.scatter(shade, { spacing });
  const settled = t.settle(seeds, { density: shade, spacing, iterations });
  return settled.points.map((p) => circle(p.x, p.y, 0.45));
});
```

Set `settle rounds` to 0 and the drawing is the scatter alone: the form is there, grainier and with a few clumps. At 12 the tone is even and the shadow's crescent has a clean edge. Which is the better drawing depends on what the grain is for; the settled one is the better study of light, and the scattered one is the better texture.

The points decided nothing about the ink. The same settled points, drawn as small rings and as short strokes leaning one way, are different drawings of the same tone. A ring reads lighter than a dot of the same radius, so the rings' study is paler; the strokes add a direction the light never had.

```ts live focus=11-14
import { sketch, circle, line, distance, group } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const body = (x, y) => distance([x, y], [50, 50]) < 40;
  const light = (x, y) => Math.max(0, 1 - distance([x, y], [34, 34]) / 56);
  const shade = (x, y) => (body(x, y) ? 0.06 + 0.94 * Math.pow(1 - light(x, y), 1.6) : 0);
  const seeds = t.scatter(shade, { spacing: 2 });
  const settled = t.settle(seeds, { density: shade, spacing: 2, iterations: 12 });
  const pts = settled.points;
  return [
    pts.map((p) => circle(p.x, p.y, 0.7)),
    group({ translate: [100, 0] }, pts.map((p) => line(p.x - 0.6, p.y + 0.5, p.x + 0.6, p.y - 0.5))),
  ];
});
```

## On your own

Make a boundary you can recognise in tone alone, with no outline drawn: a shape whose inside and outside are two densities, so the edge is where the spacing changes. A circle is the plain version; a shape with a corner will teach you something about how sharp a tonal edge can be at a given spacing.

<details>
<summary>A hint, not the answer</summary>

Chapter 7's `distanceTo(t.material(shape))` is positive inside a shape and negative outside; a density of `d(x, y) > 0 ? 0.9 : 0.2` is a hard edge, and `0.2 + 0.7 * ease.smooth(…)` of the distance is a soft one, with `ease` from the same import as `map`. The edge can be no sharper than the spacing: two densities that differ by less than one dot's worth across the edge are one density.

</details>

<details>
<summary>An optional extension: tone from a photograph</summary>

A photograph is a field too, once its brightness is read at a position. `image(name, { x, y, width })` places an image on the sheet and gives `img.lum(x, y)` for its brightness and `img.a(x, y)` for its opacity; outside the placed image both are 0, so the adapter below returns 0 there rather than treating transparent paper as black. Darkness is `1 − lum`, raised to a contrast. Everything after that line is the study above.

```ts live
import { sketch, circle, image } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 8 }, (t) => {
  const img = image('ivy.png', { x: 0, y: 0, width: 100 });
  const dark = (x, y) => (img.a(x, y) < 0.5 ? 0 : Math.pow(1 - img.lum(x, y), 1.4));
  const seeds = t.scatter(dark, { spacing: 1.4 });
  const settled = t.settle(seeds, { density: dark, spacing: 1.4, iterations: 10 });
  return settled.points.map((p) => circle(p.x, p.y, 0.35));
});
```

</details>

## Where to look things up

`t.scatter`, `t.relax`, `t.settle` and the three quantities are under *Point distributions* on [Materials](#/materials); `image` and its sampling under [Images & imports](#/images). Next, chapter 9 asks what the regions between these points look like, and makes them editable.
