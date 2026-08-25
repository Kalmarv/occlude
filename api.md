# occlude v2 — API spec

## Principles

1. **Shapes are values.** Calling `circle()` returns a description. Nothing is recorded, drawn, or mutated. A shape is on the page only if it's in the tree the sketch returns.
2. **No globals.** The sketch receives its toolkit as a parameter and destructures what it needs. Multiple sketches per process, testable, autocompletable.
3. **The runtime owns the page.** The studio/CLI calls the sketch with paper, seed, and margin already resolved. The sketch never renders or exports.
4. **Tree order is draw order is z.** Later occludes earlier. `z` exists only as an override.
5. **Occlusion is first-class.** `opaque` is a shape flag, not a side effect of `fill`.
6. **p5 ergonomics at the line level.** Short names, positional args, trailing options object, loops stay loops.

---

## Sketch definition

```ts
import { sketch } from 'occlude';

export default sketch(config, (tk) => tree);
```

**config**

| key      | values                                          | default  |
|----------|-------------------------------------------------|----------|
| `aspect` | `[w, h]` \| `'square'` \| `'paper'`             | `'paper'`|
| `margin` | percent inset                                   | `5`      |
| `origin` | `'topLeft'` \| `'center'`                       | `'topLeft'` |
| `yUp`    | boolean                                         | `false`  |
| `pens`   | ad-hoc pen definitions for this sketch          | `[]`     |

**tk** — the toolkit. Every function is a closure over this sketch's instance, so destructuring is safe.

**tree** — `Shape | Shape[] | nested arrays`. Flattened depth-first. `null`/`undefined`/`false` entries are skipped, so conditionals inline cleanly.

The sketch function runs once per render with paper and seed known, so units resolve eagerly and `bounds()` is exact.

---

## Shapes

All take positional geometry and a trailing `opts` object. All return a `Shape` value.

```ts
circle(x, y, r, opts?)
ellipse(x, y, rx, ry, rotation?, opts?)
rect(x, y, w, h, radius?, opts?)
line(x1, y1, x2, y2, opts?)
polygon(x, y, sides, r, rotation?, opts?)   // regular
polygon([[x, y], ...], opts?)               // explicit
```

Optional positional args before `opts` can be skipped by passing `undefined`, or — preferred — moved into `opts`: `rect(0, 0, 40, 30, { radius: 4 })`. Both forms accepted; `opts` wins.

### Shape opts

| key      | type                     | meaning |
|----------|--------------------------|---------|
| `pen`    | name \| pen object       | stroke pen. Defaults to group pen, then sketch default. |
| `stroke` | `false`                  | no outline |
| `fill`   | fill spec                | draws texture. **Implies `opaque: true`.** |
| `fillPen`| name \| pen object       | pen for the fill; defaults to `pen` |
| `opaque` | boolean                  | hides everything beneath. Default `false` (or `true` if `fill` set). |
| `z`      | number                   | sort override within the containing group. Unset = tree order. Explicit `z` always sorts relative to other explicit `z`; shapes without `z` keep tree order among themselves and are treated as `z: 0`. |

The four occlusion states, spelled out:

| want | opts |
|------|------|
| outline only, see-through | `{}` |
| outline, hides what's beneath | `{ opaque: true }` |
| textured, hides what's beneath | `{ fill: hatch(45) }` |
| invisible occluder | `mask(shape)` |

### Helpers

```ts
mask(shape)            // → { ...shape, opaque: true, stroke: false }
withOpts(shape, opts)  // → shallow-merged copy
```

Open paths cannot be `opaque` or `fill`ed — `build()` throws.

---

## Paths

