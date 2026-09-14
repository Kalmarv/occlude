# Procedural 3D API final report

The scoped `3dapi.md` proposal is implemented, verified and deployed to the dev
Studio. `API-REQUIREMENTS-AUDIT.md` maps every requirement to source, tests and
runtime evidence. The final correction and deployment record are in
`paper-world-depth/`.

## What shipped

- A common immutable geometry API in `occlude/3d`: raw mesh, plane, box,
  sphere, cylinder, cone, torus, polylines and curves, circle profiles,
  sweep and revolve. Generic subdivision preserves the represented surface.
- Typed point/edge/face attributes and collections, selection and grouping,
  displacement fields, frozen edit steps, deterministic IDs and provenance.
- Seeded surface sampling/scatter, shared-prototype instances, per-instance
  transforms and attributes, and explicit realization.
- Prepared nearest/ray/segment queries and reusable forces, plus explicit GPU
  modeling batches with preserved source metadata.
- A retained `view` interpretation with ordinary visible/hidden collections,
  source-aware projected strokes, selective multi-pen hatch and model sections.
- Main Studio orthographic/perspective exploration, appropriate Span/FOV
  controls, camera commit, persistence and portable download/reopen.
- Nineteen live 3D examples and three migrated sketches in the dev sketch store:
  `visibility-laboratory`, `procedural-relief`, and `paper-composition`.
- Exclusive host phase measurements for capture, queue, packing, transfer
  submission, readback, refinement and finishing, with GPU timestamps separate.

## How it fits together

Factories and modeling operations produce geometry without drawing it. `view`
captures a model and camera, extracts source features and decorations, and
classifies visible/hidden source intervals. The Studio worker uses WebGPU for
candidate interval work; uncertain numeric decisions are refined on the CPU.
The final correction retains original world triangles and affine source points
for those predicates, avoiding depth reversals introduced by camera transforms.

Projected strokes retain source identity, support and parameter ranges as they
enter the existing paper/pen pipeline. Clips, masks, labels, stroke styles,
preview, export and route planning share the existing 2D machinery. A retained
camera commit reinterprets the captured model without rerunning modeling RNG.

This includes custom geometry kernels for mesh topology/refinement, profile
construction, sampling, queries, feature/decorative curve extraction and
visibility. It is a focused drawing/modeling system, not a general CAD solid
kernel. Three.js is not required. Blender was a reference and independent
comparison tool; its source was not incorporated into the implementation.

## Final correctness result

The exact underside camera supplied by the user exposed a real bug: camera-space
rounding caused the tower to hide portions of a block bottom that was actually
in front of it. The new world-space refinement corrects that depth ordering.
Independent rational ray/box geometry now agrees with all 96 mesh edges and
1,685 hatch segments across four cameras on both CPU and served NVIDIA GPU.
All exposed bottom hatch rows remain visible.

The same fix changes one forest documentation drawing. An independent exact
ray/triangle checker found 57 incorrect old classifications and none in the
new output over 165 interval-interior samples. Only that drawing's baseline
was deliberately updated; 238 other stable examples are unchanged.

Final checks: all nine Docker build gates, seven new unit regressions, nine
analytic main Studio GPU probes, 36 hardware precision fixtures and all 19
live documentation sources pass. Church toolpath statistics and the WASM hash
are unchanged. Playwright checks use the actual Studio and a nonfallback
NVIDIA GPU; the precision laboratory is supplementary. The served origin was
checked at localhost:5273, not through an authenticated Cloudflare session.
Production container identities and all three stored demo sources were
verified unchanged by this correction.

## Limits and the user's follow-ups

- Hatch is paper-directed and surface-supported. Curvature-following hatch
  remains future work.
- Crossing surfaces do not automatically generate mesh–mesh intersection
  curves. Model-space section planes are supported.
- The partial base-grid observation is accounted for by crease selection:
  coplanar seams are not creases. `view.creaseAngle` already gives user control,
  with a 30-degree default. Broader artistic control can be revisited.
- Camera-control ergonomics remain a future discussion. Eager fixed strokes
  remain camera-bound; retained `view` drawings can be reinterpreted on commit.
- An axis-alignment rotation helper with explicit twist/reference direction
  was proposed in discussion. It has not been implemented.
- Automatic worker restart and GPU device-loss recovery were deferred by the
  user. Connected-region extrusion, inset, bevel, smooth subdivision,
  corner-domain attributes and selective refinement remain future modeling work.
- The supplied box coordinates contain a genuine one-ULP bottom separation.
  A few positive microscopic intervals therefore collapse to point paths on
  the existing paper grid. Every remaining point in the four-camera fixture
  was traced to such an interval; no blanket short-line suppression was added.
