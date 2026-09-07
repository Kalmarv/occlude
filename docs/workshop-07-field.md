# 7. Read an invisible landscape

**How can one function produce different drawings?** A field is a function that answers a question at a position: how high is it here, which way does it slope. Nothing is drawn by asking. What gets drawn depends on which question is asked and how the answers are turned into lines, and the same field can be a contour map, a flow, a scatter of marks or the outline of an area. This is the pair of drawings this chapter arrives at: one noise landscape, read once as contours and once as flow lines that thin out where the land is high. By the end you will be able to write a scalar field and a vector field, look at each before drawing it, trace contours and streamlines, and say what each of them follows.

```ts live
import { sketch, strokes, curl, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const scale = ui(50, { min: 12, max: 80, step: 1, label: 'noise scale' });
  const levels = ui(7, { min: 2, max: 14, step: 1 });
  const land = (x, y) => 0.5 + 0.5 * t.noise(x / scale, y / scale);
  const heights = t.times(levels, (k) => (k + 1) / (levels + 1));
  return strokes(t.isolines(land, heights, { step: 1 }));
});
```

```ts live
import { sketch, strokes, curl, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const scale = ui(50, { min: 12, max: 80, step: 1, label: 'noise scale' });
  const spacing = ui(1.6, { min: 0.6, max: 4, step: 0.1, label: 'line spacing (mm)' });
  const land = (x, y) => 0.5 + 0.5 * t.noise(x / scale, y / scale);
  const along = curl(land);
  return strokes(t.streamlines(along, { spacing: (x, y) => spacing * (0.5 + 4 * land(x, y)) }));
});
```

## Values

**A number at a place.** The simplest field: `ramp(x, y)` returns `x / 200`, so it is 0 at the left edge of this sheet and 1 at the right, whatever `y` is. A function is nothing to look at, so a sparse grid asks it: each cell's centre gets a mark whose size is the value there. The field is evaluated when it is asked, here 96 times; it is not a stored column and not a picture. `t.grid` gives cells with centres `cx`, `cy` in drawable units, the same units every coordinate on these pages has used.

```ts live focus=4-5
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const ramp = (x, y) => x / 200;
  return t.grid({ cols: 16, rows: 6 }).map((c) => circle(c.cx, c.cy, 0.3 + ramp(c.cx, c.cy) * 3));
});
```

**Find equal values.** A contour is the set of places where a field has one value. `t.isolines(field, levels, { step })` traces them for each level in the list, sampling the field every `step` units and interpolating between samples, so the lines are smoother than the grid. On the ramp the contours are vertical lines, one per level, because `x / 200` equals 0.3 along one vertical line and nowhere else. Before changing anything: with the same levels, what will the contours of `distance from the centre` look like?

```ts live focus=4-6
import { sketch, strokes, distance, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const which = ui(0, { min: 0, max: 2, step: 1, label: 'field: 0 ramp, 1 distance, 2 landscape' });
  const fields = [(x, y) => x / 200, (x, y) => 1 - distance([x, y], [100, 50]) / 70, (x, y) => 1 - distance([x, y], [100, 50]) / 70 + 0.25 * t.noise(x / 24, y / 24)];
  const field = fields[which];
  const levels = [0.2, 0.4, 0.6, 0.8];
  return strokes(t.isolines(field, levels, { step: 1 }));
});
```

<details>
<summary>What to look for</summary>

Rings, evenly spaced, because the distance field changes at the same rate in every direction. The levels are the same four numbers throughout, so the comparison is only about the field. The third field is the second with a little noise added, and the rings buckle: a contour goes wherever the value is exactly its level, and the noise moves those places about. Nothing about the tracing changed between the three; only the question being asked.

</details>

**The landscape.** Replace the geometry with noise alone. `t.noise` returns values between about −1 and 1 that vary smoothly, so `0.5 + 0.5 * noise` is a landscape of heights between 0 and 1, and the `scale` control is the distance over which it changes. The levels are spread evenly between 0 and 1 by `t.times`. This is the first finished drawing from the top of the page.

