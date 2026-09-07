# 5. Let lines notice each other

**How can growing lines react to what is already drawn?** By the end of this chapter you can grow a line tip by tip, ask a frozen state what lies near a point or across a step, and decide what a tip does about it: join and stop, or steer clear. This is the drawing you are about to make: the reeds on the lake's eastern shore have grown into a reed bed, each shoot bending with the noise, leaning on a neighbour when it runs into one and giving it a wide berth otherwise.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes, query } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the lake from chapters 1 to 4 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  // #endregion
  const seeds = lake.attribute('active', (p) => p.east).attribute('heading', -Math.PI / 2);
  const reeds = seeds.steps(14, (current, next, k) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      let h = p.heading + t.noise(p.x / 6, p.y / 6, k) * 0.5;
      const ahead = add(p, [Math.cos(h) * 3, Math.sin(h) * 3]);
      const near = lines.nearest(ahead, { within: 3, excludeIncident: p });
      if (near) {
        const side = Math.sign(Math.cos(h) * (near.position[1] - p.y) - Math.sin(h) * (near.position[0] - p.x)) || 1;
        h -= side * 0.4 * (1 - near.distance / 3);
      }
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h, east: 1 } }) };
      return { position: target, attributes: { active: 1, heading: h, east: p.east } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [sky, sun, farHill, nearHill, polygon(lake, { opaque: true }), strokes(reeds)];
});
```

## Start here

Chapter 4 ended with a lake and reeds. The growth rings are dropped here, since the reeds are the subject, and the reeds are still what they were in chapter 3: one straight line per eastern point, drawn in one go. A reed does not grow; it is placed.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the lake from chapters 1 to 4 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  // #endregion
  const reeds = lake.points.filter((p) => p.east === 1).map((p) => line(p.x, p.y, p.x + 1, p.y - 7));
  return [sky, sun, farHill, nearHill, polygon(lake, { opaque: true }), reeds];
});
```

## Change it

