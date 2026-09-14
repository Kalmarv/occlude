# M6 intersection construction — work in progress

Base commit: `6ab53b6b807ae82f9612a0e9ee29272ea3d71714`.
This checkpoint delivers automatic intersection construction and its ordinary
authoring API. It does not complete the full M6/M7/selected-M8 assignment.
All nine Docker gates passed. Dev serves stamp `6ab53b6-intersections`;
`deployment.json` identifies the image. Playwright checked the changed example
and the existing instance example through Studio imports, Monaco, SVG export and
a nonfallback NVIDIA GPU. `crossing-forms` is saved in the isolated dev sketch
store and its source readback matches the documented example.

The implementation now composes world BVH preparation, exact triangle contacts,
segment arrangement, contact classification, chain assembly and graph validation.
The synchronous and asynchronous paths share generator stages; the latter yields
real event-loop tasks and checks cancellation before returning a complete result.
Capacity limits cover input geometry, candidates, contact coordinates, raw
segments, split events, support memberships and output graph topology.

`triangle-oracle.py` uses Python Fraction without importing Occlude. Its 300
fixtures derive contact from contained vertices and edge intersections, followed
by a hull, independently of the runtime triangle clipping/plane-cut algorithm.
It includes coplanar and transverse triangles at different binary scales. Generate
with:

```sh
python3 development/3d/intersections/triangle-oracle.py --fixtures > packages/occlude/test/fixtures/triangle-contacts.json
```

Focused tests live in:

- `box-oracle.py` is an independent Fraction oracle for 40 deterministic
  axis-aligned box cases, including offsets, identical boxes, disjoint/nested
  surfaces, tangencies, one-ULP gaps and uniform binary scales. Generate with:

  ```sh
  python3 development/3d/intersections/box-oracle.py --fixtures > packages/occlude/test/fixtures/intersection-boxes.json
  ```

- `three-intersection-box-oracle.test.ts`: compares exact rational segment
  coverage and isolated points against all 40 generated cases. Result: 1 test
  passed (40 fixtures).

- `three-triangle-contact.test.ts`: the independent exact triangle oracle and
  contact winding/input-order checks.
- `three-intersection-contacts.test.ts`: validated topology, closed spatial
  bounds, cache ownership, candidate reduction, capacity limits and cancellation.
- `three-arrangement.test.ts`: overlap membership, exact crossings, skew lines,
  separate partitions and tiny positive separation.
- `three-intersection-atoms.test.ts`: complete axis-aligned patch boundary
  coverage, absence of triangulation diagonals, point/edge/transverse contacts,
  both-source supports and genuinely coincident disconnected sheets.
- `three-intersection-graph.test.ts`: chains, loops, branches, collinear split
  identity, isolated contacts and equivalent synchronous/asynchronous graphs.

The existing graph/render regression suites also pass after making graph
validation yieldable. Luna agents performed bounded reviews and authored focused
checks under the user's authorization. No broad gate, performance, browser or
production claim follows from these focused results.

The ordinary `intersections(a, b)` factory and `await t.intersections(a, b)`
entry accept meshes or instance sets. Edges expose typed contact attributes
through ordinary collections. Placement subsets, key changes and attribute edits
retain actual ownership; transforms create new placements. The bound operation
captures inputs before yielding and checks execution scope again before adoption.
CPU and queue timings and construction counts are recorded with modeling stats.

The live `three#24` example intentionally replaces verbose advanced graph assembly
with two crossing boxes and a generated seam. All other docs ink hashes and
church routing remain unchanged. `ink-change.json` records the deliberate change.

Remaining before full M6 delivery: curve resampling/query/adjacent-region/trace
consumers, broader oblique mesh-level and rendered visibility evidence, and the
style-phase audit. Chain IDs omit collinear support splits, but the renderer's
stroke seed still derives from its constructed reference ID; connect and verify
that identity before claiming retessellation-stable style phase. Full Studio
workflow/persistence and benchmark acceptance also remain required. The full
M7/selected-M8 scope in `../3dpt2.md` is unchanged.


Verification commands (from the isolated checkout unless noted):

```sh
OCCLUDE_BUILD_STAMP=6ab53b6-intersections docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev build dev
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev up -d dev
# From packages/occlude-studio:
DISPLAY=:93 OCCLUDE_API_EVIDENCE=../../development/3d/intersections/live node --input-type=module < ../../development/3d/intersections/verify-live.mjs
```

`build.log`, `live.log`, `church.log` and `live/report.json` retain the evidence.
The screenshot in `live/example-24.png` was visually inspected. Broader camera,
construction-picking, save/download/reopen and G-code acceptance remain part of
the full assignment; this targeted check makes no claim to finish that audit.