```ts live focus=4-7
import { sketch, strokes, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const scale = ui(50, { min: 12, max: 80, step: 1, label: 'noise scale' });
  const levels = ui(7, { min: 2, max: 14, step: 1 });
  const land = (x, y) => 0.5 + 0.5 * t.noise(x / scale, y / scale);
  const heights = t.times(levels, (k) => (k + 1) / (levels + 1));
  return strokes(t.isolines(land, heights, { step: 1 }));
});
```

Two controls, two different kinds of change. `noise scale` changes the landscape: at 12 it is a rough field of small hills, at 80 a few broad ones. `levels` changes only how finely the same landscape is read: more contours, the same hills. Where the contours crowd the ground is steep. Look for the closed rings: each is a summit or a hollow, and nothing on the page says which.

**Work on the result.** `t.isolines` returns material, the same kind chapters 2 to 6 edited and selected, with every connection carrying its `level` as an attribute. So a level can be picked out, `contours.edges.filter((e) => e.attrs.level === 0.5)`, and all of them grouped, `contours.edges.groupBy((e) => e.attrs.level)`, each group a selection `strokes` accepts. Here every other level goes in blue; the geometry is untouched.

```ts live focus=8-10
import { sketch, strokes, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const scale = ui(50, { min: 12, max: 80, step: 1, label: 'noise scale' });
  const levels = ui(7, { min: 2, max: 14, step: 1 });
  const land = (x, y) => 0.5 + 0.5 * t.noise(x / scale, y / scale);
  const heights = t.times(levels, (k) => (k + 1) / (levels + 1));
  const contours = t.isolines(land, heights, { step: 1 });
  const byLevel = contours.edges.groupBy((e) => e.attrs.level);
  return byLevel.map((group, k) => strokes(group, { pen: k % 2 ? 'stabilo-88-blue' : 'pigma-005-black' }));
});
```

Why is `level` on the connections rather than on the points? A point where two contours meet, if it ever happened, would have two levels; a connection lies on exactly one contour. Two things that sound alike and are not: `step` is the spacing of the samples the tracing takes, and a smaller step follows the field more faithfully; `resample` on the returned material redistributes its points along lines that already exist, and cannot recover detail the tracing did not see.

## Directions

**An arrow at a place.** A vector field answers with a direction and a length: `(x, y) => [dx, dy]`. The grid can show it as short lines, each drawn from its cell's centre a fixed distance along the vector's direction, with a dot at the tail so the direction reads. Two fields: everywhere rightward, and a turn about the centre, whose vector at a point is perpendicular to the line from the centre to it.

```ts live focus=4-5
import { sketch, circle, line, add, mul, unit, group, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const rightward = (x, y) => [1, 0];
  const turning = (x, y) => [-(y - 50), x - 50];
  const arrows = (field) => t.grid({ cols: 8, rows: 8 }).map((c) => {
    const tip = add([c.cx, c.cy], mul(unit(field(c.cx, c.cy)), 4));
    return [circle(c.cx, c.cy, 0.5), line(c.cx, c.cy, tip[0], tip[1])];
  });
  return [arrows(rightward), group({ translate: [100, 0] }, arrows(turning))];
});
```

`unit` makes every arrow the same length, so only the direction is shown; the turning field's vectors are longer far from the centre, and the arrows do not say so. A field preview shows what you ask it to.

**Follow the arrows.** `t.streamlines(field, { spacing })` starts lines and follows the field from each, keeping them a set distance apart and stopping a line when it would come too close to another or leave the sheet. On the rightward field the lines are horizontal and evenly spaced; on the turning field they are circles. A streamline follows a direction; a contour follows a value. Set the spacing and watch the count change while every line stays where it was.

```ts live focus=8-10
import { sketch, strokes, group, rect, within, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const spacing = ui(2, { min: 0.8, max: 6, step: 0.2, label: 'line spacing (mm)' });
  const rightward = (x, y) => [1, 0];
  const turning = (x, y) => [-(y - 50), x - 50];
  const half = rect(0, 0, 100, 100);
  return [
    strokes(t.streamlines(within(rightward, half), { spacing })),
    group({ translate: [100, 0] }, strokes(t.streamlines(within(turning, half), { spacing }))),
  ];
});
```

`streamlines` fills the whole drawable it is given, so each field is bounded to the left half with `within(field, shape)` before the right one is moved over: outside the shape the field is absent, and a line stops at its edge. The same bound works for contours.