**Reeds that grow.** A reed becomes a chain of short connections, added one per step, and it grows out of the lake itself. Two attributes are added to the lake: `active`, 1 for a point that is a growing tip, which is exactly the eastern points, and `heading`, an angle in radians, pointing up. Each step, `next.extend` adds a child to every tip: a new point at `position`, one step along the heading, connected to its parent. A new point must name every column the material has, so the child is given `active`, `heading` and its parent's `east`; then the parent's `active` is set to 0, so only the newest point of each reed keeps growing. `where: tips` limits both edits to the tips, a selection of `current`. The reeds and the shore are one material now, joined at the points the reeds grew from.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the lake from chapters 1 to 4 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  // #endregion
  const seeds = lake.attribute('active', (p) => p.east).attribute('heading', -Math.PI / 2);
  const reeds = seeds.steps(14, (current, next) => {
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      const target = add(p, [Math.cos(p.heading) * 1.5, Math.sin(p.heading) * 1.5]);
      return { position: target, attributes: { active: 1, heading: p.heading, east: p.east } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [sky, sun, farHill, nearHill, polygon(lake, { opaque: true }), strokes(reeds)];
});
```

`strokes(reeds)` draws every connection, the shore's and the reeds', so each reed is a stroke of fourteen short pieces; the shore is drawn again over the lake's own outline, which the pen rules treat as one line. So far the reeds are straight, because the heading never changes.

**Bend with the noise.** Turn the heading a little each step by a noise read at the tip's position, with the step number as a third input so the same place does not always turn the same way. Now the reeds sway, and some of them run into each other: there are thirty-seven places where two strokes cross.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the lake from chapters 1 to 4 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  // #endregion
  const seeds = lake.attribute('active', (p) => p.east).attribute('heading', -Math.PI / 2);
  const reeds = seeds.steps(14, (current, next, k) => {
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      const h = p.heading + t.noise(p.x / 6, p.y / 6, k) * 0.5;
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      return { position: target, attributes: { active: 1, heading: h, east: p.east } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [sky, sun, farHill, nearHill, polygon(lake, { opaque: true }), strokes(reeds)];
});
```

A crossing is two strokes drawn over each other. The material does not know about it: there is no point where they meet, only two connections that happen to pass through the same place. That is the visible problem this chapter solves.

**Notice a line in the way.** `query.edges(current)` prepares a spatial index of the state's connections, once per step, outside the callback. `lines.firstHit(p, target, { excludeIncident: p })` asks it whether the straight move from `p` to `target` would cross any connection, ignoring the ones that touch `p` itself (its own stem). The answer is `null` or a hit: which connection, and how far along it, as `hit.t`. When there is a hit, the tip does not step; it splits the connection it would have crossed at that point, with `next.split`, and connects to the new point instead, which is what `{ to: … }` means. The new point is not active, so the reed stops there, leaning on its neighbour. A crossing has become a junction: a point with three connections, which the material knows about.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes, query } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the lake from chapters 1 to 4 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  // #endregion
  const seeds = lake.attribute('active', (p) => p.east).attribute('heading', -Math.PI / 2);
  const reeds = seeds.steps(14, (current, next, k) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      const h = p.heading + t.noise(p.x / 6, p.y / 6, k) * 0.5;
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h, east: 1 } }) };
      return { position: target, attributes: { active: 1, heading: h, east: p.east } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [sky, sun, farHill, nearHill, polygon(lake, { opaque: true }), strokes(reeds)];
});
```

The split needs a `point` for the inserted vertex because the material's columns are attributes a new point must have; `heading: h` records the direction the joining reed arrived from, `east: 1` says it is on the eastern side like every reed, and `active: 0` says the junction does not grow.

**Steer clear.** Joining is one decision; avoiding is another. `lines.nearest(ahead, { within: 3, excludeIncident: p })` looks a little ahead of the tip for the closest connection within 3 that is not the tip's own, and answers with the closest point on it and the distance. Which side that point lies on decides which way to turn: the cross product of the heading and the vector to it is positive on one side and negative on the other, and `Math.sign` reduces it to that. The turn is strongest when the line is close and fades to nothing at the edge of the search. Reeds now lean away from their neighbours, and fewer of them collide; the ones that still do, join. This is the finished drawing from the top of the page.

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes, query } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the lake from chapters 1 to 4 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  // #endregion
  const seeds = lake.attribute('active', (p) => p.east).attribute('heading', -Math.PI / 2);
  const reeds = seeds.steps(14, (current, next, k) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      let h = p.heading + t.noise(p.x / 6, p.y / 6, k) * 0.5;
      const ahead = add(p, [Math.cos(h) * 3, Math.sin(h) * 3]);
      const near = lines.nearest(ahead, { within: 3, excludeIncident: p });
      if (near) {
        const side = Math.sign(Math.cos(h) * (near.position[1] - p.y) - Math.sin(h) * (near.position[0] - p.x)) || 1;
        h -= side * 0.4 * (1 - near.distance / 3);
      }
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h, east: 1 } }) };
      return { position: target, attributes: { active: 1, heading: h, east: p.east } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [sky, sun, farHill, nearHill, polygon(lake, { opaque: true }), strokes(reeds)];
});
```

## What the index does not see

The query is built from `current`, the frozen state at the start of the step. Points added during the step are not in it, so two tips that both step into the same spot in one step can still cross each other: each asked the index and the index did not know about the other. With a step of 1.5 that is rare: the drawing above has eleven junctions and two such crossings left, against thirty-seven crossings before any joining. Chapter 6 shows how to find the crossings that remain and make them junctions after the fact.

## Experiments

**A joined reed grows on.** Predict: in the finished sketch, change the split's `active: 0` to `active: 1`, so the junction itself is a tip. What changes? Change it. Observe: every reed now reaches the full fourteen steps, growing on past the point where it leaned on a neighbour, so the top of the bed is denser and every reed ends in a tip; there are thirteen junctions now, two more than before, because reeds that grew on met further neighbours. Explain: joining and stopping were two decisions written in one place. The hit still makes a junction; `active` decides whether the reed's life ends there.

