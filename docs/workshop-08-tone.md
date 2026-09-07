# 8. Put the ink where it matters

**How can the arrangement of points make tone?** A pen draws lines of one weight. Grey comes from how close the marks are, and a drawing of identical dots can carry a full range of light and shade if the dots are placed by a rule that reads the tone it wants. This is the drawing this chapter arrives at: a ball, lit from the upper left, its shadow shaped and its dark side dissolving into the ground it sits on, made of dots of one size, each one where the density asked for it. By the end you will be able to choose between scattering, relaxing and settling for a reason, and, more to the point, make a flat shape look round and say which of your decisions did it.

```ts live
import { sketch, circle, distance, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const highlight = [ui(84, { min: 40, max: 160, step: 1, label: 'highlight x' }), ui(34, { min: 10, max: 90, step: 1, label: 'highlight y' })];
  const contrast = ui(1.8, { min: 0.6, max: 4, step: 0.1 });
  const ground = ui(0.22, { min: 0, max: 0.5, step: 0.02, label: 'ground tone' });
  const mark = ui(0.45, { min: 0.15, max: 0.8, step: 0.05, label: 'mark radius' });
  const r = (x, y) => distance([x, y], [100, 50]);
  const light = (x, y) => Math.max(0, 1 - distance([x, y], highlight) / 56);
  const body = (x, y) => Math.max(0.06, Math.pow(1 - light(x, y), contrast) - 0.25 * Math.max(0, (r(x, y) - 28) / 12) * (1 - light(x, y)));
  const shade = (x, y) => (r(x, y) < 40 ? body(x, y) : ground * Math.max(0, 1 - (r(x, y) - 40) / 20) * (y > 50 ? 1 : 0.2));
  const seeds = t.scatter(shade, { spacing: 2 });
  return t.settle(seeds, { density: shade, spacing: 2, iterations: 10 }).points.map((p) => circle(p.x, p.y, mark));
});
```

Drag `highlight x` across the ball and back: the same dots, and the ball turns to face wherever the light is.

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

Both are drawn by the same pen, and each circle is a ring of that pen's line, so the two carry their tone differently. On the left the ink per mark varies and the marks sit on a grid; a large circle is a visible ring, and the smallest ones, whose circumference falls below the nib, become single taps of the pen. On the right every mark is the same and only the gaps between them change. Which reads as a smoother grey from across the room, and which shows its construction? The rest of this chapter works with placement, because spacing is the quantity a pen leaves alone, but the left side is a legitimate drawing too, and chapter 11 comes back to how such marks survive at a size.

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

## Make a flat shape round

A disc of one density is a disc: a flat grey coin, settled so its dots are even. Nothing on it says which way is up or where the light is. This is the start; every step after it is one decision about light.

```ts live focus=4-5
import { sketch, circle, distance } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 8 }, (t) => {
  const body = (x, y) => distance([x, y], [50, 50]) < 40;
  const shade = (x, y) => (body(x, y) ? 0.5 : 0);
  const seeds = t.scatter(shade, { spacing: 2 });
  return t.settle(seeds, { density: shade, spacing: 2, iterations: 10 }).points.map((p) => circle(p.x, p.y, 0.45));
});
```

**Locate the highlight.** Light comes from somewhere. `light(x, y)` is 1 at a point and falls off with the distance from it, and the shade is `1 − light`: dense where the light is weak, sparse where it is strong. Put the highlight inside the disc, off centre, and the disc becomes a ball. Drag it; the ball turns to face the light. Put it at the centre and the ball is lit head-on and flattens again.

```ts live focus=4-7
import { sketch, circle, distance, ui } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 8 }, (t) => {
  const highlight = [ui(36, { min: 10, max: 90, step: 1, label: 'highlight x' }), ui(34, { min: 10, max: 90, step: 1, label: 'highlight y' })];
  const body = (x, y) => distance([x, y], [50, 50]) < 40;
  const light = (x, y) => Math.max(0, 1 - distance([x, y], highlight) / 56);
  const shade = (x, y) => (body(x, y) ? 0.06 + 0.94 * (1 - light(x, y)) : 0);
  const seeds = t.scatter(shade, { spacing: 2 });
  return t.settle(seeds, { density: shade, spacing: 2, iterations: 10 }).points.map((p) => circle(p.x, p.y, 0.45));
});
```

The floor of 0.06 keeps the lit side from being empty paper: a ball has a bright side, not a missing one. Try 0 and the highlight becomes a hole.

**Shape the shadow.** The shadow above is a smooth slope from light to dark. A ball in a room has more structure than that: the shade deepens quickly past the terminator, the line where the light stops reaching, and it lifts again near the far rim, where light bounced off the ground comes back. Two numbers do this. `contrast` raises the shade to a power, which moves the terminator and hardens the dark side; `rim` subtracts a little density near the edge on the shadow side, the reflected light. Turn `rim` to 0 and compare: the ball with reflected light sits on a surface, the one without floats.

```ts live focus=6-9
import { sketch, circle, distance, ui } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 8 }, (t) => {
  const contrast = ui(1.8, { min: 0.6, max: 4, step: 0.1 });
  const rim = ui(0.25, { min: 0, max: 0.6, step: 0.05, label: 'rim light' });
  const r = (x, y) => distance([x, y], [50, 50]);
  const light = (x, y) => Math.max(0, 1 - distance([x, y], [36, 34]) / 56);
  const bounce = (x, y) => rim * Math.max(0, (r(x, y) - 28) / 12) * (1 - light(x, y));
  const shade = (x, y) => (r(x, y) < 40 ? Math.max(0.06, Math.pow(1 - light(x, y), contrast) - bounce(x, y)) : 0);
  const seeds = t.scatter(shade, { spacing: 2 });
  return t.settle(seeds, { density: shade, spacing: 2, iterations: 10 }).points.map((p) => circle(p.x, p.y, 0.45));
});
```

