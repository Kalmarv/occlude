# 5. Grow a network

**How can a line choose where to go and when to stop?** A point that moves and leaves a trail is a line. Give its newest point a rule, a way to look around, and a decision about what it finds, and the line becomes a path that branches, avoids, or joins. This is the drawing this chapter arrives at: a stand of paths growing up past a rock, branching now and then, each one turning away from its neighbours; and, right after it, the same paths turning toward their neighbours instead. By the end you will be able to write a stop, a join or a turn of your own, and know what the growing tip can and cannot see.

```ts live
import { sketch, circle, strokes, material, append, query, add, mul, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 7 }, (t) => {
  const steps = ui(34, { min: 0, max: 60, step: 1 });
  const branch = ui(0.06, { min: 0, max: 0.3, step: 0.01, label: 'branch chance' });
  const sense = ui(6, { min: 0, max: 14, step: 0.5, label: 'sensing distance' });
  const steer = ui(0.5, { min: -1, max: 1, step: 0.05, label: 'steer (+ away, − toward)' });
  const rock = t.sample(circle(100, 46, 16), { count: 40 }).attribute('active', 0).attribute('heading', 0);
  const seeds = material(t.times(9, (i, u) => [14 + u * 172, 96]), { active: 1, heading: -Math.PI / 2 });
  const side = (heading, toward) => Math.sign(Math.cos(heading) * toward[1] - Math.sin(heading) * toward[0]) || 1;
  const paths = append(rock, seeds).steps(steps, (current, next, k) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1 && p.y > 4 && p.x > 3 && p.x < 197);
    next.extend((p) => {
      let h = p.heading + t.noise(p.x / 10, p.y / 10, k) * 0.35;
      const ahead = add(p, mul([Math.cos(h), Math.sin(h)], sense));
      const near = lines.nearest(ahead, { within: sense, excludeIncident: p });
      if (near) h -= side(h, [near.position[0] - p.x, near.position[1] - p.y]) * steer * (1 - near.distance / sense);
      const target = add(p, mul([Math.cos(h), Math.sin(h)], 2.2));
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h } }) };
      const headings = t.chance(branch) ? [h - 0.5, h + 0.5] : [h];
      return headings.map((hh) => ({ position: add(p, mul([Math.cos(hh), Math.sin(hh)], 2.2)), attributes: { active: 1, heading: hh } }));
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [strokes(paths), paths.points.filter((p) => p.active === 1).map((p) => circle(p.x, p.y, 0.8))];
});
```

Set `steer` to −0.5 and the same seeds under the same rule gather into bundles and lean on one another. Everything between one point and that drawing is on this page.

## One tip leaves a trail

A material of one point. It carries two attributes chosen for this drawing: `active`, 1 while the point may still grow, and `heading`, the direction it grows in, as an angle in radians, pointing up. Each step, `next.extend` gives every active point a child: a new point one stride along the heading, connected to its parent, with attributes of its own. Then the parent's `active` is set to 0. Only the newest point of the path keeps growing, and the older ones are the trail. The dot marks the point that is active now.

```ts live focus=5,7-13
import { sketch, circle, strokes, material, add, mul, ui } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const steps = ui(6, { min: 0, max: 20, step: 1 });
  const seed = material([[50, 92]], { active: 1, heading: -Math.PI / 2 });
  const stride = 4;
  const path = seed.steps(steps, (current, next) => {
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => ({
      position: add(p, mul([Math.cos(p.heading), Math.sin(p.heading)], stride)),
      attributes: { active: 1, heading: p.heading },
    }), { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [strokes(path), path.points.filter((p) => p.active === 1).map((p) => circle(p.x, p.y, 1)), path.points.map((p) => circle(p.x, p.y, 0.4))];
});
```

`active` is not something the engine knows about. It is a number on a row, like `east` was in chapter 3, and the rule reads it to decide who gets a child. Before you change anything: what would happen if the line that sets `active` to 0 were removed?

<details>
<summary>What to look for</summary>

