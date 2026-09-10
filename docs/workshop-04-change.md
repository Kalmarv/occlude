# 4. Repeat a change

**What happens when a small rule acts repeatedly?** One displacement is easy to picture. The same displacement applied forty times, with a second rule pulling the other way and new points appearing where the line has stretched, makes contours nobody drew. This is the drawing this chapter arrives at: one ring, grown by a rule of three named parts, with a few of its earlier states drawn lightly and the last one emphasised. By the end you will know which part of the rule moves, which restrains, which adds points, and how to keep the states you want to draw.

```ts live
import { sketch, circle, strokes, force, sum, sub, mul, ui } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) => {
  const steps = ui(40, { min: 0, max: 60, step: 1 });
  const wrinkle = ui(0.9, { min: 0, max: 3, step: 0.1, label: 'wrinkle amount' });
  const strength = ui(0.5, { min: 0, max: 1.5, step: 0.05, label: 'tension strength' });
  const every = ui(8, { min: 1, max: 24, step: 1, label: 'draw every' });
  const centre = [t.cx, t.cy];
  const ring = t.sample(circle(t.cx, t.cy, 14), { count: 36 });
  const outward = (p) => mul(sub(p, centre), 0.02);
  const uneven = (p) => [t.noise(p.x / 14, p.y / 14) * wrinkle, t.noise(p.x / 14 + 30, p.y / 14) * wrinkle];
  const grown = ring.steps(steps, (current, next) => {
    const pull = force.tension(current, { rest: 2.5 });
    next.move((p) => sum(outward(p), uneven(p), mul(pull(p), strength)));
    next.splitEdges((e) => e.length > 5);
  }, { every });
  const states = grown.history;
  return [
    states.slice(0, -1).map((h) => strokes(h.material, { pen: 'pigma-005-black' })),
    strokes(grown, { pen: 'stabilo-88-blue' }),
  ];
});
```

Drag `steps` to zero and back up. Everything on this page comes from what happens between those two ends.

## One move, then several

Start with a ring and one rule: every point moves away from the centre. `sub(p, centre)` is the vector from the centre to the point; `mul(…, 0.06)` shortens it to six percent. That is the displacement, and `next.move` adds it to where the point already is. The blue ring is the original; the black one is after `steps` moves; the dots are its points.

Before you drag the slider: the displacement is six percent of the distance from the centre. Will the ring grow by the same amount each step, or by more each time?

```ts live focus=4,7-8
import { sketch, circle, strokes, sub, mul, ui } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const steps = ui(0, { min: 0, max: 20, step: 1 });
  const centre = [t.cx, t.cy];
  const ring = t.sample(circle(t.cx, t.cy, 14), { count: 36 });
  const outward = (p) => mul(sub(p, centre), 0.06);
  const grown = ring.steps(steps, (current, next) => next.move((p) => outward(p)));
  return [
    strokes(ring, { pen: 'stabilo-88-blue' }),
    strokes(grown),
    grown.points.map((p) => circle(p.x, p.y, 0.6)),
  ];
});
```

<details>
<summary>What to look for</summary>

The ring grows by more each step. The displacement is a fraction of the distance from the centre, and after each step that distance is larger, so the next step is larger too: multiplication, not addition. Twelve steps at six percent is about twice the radius; twenty is about three times. If you want constant speed, make the displacement a fixed length instead of a fraction: `mul(unit(sub(p, centre)), 0.7)`, with `unit` from the same vocabulary, moves every point 0.7 outward whatever its distance.

The other thing to notice is what `next.move` does with the answer. `[dx, dy]` is added to the point's position; it is not the position. A rule that returns `[t.cx + 30, t.cy]` does not put every point at one place, it moves every point by the same amount. Chapter 2 said this; here it is the difference between a ring that grows and a ring that slides.

</details>

## Make the motion uneven

A ring that only expands stays a circle. Give each point a second displacement that depends on where it is: `uneven(p)` reads a noise at the point's position, twice, for `x` and for `y`. Noise is a smooth function of position, not a growth rule: it can move one side of the ring outward, the other inward, and slide a third part sideways. The short lines show the displacement each point would get, six times longer than it is, so you can see the field before it acts.