## Connect the two

A scalar field has a slope at every point, and `curl(field)` turns the slope a quarter turn: a vector field that runs along the contours instead of across them. Streamlines of `curl(land)` therefore trace the same shapes the contours did, but with different placement: a contour is wherever a chosen value is, a streamline is wherever the spacing allows one. The two drawings are the same landscape read by two rules.

```ts live focus=6-7,11
import { sketch, strokes, curl, group, rect, within, ui } from 'occlude';

export default sketch({ aspect: [3, 1], seed: 9 }, (t) => {
  const scale = ui(40, { min: 12, max: 60, step: 1, label: 'noise scale' });
  const land = (x, y) => 0.5 + 0.5 * t.noise(x / scale, y / scale);
  const along = curl(land);
  const heights = t.times(7, (k) => (k + 1) / 8);
  const half = rect(0, 0, 148, 100);
  return [
    strokes(t.isolines(within(land, half), heights, { step: 1 })),
    group({ translate: [152, 0] }, strokes(t.streamlines(within(along, half), { spacing: 2 }))),
  ];
});
```

The drawing on the left has seven lines' worth of information and empty ground between them; the one on the right has lines everywhere and no way to tell high from low. A flow study wants quiet areas, and `spacing` can be a field too: a function of position that says how far apart the lines are here. The second finished drawing uses the landscape itself, so the lines thin out on the high ground and crowd in the hollows, and the same function decides both where a line goes and how many there are.

```ts live focus=6-7
import { sketch, strokes, curl, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 9 }, (t) => {
  const scale = ui(50, { min: 12, max: 80, step: 1, label: 'noise scale' });
  const spacing = ui(1.6, { min: 0.6, max: 4, step: 0.1, label: 'line spacing (mm)' });
  const land = (x, y) => 0.5 + 0.5 * t.noise(x / scale, y / scale);
  const along = curl(land);
  return strokes(t.streamlines(along, { spacing: (x, y) => spacing * (0.5 + 4 * land(x, y)) }));
});
```

Try `(0.5 + 4 * (1 - land(x, y)))` in the spacing, and the tone inverts: the hollows go quiet and the hills fill. Nothing about the flow changed. Between the contour map and this, the flow study is the stronger drawing at this seed: its tone is continuous and it has somewhere to rest, where the contour map is the same everywhere. A contour map with a `spacing` of its own, more levels near a chosen height and fewer elsewhere, would answer back.

## Geometry as a field

One more source of a field, short because it is chapter 2's material seen from here. `distanceTo(boundary)` builds a signed distance from an outline: positive inside, zero on it, negative outside, and `t.material(shape)` is the outline it takes; the boundary has to be a closed loop or chain for inside to mean anything. Contour that field and the outline grows rings inside and outside itself: geometry became a field, and the field became geometry again.

```ts live focus=5-6
import { sketch, strokes, ellipse, distanceTo } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const outline = t.material(ellipse(100, 50, 40, 22, 20));
  const d = distanceTo(outline);
  return [strokes(outline, { pen: 'stabilo-88-blue' }), strokes(t.isolines(d, [-12, -6, 6, 12, 18], { step: 0.6 }))];
});
```

## On your own

Keep one scalar field, the landscape or one of your own, and make two drawings from it whose character differs, not by changing the field but by changing how its values become marks: contours, flow, marks on a grid, an area at one level, or something this page did not do. Then say, in a sentence, what each drawing's rule is following.

<details>
<summary>A hint, not the answer</summary>

`t.isolines(land, 0.6, { close: true })` is a closed outline of everything above 0.6, and `polygon` will fill it; a grid of marks whose size is `land` is the field as tone; `t.streamlines(grad(land))` runs across the contours instead of along them, downhill or up depending on a minus sign. Any two of these are two drawings; the sentence is the harder part, and the more useful one.

</details>

## Where to look things up

Fields, `within`, `grad` and `curl` are under *Fields* on [Fields & variation](#/fields); `isolines`, `distanceTo` and `streamlines` under *Contours* and *Flow lines*. Next, chapter 8 uses a field to decide where marks go, and makes tone from placement alone.