Every point would stay active, so every point would get a child every step: after six steps the seed alone would have six children, each of those five, and so on, a bush of short spurs rather than a path. Retiring the parent is what makes the growth happen at the end of the line. It is one line of the rule, and it is a choice.

</details>

## One tip becomes two

A branch is a tip with two children. The rule's third argument, `k`, is the step number, so a branch at a chosen step is easy to arrange: at step 5 the tip returns two children, one heading a little left, one a little right. Both are active, so from then on there are two trails. The topology, one path becoming two, is decided by the rule; whether the moment is chosen or left to chance is a separate decision, and the second sketch leaves it to `t.chance`, a seeded coin that comes up true with the given probability.

```ts live focus=9-10
import { sketch, circle, strokes, material, add, mul, ui } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const steps = ui(12, { min: 0, max: 20, step: 1 });
  const seed = material([[50, 92]], { active: 1, heading: -Math.PI / 2 });
  const stride = 4;
  const path = seed.steps(steps, (current, next, k) => {
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      const headings = k === 5 ? [p.heading - 0.5, p.heading + 0.5] : [p.heading];
      return headings.map((h) => ({ position: add(p, mul([Math.cos(h), Math.sin(h)], stride)), attributes: { active: 1, heading: h } }));
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [strokes(path), path.points.filter((p) => p.active === 1).map((p) => circle(p.x, p.y, 1))];
});
```

```ts live focus=5,10
import { sketch, circle, strokes, material, add, mul, ui } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 3 }, (t) => {
  const steps = ui(14, { min: 0, max: 24, step: 1 });
  const branch = ui(0.15, { min: 0, max: 0.5, step: 0.01, label: 'branch chance' });
  const seed = material([[50, 92]], { active: 1, heading: -Math.PI / 2 });
  const stride = 4;
  const path = seed.steps(steps, (current, next) => {
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      const headings = t.chance(branch) ? [p.heading - 0.5, p.heading + 0.5] : [p.heading];
      return headings.map((h) => ({ position: add(p, mul([Math.cos(h), Math.sin(h)], stride)), attributes: { active: 1, heading: h } }));
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [strokes(path), path.points.filter((p) => p.active === 1).map((p) => circle(p.x, p.y, 1))];
});
```

A branch point is a point with three connections. `strokes` walks each arm once, so the fork is drawn as a fork and not as three overlapping lines.

## Ask about a proposed move

Put something in the way: a bar across the path. It is ordinary material, a chain of two points, and `append` puts it and the seed into one material, which is why the bar has an `active` of 0 and a heading of its own: every point of one material has the same columns. Before the tip takes a step, ask the current state a question: if I moved from here to there, what would I cross first? `query.edges(current)` prepares that question for a state, once; `lines.firstHit(from, to, { excludeIncident: p })` answers it for one move, ignoring the connections that touch `p` itself, which would otherwise always be hit first. The answer is `null` or a hit: which connection, where on it (`hit.position`), and how far along it (`hit.t`).

This sketch grows the path to just before the bar and then asks the question once, outside any step, so you can see it: the proposed move in blue, the hit marked.

```ts live focus=15-19
import { sketch, circle, line, strokes, material, append, query, add, mul, ui } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const stride = ui(6, { min: 2, max: 16, step: 0.5 });
  const bar = t.sample(line(30, 46, 74, 40), { count: 2 }).attribute('active', 0).attribute('heading', 0);
  const seed = material([[50, 92]], { active: 1, heading: -Math.PI / 2 });
  const path = append(bar, seed).steps(11, (current, next) => {
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => ({
      position: add(p, mul([Math.cos(p.heading), Math.sin(p.heading)], 4)),
      attributes: { active: 1, heading: p.heading },
    }), { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  const tip = path.points.filter((p) => p.active === 1).at(0);
  const target = add(tip, mul([Math.cos(tip.heading), Math.sin(tip.heading)], stride));
  const lines = query.edges(path);
  const hit = lines.firstHit(tip, target, { excludeIncident: tip });
  return [
    strokes(path),
    line(tip.x, tip.y, target[0], target[1], { pen: 'stabilo-88-blue' }),
    circle(target[0], target[1], 0.8, { pen: 'stabilo-88-blue' }),
    hit ? circle(hit.position[0], hit.position[1], 1.6, { pen: 'stabilo-88-green' }) : [],
  ];
});
```

