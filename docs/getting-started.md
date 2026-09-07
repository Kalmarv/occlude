# Getting started

Occlude is a library and studio for pen-plotter drawings. A sketch is a function that returns shapes; the engine works out which strokes survive when shapes hide one another, and the studio previews, exports and plots the result.

Every example on these pages is live: the preview is rendered by the same engine the studio uses, on the sheet named under it. The code beside it is editable, and edits re-render in place. Nothing you type here is saved; reload the page to get the original back, or use "open in studio" to keep working on it with the same paper and pens.

```ts live
import { sketch, circle, line, fill, mm } from 'occlude';

export default sketch({ aspect: [2, 1], seed: 3 }, (t) => [
  t.times(24, (k, u) => line(0, u * 100, 200, u * 100)),
  t.times(14, () =>
    circle(t.rnd(20, 180), t.rnd(15, 85), t.rnd(8, 22), {
      fill: fill('hatch', { angle: t.rnd(180), spacing: mm(1) }),
    }),
  ),
]);
```

## The sketch function

`sketch(config, (toolkit) => tree)` describes a drawing. The function receives a toolkit and returns shapes; nothing is drawn until the sketch renders. The tree may nest arrays to any depth. It is flattened, drawn in tree order, and falsy entries are skipped, so `condition && shape` is a normal way to include something conditionally.

```ts
sketch({
  aspect: [3, 2],         // [w, h] | 'square' | 'paper' (default: the paper's own shape)
  margin: 6,              // percent inset from the paper edge
  seed: 'url',            // 'url' reads ?seed= (default); or a number or string
  pen: 'pigma-005-black', // default pen for shapes that don't name one
  origin: 'topLeft',      // or 'center'
  yUp: false,
  rectMode: 'corner',     // or 'center': how rect() anchors (x, y)
}, (t) => tree)
```

A fixed aspect is letterboxed onto whatever paper is chosen at render time. The toolkit carries the drawable's size as plain numbers (`t.width`, `t.height`, `t.cx`, `t.cy`), the same values `t.bounds()` returns.

Pure constructors are imports from `'occlude'`: shapes, fills, modifiers, units, `map` and `ease`, `ui`, `svg`, and the material vocabulary. They work in helper files too. Anything that depends on the running sketch lives only on the toolkit: randomness (`rnd`, `noise`, `pick`, `chance`, `stream` read the seed), layout (`bounds`, `grid`, `times` need the resolved paper), and sampling (`scatter`, `sample`, `points`). The toolkit also exposes the pure functions, so destructuring `({ circle, rnd }) => …` is an equivalent style.

## Coordinates and units

A bare number is a percentage of the drawable's short side. On a 2:1 drawable the long side runs to 200, on a square one both run to 100. Wrappers pin other meanings:

| Unit | Meaning |
|---|---|
| `mm(v)` | physical millimetres, the same on any paper |
| `w(v)`, `h(v)` | percent of the drawable's width or height |
| `s(v)` | percent of the long side |

They mix freely and resolve when the paper is known. Use bare units for composition and `mm()` for anything that should stay the same size on paper: hatch spacing, dot sizes, wobble amplitude.

```ts live
import { sketch, rect, label, mm, w } from 'occlude';

export default sketch({ aspect: [2, 1] }, () => [
  rect(6, 10, 25, 40),                  // 25 bare units: a quarter of the short side
  rect(50, 10, w(25), 40),              // w(25): a quarter of the width, twice as wide on 2:1
  rect(120, 10, mm(25), mm(20)),        // mm(): physical, the same on any paper
  label('25', 6, 58, 6), label('W(25)', 50, 58, 6), label('MM(25)', 120, 58, 6),
]);
```

Read `t.bounds()` when a drawing should fill whatever drawable it lands on; assuming a 0 to 100 range on the long axis leaves half of a 2:1 sheet blank.

## Seeds and randomness

Every random value comes from the sketch's seed: `seed` in the config, or the URL's `?seed=` when the config says `'url'` (the studio's default). The same source and seed produce the same geometry. `t.rnd()`, `t.pick()`, `t.chance()` and `t.noise()` are the everyday calls; Fields & variation covers them, independent streams, and easing.

## Controls

`ui(value, { min?, max?, step?, label? })` marks a literal number or boolean as tweakable. In the studio each one gets a slider over the preview, and dragging it rewrites the literal in your code, so the tuned sketch saves and replots exactly as seen. The label defaults to the variable name. On these pages each `ui()` in a live example becomes a slider under its code, editing the literal in the same way. Anywhere else `ui()` returns its value.

Any other number literal can be scrubbed in the studio's editor by Alt-dragging it (Shift for ten times the step, Ctrl for a tenth). `ui()` is for the values that deserve a labelled control.

```ts live
import { sketch, circle, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const rings = ui(9, { min: 1, max: 30, step: 1 });
  const spread = ui(0.6, { min: 0, max: 1, step: 0.05 });
  return t.times(rings, (k, u) => circle(100, 50, 3 + u * 27 * (1 + spread)));
});
```

`t.probe(label, value)` returns the value unchanged and records it. After a render the studio's controls panel shows the label's count, minimum, mean, maximum and a small histogram, which is the quick way to learn a field's range before easing or mapping it. It never changes a value and is free to leave in.

```ts
const density = (x, y) => {
  const s = t.probe('s', d(x, y));
  return s <= 0 ? 0 : t.probe('p', ease.smooth(1 - s / 12));
};
```

## How shapes hide each other

1. Later wins. A shape hides everything earlier in the tree that lies under its area. `z` overrides the order; ties break by tree order.
2. Only area hides. A shape occludes when it has a fill or `opaque: true`. Strokes never hide anything, and a stroke's width does not enlarge the hidden area. In the current version a fill always makes its shape opaque; see Fills for the details and the open question around non-hiding texture.
3. Ink exactly on an occluder's boundary stays visible. Where two shapes share an edge, it is drawn once.
4. The pen width decides what is drawable. Each visible run of a stroke is judged as a whole: a run shorter than the nib becomes a single pen tap, or is dropped when a neighbouring stroke of the same pen already covers it. A hidden gap shorter than the pen width is inked through, because the pen could not have left it. A closed outline whose circumference exceeds the nib is drawn as a ring, however small.

Other numerical policies exist but are not artistic tolerances: input coordinates snap to a 0.005 mm grid so shared edges coincide exactly, curves stay exact through the solve and are flattened only at export, and fields are sampled on rasters at encode time.

## Saving, forking, snapshots

The studio saves the working sketch on every run and, with Ctrl+S, into the sketch library on the studio server. The library is a git repository, so each save is a commit and older versions stay reachable. Two moves beyond saving, both from the top bar:

- Fork copies the current sketch into a new one whose first line records its origin, and opens it. Forks can fork; the Sketches page nests them under their parent.
- Snapshot freezes the current source together with the seed it rendered under, as an immutable tag. On the Sketches page a snapshot opens with its seed or forks into a sketch of its own.

Thumbnails come from the studio's finished render at save and snapshot time.

## Export and plotting

Plotting & saving covers paper and pens, choosing which part of the ordered drawing to plot, SVG, G-code and PNG export, simulation, saved results, and driving the machine.