**Lean toward, not away.** Predict: put `active: 0` back and change `h -= side` to `h += side`, so a reed turns toward the nearest line instead of away from it. Change it. Observe: the reeds gather into a few bundles, seventeen junctions instead of eleven, fewer reeds reach the top, and no crossing is left at all. Explain: turning toward a neighbour makes a hit likely, and a hit is a join; the same sensing that spread the reeds now gathers them. The sign of one number is the difference between a reed bed and a thicket.

## On your own

Let the western shore grow reeds too, leaning west: seed every lake point, and give a western seed the heading `-Math.PI / 2 - 0.4` and an eastern one `-Math.PI / 2 + 0.4`. The rule does not change.

<details>
<summary>A possible solution</summary>

```ts live
import { sketch, circle, ellipse, rect, clip, line, polygon, fill, mm, force, add, sub, mul, strokes, query } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 5 }, (t) => {
  // #region the landscape and the lake from chapters 1 to 4 (unchanged)
  const sky = t.times(8, (k, u) => line(0, 6 + u * 54, 200, 6 + u * 54));
  const sun = circle(110, 58, 15, { pen: 'stabilo-88-blue' });
  const sheet = rect(0, 0, 200, 100);
  const farHill = clip(sheet, ellipse(70, 95, 70, 45, 0, { fill: fill('hatch', { angle: 60, spacing: mm(1.4) }) }));
  const nearHill = clip(sheet, ellipse(140, 110, 60, 42, 0, { fill: fill('hatch', { angle: 120, spacing: mm(1.4) }) }));
  const pond = ellipse(140, 90, 34, 8, 0, { opaque: true });
  const shore = t.sample(pond, { count: 24 }).attribute('east', (p) => (p.x >= 140 ? 1 : 0));
  const lake = shore.steps(40, (current, next) => {
    const pull = force.tension(current, { rest: 4 });
    next.move((p) => add(add(mul(sub(p, [140, 94]), 0.011), [t.noise(p.x / 12, p.y / 12) * 0.8, t.noise(p.x / 12 + 30, p.y / 12) * 0.8]), mul(pull(p), 0.5)));
    next.splitEdges((e) => e.length > 6);
  });
  // #endregion
  const seeds = lake.attribute('active', 1).attribute('heading', (p) => (p.east === 1 ? -Math.PI / 2 + 0.4 : -Math.PI / 2 - 0.4));
  const reeds = seeds.steps(14, (current, next, k) => {
    const lines = query.edges(current);
    const tips = current.points.filter((p) => p.active === 1);
    next.extend((p) => {
      let h = p.heading + t.noise(p.x / 6, p.y / 6, k) * 0.5;
      const ahead = add(p, [Math.cos(h) * 3, Math.sin(h) * 3]);
      const near = lines.nearest(ahead, { within: 3, excludeIncident: p });
      if (near) {
        const side = Math.sign(Math.cos(h) * (near.position[1] - p.y) - Math.sin(h) * (near.position[0] - p.x)) || 1;
        h -= side * 0.4 * (1 - near.distance / 3);
      }
      const target = add(p, [Math.cos(h) * 1.5, Math.sin(h) * 1.5]);
      const hit = lines.firstHit(p, target, { excludeIncident: p });
      if (hit) return { to: next.split(hit.edge, { at: hit.t, point: { active: 0, heading: h, east: 1 } }) };
      return { position: target, attributes: { active: 1, heading: h, east: p.east } };
    }, { where: tips });
    next.set(() => ({ active: 0 }), { where: tips });
  });
  return [sky, sun, farHill, nearHill, polygon(lake, { opaque: true }), strokes(reeds)];
});
```

Every point is a tip now, and the heading is chosen per point from `east`, the way `active` was chosen from it before.

</details>

## Where to look things up

`extend`, `split` and the other edits are under *Movement and growth* on [Materials](#/materials); `query.edges`, `nearest` and `firstHit` under *Spatial queries*; the branching examples under *Branching*. Next, chapter 6: the reeds that lean on each other enclose small spaces. Chapter 6 finds them.
