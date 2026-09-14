# Rotation values and model-space point grids

Shared API checkpoint for `3dpt2.md`, starting at `2bda97a`. M6/M7/M8 are not
complete. Build stamp: `2bda97a-orientation-grid`; isolated dev port: 5273.

`axisAngle` and `alignAxis` return immutable quaternion-backed values. Geometry,
point/sample/curve rotations and instance rotate fields accept them directly;
serialized rotation data remains quaternion data, with no mandatory Euler round
trip. Existing Euler inputs keep the original sequential XYZ arithmetic.
`then` composes in application order, `inverse` undoes the rotation, and `apply`
rotates anonymous vectors or point rows about zero. Geometry pivots remain the
explicit `.rotate(value, origin)` argument. Instance order remains scale,
rotation, translation, with mirrored winding preserved by negative scales.

Alignment supports paired local/world references, world-axis twist, and previous
orientation transport. The default shortest turn uses a fixed local reference
for exact antipodal directions; it does not choose a new reference axis at each
sample based on the target's largest component. A stateless convention has an
antipodal singularity; callers following a sequence can transport the preceding
frame. Degenerate directions/references and conflicting previous/up constraints
are diagnosed. Near-antipodal half-angle evaluation retains tiny transverse
components even when the dot product rounds to -1.

User-requested `grid({cols, rows, layers?, spacing?, maxPoints?, key?})` produces
ordinary centered point geometry with i/j/k attributes. It replaces the 36-site
example's modulo/index arithmetic exactly, including row order, coordinates,
IDs and rendered ink. Spacing is in model units. This reuses the familiar cols/
rows vocabulary while keeping `t.grid`'s paper-cell behavior separate.

The existing sampled-tree example (`three#16`) deliberately changes its ink:
normal alignment now uses a shortest turn instead of Euler tilt plus azimuth
roll. The octagonal tree cross-sections therefore have different roll around
their axes. The new `three#21` demonstrates up-constrained alignment, twist and
axis-angle modeling. All other 240 existing stable examples retain their hashes;
there are now 242 stable entries and two unstable examples. Church remains
15,601 chains / 96,037 mm draw / 16,515 mm travel / 381.0 minutes / bridge 0 /
Euler 15,593 / coincident 18.1 mm.

Eight orientation tests cover axis/composition/inverse/serialization, parallel
and antiparallel cases, very large and tiny directions, references/twist, normal
field continuity, transported frames, invalid inputs, pivots and mirrored
nonuniform instance realization. Three grid tests cover exact old-layout parity,
layers/spacing/metadata and invalid dimensions/capacity. Existing geometry and
instance regressions also pass. Served/build verification records are stored
alongside this file when complete.

Concept references (no external implementation code copied):

- [Houdini dihedral](https://www.sidefx.com/docs/houdini/vex/functions/dihedral.html): vector-to-vector rotation as a matrix/quaternion value.
- [Houdini maketransform](https://www.sidefx.com/docs/houdini/vex/functions/maketransform.html): explicit axis/reference frames and degree-valued transform boundaries.

Next shared foundation: generic corner attributes/edits/transfers and owned
surface locations with multi-source curve support. Full intersection, mapping,
tracing/tone/GPU evaluation, region extrusion and acceptance/integration scope
remains required.

Served verification: all nine Docker gates pass; 22 main-Studio examples pass
Monaco/import/GPU/SVG checks on a nonfallback NVIDIA Turing adapter. The four
paper-box cameras retain maximum interval error 0, and nine world-depth probes
pass. The dev sketch store is unchanged. Screenshots include the grid, sampled
trees and rotation example in `live/`; raw large paper reports are compressed.
Log files preserve tool output with trailing whitespace trimmed.

From the isolated checkout, reproduce with:

```sh
OCCLUDE_BUILD_STAMP=2bda97a-orientation-grid docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev build dev
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev up -d dev
cd packages/occlude-studio
DISPLAY=:93 OCCLUDE_API_EVIDENCE=../../development/3d/orientation-grid/live node --input-type=module < ../../development/3d/orientation-grid/verify-live.mjs
DISPLAY=:93 OCCLUDE_PAPER_FIXTURE=../../development/3d/paper-world-depth/after OCCLUDE_API_EVIDENCE=../../development/3d/orientation-grid/paper node tools/verify-paper-box-oracle.mjs
DISPLAY=:93 OCCLUDE_API_EVIDENCE=../../development/3d/orientation-grid/world-depth node tools/verify-world-depth.mjs
```

Decompress `paper-world-depth/after/oracle.json.gz` for a fresh checkout before
running its oracle. The live verifier derives from `verify-three-live.mjs` and
adds a build-stamp assertion and screenshots for examples 12, 16 and 21.