Shorten `stride` until the blue move no longer reaches the bar. The green mark disappears: `firstHit` is a question about one proposed move, not about the neighbourhood.

The query does not decide what happens next; the sketch does. Two answers to a hit, side by side, from the same path and the same bar. Left: stop short. The tip's child is placed a little before the hit and is not active, so the path ends there, touching nothing. Right: join. `next.split(hit.edge, { at: hit.t, point: … })` inserts a point into the bar at the hit and returns it, and `{ to: … }` connects the tip to that point instead of making a new one. The bar now has a point where the path meets it, and that point has three connections.

```ts live focus=11-13
import { sketch, circle, line, strokes, material, append, query, add, sub, mul, group, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const join = ui(false, { label: 'join instead of stopping' });
  const bar = t.sample(line(30, 46, 74, 40), { count: 2 }).attribute('active', 0).attribute('heading', 0);
  const seed = material([[50, 92]], { active: 1, heading: -Math.PI / 2 });
  const grow = (joins) => append(bar, seed).steps(16, (current, next) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      const target = add(p, mul([Math.cos(p.heading), Math.sin(p.heading)], 4));
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit && joins) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: p.heading } }) };
      if (hit) return { position: sub(hit.position, mul([Math.cos(p.heading), Math.sin(p.heading)], 1)), attributes: { active: 0, heading: p.heading } };
      return { position: target, attributes: { active: 1, heading: p.heading } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  const stopped = grow(false);
  const joined = grow(join);
  const junctions = (m) => m.points.filter((p) => m.degree(p) >= 3).map((p) => circle(p.x, p.y, 1.6, { pen: 'stabilo-88-green' }));
  return [
    strokes(stopped), junctions(stopped),
    group({ translate: [100, 0] }, strokes(joined), junctions(joined)),
  ];
});
```

With `join` off, both sides stop short. Turn it on and the right side joins: a green ring marks the point with three connections. On paper the two look almost the same. In the material they are different things: a stopped path ends at a location that happens to be near the bar, and the bar knows nothing about it; a joined path shares a point with the bar, and chapter 6 will show why that matters when you ask what a network encloses.

## Sense before a collision

`firstHit` answers about a move that is already proposed. To choose the move, a tip needs to know what is nearby before it decides. `lines.nearest(ahead, { within, excludeIncident: p })` looks for the closest connection to a point, within a distance, ignoring the tip's own; it answers with the closest position on that connection and the distance to it. The point asked about is a little ahead of the tip, along its heading, so the tip senses what it is heading into rather than what is beside it.

Knowing that something is near is not yet a decision. The decision here is to turn away from it, which needs to know which side it is on. For a heading and a vector toward a point, `cos(h) · toward.y − sin(h) · toward.x` is positive when the point is on one side and negative on the other; its sign is all that is used. Two fixed cases first, so the number is not a mystery: the same heading, a point above the line of travel and a point below it, with the sign written beside each.

```ts live
import { sketch, circle, line, label } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const h = -0.5; // heading: up and to the right, in radians
  const side = (heading, toward) => Math.sign(Math.cos(heading) * toward[1] - Math.sin(heading) * toward[0]) || 1;
  const from = [40, 60];
  const tip = [40 + Math.cos(h) * 30, 60 + Math.sin(h) * 30];
  const above = [90, 30];
  const below = [110, 70];
  return [
    line(from[0], from[1], tip[0], tip[1]), circle(tip[0], tip[1], 1.4),
    circle(above[0], above[1], 1.4, { pen: 'stabilo-88-blue' }), label(`side ${side(h, [above[0] - tip[0], above[1] - tip[1]])}`, 96, 28, 4),
    circle(below[0], below[1], 1.4, { pen: 'stabilo-88-blue' }), label(`side ${side(h, [below[0] - tip[0], below[1] - tip[1]])}`, 116, 68, 4),
  ];
});
```

