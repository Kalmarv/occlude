# Owned curves and the ordinary view

`polyline`, parameter-sampled `curve` and polygonal `circle` profiles share the
existing CurveGeometry returned by mesh-edge extraction. Curves own only points
and edges; extracted curves drop faces and unused points while preserving IDs,
attributes and edge provenance. Closed paths share their seam point. Factories
validate counts and budgets before sampling/allocation and reject zero-length
segments rather than silently changing connectivity.

Curves support typed point/edge attributes, selections/extraction, world-space
transforms, displacement and frozen steps/history. Curve steps bind selections
to the same point-edit engine used by mesh steps, with revision and expired-editor
guards. The surface snapshot/transform path now preserves loose authoring edges.
Feature extraction classifies those edges as ordinary wires with shared endpoint
IDs and edge attributes. `view` accepts mixed mesh/curve/instance arrays and skips
surface hatch recipes for curves. No extra renderer or visibility kernel exists.

Six focused tests cover ownership, shared seams, typed attribute/ID transfer,
transforms, frozen history and selection guards, sampling/budgets, analytic
box/wire intervals and retained camera commit without model resampling. The main
Studio Playwright verifier checks hardware GPU rendering, clean Monaco types,
number-to-string rejection, rejection of a curve face domain, projection commit,
portable reopen, and analytic wire visibility in both projections.

The oracle is the line (-2,0,-1) to (2,0,-1) behind a unit box at the origin,
viewed from (0,0,5). The hidden interval is [3/8,5/8] orthographically and
[1/3,2/3] perspectively. These expected values come from ray/box geometry, not
CPU/GPU agreement alone. The live example combines a box, helix, circle profile,
stepped polyline and extracted box-edge frame. Its camera span is 9.5 so the frame
fits portrait paper as well as the square docs canvas.

Only three#14 adds a docs ink baseline; all 234 earlier entries are unchanged.
Church routing before/after remains 15,601 chains, 96,037 mm draw, 16,515 mm travel,
381.0 minutes. All nine Docker gates and all fifteen served live examples pass.
Source and served Studio evidence both pass the two analytic GPU oracles,
camera commit/download/reopen, and positive/negative Monaco checks.

```sh
DISPLAY=:93 OCCLUDE_API_EXAMPLE=curves \
OCCLUDE_API_EVIDENCE=../../development/3d/curves-api/served \
pnpm --filter occlude-studio exec node tools/verify-mesh-api.mjs
```

Sweep/revolve, M5 demo migration, dedicated paper acceptance and phase timing
remain separate unfinished requirements. The fresh paper-composition underside
report is recorded in ../paper-depth/; its static screenshots alone do not prove
flicker or establish the cause of an exported-vector defect.
