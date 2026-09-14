# API ergonomics batch (2026-09-15)

The owner's API review (`development/3d/api-3d.md`, untracked) asked for a
more composable, terse 3D vocabulary. Items approved after two rounds:
1, 2, 4, 6, 7, 8, 9, 10, 11, 17, 18 (13 and 14 skipped as "don't care";
3, 5, 12, 15 dropped). Every change is in the library and documented on
`docs/three.md`; tests in `packages/occlude/test/three-api-ergonomics.test.ts`.

## What changed

- **1 async sketches**: `sketch(config, async t => …)` is accepted; the sync
  compiler refuses a function that returns a promise with a pointer to
  `compileSketchAsync`/`renderAsync`.
- **2 projected curve selection**: `lines.visible.kind('isoline', 'trace')`
  and `.except(...)` beside `filter`.
- **4 instances on faces**: `instanceOnFaces(prototype, mesh.faces, { scale,
  rotate, offset })` places the prototype at each face centre with +Z along
  the normal; `instanceOnPoints` also accepts `{ points }` directly.
- **6 vector helpers**: `v3.{add, sub, scale, dot, cross, length, distance,
  normalize, lerp, mix}` over triples or `{x,y,z}` rows; `falloff(point,
  { center, radius, ease })`; `t.noise(pointOrTriple, { wavelength, amount })`.
- **7 steps shorthand**: `steps(n, { move, set })` on meshes, point and curve
  geometry (a numeric move follows the vertex normal on meshes; point/curve
  geometry refuses a scalar), and on 2D `Material.steps`. A bare callback is
  deliberately not a shorthand: TypeScript cannot distinguish a one-parameter
  point field from a `(current, next)` rule (verified both overload orders and
  the union form; either the rule or the field loses its parameter types).
- **8 displacement**: `displace(number)` moves along the vertex normal;
  `{ along: 'x' | 'y' | 'z' | triple }` picks another direction.
- **9 faces getter, reductions, smooth, extrude(number)**: `mesh.faces`
  (getter), `collection.sum/mean/max/min(name)`, `mesh.smooth(name,
  { steps })`, `extrude(faces, 0.5)`.
- **10 stroke on curves**: every supported-curve derivation (`mapSurface`,
  `intersections`, `isolines`, `trace`, `t.hatch`) takes `stroke`; the
  default drawing of `view` sends those lines to that pen; `withStroke(pen)`
  re-tags a value.
- **11 one hatch family per call**: `families`/per-family ids are gone from
  `t.hatch`; crosshatch is a second call with its own direction, tone and
  pen. The fallback direction defaults to chart u, then world +X projected.
  (The dev-store demo sketches `cool.ts`, `field-ingredients.ts` and
  `curvature-crosshatch.ts` still use `families`; the error now says to call
  hatch once per family. They are the owner's files and were not edited.)
- **16 isolines**: `isolines(mesh, field, { count | spacing | levels })`, the
  field row carries the point's `x, y, z` and attributes with the corner's
  `uv` and `chart`.
- **17 keys**: removed from the docs examples; documented once in the
  collections paragraph as the tool for unstable evaluation order.
- **18 object origin**: geometry carries `origin` (born at the world origin,
  carried by `translate`) and `orientation`; `rotate(angles)` and `scale`
  pivot on it by default, `rotate('z', deg, { about: 'origin' | 'world' |
  triple, local })` reads a local axis in the accumulated orientation. An
  explicit pivot as the second argument still works.
- **light floor**: `light({ floor })` keeps a minimum tone on lit faces;
  directions accept `'up' | 'down' | 'x' | 'y' | 'z'`.

## Ink

Deliberate change to two docs examples, both rewritten from one `families`
call to two `t.hatch` calls: the second call reads the seeded stream from
where the first left it, so its seeds differ from the old family "b".

| example | before | after |
| --- | --- | --- |
| three#21 | c8b8de30… | fc15e3d6… |
| three#23 | 6dc7f67e… | 1fba7e21… |

All other 256 examples byte-identical (`docs:hashes --check` before the
fixture re-save: only those two changed; three#6 with the steps shorthand
and three#25 with the flat isolines options are identical).

## Verification

- `pnpm --filter occlude exec vitest run`: 1067 passed (14 new).
- Library and Studio typechecks clean.
- Docker verified build `ecb4f59-api-ergonomics` (`build.log`), served on
  5273; `verify-live.mjs` renders three#6, #16, #17, #18, #21, #23, #25 and a
  sketch using every new verb on the NVIDIA adapter (`live/report.json`).