**Hard silhouette or disappearing edge.** The ball's edge is a cut: inside, density; outside, nothing. That is a ball against white, and its lit side is a crisp silhouette against the paper. The other choice is to let the shadow side dissolve into a ground: a faint density outside the ball, mostly below it where a surface would be, and the ball's dark rim no darker than it, so the edge disappears where the shadow is and shows only where the light is. Same ball, both ways. Which is in a room, and which is on a page?

```ts live focus=8-9
import { sketch, circle, distance, group, rect, within } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const ball = (cx) => {
    const r = (x, y) => distance([x, y], [cx, 50]);
    const light = (x, y) => Math.max(0, 1 - distance([x, y], [cx - 14, 34]) / 56);
    const body = (x, y) => Math.max(0.06, Math.pow(1 - light(x, y), 1.8) - 0.25 * Math.max(0, (r(x, y) - 28) / 12) * (1 - light(x, y)));
    return { r, body };
  };
  const cut = ball(50);
  const hard = within((x, y) => (cut.r(x, y) < 40 ? cut.body(x, y) : 0), rect(0, 0, 100, 100));
  const soft = within((x, y) => (cut.r(x, y) < 40 ? cut.body(x, y) : 0.22 * Math.max(0, 1 - (cut.r(x, y) - 40) / 20) * (y > 50 ? 1 : 0.2)), rect(0, 0, 100, 100));
  const study = (shade) => t.settle(t.scatter(shade, { spacing: 2 }), { density: shade, spacing: 2, iterations: 10 }).points.map((p) => circle(p.x, p.y, 0.45));
  return [study(hard), group({ translate: [100, 0] }, study(soft))];
});
```

On the right the ground tone is a density of 0.22 at the ball's edge, a fifth of that above the ball's middle, fading to nothing twenty units out, and the ball's shadow side, at about the same density, has no edge against it; the silhouette survives only on the lit side, which is where a ball in a room shows its outline. On the left the dark rim is the strongest line in the drawing, and it says "disc" as much as "ball". Neither is wrong. The left is the version to choose when the drawing is about the shape; the right when it is about the light.

**Tune the marks at the size they will be.** All of the above was judged at one size. A settled arrangement at spacing 2 on this sheet is dots about 3.6 mm apart at the densest, and a dot of radius 0.45 is a ring 1.6 mm across: a coarse stipple, readable at arm's length. The same study on A6, where the drawable is half the size, puts the densest dots 1.8 mm apart with the same 1.6 mm rings, and the shadow side closes up into rings that touch. That is a different drawing, and either the spacing or the mark has to change with the sheet: on the small sheet a mark of 0.25 keeps the shadow as a tone.

```ts live paper=A6
import { sketch, circle, distance, ui } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 8 }, (t) => {
  const mark = ui(0.45, { min: 0.15, max: 0.8, step: 0.05, label: 'mark radius' });
  const r = (x, y) => distance([x, y], [50, 50]);
  const light = (x, y) => Math.max(0, 1 - distance([x, y], [36, 34]) / 56);
  const shade = (x, y) => (r(x, y) < 40 ? Math.max(0.06, Math.pow(1 - light(x, y), 1.8) - 0.25 * Math.max(0, (r(x, y) - 28) / 12) * (1 - light(x, y))) : 0);
  const seeds = t.scatter(shade, { spacing: 2 });
  return t.settle(seeds, { density: shade, spacing: 2, iterations: 10 }).points.map((p) => circle(p.x, p.y, mark));
});
```

**The drawing.** The ball with its highlight placed, its shadow shaped, its edge dissolving into a ground, on a sheet with room, and the mark sized for that sheet. The controls are the decisions in the order the page made them; none of them is the dot count.

```ts live focus=4-7
import { sketch, circle, distance, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 8 }, (t) => {
  const highlight = [ui(84, { min: 40, max: 160, step: 1, label: 'highlight x' }), ui(34, { min: 10, max: 90, step: 1, label: 'highlight y' })];
  const contrast = ui(1.8, { min: 0.6, max: 4, step: 0.1 });
  const ground = ui(0.22, { min: 0, max: 0.5, step: 0.02, label: 'ground tone' });
  const mark = ui(0.45, { min: 0.15, max: 0.8, step: 0.05, label: 'mark radius' });
  const r = (x, y) => distance([x, y], [100, 50]);
  const light = (x, y) => Math.max(0, 1 - distance([x, y], highlight) / 56);
  const body = (x, y) => Math.max(0.06, Math.pow(1 - light(x, y), contrast) - 0.25 * Math.max(0, (r(x, y) - 28) / 12) * (1 - light(x, y)));
  const shade = (x, y) => (r(x, y) < 40 ? body(x, y) : ground * Math.max(0, 1 - (r(x, y) - 40) / 20) * (y > 50 ? 1 : 0.2));
  const seeds = t.scatter(shade, { spacing: 2 });
  return t.settle(seeds, { density: shade, spacing: 2, iterations: 10 }).points.map((p) => circle(p.x, p.y, mark));
});
```

Set `ground tone` to 0 and the ball is cut out; move the highlight to the centre and it flattens; push `contrast` past 3 and the terminator becomes an edge of its own, a second silhouette inside the first, which is what a hard light does. The drawing at the top of the page is this one, and the reason it looks the way it does is four numbers you have now moved yourself.

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