```ts live focus=5,8,11
import { sketch, circle, strokes, line, add, sub, mul, ui } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) => {
  const steps = ui(0, { min: 0, max: 20, step: 1 });
  const wrinkle = ui(1, { min: 0, max: 3, step: 0.1, label: 'wrinkle amount' });
  const centre = [t.cx, t.cy];
  const ring = t.sample(circle(t.cx, t.cy, 14), { count: 36 });
  const uneven = (p) => [t.noise(p.x / 14, p.y / 14) * wrinkle, t.noise(p.x / 14 + 30, p.y / 14) * wrinkle];
  const grown = ring.steps(steps, (current, next) => next.move((p) => uneven(p)));
  return [
    grown.points.map((p) => line(p.x, p.y, ...add(p, mul(uneven(p), 6)))),
    strokes(ring, { pen: 'stabilo-88-blue' }),
    strokes(grown),
  ];
});
```

Look at the arrows first, with `steps` at zero. Where neighbouring arrows point the same way, that part of the ring will slide. Where they point apart, the connection between those points will stretch; where they point together, it will shorten. Then drag `steps`. Does the ring get bigger?

<details>
<summary>What to look for</summary>

At this seed the ring drifts and deforms more than it grows: some connections stretch to twice their length while others bunch up, and the whole thing slides a little, because the noise happens to have a net direction here. Change the seed in the config and the same rule gives a different answer. What holds in general is only this: a noise displacement changes the spacing between points unevenly, and it has no preference for outward. Growth, if you want it, is the job of `outward`.

</details>

## A competing rule

The uneven motion pulls points apart in some places. Something can pull them back: a force. `force.tension(current, { rest: 2.5 })` is prepared once per step from `current`, and for a point it gives the vector toward each connected neighbour that is more than 2.5 away, by the extra distance. Nothing toward closer neighbours: a slack cord, not a spring. It is prepared inside the rule because it reads the connections and positions of the state being moved; the ring of the previous step is a different state with different positions.

Two rings from the same start, the same seed and the same noise. Left, uneven motion alone. Right, with tension added, scaled by `strength`. `sum` adds any number of displacements.

```ts live focus=10-13
import { sketch, circle, strokes, group, force, sum, mul, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  const steps = ui(16, { min: 0, max: 40, step: 1 });
  const strength = ui(0.5, { min: 0, max: 1.5, step: 0.05, label: 'tension strength' });
  const ring = t.sample(circle(50, 50, 14), { count: 36 });
  const uneven = (p) => [t.noise(p.x / 14, p.y / 14), t.noise(p.x / 14 + 30, p.y / 14)];
  const loose = ring.steps(steps, (current, next) => next.move((p) => uneven(p)));
  const held = ring.steps(steps, (current, next) => {
    const pull = force.tension(current, { rest: 2.5 });
    next.move((p) => sum(uneven(p), mul(pull(p), strength)));
  });
  return [
    strokes(loose), loose.points.map((p) => circle(p.x, p.y, 0.5)),
    group({ translate: [100, 0] }, strokes(held), held.points.map((p) => circle(p.x, p.y, 0.5))),
  ];
});
```

What is tension opposing here? Set `strength` to zero and the two rings are the same; raise it and watch where the right ring differs from the left.

<details>
<summary>What to look for</summary>

Tension acts only on connections longer than `rest`, so it changes the stretched parts of the ring and leaves the bunched parts alone: the right ring keeps its points more evenly spread along the stretched arcs, and its outline is smoother there. It cannot make a bunched arc spread out, because a short connection gives no pull. At high strength the ring pulls itself tight and the noise has less to work with, which is a choice, not a failure.

</details>

## Give long segments more detail

Points are where a ring can bend. A stretched connection is a long straight side, and no displacement of its two ends will put a bend in the middle of it. `next.splitEdges((e) => e.length > 5)` looks at every connection after the moves and inserts a point in the middle of each one longer than 5. The label counts the points.

Before you look: if the ring is subdivided at the end of a step, and nothing moves it afterwards, does its silhouette change?

```ts live focus=9-12
import { sketch, circle, strokes, label, sub, mul, ui } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const steps = ui(12, { min: 0, max: 20, step: 1 });
  const split = ui(true, { label: 'subdivide' });
  const centre = [t.cx, t.cy];
  const ring = t.sample(circle(t.cx, t.cy, 14), { count: 36 });
  const outward = (p) => mul(sub(p, centre), 0.06);
  const grown = ring.steps(steps, (current, next) => {
    next.move((p) => outward(p));
    if (split) next.splitEdges((e) => e.length > 5);
  });
  return [
    strokes(grown),
    grown.points.map((p) => circle(p.x, p.y, 0.6)),
    label(`${grown.n} points`, 4, 6, 4),
  ];
});
```

