# Gallery

Credited generative classics rewritten in occlude, one drawing per piece, live on the page and checked by the same tool as the rest of the docs. Where two constructions of a piece are genuinely different drawings, both appear under their own titles. The originals are linked; their ideas are borrowed, never their code.

## Generative Artistry

Nine short tutorials by Tim Holman and Ruth John ([generativeartistry.com](https://generativeartistry.com), MIT), each reconstructing a classic by Nees, Molnár, Kolomyjec, Mondrian and others in a few lines of canvas code.

### Tiled lines

After the one-line BASIC program `10 PRINT CHR$(205.5+RND(1)); : GOTO 10`: every cell of a grid gets one diagonal, flipped by a coin. `t.grid` hands out the cells and `t.chance` is the coin. Diagonals that meet at a corner are joined by the toolpath planner, so the pen draws far fewer strokes than there are cells. ([original](https://generativeartistry.com/tutorials/tiled-lines/))

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

### Ridges

After Peter Saville's cover for *Unknown Pleasures*: stacked pulse traces, each hiding the traces behind it. The tutorial paints each ridge's interior out before stroking it; on paper the interior becomes a mask, the same points closed down to the page bottom, and the engine cuts the ridges behind it exactly. The pulse is seeded noise under an eased envelope that pins the edges. ([original](https://generativeartistry.com/tutorials/joy-division/))

```ts live
import { sketch, stroke, polygon, mask, ease } from 'occlude';

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
    return [stroke(pts), mask(polygon([...pts, [size - step, size], [step, size]]))];
  });
});
```

### Cubic disarray

Georg Nees, *Schotter* (1968): a grid of squares that keeps its composure at the top and tumbles as it falls, each square rotated and shifted by an amount that grows with its row. Per-shape `translate` and `rotate` pivot each square on its own centre. Nees's plotter crossed the outlines where squares overlapped, and so does this. ([original](https://generativeartistry.com/tutorials/cubic-disarray/))

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

### Piled squares

A different composition on the same rule: the squares are opaque, so the lower rows read as a pile with every hidden edge cut at the square in front, and the fall is eased so it starts late and ends hard.

```ts live
import { sketch, rect, group, ease } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 17 }, (t) => {
  const size = 100, n = 11, sq = size / n;
  return t.times(n - 1, (row) => {
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

### Triangulated cells

After the tutorial's triangular mesh: rows of jittered points, alternate rows shifted half a cell, and every triangle given its own tone. The tutorial zig-zags the rows into triangle strips; here the same points are Delaunay-triangulated with `connect.triangulate`, whose faces are the triangles, so the topology is the triangulation's rather than the strips'. Grey has no pen, so tone is hatch spacing from a noise field sampled at each triangle's centroid, and the filled triangles are opaque, so shared edges draw once. ([original](https://generativeartistry.com/tutorials/triangular-mesh/))

```ts live
import { sketch, polygon, fill, mm, connect } from 'occlude';

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
  const triangles = connect.triangulate(pts).faces();
  return triangles.measure().map(({ face, centroid: [cx, cy] }) =>
    polygon(face, { fill: fill('hatch', { angle: 45, spacing: mm(0.5 + tone(cx, cy) * 2.5) }) }));
});
```

### Un deux trois

Vera Molnár's *(Des)Ordres* family: a grid of cells with one short line in the top third, two in the middle and three at the bottom, each cell turned a little. The line positions are the tutorial's fractions of the cell and the rotation its `Math.random() * 5` radians, converted to degrees. Each cell is a group translated to its centre so the turn pivots there. ([original](https://generativeartistry.com/tutorials/un-deux-trois/))

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

### Circle packing

Drop a tiny circle somewhere free, grow it until it touches a neighbour or the edge, repeat. The rejection loop and the growth loop are the tutorial's, with `t.rnd` for the darts; counts are trimmed for the page. ([original](https://generativeartistry.com/tutorials/circle-packing/))

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

### Circles in Voronoi cells

A different algorithm with a related look: blue-noise centres from `t.scatter`, each centre's Voronoi cell from `t.voronoi`, and a circle inscribed in its own cell, which can never touch a neighbour. The radius is the distance from the site to its cell's boundary, and the density is a field, so the packing tightens toward the sheet's edge.

```ts live
import { sketch, circle, distanceTo } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 8 }, (t) => {
  const density = (x, y) => 0.1 + 0.9 * Math.min(1, Math.hypot(x - 50, y - 50) / 60);
  const sites = t.relax(t.scatter(density, { spacing: 6 }), { iterations: 2, density });
  const cells = t.voronoi(sites);
  return sites.points.map((p) => {
    const cell = cells.cellOf(p);
    return cell && circle(p.x, p.y, distanceTo(cell)(p.x, p.y) * 0.92);
  });
});
```

### Hypnotic squares

William Kolomyjec's *Hypnotic Squares* (1971): a grid of squares, each holding a chain of smaller squares that shrink toward one of nine anchors, centred or pulled to a side or a corner. Each tile picks a pull in x and y from −1, 0, 1; the chain shrinks the square linearly and slides its corner toward the pull, relative to the square before it. ([original](https://generativeartistry.com/tutorials/hypnotic-squares/))

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

### Composition after Mondrian

A square split along a seven-step grid, each line taking a piece with a coin, three pieces coloured. Colour is a pen: the three pieces get a solid fill in their own pen and everything else is outline. Adjacent pieces share edges, and shared edges draw once. The pen names are the default library's; substitute three of yours in a studio with its own pens, or give the three pieces three textures for a one-pen version. ([original](https://generativeartistry.com/tutorials/piet-mondrian/))

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

### Hours of dark

After Accurat's poster: one mark per day of the year, column-major, turned and thickened by the length of the night. The tutorial approximates the night with a cosine over the year; this version computes hours of darkness from the sunrise equation for a latitude on a slider, with the solar declination approximated by a cosine of the day and no correction for refraction or altitude. Six to eighteen hours of dark map onto the same marks. A bar is a solid-filled rect with no stroke; a bar thinner than the nib is inked as one stroke. ([original](https://generativeartistry.com/tutorials/hours-of-dark/))

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
