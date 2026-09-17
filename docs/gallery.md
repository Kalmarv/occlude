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

## Anders Hoff (inconvergent)

Anders Hoff writes his drawings as rules over vectors and graphs, in his own Common Lisp tools ([cl-veq](https://github.com/inconvergent/cl-veq), [cl-grph](https://github.com/inconvergent/cl-grph), [weir](https://github.com/inconvergent/weir); MIT), and describes them in essays such as [Vectors & Symbols](https://inconvergent.net/2023/vectors-and-symbols/), [A graph data structure with Datalog](https://inconvergent.net/2022/graph-data-structure-with-datalog-ql/) and [A vector DSL](https://inconvergent.net/2023/a-vector-dsl/). These pieces borrow the rules he describes, not the look and not the code: each is one small process, stated in occlude's material and vector vocabulary, and the drawing is whatever the process leaves.

### Ribbon

After 1/1 0ba65d8 (2018). The rule: every vertex of one polyline steps along the line's own normal, at a speed that varies slowly along the line and in time, and the line is drawn after each step. Where the speed is even the generations stack into a band; where the normal turns faster than the line moves, the band folds over itself. The normal at a vertex comes from its two neighbours in the material.

```ts live
import { sketch, curve, strokes, sub, perp, unit, mul } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 5 }, (t) => {
  let m = curve([[8, 30], [24, 16], [46, 28], [62, 12], [84, 30], [90, 48]], { closed: false });
  const out = [];
  for (let k = 0; k < 160; k++) {
    out.push(strokes(m, { pen: 'pigma-005-black' }));
    m = m.steps(1, (prev, next) =>
      next.move(prev.points, (p) => {
        const nb = prev.connectedPoints(p);
        const along = nb.length === 2 ? sub(nb[1], nb[0]) : nb.length === 1 ? sub(nb[0], p) : [1, 0];
        const speed = 0.36 + 0.3 * t.noise(p.index / 3 + 2, k / 40);
        return mul(unit(perp(along)), speed);
      }),
    );
  }
  return out;
});
```

### Fans

After 1/1 fd148f1 (2018). The fans are sand. Every arc is walked in small steps with `along`, and each station leaves a grain: a short dash along the arc's tangent, thrown off it by an amount that grows toward the stem and at the fan's edges. Far out the grains line up into an arc; near the stem they scatter into dust. The struts and hatched sleeves are placed on the same arms.

```ts live
import { sketch, circle, line, rect, polygon, clip, fill, group, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 21 }, (t) => {
  const C = [50, 52], R = 30;
  const arm = (k) => {
    const a = (k * 60 - 90 + t.rnd(-5, 5)) * Math.PI / 180;
    const ex = C[0] + Math.cos(a) * R, ey = C[1] + Math.sin(a) * R;
    const grains = t.times(15, (i) => {
      const r = 3 + i * 1.15, ring = t.material(circle(ex, ey, r));
      return ring.along({ spacing: 0.7 }).map((st) => {
        // angle off the arm: 0 straight ahead, ±1 at the sides
        const off = Math.abs(((Math.atan2(st.y - ey, st.x - ex) - a + 3 * Math.PI) % (2 * Math.PI)) - Math.PI) / Math.PI;
        if (off > 0.55) return [];                         // the fan spans ±100°
        const dust = Math.pow(1 - Math.min(1, r / 18), 1.6) + Math.max(0, off - 0.42) * 2; // near the stem, and at the fan's edges
        const n = 1 + Math.floor(dust * 3);
        return t.times(n, () => {
          const j = dust * 2.2, gx = st.x + st.normal[0] * t.rnd(-j, j) + st.tangent[0] * t.rnd(-j, j), gy = st.y + st.normal[1] * t.rnd(-j, j) + st.tangent[1] * t.rnd(-j, j);
          if (dust > 0.9 && t.chance(dust - 0.6)) return [];
          const l = 0.55 * (1 - dust * 0.5);
          return line(gx - st.tangent[0] * l, gy - st.tangent[1] * l, gx + st.tangent[0] * l, gy + st.tangent[1] * l, { pen: i % 4 === 0 && dust < 0.3 ? 'pigma-05-black' : 'pigma-005-black' });
        });
      });
    });
    const strut = [line(C[0], C[1], ex, ey, { pen: 'pigma-05-black' }), line(C[0] + 0.5, C[1] + 0.3, ex + 0.5, ey + 0.3, { pen: 'pigma-05-black' })];
    const sleeves = t.times(2, () => {
      const s = t.rnd(0.2, 0.85), l = t.rnd(4, 9), sx = C[0] + Math.cos(a) * R * s, sy = C[1] + Math.sin(a) * R * s;
      return rect(sx - l / 2, sy - 0.9, l, 1.8, { rotate: a * 180 / Math.PI, origin: [sx, sy], stroke: false, fill: fill('hatch', { angle: 0, spacing: mm(0.3) }) });
    });
    return [grains, ...strut, ...sleeves];
  };
  const bits = t.times(7, () => {
    const x = C[0] + t.rnd(-18, 18), y = C[1] + t.rnd(-18, 18);
    return t.chance(0.6) ? circle(x, y, t.rnd(0.6, 1.4), { pen: 'pigma-05-black' }) : rect(x, y, 1.6, 2.2, { stroke: false, fill: fill('hatch', { angle: 30, spacing: mm(0.3) }) });
  });
  return [t.times(6, arm), ...bits];
});
```

### Asemic

After 1/1 4c80cca (2017): a page of writing that says nothing. A pen with inertia chases a row of targets it never quite reaches. Each word is a handful of targets along the baseline, most low, some flung up into an ascender, and the trace the pen leaves is the script. The letterforms are never drawn; they are what a spring-damped point does on its way past the targets.

```ts live
import { sketch, curve, strokes } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 3 }, (t) => {
  const lines = 17, lh = 84 / lines, out = [];
  for (let j = 0; j < lines; j++) {
    const y = 10 + j * lh;
    let x = 10;
    while (x < 86) {
      // targets for one word: a zig of tops and bottoms, the odd tall one
      const n = Math.round(t.rnd(3, 11));
      const targets = [];
      for (let i = 0; i < n; i++) {
        const up = i % 2 === 0;
        const tall = up && t.chance(0.12);
        targets.push([x + i * t.rnd(1.1, 1.7), y + (up ? -(tall ? 3.4 : t.rnd(0.9, 1.7)) : t.rnd(0.3, 1.1))]);
      }
      // the pen: a point with velocity pulled toward the current target
      let px = targets[0][0] - 0.8, py = y, vx = 0, vy = 0, ti = 0;
      const pts = [[px, py]];
      for (let s = 0; s < 400 && ti < targets.length; s++) {
        const [tx, ty] = targets[ti];
        vx += (tx - px) * 0.16; vy += (ty - py) * 0.16;
        vx *= 0.72; vy *= 0.72;
        px += vx; py += vy;
        pts.push([px, py]);
        if (Math.hypot(tx - px, ty - py) < 0.35) ti++;
      }
      out.push(strokes(curve(pts, { closed: false }), { pen: 'stabilo-88-blue' }));
      x = targets[n - 1][0] + t.rnd(2, 4.5);
    }
  }
  return out;
});
```

### Plans

After 1/1 8f41fd6 (2018): nine piles of rectangles on a unit grid, each turned as a whole. Every pile is one outline: its rectangles are appended as material and planarized, the union's boundary is what gets drawn, and the faces inside are read back for hatching, heavy edges and marks at their inscribed centres.

```ts live
import { sketch, rect, circle, line, polygon, fill, group, strokes, append, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 11 }, (t) => {
  const u = 3.2;
  const plan = (cx, cy) => {
    let x = 0, y = 0;
    const rects = t.times(7, () => {
      const w = u * Math.round(t.rnd(2, 6)), h = u * Math.round(t.rnd(2, 6));
      const r = rect(cx + x - w / 2, cy + y - h / 2, w, h);
      x += u * t.pick([-2, -1, 1, 2]);
      y += u * t.pick([-2, -1, 1, 2]);
      return r;
    });
    const pile = append(...rects.map((r) => t.material(r))).planarize();
    const faces = pile.faces();
    const inner = [...faces].filter(() => t.chance(0.3)).map((f) =>
      polygon(f, { stroke: false, fill: fill('hatch', { angle: t.chance(0.5) ? 0 : 90, spacing: mm(1) }) }));
    const outline = strokes(faces.boundaries(), { pen: 'pigma-05-black' });
    const marks = [...faces.measure()].filter(() => t.chance(0.4)).map((f) => {
      const [cx, cy] = f.inscribedCentre;
      return circle(cx, cy, 0.9, { fill: t.chance(0.5) ? fill('hatch', { angle: 45, spacing: mm(0.3) }) : undefined });
    });
    return group({ rotate: t.rnd(-50, 50), origin: [cx, cy] }, ...inner, ...outline, ...marks);
  };
  return t.grid({ cols: 3, rows: 3 }).map((c) => plan(c.x + c.w / 2, c.y + c.h / 2));
});
```

### Idling

After "Idling" (2022), a study in his graph library. A graph that edits itself: each step one random rule fires. A vertex sprouts a new edge in a slowly turning direction, an edge splits, two near vertices join, or the whole thing breathes apart. The drawing is a reading of the graph it left: its edges, the faces it has closed hatched, its tips marked, its longest edges heavy. Nothing is placed.

```ts live
import { sketch, curve, strokes, polygon, circle, fill, force, sub, add, mul, unit, distance, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 8 }, (t) => {
  let m = curve(t.times(6, (k) => [22 + k * 11, 50 + t.rnd(-10, 10)]), { closed: false });
  for (let k = 0; k < 360; k++) {
    m = m.steps(1, (prev, next) => {
      const pts = [...prev.points], rule = t.rnd(0, 1);
      if (rule < 0.42) {
        // sprout: any vertex grows an edge, roughly continuing its own line
        const p = t.pick(pts), nb = prev.connectedPoints(p);
        const back = nb.length ? t.pick(nb) : add(p, [1, 0]);
        const dir = unit(sub(p, back)), turn = t.noise(p.x / 15, p.y / 15, k / 40) * 1.6 + (nb.length > 1 ? Math.PI / 2 : 0);
        const d = [dir[0] * Math.cos(turn) - dir[1] * Math.sin(turn), dir[0] * Math.sin(turn) + dir[1] * Math.cos(turn)];
        next.extrude(prev.points.filter((q) => q.index === p.index), () => ({ position: add(p, mul(d, t.rnd(4, 9))), attributes: {} }));
      } else if (rule < 0.62) {
        // split: a long edge gets a vertex
        const long = [...prev.edges].filter((e) => e.length > 9);
        if (long.length) next.split(t.pick(long), { at: t.rnd(0.3, 0.7) });
      } else if (rule < 0.86) {
        // join: two vertices within reach that are not already connected
        const p = t.pick(pts);
        const near = pts.filter((q) => q !== p && distance(p, q) < 13 && distance(p, q) > 3 && !prev.connectedPoints(p).some((c) => c.index === q.index));
        if (near.length) next.connect(p, t.pick(near));
      } else {
        // breathe: keep apart, stay on the page
        next.move(prev.points, force.sum(force.separation(prev, { radius: 3, excludeConnected: true }), force.boundary([[5, 5], [95, 5], [95, 95], [5, 95]], { radius: 6 })));
      }
    });
  }
  const flat = m.planarize();
  const hatched = [...flat.faces()].filter(() => t.chance(0.35)).map((f) => polygon(f, { stroke: false, fill: fill('hatch', { angle: t.pick([0, 45, 90, 135]), spacing: mm(1) }) }));
  const heavy = [...m.edges].filter((e) => e.length > 12).map((e) => strokes(curve([[e.a.x, e.a.y], [e.b.x, e.b.y]], { closed: false }), { pen: 'pigma-05-black' }));
  const tips = [...m.points].filter((p) => m.connectedPoints(p).length === 1).map((p) => circle(p.x, p.y, 0.8, { fill: t.chance(0.5) ? fill('hatch', { angle: 0, spacing: mm(0.3) }) : undefined }));
  return [hatched, strokes(m), heavy, tips];
});
```

### Traces

After the tiling studies in *A vector DSL* (2023): traces on a lattice that only turn by 45°, never cross, and end in a pad. A set of claimed cells is the whole rule; the drawing is what the walks leave behind.

```ts live
import { sketch, curve, strokes, circle, fill, mm } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 4 }, (t) => {
  const n = 40, s = 84 / n, o = 8;
  const taken = new Set();
  const key = (i, j) => `${i},${j}`;
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const out = [];
  for (let w = 0; w < 140; w++) {
    let i = Math.floor(t.rnd(0, n)), j = Math.floor(t.rnd(0, n));
    if (taken.has(key(i, j))) continue;
    let d = Math.floor(t.rnd(0, 8));
    const pts = [[o + i * s, o + j * s]];
    taken.add(key(i, j));
    for (let step = 0; step < 30; step++) {
      if (t.chance(0.35)) d = (d + t.pick([1, -1]) + 8) % 8; // a 45° turn
      const [di, dj] = dirs[d];
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= n || nj >= n || taken.has(key(ni, nj))) break;
      i = ni; j = nj; taken.add(key(i, j));
      pts.push([o + i * s, o + j * s]);
    }
    if (pts.length < 3) continue;
    out.push(strokes(curve(pts, { closed: false })));
    const [ex, ey] = pts[pts.length - 1];
    out.push(t.chance(0.7) ? circle(ex, ey, 0.55, { fill: fill('hatch', { angle: 0, spacing: mm(0.25) }), stroke: false }) : circle(ex, ey, 0.8));
  }
  return out;
});
```

### Wheel

After the symmetry experiments in *A vector DSL* (2023). One walk, drawn twelve times. The walk starts on the mirror axis heading sideways, so its reflection continues it into one figure; a slow noise switches it between running, with a gentle pull round the centre, and tangling, where hard turns loop it back on itself. Where it runs, a few stretches are swept sideways along their own normal into a hatched slab, the same rule as the ribbon. Six rotations and a mirror finish the wheel.

```ts live
import { sketch, curve, strokes, ellipse, group, fill, mm, sub, perp, unit, mul } from 'occlude';

export default sketch({ aspect: [1, 1], seed: 11 }, (t) => {
  const C = [50, 50];
  const pts = [];
  let x = 50, y = 24, a = 0;
  for (let i = 0; i < 700; i++) {
    const tangle = t.noise(i / 45, 3) > 0.1;
    // Running: drift toward going round the ring (the tangent of the circle
    // through the pen, about the centre), so the wheel holds together.
    const round = Math.atan2(x - C[0], -(y - C[1]));
    const pull = Math.atan2(Math.sin(round - a), Math.cos(round - a)) * 0.05;
    a += tangle ? 0.27 + t.noise(i / 5, 8) * 0.5 : t.noise(i / 9, 8) * 0.28 + pull;
    x += Math.cos(a) * 0.24; y += Math.sin(a) * 0.24;
    pts.push([x, y]);
  }
  const walk = strokes(curve(pts, { closed: false }), { pen: 'pigma-005-black' });

  // Slabs: sweep a stretch of the walk along its normal, one small step at a time.
  const slabs = t.times(4, (k) => {
    const from = 60 + k * 150 + Math.floor(t.rnd(0, 40));
    let m = curve(pts.slice(from, from + 22), { closed: false });
    return t.times(11, () => {
      const s = strokes(m, { pen: 'pigma-005-black' });
      m = m.steps(1, (prev, next) => next.move(prev.points, (p) => {
        const nb = prev.connectedPoints(p);
        const along = nb.length === 2 ? sub(nb[1], nb[0]) : nb.length === 1 ? sub(nb[0], p) : [1, 0];
        return mul(unit(perp(along)), 0.22);
      }));
      return s;
    });
  });

  // Beads: hatched ellipses where the walk lingered.
  const beads = pts.filter((_, i) => i % 120 === 60).map(([bx, by]) =>
    ellipse(bx, by, 1.4, 0.8, t.rnd(0, 180), { stroke: false, fill: fill('hatch', { angle: 0, spacing: mm(0.3) }) }));

  const one = [walk, ...slabs, ...beads];
  return t.times(6, (k) => [
    group({ rotate: k * 60, origin: C }, ...one),
    group({ rotate: k * 60, origin: C }, group({ scale: [-1, 1], origin: C }, ...one)),
  ]);
});
```