<details>
<summary>What to look for</summary>

Toggle `subdivide` with `steps` fixed: the outline is the same, and only the dots change. A midpoint inserted on a straight side lies on that side, and the outward push moves it exactly as the side would have moved, so subdivision on its own adds nothing you can see. Its effect arrives in later steps, when the new point is moved by something that treats it differently from its neighbours. Uneven motion is that something. With subdivision the count climbs as the ring grows; without it the ring has 36 points however large it gets, and a large ring of 36 points is a polygon.

</details>

## Put the rule together

The three parts, named: `outward` moves, `uneven` disturbs, `pull` restrains, and the split adds points where the first two have stretched the ring. Nothing else. Each control belongs to one part.

```ts live focus=9-13
import { sketch, circle, strokes, force, sum, sub, mul, label, ui } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) => {
  const steps = ui(30, { min: 0, max: 60, step: 1 });
  const wrinkle = ui(0.9, { min: 0, max: 3, step: 0.1, label: 'wrinkle amount' });
  const strength = ui(0.5, { min: 0, max: 1.5, step: 0.05, label: 'tension strength' });
  const centre = [t.cx, t.cy];
  const ring = t.sample(circle(t.cx, t.cy, 14), { count: 36 });
  const outward = (p) => mul(sub(p, centre), 0.02);
  const uneven = (p) => [t.noise(p.x / 14, p.y / 14) * wrinkle, t.noise(p.x / 14 + 30, p.y / 14) * wrinkle];
  const grown = ring.steps(steps, (current, next) => {
    const pull = force.tension(current, { rest: 2.5 });
    next.move((p) => sum(outward(p), uneven(p), mul(pull(p), strength)));
    next.splitEdges((e) => e.length > 5);
  });
  return [strokes(grown), label(`${grown.n} points`, 4, 6, 4)];
});
```

Try `wrinkle` at zero, then `strength` at zero, then both. Which of the three parts is responsible for the folds, and which for the folds not tearing apart?

<details>
<summary>What to look for</summary>

With no wrinkle the ring is a growing circle that gains points and stays a circle: the outward push and the split cannot fold anything. With wrinkle and no tension the folds form and keep deepening, because a stretched part is split and the new points are pushed unevenly again. With both, the folds form and settle into a wavy contour, because tension keeps the spacing from running away between splits. At this seed forty steps is a pleasant contour and sixty a crowded one; the balance between `wrinkle` and `strength` is the drawing's character, and there is no correct value.

</details>

## Draw the process

So far only the last state is drawn. `{ every: 8 }` as a third argument to `steps` keeps the state at iteration 0, every eighth iteration and the last, on the result's `history`. Each entry is a material of its own. Drawing them is what makes the growth visible as a sequence; keeping them is a separate choice from drawing them, and neither changes the final ring. The last state is drawn in blue over the lighter earlier ones.

```ts live focus=8,15-19
import { sketch, circle, strokes, force, sum, sub, mul, ui } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) => {
  const steps = ui(40, { min: 0, max: 60, step: 1 });
  const wrinkle = ui(0.9, { min: 0, max: 3, step: 0.1, label: 'wrinkle amount' });
  const strength = ui(0.5, { min: 0, max: 1.5, step: 0.05, label: 'tension strength' });
  const every = ui(8, { min: 1, max: 24, step: 1, label: 'draw every' });
  const centre = [t.cx, t.cy];
  const ring = t.sample(circle(t.cx, t.cy, 14), { count: 36 });
  const outward = (p) => mul(sub(p, centre), 0.02);
  const uneven = (p) => [t.noise(p.x / 14, p.y / 14) * wrinkle, t.noise(p.x / 14 + 30, p.y / 14) * wrinkle];
  const grown = ring.steps(steps, (current, next) => {
    const pull = force.tension(current, { rest: 2.5 });
    next.move((p) => sum(outward(p), uneven(p), mul(pull(p), strength)));
    next.splitEdges((e) => e.length > 5);
  }, { every });
  const states = grown.history;
  return [
    states.slice(0, -1).map((h) => strokes(h.material, { pen: 'pigma-005-black' })),
    strokes(grown, { pen: 'stabilo-88-blue' }),
  ];
});
```

This is the drawing from the top of the page. Drag `draw every` from 1 to 24 with `steps` at 40: the final ring never changes, and the drawing changes completely. Where does it stop reading as a sequence and start reading as a surface?

