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

**The occlude way.** A ridge is plain data — a list of points — so the
stroke is `trace`, the open-minded sibling of `polygon`, and the hill
behind it is the same points closed down to the page bottom and masked.
Top ridge first: later wins, so each hill hides the ones behind it, with
no chord and no builder. The jitter becomes seeded `noise` so each trace
is a pulse rather than static, and the envelope an `ease` curve instead
of a clamp.

```ts live
import { sketch, trace, polygon, mask, ease } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 24 }, (t) => {
  const size = 100, step = size / 32;
  return t.times(26, (k) => {
    const base = step * (6 + k);
    const pts = [];
    for (let x = step; x <= size - step; x += 0.4) {
      const env = ease.sinInOut(1 - Math.min(1, Math.abs(x - size / 2) / 32));
      const pulse = (t.noise(x / 7, k * 9) + 1) / 2;
      pts.push([x, base - pulse * env * 17]);
    }
    return [trace(pts), mask(polygon([...pts, [size - step, size], [step, size]]))];
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

### Triangular Mesh

A grid of points, every row jittered and every other row shifted half a
cell, zig-zagged into strips of triangles and each one painted a random
grey. ([original](https://generativeartistry.com/tutorials/triangular-mesh/))

**As written.** The same rows, the same alternating zig-zag bookkeeping.
Grey has no pen, so tone becomes hatch spacing: a random spacing per
triangle, and the fill makes every triangle opaque, so shared edges draw
once and nothing shows through.

```ts live
import { sketch, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 31 }, (t) => {
  const size = 100, gap = size / 8;
  const lines = [];
  let odd = false;
  for (let y = gap / 2; y <= size; y += gap) {
    odd = !odd;
    const row = [];
    for (let x = gap / 4; x <= size; x += gap) {
      row.push([x + t.rnd(-0.4, 0.4) * gap + (odd ? gap / 2 : 0), y + t.rnd(-0.4, 0.4) * gap]);
    }
    lines.push(row);
  }
  const tris = [];
  for (let i = 0; i < lines.length - 1; i++) {
    odd = !odd;
    const zig = [];
    for (let j = 0; j < lines[i].length; j++) {
      zig.push(odd ? lines[i][j] : lines[i + 1][j]);
      zig.push(odd ? lines[i + 1][j] : lines[i][j]);
    }
    for (let j = 0; j < zig.length - 2; j++) {
      tris.push(polygon([zig[j], zig[j + 1], zig[j + 2]], {
        fill: fill('hatch', { angle: 45, spacing: mm(t.rnd(0.5, 3)) }),
      }));
    }
  }
  return tris;
});
```

**The occlude way.** The zig-zag is bookkeeping for a triangulation, and
a point set already knows its own: `t.points(pts).mesh()` is the Delaunay
mesh of the same jittered rows. Tone stops being a coin and becomes a
field sampled at each triangle's centre, so the greys drift across the
sheet instead of flickering.

```ts live
import { sketch, polygon, fill, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 31 }, (t) => {
  const gap = 100 / 8;
  const pts = [];
  let odd = false;
  for (let y = gap / 2; y <= 100; y += gap) {
    odd = !odd;
    for (let x = gap / 4; x <= 100; x += gap) {
      pts.push([x + (odd ? gap / 2 : 0) + t.rnd(-0.4, 0.4) * gap, y + t.rnd(-0.4, 0.4) * gap]);
    }
  }
  const tone = (x, y) => (t.noise(x / 40, y / 40) + 1) / 2;
  return t.points(pts).mesh().map((tri) => {
    const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
    const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
    return polygon(tri, { fill: fill('hatch', { angle: 45, spacing: mm(0.5 + tone(cx, cy) * 2.5) }) });
  });
});
```

### Un Deux Trois

Vera Molnár's *(Des)Ordres* family: a grid of cells, one short line in
the top third, two in the middle, three at the bottom, each cell turned
a little. ([original](https://generativeartistry.com/tutorials/un-deux-trois/))

**As written.** The line positions are the tutorial's literal fractions
of the cell; the rotation is its `Math.random() * 5` radians, in degrees.
Each cell is a `group` translated to its centre, so the turn pivots there.

```ts live
import { sketch, line, group } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) => {
  const size = 100, step = size / 16;
  const cells = [];
  for (let y = 0; y < size; y += step) {
    for (let x = 0; x < size; x += step) {
      const positions = y < size / 3 ? [0.5] : y < (size * 2) / 3 ? [0.2, 0.8] : [0.1, 0.5, 0.9];
      cells.push(group(
        { translate: [x + step / 2, y + step / 2], rotate: (t.rnd(5) * 180) / Math.PI },
        positions.map((p) => line(p * step - step / 2, -step / 2, p * step - step / 2, step / 2)),
      ));
    }
  }
  return cells;
});
```

**The occlude way.** The thirds are a step function of the row and the
turn is white noise; both are fields in disguise. Count from an eased
row fraction, angle from `noise` sampled at the cell, and the grid of
tics becomes a flow that reads as one gesture.

```ts live
import { sketch, line, group, ease } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) =>
  t.grid({ cols: 16, rows: 16 }).map((c) => {
    const n = 1 + Math.floor(2.999 * ease.quadIn(c.j / 15));
    const spread = n === 1 ? 0 : n === 2 ? 0.6 : 0.8;
    return group(
      { translate: [c.cx, c.cy], rotate: t.noise(c.cx / 30, c.cy / 30) * 90 },
      t.times(n, (k, u) => {
        const p = n === 1 ? 0 : (u - 0.5) * spread;
        return line(p * c.w, -c.h / 2, p * c.w, c.h / 2);
      }),
    );
  }),
);
```

### Circle Packing

Drop a tiny circle somewhere free, grow it until it touches a neighbour
or the edge, repeat. ([original](https://generativeartistry.com/tutorials/circle-packing/))

**As written.** The rejection loop and the grow loop, with `t.rnd` for
the darts. Counts are trimmed for a docs page; the picture is the same.

```ts live
import { sketch, circle } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 8 }, (t) => {
  const size = 100, minR = 0.6, maxR = 30, total = 300, attempts = 300, grow = 0.3;
  const circles = [];
  const collides = (c) =>
    c.x + c.r >= size || c.x - c.r <= 0 || c.y + c.r >= size || c.y - c.r <= 0 ||
    circles.some((o) => Math.hypot(c.x - o.x, c.y - o.y) < c.r + o.r);
  for (let i = 0; i < total; i++) {
    let c = null;
    for (let tries = 0; tries < attempts && !c; tries++) {
      const cand = { x: t.rnd(size), y: t.rnd(size), r: minR };
      if (!collides(cand)) c = cand;
    }
    if (!c) continue;
    while (c.r < maxR) {
      c.r += grow;
      if (collides(c)) { c.r -= grow; break; }
    }
    circles.push(c);
  }
  return circles.map((c) => circle(c.x, c.y, c.r));
});
```

**The occlude way.** A packing is a point set with a radius rule. Blue
noise from `t.scatter` gives the centres, `.cells()` gives each centre
its Voronoi cell, and a circle inscribed in its own cell can never touch
a neighbour: `distanceTo` the cell boundary is the radius. No darts, no
collision test, and the density is a field, so the pack can tighten
toward the edge of the sheet.

```ts live
import { sketch, circle, distanceTo } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 8 }, (t) => {
  const density = (x, y) => 0.1 + 0.9 * Math.min(1, Math.hypot(x - 50, y - 50) / 60);
  return t.scatter(density, { spacing: 6 }).relax(2).cells().map((c) =>
    circle(c.site.x, c.site.y, distanceTo([c.pts])(c.site.x, c.site.y) * 0.92));
});
```

### Hypnotic Squares

William Kolomyjec's *Hypnotic Squares* (1971): a grid of squares, each
holding a chain of smaller squares that shrink toward one of nine
anchors — centred, or pulled to a side or a corner.
([original](https://generativeartistry.com/tutorials/hypnotic-squares/))

**As written.** Each tile picks a pull in x and y from −1, 0, 1; the
chain is a loop that shrinks the square linearly and slides its corner
toward the pull, relative to the square before it.

```ts live
import { sketch, rect } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 13 }, (t) => {
  const size = 100, tiles = 7, tile = size / tiles, finalSize = 1, steps = 5;
  const out = [];
  for (let i = 0; i < tiles; i++) {
    for (let j = 0; j < tiles; j++) {
      const mx = t.pick([-1, 0, 1]), my = t.pick([-1, 0, 1]);
      let x = i * tile, y = j * tile, w = tile;
      for (let s = steps; s >= 0; s--) {
        out.push(rect(x, y, w, w));
        const next = tile * (s / steps) * 0.8 + finalSize;
        x += ((w - next) / 2) * (1 + mx * 0.5);
        y += ((w - next) / 2) * (1 + my * 0.5);
        w = next;
      }
    }
  }
  return out;
});
```

**The occlude way.** The chain is one square scaled about a pivot, and
the pivot is the vanishing point: `group({ translate: pivot, scale })`
pins the pivot first, so every smaller copy converges on it. Nine
anchors become any point in the tile.

```ts live
import { sketch, rect, group } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 13 }, (t) =>
  t.grid({ cols: 7, rows: 7 }).map((c) => {
    const px = c.cx + t.pick([-1, 0, 1]) * c.w * 0.3;
    const py = c.cy + t.pick([-1, 0, 1]) * c.h * 0.3;
    return t.times(6, (k, u) =>
      group({ translate: [px, py], scale: 1 - u * 0.88 }, rect(c.x - px, c.y - py, c.w, c.h)),
    );
  }),
);
```

### Piet Mondrian

*Composition* by recursion: a square split along a grid of lines, each
line taking a piece with a coin, three pieces coloured.
([original](https://generativeartistry.com/tutorials/piet-mondrian/))

**As written.** The same split-with-a-coin over the same seven-step
grid. Colour is a pen: the three coloured pieces get a `solid` fill in
their own pen, everything else is outline. Adjacent pieces share edges
and shared edges draw once. The pen names are the default library's;
in a studio with its own pens, substitute three of yours.

```ts live
import { sketch, rect, fill } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 3 }, (t) => {
  const size = 100, step = size / 7;
  const pens = ['stabilo-88-blue', 'stabilo-88-green', 'pigma-01-black'];
  let pieces = [{ x: 0, y: 0, w: size, h: size, pen: null }];
  const split = (axis, at) => {
    pieces = pieces.flatMap((s) => {
      const len = axis === 'x' ? s.w : s.h;
      if (!(at > s[axis] && at < s[axis] + len) || !t.chance(0.5)) return [s];
      return axis === 'x'
        ? [{ ...s, w: at - s.x }, { ...s, x: at, w: s.x + s.w - at }]
        : [{ ...s, h: at - s.y }, { ...s, y: at, h: s.y + s.h - at }];
    });
  };
  for (let i = step; i < size; i += step) { split('y', i); split('x', i); }
  for (const pen of pens) pieces[Math.floor(t.rnd(pieces.length))].pen = pen;
  return pieces.map((s) =>
    rect(s.x, s.y, s.w, s.h, s.pen ? { fill: fill('solid'), fillPen: s.pen } : {}));
});
```

**The occlude way.** One pen. Colour becomes texture: the three
pieces get three fills — `hatch`, `crosshatch`, `stipple` — and the
plotter's Mondrian is a study in tone instead of hue.

```ts live
import { sketch, rect, fill, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 3 }, (t) => {
  const size = 100, step = size / 7;
  const fills = [
    fill('hatch', { angle: 45, spacing: mm(0.9) }),
    fill('crosshatch', { angles: [0, 90], spacing: mm(1.4) }),
    fill('stipple', { density: 0.5 }),
  ];
  let pieces = [{ x: 0, y: 0, w: size, h: size, fill: null }];
  const split = (axis, at) => {
    pieces = pieces.flatMap((s) => {
      const len = axis === 'x' ? s.w : s.h;
      if (!(at > s[axis] && at < s[axis] + len) || !t.chance(0.5)) return [s];
      return axis === 'x'
        ? [{ ...s, w: at - s.x }, { ...s, x: at, w: s.x + s.w - at }]
        : [{ ...s, h: at - s.y }, { ...s, y: at, h: s.y + s.h - at }];
    });
  };
  for (let i = step; i < size; i += step) { split('y', i); split('x', i); }
  for (const f of fills) pieces[Math.floor(t.rnd(pieces.length))].fill = f;
  return pieces.map((s) => rect(s.x, s.y, s.w, s.h, s.fill ? { fill: s.fill } : {}));
});
```

### Hours of Dark

After Accurat's poster: one mark per day of the year, turned and
thickened by how long the night is. The tutorial fakes the night with a
cosine over the year.
([original](https://generativeartistry.com/tutorials/hours-of-dark/))

**As written.** 365 cells, column-major. Darkness is the cosine; the mark
is a bar whose width follows it, turned from upright at midsummer to
flat at the year's ends. A bar has width, so it is a `solid`-filled rect
with no stroke, and a bar thinner than the nib is inked as one stroke:
the nib is the only tolerance.

```ts live
import { sketch, rect, fill, group } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const size = 100, days = 365, cols = 23, rows = Math.ceil(days / cols);
  const cw = size / cols, ch = size / rows;
  return t.times(days, (i) => {
    const col = Math.floor(i / rows), row = i % rows;
    const dark = Math.abs(Math.cos((i / days) * Math.PI));
    const w = 0.2 + dark * 1.8, len = Math.min(cw, ch) * 0.8;
    return group(
      { translate: [col * cw + cw / 2, row * ch + ch / 2], rotate: -dark * 90 },
      rect(-w / 2, -len / 2, w, len, { fill: fill('solid', { angle: 90 }), stroke: false }),
    );
  });
});
```

**The occlude way.** The night is data, not a cosine: the sunrise
equation gives real hours of dark for a latitude (six to eighteen hours
mapped onto the same marks), and `ui` puts the latitude on a slider in
the studio. Same marks, true shape of the year.

```ts live
import { sketch, rect, fill, group, ui } from 'occlude';

export default sketch({ aspect: [1, 1] }, (t) => {
  const latitude = ui(52, { min: -66, max: 66 });
  const size = 100, days = 365, cols = 23, rows = Math.ceil(days / cols);
  const cw = size / cols, ch = size / rows;
  const rad = Math.PI / 180;
  const hoursOfDark = (day) => {
    const decl = -23.44 * rad * Math.cos(((2 * Math.PI) / 365) * (day + 10));
    const cosH = -Math.tan(latitude * rad) * Math.tan(decl);
    return 24 - (2 * Math.acos(Math.max(-1, Math.min(1, cosH)))) / (15 * rad);
  };
  return t.times(days, (i) => {
    const col = Math.floor(i / rows), row = i % rows;
    const dark = Math.max(0, Math.min(1, (hoursOfDark(i) - 6) / 12));
    const w = 0.2 + dark * 1.8, len = Math.min(cw, ch) * 0.8;
    return group(
      { translate: [col * cw + cw / 2, row * ch + ch / 2], rotate: -dark * 90 },
      rect(-w / 2, -len / 2, w, len, { fill: fill('solid', { angle: 90 }), stroke: false }),
    );
  });
});
```
