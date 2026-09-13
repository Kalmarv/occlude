# Procedural construction and GPU deformation (M3 in progress)

The lab's **Extruded and deformed grid** scene builds an 8×8 editable polygon
grid, assigns per-face importance from stable seeded streams, extrudes separated
faces, then runs 24 GPU displacement/adjacency passes. The returned surface is
ordinary editable data. Camera orbit reuses it; visibility and paper styling
continue through the existing worker and protected-stroke pipeline.

## Modeling contracts

- `grid3` produces Z-up quads with shared topology. `measureFaces3` reports
  triangle-derived area, area-weighted center, normal and edge adjacency.
  `FaceSelection3` offers filter/map/groupBy/adjacent with exact source ownership.
- `extrudeFaces3` replaces the selected face with its translated cap and connects
  the original perimeter by side quads. It does not move shared input vertices
  or add a bottom cap. Positive distance follows the area-weighted normal;
  negative distance recesses; zero is an owned topology-free copy. Folded caps
  retain their original piecewise triangulation.
- Selection and callbacks read a captured frozen surface. Changed cap/side/point
  IDs derive from operation ID, parent ID and local ordinal. Unchanged point,
  face and edge IDs persist. Generated rows carry parent metadata; cap edges
  inherit source edge attributes. Default attribute copying treats values as
  intensive labels/scalars. Explicit `extensiveFaceAttributes` distribute each
  source face's value by resulting cap/side area, conserving the parent sum.
  Point/edge attributes are copied, not interpreted as conserved quantities.
- Simultaneously selected adjacent faces are rejected. The demo uses separated
  faces in one pass, so there are no coincident independent side walls. Repeated
  independent passes can still create coincident geometry; it is not silently
  deleted or advertised as a mesh Boolean.
- `transformSurface3` applies explicit world translation, XYZ Euler degrees,
  scale and pivot. Singular scales fail; negative determinant reverses polygon
  and triangle winding. Geometric normals are recomputed from transformed data.
- `stepsSurface3` captures frozen input each iteration and commits an owned
  result in order. History is explicitly bounded. Previous-pass selections fail
  on a new surface; positions and attributes of materialized output stay editable.

## GPU contract

`GpuDeform3` owns a reusable pipeline on the host's explicit device. Each job
captures input synchronously and uploads normalized positions, sorted original
edge adjacency (CSR), per-point displacement vectors and pins once. Every pass
reads the previous position buffer, computes a gather Laplacian plus authored
displacement, and writes the alternate buffer. No float atomics, JS callback in
WGSL, or per-point readback. One final readback materializes the CPU surface.
Pins are restored bit-exactly from the captured source. Overflow, device limits,
memory budget and invalid parameters are explicit errors; cancellation prevents
adoption. Worker scheduling and device generation follow existing lifecycle rules.

Displacement arrays can be sampled from arbitrary CPU fields before upload;
they are fixed for this batch. Iteration-dependent arbitrary JS requires an
explicit materialization boundary. This is not automatic closure compilation.

## Evidence and remaining scope

`three-model.test.ts` covers shared-grid measures/adjacency, ownership, cap and
side parentage, positive/negative closed volume, zero extrusion, extensive face
conservation, folded triangulation, mirrored transforms and frozen bounded passes.
`three-deform.test.ts` checks a known gather result, original-edge adjacency,
pins, translation equivariance and invalid/cancelled batches.

Direct Playwright `playwright-model/report.json` compares 32 GPU passes with the
CPU reference on NVIDIA Turing, verifies pins, snapshot ownership and
cancellation, then checks the 24-pass demo and orbit without modeling again.
The grouping helper was extracted unchanged from relation.ts to avoid its
material/selection import cycle when pure 3D modeling imports grouping first.

M3 is not complete: batched surface queries, point/edge selection integration,
point-cloud/polyline public factories, instance transforms and the public async
workflow remain. M2 ordered modifiers/phase and the rest of M4–M5 remain in scope.
No large-scene performance acceptance or final MVP completion claim.

Final isolated-image gates: Rust 11.0s, TS 20.6s, library types 5.3s, Studio
types 4.7s, docs 12.4s, unchanged ink 14.4s, build 36.2s, smoke 2.3s. WASM MD5
remains `c21c4ef21cb4091b6019b1aa440f6bea`. These are local Docker gates;
hardware acceptance is the separate direct Playwright run of the served bundle.