A path is built mutably (it's the one place loops need it) and terminated with `build()`, which snapshots into a `Shape` value.

```ts
const p = path();
p.moveTo(0, 60);
for (const x of range(2, 100, 2)) p.lineTo(x, 60 + noise(x * 0.02) * 10);
const stroke = p.build({ pen: 'pigma-005-black' });

// build() snapshots — the builder is still usable
const below = mask(p.lineTo(100, 100).lineTo(0, 100).close().build());
```

Builder API unchanged: `moveTo lineTo bezierTo quadTo arcTo close`. `path({ winding })` for the winding rule. All builder methods return `this` for chaining.

---

## Fills

Unchanged in surface:

```ts
hatch(angle?, spacing?, offset?)        // or hatch({ angle, spacing, offset })
crosshatch(angles?, spacing?, offset?)  // or crosshatch({ ... })
stipple(density?, minDist?)             // or stipple({ ... })
```

Custom fills are unchanged except **no `ctx.rnd`**. Use the toolkit's `rnd` from the enclosing scope. Fills run in tree order at render time, so a fixed seed still reproduces every texture.

```ts
(region, ctx) => prims   // region: { bbox, contains, path, area } in mm; ctx: { penWidth }
```

---

## Grouping

```ts
group(opts, ...children)
```

| key         | meaning |
|-------------|---------|
| `translate` | `[x, y]` |
| `rotate`    | degrees |
| `scale`     | number or `[sx, sy]` |
| `pen`       | default pen for descendants |
| `z`         | sort override for the group as a unit |
| `opaque`    | make every descendant opaque |

Transform order within one group is translate → rotate → scale, same as v1 `push`. Nesting composes. Children may be nested arrays.

```ts
clip(shape, ...children)
```

Children are restricted to `shape`. `shape` is not drawn and does not occlude. Equivalent to `group({ clip: shape }, ...)`.

---

## Iteration helpers

```ts
times(n, (i, t) => x)          // → x[]; t = i / (n - 1), or 0 when n === 1
range(n)                        // → [0 … n-1]
range(a, b, step = 1)           // → [a, a+step … < b]
sample(n, () => x)              // → x[]; for when the index doesn't matter
grid({ cols, rows, gap? })      // → { x, y, w, h, i, j, u, v }[] inside the margin (u, v = normalised)
noisyLine(x1, y1, x2, y2, opts) // → Shape (was a side-effecting call)
```

Nested arrays are flattened by the tree, so `times(5, i => times(5, j => …))` is a valid return value.

---

## Random & noise

One stream, seeded from the runtime. No named streams.

```ts
rnd() rnd(n) rnd(a, b) pick(arr) chance(p) prob(p, fn, elseFn?)
noise(x, y?, z?)
map(v, a, b, c, d) norm(v, a, b) invert(v, max, min?)
```

Inserting a `rnd()` call anywhere shifts every later value. This is accepted: seeds are for reproducing a finished plot, not for editing one part of it.

`Math.random` inside a sketch is a lint error.

---

## Units & bounds

Unchanged: bare numbers are percent of the short side; `w()`, `h()`, `long()`, `mm()` wrappers. Because paper is known before the sketch runs, wrappers resolve immediately and can be used in arithmetic.

`bounds()` → `{ w, h, cx, cy }` in bare units, exact for the paper being rendered.

---

## Pens & paper

Pens are named or ad-hoc objects, passed per shape or per group. There is no "current pen." A sketch-level default comes from `config.pens[0]` or the studio's library.

Paper is chosen by the runtime. `config.aspect` letterboxes onto it.

---

## Runtime (studio / CLI)

```ts
const scene = await runSketch(sketchModule, { paper: 'A4', seed: 4821 });
render(scene, { coarsen })
exportSvg(scene, { background, onlyPen: 'pigma-005-black' })
exportGcode(scene, { profile, optimize })
exportPng(scene, { scale })
```

`onlyPen` takes a pen name. Everything else unchanged.

---

## Migration from v1

| v1 | v2 |
|----|----|
| `sketch({ ... }); margin(5);` at top of file | `sketch({ ..., margin: 5 }, tk => ...)` |
| `import { circle } from 'occlude'` | `({ circle }) => ...` destructured from the toolkit |
| `circle(x, y, r)` records | `circle(x, y, r)` returns a value; include it in the returned tree |
| `.fill(spec)` | `{ fill: spec }` |
| `.fill()` (opaque, stroked) | `{ opaque: true }` |
| `.fill(false)` | omit `opaque` / `fill` |
| `.mask()` | `mask(shape)` |
| `.stroke(false)` / `.noStroke()` | `{ stroke: false }` |
| `.stroke(pen)` / `.pen(p)` | `{ pen }` (and `fillPen` if different) |
| `.z(n)` | `{ z: n }` — now relative to siblings, not to global draw index |
| `.clone()` | shapes are values; reuse the variable, or `withOpts(shape, {...})` for a variant. Path builders: `build()` twice |
| `pen('name')` sets current pen | `group({ pen: 'name' }, ...)` or per-shape `{ pen }` |
| `push({ translate }, () => { ... })` | `group({ translate }, ...children)` |
| `clip(shape, () => { ... })` | `clip(shape, ...children)` |
| `stream('name')` | removed; use `rnd` |
| `ctx.rnd()` in custom fills | closed-over `rnd` |
| `Array.from({ length: n }, (_, i) => ...)` | `times(n, (i, t) => ...)` |
| `initOcclude(); render(); exportSvg()` in the sketch | removed; runtime calls the sketch |
| `seed: 'url'` in config | runtime option |

### Things that change meaning

- **Draw order is now depth order, always.** In v1 you could draw a far ridge after a near one and fix it with `.z()`. In v2, write the loop back-to-front. `z` still works but is local to the group.
- **`fill` no longer needs the shape to already exist.** There's no "add fill to a recorded shape later" — decide at construction.
- **Helpers return, never record.** Any function that previously "drew" (`noisyLine`, custom helpers) must now return shapes and the caller must include them in the tree.

---

## Open questions

- Should `group` accept a plain array as children (`group(opts, children)`) as well as varargs? Leaning yes; both flatten identically.
- Does `z` need to sort across groups, or is per-group enough? Start per-group; escalate only if a real sketch needs more.
- `fillPen` as a separate key vs `fill: { spec, pen }`. Separate key keeps the common case (`fill: hatch(45)`) shortest.
- `ellipse`/`polygon` rotation as positional or opts-only. Two forms is friction; consider opts-only in v2 and accept the extra characters.