Now the sensing itself, on one tip and one bar, with the look-ahead point in blue and the nearest position on the bar in green. `steer` is how hard the tip turns, scaled by how close the bar is: nothing at the edge of the sensing distance, the full amount when touching. The sign of `steer` is the whole difference between avoiding and approaching.

```ts live focus=12-15
import { sketch, circle, line, strokes, material, append, query, add, mul, ui } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const steps = ui(10, { min: 0, max: 24, step: 1 });
  const sense = ui(10, { min: 0, max: 20, step: 0.5, label: 'sensing distance' });
  const steer = ui(0.4, { min: -1, max: 1, step: 0.05, label: 'steer (+ away, − toward)' });
  const bar = t.sample(line(56, 60, 96, 20), { count: 2 }).attribute('active', 0).attribute('heading', 0);
  const seed = material([[50, 92]], { active: 1, heading: -Math.PI / 2 });
  const side = (heading, toward) => Math.sign(Math.cos(heading) * toward[1] - Math.sin(heading) * toward[0]) || 1;
  const marks = [];
  const path = append(bar, seed).steps(steps, (current, next) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      let h = p.heading;
      const ahead = add(p, mul([Math.cos(h), Math.sin(h)], sense));
      const near = lines.nearest(ahead, { within: sense, excludeIncident: p });
      if (near) h -= side(h, [near.position[0] - p.x, near.position[1] - p.y]) * steer * (1 - near.distance / sense);
      marks.push(circle(ahead[0], ahead[1], 0.7, { pen: 'stabilo-88-blue' }), near ? line(ahead[0], ahead[1], near.position[0], near.position[1], { pen: 'stabilo-88-green' }) : []);
      return { position: add(p, mul([Math.cos(h), Math.sin(h)], 4)), attributes: { active: 1, heading: h } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [strokes(path), marks];
});
```

Watch the green lines as `steps` grows: they appear when the look-ahead point comes within `sense` of the bar, and the path bends away from that step on. Then set `steer` negative. What does the path do when it reaches the bar, and why does it not stop there?

<details>
<summary>What to look for</summary>

With `steer` negative the path turns toward the bar and runs into it: this rule has no `firstHit` and no decision about a hit, so the tip crosses the bar and carries on. Sensing and colliding are two different questions. A rule that turns toward things needs the join from the previous section as well, or it draws through them; the finished sketch at the top has both.

</details>

## Compose the paths

Nine seeds along the bottom, a rock in the middle made of a sampled circle, a gentle turning noise so the paths are not straight, a seeded chance of a branch, the sensing rule, and the join. Each named line of the rule is one of this page's sections: `turn`, `ahead` and `near`, the `side` test, `target` and `hit`, the `headings`. The tips are also confined to the sheet by the selection: a tip that reaches the top or the sides stops being chosen.

```ts live focus=12-20
import { sketch, circle, strokes, material, append, query, add, mul, ui } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 7 }, (t) => {
  const steps = ui(34, { min: 0, max: 60, step: 1 });
  const branch = ui(0.06, { min: 0, max: 0.3, step: 0.01, label: 'branch chance' });
  const sense = ui(6, { min: 0, max: 14, step: 0.5, label: 'sensing distance' });
  const steer = ui(0.5, { min: -1, max: 1, step: 0.05, label: 'steer (+ away, − toward)' });
  const rock = t.sample(circle(100, 46, 16), { count: 40 }).attribute('active', 0).attribute('heading', 0);
  const seeds = material(t.times(9, (i, u) => [14 + u * 172, 96]), { active: 1, heading: -Math.PI / 2 });
  const side = (heading, toward) => Math.sign(Math.cos(heading) * toward[1] - Math.sin(heading) * toward[0]) || 1;
  const paths = append(rock, seeds).steps(steps, (current, next, k) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1 && p.y > 4 && p.x > 3 && p.x < 197);
    next.extend((p) => {
      let h = p.heading + t.noise(p.x / 10, p.y / 10, k) * 0.35;
      const ahead = add(p, mul([Math.cos(h), Math.sin(h)], sense));
      const near = lines.nearest(ahead, { within: sense, excludeIncident: p });
      if (near) h -= side(h, [near.position[0] - p.x, near.position[1] - p.y]) * steer * (1 - near.distance / sense);
      const target = add(p, mul([Math.cos(h), Math.sin(h)], 2.2));
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h } }) };
      const headings = t.chance(branch) ? [h - 0.5, h + 0.5] : [h];
      return headings.map((hh) => ({ position: add(p, mul([Math.cos(hh), Math.sin(hh)], 2.2)), attributes: { active: 1, heading: hh } }));
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [strokes(paths), paths.points.filter((p) => p.active === 1).map((p) => circle(p.x, p.y, 0.8))];
});
```

