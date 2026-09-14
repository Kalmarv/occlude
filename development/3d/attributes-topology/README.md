# Attribute edits and mesh topology checkpoint

Scope: one additional shared-data/API slice for `3dpt2.md`. M6/M7/M8 are not
complete. Source starts at `44b6f55`; tested build stamp is
`44b6f55-attributes-topology`. Only isolated dev service/port 5273 is used for
this checkpoint.

Implemented:

- Multi-column field maps for mesh/curve/point/sample point attributes, edge
  maps, and face maps alongside the compatible face-patch callback. Initializers
  read one incoming revision; point transfer policy is preserved unless replaced.
- Initialized point/edge/face attribute writes in frozen passes, partial-record
  merge, last-write-wins, accumulated movement, operation-wide validation before
  writes, async rejection and editor/revision ownership checks. State literals
  widen at the pass boundary; value kinds and numeric vector dimensions persist.
- Point/sample `.steps`, transforms and typed history. Sample interpretation is
  captured provenance; point motion does not implicitly rebind it to a surface.
- Typed mesh incident-domain rows/collections, neighbors, connected expansion,
  induced components and selected-region boundary edges. Selection algebra and
  groups retain their concrete capabilities and key metadata. Disconnected or
  vertex-touching face sheets are not treated as edge-connected.
- Weak topology tokens/adjacency reuse across motion and state edits; fresh
  measurements/rows after each geometry revision. Mutable advanced surfaces
  revalidate topology. Relationships are nonenumerable, and face attribute
  vectors use the owned frozen values.
- Existing query/force demo now captures two result fields in one attribute map
  and selects shaded faces with `f.points.some(...)`, without ID lookup maps.
  New live `three#20` demonstrates evolving point state.

Validation records are adjacent to this file. Existing 240 stable docs hashes
are unchanged; only `three#20` is added (241 stable, two unstable). Church stays
15,601 chains / 96,037 mm draw / 16,515 mm travel / 381.0 minutes / bridge 0 /
Euler 15,593 / coincident 18.1 mm. WASM remains
`8bf0034cb79606aa8d6c7293496a1b7e`.

Development found and corrected two ownership issues before publication: the
editor's temporary edge-attribute carrier initially lost its topology token;
face measurements initially exposed shallow-cloned attribute vectors. Tests
assert adjacency object reuse and frozen nested face vectors, respectively.

Remaining assignment scope includes orientation, corner attributes/edits and
transfers, owned surface locations/multi-source support, intersections, UV
mapping, generic surface tracing/tone/GPU evaluation, connected-region
extrusion, complete acceptance demos, and full integration/performance proof.
See `../M6-M8-PROGRESS.md`; this checkpoint does not redefine completion.

Served verification passes: 21 main-Studio live examples (Monaco, SVG paths,
nonfallback NVIDIA Turing adapter), four saved paper/box cameras with maximum
interval error 0, and nine independent world-depth probes. See `live/`, `paper/`
and `world-depth/`. All nine Docker gates pass in `docker-build.log`. The dev
sketch store hashes remain unchanged before/after this checkpoint.

Reproduce from the isolated checkout:

```sh
OCCLUDE_BUILD_STAMP=44b6f55-attributes-topology docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev build dev
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev up -d dev
cd packages/occlude-studio
DISPLAY=:93 OCCLUDE_API_EVIDENCE=../../development/3d/attributes-topology/live node tools/verify-three-live.mjs
DISPLAY=:93 OCCLUDE_PAPER_FIXTURE=../../development/3d/paper-world-depth/after OCCLUDE_API_EVIDENCE=../../development/3d/attributes-topology/paper node tools/verify-paper-box-oracle.mjs
DISPLAY=:93 OCCLUDE_API_EVIDENCE=../../development/3d/attributes-topology/world-depth node tools/verify-world-depth.mjs
```

The paper oracle needs `paper-world-depth/after/oracle.json` locally; decompress
its tracked `.gz` when reproducing in a fresh checkout. Large captured JSON
outputs here are also stored compressed.
