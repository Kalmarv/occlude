# Gallery — classics, transposed

Canonical generative pieces rewritten in occlude, each in up to three
forms. **As written** is the literal transposition: same algorithm, same
look, proof the vocabulary covers it. **The occlude way** is what the
piece becomes when fill means occlude, the pen's time is a design
dimension, and fields are citizens. **Simpler** is the same picture in the
fewest moves. Every fence renders live through the real engine and is
checked by `pnpm --filter occlude docs:check`, so the gallery doubles as a
regression corpus.

Every piece is credited to its author. The originals are linked; only
their ideas are borrowed, never their code.

## Generative Artistry

Nine short tutorials by Tim Holman and Ruth John
([generativeartistry.com](https://generativeartistry.com), MIT). Each
one reconstructs a classic — Nees, Molnár, Riley, Mondrian — in a few
lines of canvas code, which makes them the canon to test a new
vocabulary against.

### Tiled Lines

After the one-line BASIC program `10 PRINT CHR$(205.5+RND(1)); : GOTO
10` — every cell of a grid gets one diagonal, flipped by a coin.
([original](https://generativeartistry.com/tutorials/tiled-lines/))

**As written.** A grid, a coin, a line. `t.grid` hands out the cells and
`t.chance` is the coin; the seed makes the coin fair forever.

```ts live
import { sketch, line } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 10 }, (t) =>
  t.grid({ cols: 16, rows: 16 }).map((c) =>
    t.chance(0.5)
      ? line(c.x, c.y, c.x + c.w, c.y + c.h)
      : line(c.x + c.w, c.y, c.x, c.y + c.h),
  ),
);
```

**The occlude way** is the same code. The screen draws 256 segments;
the pen draws 73 strokes, because diagonals that meet at a cell corner
are one path and the toolpath planner chains them on its own (measured
with `plotstats`). Nothing to add: the literal form is the idiomatic one.

### Joy Division

Peter Saville's cover for *Unknown Pleasures*: stacked pulse traces, each
one hiding the traces behind it. The tutorial fakes the hiding by
painting each ridge's interior with `destination-out` before stroking
it. ([original](https://generativeartistry.com/tutorials/joy-division/))

**As written.** The same points, the same midpoint quadratics, the same
envelope that lets the middle jump and pins the edges. The one
substitution is forced by paper: an eraser is not a pen. The painted-out
interior becomes a `mask` — the same closed polygon, occluding and
drawing nothing — and the engine cuts the ridges behind it exactly.

```ts live
import { sketch, path, mask } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 24 }, (t) => {
  const size = 100, step = size / 32;
  const lines = [];
  for (let y = step; y <= size - step; y += step) {
    const pts = [];
    for (let x = step; x <= size - step; x += step) {
      const toCenter = Math.abs(x - size / 2);
      const variance = Math.max(size / 2 - 15 - toCenter, 0);
      pts.push([x, y - t.rnd() * variance / 2]);
    }
    lines.push(pts);
  }
  return lines.slice(5).map((pts) => {
    const p = path().moveTo(pts[0][0], pts[0][1]);
    let j = 0;
    for (; j < pts.length - 2; j++) {
      const xc = (pts[j][0] + pts[j + 1][0]) / 2;
      const yc = (pts[j][1] + pts[j + 1][1]) / 2;
      p.quadTo(pts[j][0], pts[j][1], xc, yc);
    }
    p.quadTo(pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1]);
    const stroke = p.build();
    return [stroke, mask(p.close().build())];
  });
});
```

**The occlude way.** The ridge idiom from the reference: build the
open trace, stroke it, then extend the same builder down to the page
bottom and mask that — the occluder is the whole hill, not a chord. The
jitter becomes seeded `noise` so each trace is a pulse rather than
static, and the envelope becomes an `ease` curve instead of a clamp.

```ts live
import { sketch, path, mask, ease } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 24 }, (t) => {
  const size = 100, step = size / 32;
  // Top ridge first: later wins, so each hill hides the ones behind it.
  return t.times(26, (k) => {
    const base = step * (6 + k);
    const p = path().moveTo(step, base);
    for (let x = step + 0.4; x <= size - step; x += 0.4) {
      const env = ease.sinInOut(1 - Math.min(1, Math.abs(x - size / 2) / 32));
      const pulse = (t.noise(x / 7, k * 9) + 1) / 2;
      p.lineTo(x, base - pulse * env * 17);
    }
    const stroke = p.build();
    p.lineTo(size - step, size).lineTo(step, size).close();
    return [stroke, mask(p.build())];
  });
});
```

### Cubic Disarray

Georg Nees, *Schotter* (1968): a grid of squares that keeps its
composure at the top and tumbles as it falls, each square rotated and
shifted by an amount that grows with its row.
([original](https://generativeartistry.com/tutorials/cubic-disarray/))

**As written.** Rotation and displacement scale with the row, sign by
coin, magnitude by `rnd`. Transforms pivot on the user origin, so each
square is a `group` translated to its centre first and rotated there.

```ts live
import { sketch, rect, group } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 17 }, (t) => {
  const size = 100, sq = size / 11, displacement = 4.5, rotation = 20;
  const cells = [];
  for (let x = sq; x < size - sq; x += sq) {
    for (let y = sq; y <= size - sq; y += sq) {
      const rot = (y / size) * t.pick([-1, 1]) * t.rnd() * rotation;
      const shift = (y / size) * t.pick([-1, 1]) * t.rnd() * displacement;
      cells.push(group({ translate: [x + shift, y], rotate: rot },
        rect(-sq / 2, -sq / 2, sq, sq)));
    }
  }
  return cells;
});
```

**The occlude way.** Nees's plotter crossed the outlines where squares
overlapped; ink cannot be erased. Here the squares are opaque, so the
lower rows read as a pile: later wins, and every hidden edge is cut
exactly at the square in front. The disorder is one number per row,
`u`, shaped by an `ease` so the fall starts late and ends hard.

```ts live
import { sketch, rect, group, ease } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 17 }, (t) => {
  const size = 100, n = 11, sq = size / n;
  return t.times(n - 1, (row, u) => {
    const fall = ease.quadIn((row + 1) / (n - 1));
    return t.times(n - 1, (col) => {
      const x = sq + col * sq, y = sq + row * sq;
      return group(
        { translate: [x + t.rnd(-1, 1) * fall * 5, y], rotate: t.rnd(-1, 1) * fall * 22 },
        rect(-sq / 2, -sq / 2, sq, sq, { opaque: true }),
      );
    });
  });
});
```

**Simpler.** Per-shape `translate`/`rotate` opts are the group without
the wrapper; the seed still owns the coin.

```ts live
import { sketch, rect } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 17 }, (t) =>
  t.grid({ cols: 10, rows: 10 }).map((c) => {
    const fall = (c.j + 1) / 10;
    return rect(-c.w / 2, -c.h / 2, c.w, c.h, {
      translate: [c.cx + t.rnd(-1, 1) * fall * 5, c.cy],
      rotate: t.rnd(-1, 1) * fall * 22,
    });
  }),
);
```