## Two other readings of the same rule

The rule is the same; the constants and what is drawn are not. Calm: little wrinkle, firm tension, a wide interval, so the states nest like contour lines on a map. The folds are gentle and the spacing between states is what carries the drawing.

```ts live focus=4-7,18
import { sketch, circle, strokes, force, sum, sub, mul, ui } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) => {
  const steps = 60;
  const wrinkle = 0.4;
  const strength = 0.9;
  const every = 6;
  const centre = [t.cx, t.cy];
  const ring = t.sample(circle(t.cx, t.cy, 14), { count: 36 });
  const outward = (p) => mul(sub(p, centre), 0.018);
  const uneven = (p) => [t.noise(p.x / 14, p.y / 14) * wrinkle, t.noise(p.x / 14 + 30, p.y / 14) * wrinkle];
  const grown = ring.steps(steps, (current, next) => {
    const pull = force.tension(current, { rest: 2.5 });
    next.move((p) => sum(outward(p), uneven(p), mul(pull(p), strength)));
    next.splitEdges((e) => e.length > 5);
  }, { every });
  return grown.history.map((h) => strokes(h.material, { pen: 'pigma-005-black' }));
});
```

Folded: the same constants, a shorter split length so the folds get more points to bend with, and only the last state drawn, as an area with a hatch, so the folds read as a shape rather than a path. Retaining history and drawing it are separate choices; here the history is not even kept. The thin spikes at its edge are places where the ring folded over itself; an area with a crossing in its outline is a subject for chapter 6.

```ts live focus=4-6,12,15
import { sketch, circle, polygon, fill, mm, force, sum, sub, mul } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) => {
  const steps = 44;
  const wrinkle = 0.9;
  const strength = 0.5;
  const centre = [t.cx, t.cy];
  const ring = t.sample(circle(t.cx, t.cy, 14), { count: 36 });
  const outward = (p) => mul(sub(p, centre), 0.02);
  const uneven = (p) => [t.noise(p.x / 14, p.y / 14) * wrinkle, t.noise(p.x / 14 + 30, p.y / 14) * wrinkle];
  const grown = ring.steps(steps, (current, next) => {
    const pull = force.tension(current, { rest: 2.5 });
    next.move((p) => sum(outward(p), uneven(p), mul(pull(p), strength)));
    next.splitEdges((e) => e.length > 4);
  });
  return polygon(grown, { fill: fill('hatch', { angle: 30, spacing: mm(1.1) }) });
});
```

Of the three, the calm stack is the one that would be worth plotting as it is: its spacing is deliberate and the eye can follow one state at a time. The folded area is stronger as a single form, but the hatch is doing most of the work and the spikes are accidents rather than decisions. The first drawing sits between them, and its interest is in the transition from circle to contour, which is why its early states are drawn lightly and its last one emphasised. A wrinkle of 3 with a strength of 0 is worth trying once, and worth stopping at once.

## Two questions before you go on

Can you make a drawing whose early outlines matter more than its final one? Consider what you have: the history is a list of materials, and a list can be sliced, reversed, drawn in different pens or not at all.

And a thing to be careful about: nothing in this rule promises that the ring never crosses itself. Tension keeps neighbours close; it says nothing about two distant parts of the ring folding into each other. Chapter 5 gives lines a way to notice each other, and chapter 6 deals with what happens when they cross.

## On your own

Slow the outward push over time, so the ring grows fast at first and then spends its later steps only folding, and choose which of its states to draw. Two things you have not used yet: the rule's third argument, `k`, is the step number, counting from 0; and a control can be a fraction as easily as a count.

<details>
<summary>A hint, not the answer</summary>

`outward` is prepared once and knows nothing about time. Make the rule scale it: something of the form `mul(outward(p), 1 - k / steps)` gives a push that is full at the start and gone at the end; `1 - k / steps` squared, or a step function that switches the push off after a chosen iteration, are different drawings. Then decide about `every`: a growth that slows down puts its late states close together, so an even interval will crowd them, and drawing only the states before the push stops is one honest answer.

</details>

## Where to look things up

`steps`, `every`, `history` and the edits `next` accepts are under *Movement and growth* on [Materials](#/materials); the force recipes, `tension` among them, under *Forces*; the vector helpers `sub`, `mul`, `sum` and `unit` under *Vectors*. Next, chapter 5: a line that grows from one end and decides where to go.