Two readings of the same rule. `steer` at 0.5: the paths part around the rock and keep their distance from each other, a spare, upright stand with open space between the trails. `steer` at −0.5: they lean into each other and join, and a joined path ends there, so the drawing is a web of bundles and ladders, with the rock as a wall some of them gather against. Neither needs the other's settings: the spare one is better with a low branch chance, the joined one can take more branching because joining prunes.

Which drawing is stronger? At this seed, the avoiding stand, because its open space is deliberate and most paths can be followed to a tip; the web is more eventful but its crossings and ladders happen wherever they happen, and the eye has nowhere to rest. Try `sense` at 0 as well: no sensing, so the only interaction is the join, and the paths cross the rock's outline and stop on it. That version is honest about what a rock does.

## What the tip cannot see

The query is prepared from `current`, the frozen state at the start of the step. Points added during the step are not in it. Two tips whose paths cross: one walking east along `y = 50`, one walking north along `x = 50`. Each asks the index before every step; the index knows the other's trail but not the move it is about to make. Set `stride` to 4 and look at what happens where the paths meet.

```ts live focus=4,11-12
import { sketch, circle, strokes, material, query, add, mul, ui } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const stride = ui(2, { min: 2, max: 4, step: 2 });
  const pair = material([[32, 50], [50, 69]], { active: 1, heading: [0, -Math.PI / 2] });
  const walked = pair.steps(10, (current, next) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      const target = add(p, mul([Math.cos(p.heading), Math.sin(p.heading)], stride));
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: 0 } }) };
      return { position: target, attributes: { active: 1, heading: p.heading } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [strokes(walked), walked.points.filter((p) => p.active === 1).map((p) => circle(p.x, p.y, 1)), walked.points.map((p) => circle(p.x, p.y, 0.4))];
});
```

<details>
<summary>What to look for</summary>

At a stride of 2 the northbound tip reaches the crossing a step after the eastbound one has passed through it, finds that trail across its move, and joins it: the meeting point has three connections and the northbound path ends there. At a stride of 4 they pass through each other: on the decisive step each tip's move crosses only the other tip's *proposed* move, which is not in the index, so neither sees a hit, and the next step finds them already past each other, each with the other's trail behind it and a crossing that no point marks. The rule is not wrong; it answered the question it was asked. A step small compared with the sensing distance makes this rare, and chapter 6 shows how to find the crossings that remain and turn them into junctions afterwards.

</details>

## On your own

Make the tips behave differently on the two halves of the sheet, with one growth rule for all of them. Left of centre, paths avoid; right of centre, they approach and join. Two ways in, and they are chapter 3's: decide by position when the rule runs, or write an attribute on the seeds and read it. Which is the better choice if a path wanders across the middle?

<details>
<summary>A hint, not the answer</summary>

`steer` is a number the rule multiplies by; nothing says it has to be the same number for every tip. `p.x < 100 ? 0.5 : -0.5` decides by where the tip is now; a `bias` attribute written on each seed, carried to every child in `attributes`, decides by where the path started. The first changes its mind when a path crosses the middle; the second does not. Neither is wrong, and the two drawings differ exactly there.

</details>

## Where to look things up

`extend`, `split` and `append` are under *Movement and growth* and *Making a material* on [Materials](#/materials); `query.edges`, `nearest` and `firstHit` under *Spatial queries*; the branching examples under *Branching*. Next, chapter 6: what the spaces between these lines can become.
