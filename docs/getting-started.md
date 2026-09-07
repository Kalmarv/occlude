# Getting started

Every entry is a live example: the canvas below each snippet is rendered by
the same engine the studio uses, right now, in your browser — if a change
breaks an example, this page shows it. **Open in studio** loads the snippet
into the editor.

Coordinates are bare units (percent of the drawable's short side) unless
wrapped — `mm(1)` is physical. Examples use the default pen library.

## The sketch function

A sketch is a pure function from a toolkit to a tree of shape values —
nothing draws until it renders. The tree may nest arrays arbitrarily; it
is flattened, **tree order is draw order**, and falsy entries are skipped
(so `cond && shape` composes).

```ts
sketch({
  aspect: [3, 2],        // [w, h] | 'square' | 'paper' (default)
  margin: 6,             // percent inset from the paper edge
  seed: 'url',           // 'url' reads ?seed= (default); or a number/string
  pen: 'pigma-005-black',// default pen for shapes that don't set one
  origin: 'topLeft',     // or 'center'
  yUp: false,
  rectMode: 'corner',    // or 'center' — p5-style rect anchoring default
}, (toolkit) => tree)
```

Fixed aspects are letterboxed onto whatever paper is selected at
render/export. Everything random derives from the seed. Alongside its
functions, the toolkit carries the drawable extent as plain numbers —
`width`, `height`, `cx`, `cy` (the same values `bounds()` returns).

**Imports vs the toolkit:** everything pure — shape constructors, fills,
modifiers, units, `map`/`ease`, `ui`, `svg` — is importable from
`'occlude'` (and therefore usable in helper files). Everything that
depends on the *running sketch* lives only on the toolkit: randomness
(`rnd`/`noise`/`pick`/`chance`/`stream` read the seed), layout
(`bounds`/`grid`/`times` need the resolved paper), and point
distributions (`scatter`/`points` need both; their pure duals
`voronoi`/`triangulate` are imports). The toolkit also
carries the pure functions, so destructuring `({ circle, rnd }) => …` is
an equivalent style.

The occlusion contract, in four rules:

1. **Later wins.** Opaque shapes hide everything before them in the tree;
   `z` overrides the ordering, ties break by tree order.
2. **Only fills/opacity occlude.** Strokes never hide anything, and stroke
   width never dilates an occluder.
3. **On the boundary counts as visible.** Ink lying exactly on an occluder's
   edge survives (shared edges draw once — duplicates are removed).
4. **The nib is the only tolerance.** Visible ink rounds to the nearest
   plottable mark. Closed outlines are judged whole: a tiny circle whose
   circumference still exceeds the nib is drawn as a ring (a solid dot of
   diameter 2r + nib — dot sizes stay continuous); below that it becomes a
   single pen tap — unless that ink is already laid down by a neighbouring
   stroke of the same pen, in which case it's redundant and dropped.
   Hidden gaps shorter than the pen width are inked — a pen can't plot a
   line or a gap finer than its own nib.

## Units

Bare numbers are percent of the drawable's short side — sketches stay
paper-independent. Wrappers pin other meanings: `mm(v)` physical
millimetres (nib-true detail), `w(v)`/`h(v)` percent of width/height,
`s(v)` percent of the long side. Mixed freely; resolved at render when
the paper is known.

```ts live
import { sketch, rect, label, mm, w } from 'occlude';

export default sketch({ aspect: [2, 1] }, () => [
  rect(2, 6, 25, 20),                 // bare: % of short side
  rect(35, 6, w(25), 20),             // w(): % of WIDTH — wider on 2:1
  rect(2, 32, mm(25), mm(10)),        // mm(): physical, same on any paper
  label('BARE', 3, 27.5, 3), label('W()', 36, 27.5, 3), label('MM', 3, 44, 3),
]);
```

## Controls and probes

### ui

`ui(value, { min?, max?, step?, label? })` — a tweakable value. In the
studio, every `ui()` call with a **literal** number or boolean gets a
slider in a panel over the preview; dragging it **edits the literal in
your code** (highlighted while you drag), so the tuned sketch saves,
shares, and replots exactly as seen. The label defaults to the assigned
name (`const rows = ui(12)` → "rows"). At render time `ui()` just returns
its value — headless tools and this page see the literal.

Every other number is tweakable too, without wrapping it: **Alt-drag any
number literal in the editor** to scrub it (Shift ×10, Ctrl ÷10 and one
more decimal). The step follows the literal's own precision, and the edit
lands in the code the same way — `ui()` is for the values you want a
labelled control for.

```ts live
import { sketch, circle, ui } from 'occlude';

export default sketch({ aspect: [2, 1] }, (t) => {
  const rings = ui(9, { min: 1, max: 30, step: 1 });
  const spread = ui(0.6);
  return t.times(rings, (k, u) => circle(50, 25, 3 + u * 20 * (1 + spread)));
});
```

### probe

`t.probe(label, value)` — the variable inspector. Returns `value`
unchanged and records it, so after the render the studio's controls
panel shows what the label actually ran through: count, min, mean, max,
and a small histogram. Wrap any number anywhere — a field's return, a
loop variable, something inside a fill — to learn the range before you
ease or map it. Deterministic and free to leave in: it never changes a
value.

```ts
const density = (x, y) => {
  const s = t.probe('s', d(x, y));                 // read the range, then choose the falloff
  return s <= 0 ? 0 : t.probe('p', ease.smooth(1 - s / 12));
};
```

## The sketch library

Saved sketches live on the studio server as a git repository: every save
is a commit, so nothing is ever lost, and the **Sketches** page shows the
library as cards. Two moves beyond saving, both from the studio's top bar:

- **Fork** copies the current sketch into a new one (its first line
  records `// fork of <name> @ <commit>`) and opens it, so you can follow
  a different path without touching the original. Forks can fork; the
  page nests them under their parent.
- **Snapshot** freezes the current source together with the seed it
  rendered under — an annotated tag, immutable — for "I like this one"
  moments that don't deserve a whole new sketch. On the page a snapshot
  opens with its seed, or forks into a sketch of its own.

Thumbnails come from the studio's finished render on save and snapshot;
the page never renders. Each card opens into its forks, snapshots, and a
rail of its history.
