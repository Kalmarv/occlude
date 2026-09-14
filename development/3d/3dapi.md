# Occlude: procedural 3D API redesign

Design proposal, 14 September 2026. Reviewed `dev` at [`821ea62`](https://github.com/Kalmarv/occlude/commit/821ea62a8fe3b84c584800c11d3e6b1cc9b5b446), including the supplied M0–M5 handoff and the three installed demo sources. Examples using `occlude/3d` below are **proposed API**, not code supported by that commit. This is a design pass before M6–M10, not an instruction to implement the entire future modeling catalog at once.

## Goal and decisions

Make Occlude a declarative, composable, terse, ergonomic environment for procedural drawing in three dimensions. The measure of success is the creative possibilities a short sketch unlocks: constructing forms, selecting parts, attaching attributes, repeating operations, responding to geometry, and interpreting the result as plotted ink.

The user's direction:

- Use Blender Geometry Nodes as the procedural mental model; borrow R3F/drei's approachable, reusable building blocks. A visual node editor, React, JSX, and a Three.js dependency are not prerequisites.
- Supply more useful primitives, all exposing the same ordinary geometry contracts. Artists should not assemble routine topology themselves.
- A plane is four points and one quad. Subdivision is an operation on meshes, not a capability hidden inside a special grid primitive.
- Normal sketches should not manage capture identity, triangulation, visibility flags, stroke assembly, or GPU buffers. Those capabilities remain accessible for advanced work.
- Replace public entry points such as `lineArt3` and `drawing3` with clear names and a simpler composition model.
- Fix the user's reported export visibility artifacts (described as z-fighting). The user explicitly means exported lines. Expose orthographic/perspective switching in Studio's 3D view.
- Preserve Occlude's collections, fields, attributes, frozen edit passes, forces, queries, and named-pen `stroke:` / existing `fill:` conventions.
- Own the renderer. Keep WebGPU central to execution and interactive exploration, with explicit CPU reference/fallback paths. GPU execution is an implementation strategy, not a burden placed on every geometry operation's call site.
- Preserve explicit paper, pen, seed, camera, and execution inputs. Studio edits portable libraries; sketches import complete pen models and override color. Paper supports imperial measurements and one-off values. Retain one plotting-time model and captured machine-relevant pen settings.

Blender's [fields](https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/fields.html) and [instances](https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/instances.html) are useful references for domain-dependent computation and shared geometry. R3F's [declarative composition](https://r3f.docs.pmnd.rs/getting-started/introduction) and [drei's reusable helpers](https://github.com/pmndrs/drei) inform ergonomics. These are design references; Occlude should retain its own data and rendering contracts.

## What has landed

The reviewed branch has procedural mesh data and selections; owned edits and independent-face extrusion; frozen passes; GPU deformation and surface-query batches; source-aware visibility, chaining, styling, hatch, and mesh–plane sections; retained camera exploration/commit; and portable paper/pen composition. The existing vector finishing, planning, and export pipeline remains the output path. See the [handoff](https://github.com/Kalmarv/occlude/blob/821ea62/development/3d/HANDOFF.md).

The checked-in final gate report records all gates passing. Those are implementation-team local/container results, not tests independently rerun for this design review. Automatic worker restart and device-loss recovery remain explicitly user-deferred.

The performance distinction matters: reported GPU visibility wall time is slower than CPU on all six final workloads; the actual Studio retained viewport reaches 30.4 presented FPS on the development machine. Keep optimizing end-to-end GPU work, but do not justify API choices with a visibility speedup the evidence does not show.

Remaining functional limits include independent extrusion rejecting adjacent selected faces, piecewise-planar meshes, paper-directed rather than curvature-following hatch, and plane sections rather than mesh–mesh intersection curves. The redesign must make these limits clear without making users handle the underlying plumbing.

## The proposed everyday API

Put the 3D vocabulary in `occlude/3d`: `plane`, `box`, `sphere`, `cylinder`, `cone`, `torus`, `mesh`, `view`, `orthographic`, `perspective`. The import path supplies the dimension; names do not need a trailing `3`.

Geometry factories return geometry data. Transformations and modeling operations return new geometry values. `view` is the explicit interpretation of geometry as a drawable subtree. Creating a mesh alone never draws it.

```ts
import { sketch, paper, pen, mm, inch } from 'occlude';
import { plane, sphere, view, orthographic } from 'occlude/3d';

export default sketch({
  seed: 42,
  paper: paper({ width: inch(8.5), height: inch(11), color: '#F5F0E6' }),
  margin: 5,
  pens: {
    ink: pen({ width: mm(0.3), color: '#18202A' }),
    shade: pen({ width: mm(0.18), color: '#A84932' }),
  },
}, t => {
  const terrain = plane(6, 6)
    .subdivide(5)
    .displace(p => [0, 0, t.noise(p.x * 0.7, p.y * 0.7) * 0.8]);

  const orb = sphere(0.8).translate([0, 0, 1.6]);

  return view([terrain, orb], {
    camera: orthographic({ eye: [6, 8, 5], target: [0, 0, 0], span: 8 }),
    stroke: 'ink',
    hatch: { spacing: mm(1.4), angle: 35, stroke: 'shade' },
  });
});
```

This is a proposed acceptance sketch. It needs generic subdivision and sphere generation as well as the new facade. A synchronous model-building callback can return the deferred view; Studio's async renderer performs classification later, as the current implementation already permits for a deferred 3D scene.

`view` returns something existing `clip`, groups, masks, labels, and sketch arrays can compose with. Its default ink is visible silhouettes, boundaries, and creases using a documented artistic crease threshold. Internal triangulation diagonals are not automatically ink. Hidden-line removal is internal to the 3D view; this does not silently turn the whole rectangular view into an opaque 2D mask. Existing 2D fill and opacity remain independent.

The `hatch` object declares a surface-decoration recipe. It captures the geometry version automatically and resolves physical spacing against the explicit paper/camera context later. A different pen changes ink, not the geometry source the hatch belongs to. This initial shortcut applies to the view's eligible surfaces; selective decoration uses the advanced surface/feature collections.

## Geometry and operations

### Plane and subdivision are the first proving ground

`plane(width = 1, height = width)` lies in XY, centered at the origin, facing +Z. It has four shared point records, four edges, and one quad. It has no rows/columns argument.

`mesh.subdivide(levels = 1)` adds topology while preserving the represented surface. One level turns a planar quad into four quads with shared edge midpoints and a face center. Thus a plane at level 5 has 32 × 32 quads. Budget checks must happen before allocation; exponential growth must not freeze Studio.

The operation applies to every supported valid mesh, including imported meshes, triangles, quads, and n-gons. Define deterministic refinement rules for each face type; do not implement a plane-only path under a generic name. For concave polygons, use a validated decomposition that preserves the represented surface. Shared edges must be split once and remain shared. Invalid or unsupported input must produce a specific diagnostic, not cracks or missing faces.

Subdivision does not round a box or push new sphere vertices onto an analytic sphere. Smoothing and smooth subdivision are separately specified shape-changing operations. Render-time triangulation is also separate and cannot overwrite authoring topology. Selective refinement, when added, must handle neighboring faces without T-junction cracks.

Point, edge, face, and later corner attributes need documented transfer rules. Interpolate continuous numeric values where meaningful; inherit categorical face labels; preserve original IDs and derive stable child provenance. Do not average IDs or silently reinterpret categorical values as continuous fields. Face-varying UVs/normals eventually require a corner domain rather than duplicated, disconnected mesh points.

### A useful primitive catalog

| Priority | Building blocks | Why they matter |
| --- | --- | --- |
| First slice | Plane, box, raw mesh constructor; generic subdivision | Proves the shared geometry contract on generated and custom topology. |
| Next | Sphere, cylinder, cone, torus | Immediately expands scene vocabulary and stresses smooth-looking silhouettes, seams, poles, and caps. |
| Next | 3D curves, polylines, circle profiles; sweep and revolve | Enables tubes, vessels, ribbons, lathed objects, and drawn paths through generic construction. |
| Following | Surface sampling/scatter, instance on points, instance transforms, realization | Enables forests, architecture, repeated structures, and attribute-driven populations. |
| Later modeling work | Connected-region extrusion, inset, bevel, smooth subdivision | Expands construction power without contaminating the initial API pass with a complete mesh editor. |

Primitive-specific construction parameters are legitimate where intrinsic: a circle's angular resolution or a cylinder's cap choice. Noise, displacement, hatching, and generic subdivision belong to shared operations. A sphere should not secretly retain a privileged editing model unavailable to an imported mesh.

### Collections, attributes, and steps

Use existing Occlude spellings wherever the meaning matches: `.points`, `.edges`, `.faces()`, `.filter`, `.groupBy`, `.extract`, `.attribute`, `.edgeAttribute`, and `.steps`. Add `.faceAttribute` / `.faceAttributes` for the face domain. Groups should remain selections carrying a `key`, matching the current 2D API.

Point rows expose `{ id, index, x, y, z, ...attributes }`; anonymous vectors are triples. Define reserved names and an unambiguous attribute-map access path. Do not make authors repeatedly unpack `p.position[2]` and `Number(p.attributes.height)` for ordinary typed data.

```ts
const terrain = plane(6, 6)
  .subdivide(4)
  .attribute('mobility', p => Math.max(0, 1 - Math.hypot(p.x, p.y) / 3))
  .steps(20, (current, next, k) => {
    next.move(current.points, p => [
      0,
      0,
      Math.sin(p.x + k * 0.1) * p.mobility * 0.01,
    ]);
  });
```

The proposed 3D `.steps` matches the existing frozen-pass model: reads see `current`, edits accumulate in `next`, and subsequent passes see the committed result. Preserve iteration/history semantics. `.displace(field)` is the concise one-pass displacement operation; it returns a new mesh and evaluates its field against that mesh's input points.

A field is a constant or a computation evaluated on the consuming domain. Storing its result with `.attribute` captures it; keeping a function lets another operation evaluate it on another input. Geometry fields use world coordinates. Paper hatch fields and projected-line fields use their explicitly documented domains. There is no ambient current mesh or current camera.

Extrusion deserves its own contract before introducing a short spelling. Individual-face extrusion and connected-region extrusion have different topology and displacement semantics. Preserve the current restriction until the generalized operation actually exists; never make a simple-looking `.extrude` silently reject common adjacent-face selections without explanation. Keep these operations distinct where their signatures differ.

## Own the plumbing inside the implementation

| Current friction | Proposed responsibility |
| --- | --- |
| Constructing `FaceSelection3` / `PointSelection3` / `EdgeSelection3` manually | Geometry exposes collections over one owned revision. |
| Mutating arrays and replacing a `surface` variable repeatedly | Value-returning operations and frozen edit passes. |
| Threading `sections.surface` into `hatch3`, then `hatch.surface` into the scene | Decorations reference the same owned geometry revision automatically. |
| IDs on every object, hatch family, operation, and style pass | Deterministic internal identities; optional semantic keys where persistent identity matters. |
| Packing displacement/pin arrays and matching query results by array index | Domain-aware operations accept fields/selections and retain source row identities. |
| Empty `lineSets`, bit masks, explicit stroke construction for a normal drawing | `view` supplies a default retained interpretation. |
| Knowing whether a result needs `drawing3` to support camera commit | The ordinary `view` retains its interpretation automatically. |

Make ordinary geometry values safe to reuse: two selections and two decorations made from the same value share a revision. An edit produces a new revision. Cross-revision selections receive a useful error or an explicit ID-based remap; guards must not disappear. Raw mutable geometry can enter through an explicit constructor/edit boundary that validates and takes ownership. Packed buffers stay available through the advanced API, not exposed as accidentally mutable shared state.

Automatic IDs must not depend on global counters, wall time, GPU ordering, or ambient random state. Preserve supported provenance through edits and instancing. Do not promise identity across arbitrary code rearrangement: explicit keys are available when an artist needs stable semantic identity across those changes.

## Simple drawing, inspectable line data

The renderer still exposes candidates, support provenance, visibility intervals, chains, and final strokes. Advanced users access the same data used by the convenient path.

Proposed advanced form:

```ts
return view([terrain], { camera }, lines => [
  strokes(lines.visible.filter(c => !c.kinds.has('hatch')), {
    stroke: 'ink',
  }),
  strokes(lines.hidden, { stroke: 'shade' }),
]);
```

Here `strokes` is the existing explicit ink verb, extended with a projected-curve input contract. The optional callback replaces default ink emission; it does not add a duplicate default drawing. Feature kinds are readable and can coexist on one feature. `visible` and `hidden` select classified intervals, not entire records that might contain both.

This requires real integration: projected curves must carry coordinate-space and full-source provenance through `strokes`, clipping, and supported modifiers. Do not implement the convenience API by flattening to anonymous `IsoContour` arrays and losing source dash phase, seeded style identity, support data, or the physical-paper frame. Pure factories record intent; frame-dependent conversion happens in the bound interpreter.

The callback is retained as a paper interpretation and can rerun for a new camera. It must not perform modeling, consume mutable RNG, or depend on mutable external state. Freeze/capture the scene and style inputs; ordinary JavaScript closures cannot be magically serialized or snapshotted. The built-in default avoids that callback obligation for everyday sketches.

Eager classification remains available for analysis or for modeling that intentionally depends on a view. Its results are bound to that camera and source revision; changing the camera requires reclassification or rerunning the sketch. Camera editing plus Run remains a supported workflow. The optimized Studio Commit view path must keep protecting the last committed export during exploration and failed/obsolete work.

Keep low-level visibility contracts and backend diagnostics accessible in an advanced module. Public clean names do not require immediately renaming every internal `*3` type. Avoid maintaining two independent renderers behind the old and new entry points.

## Export correctness and Studio camera controls

### Reported export visibility defect

The user reports z-fighting-like artifacts **in exported output**. This is an open correctness issue; this review has not reproduced the exact failing sketch or established its cause. A viewport depth-bias adjustment cannot establish that exported vectors are correct: export uses geometric visibility, not the construction viewport's depth buffer.

Start from the affected sketch, exact camera, paper/nib configuration, seed, export, and backend. Preserve those inputs as a regression fixture. Trace an incorrect fragment through source feature extraction, support exclusion, candidate pairing, hidden interval generation/union, chain construction, and final 2D clipping. Compare GPU and CPU results at those boundaries. Agreement alone is insufficient if both share the same incorrect predicate or support mapping; use analytically expected intervals or an independent oracle for the minimal fixture.

Relevant existing contracts are in [visibility/interval.ts](https://github.com/Kalmarv/occlude/blob/821ea62/packages/occlude/src/three/visibility/interval.ts): support surfaces are excluded by provenance, and exactly coplanar distinct geometry does not hide ink on the same plane. That is the current policy, not a diagnosis of the report. Inspect whether derived hatch/section segments carry complete support sets, especially across shared edges, before changing this policy.

Once the cause is isolated, cover the specific failure and nearby risks: nearly coplanar occluders, on-surface lines, shared-face boundaries, transformed instances, tiny depth separations, and camera clipping. Verify the affected export, then both projection modes where relevant. Preserve real thin gaps and legitimate hidden intervals; do not hide defects by increasing a global epsilon, shifting model coordinates, or suppressing every coincident line. Overlapping ink, wrong visibility, and unstable chaining are distinct possible failure classes.

Treat the fix as a focused correctness change with an explicit reason for any golden-output update. The M5 evidence remains useful, but does not override this new user-observed failure. Fixing it is a priority before adding more geometry cases.

### Projection switching

Perspective is already supported by [camera.ts](https://github.com/Kalmarv/occlude/blob/821ea62/packages/occlude/src/three/camera.ts) and the retained GPU viewport. The reviewed main Studio [constructionPanel.ts](https://github.com/Kalmarv/occlude/blob/821ea62/packages/occlude-studio/src/three/constructionPanel.ts) exposes scene selection, reset, copy, and commit, but no projection selector. The laboratory page has one. Add the control to the actual Studio workflow.

- Show Orthographic / Perspective, plus orthographic span or perspective vertical FOV as appropriate. The selector reflects the selected scene's current exploration camera.
- Preserve target, viewing direction, up vector, and apparent scale at the target plane when switching. For target distance `d` and vertical FOV `f`, equivalent orthographic span is `2 * d * tan(f / 2)`; convert degrees explicitly. On first switch to perspective, choose a documented FOV and adjust eye distance to preserve that span. This preserves framing at the target plane, not every depth in the scene.
- Keep valid near/far bounds and account for changed eye distance without unexpectedly clipping the scene. Defaults can derive from captured bounds; intentional explicit clipping must remain expressible and must not be silently rewritten by ordinary orbit.
- Orbit, zoom, picking, copy, reset, and scene switching work in both modes. Switching projection reuses captured geometry and consumes no modeling randomness.
- Exploration does not change exported ink until Commit view. Commit persists the projection and its parameters into the sketch camera configuration, reruns the correct view-dependent visibility/hatch interpretation, and updates the committed export. Download/reopen preserves the choice; editing camera code and rerunning remains valid.

Verify switching and committing in main Studio, including stale-request rejection. A passing laboratory projection test alone does not cover the missing interaction.

## Queries, forces, instances, and WebGPU

Prepared spatial queries should follow the existing `query` mental model: prepare the target once, then ask nearest/ray/segment questions or apply a batch to a selection. Return source identity with every batch result, including misses. Separate world-distance from ray/segment parameter `t`; avoid today's overloaded `distance` meaning.

Nearest-surface projection is not volume containment. A reusable constraint such as keeping points below a plane needs explicit directional/sided semantics. Do not bury the relief demo's special Z comparison inside a generic collision API.

Retain arbitrary JS callbacks for CPU modeling and frozen `.steps`. Prepared forces can be reused and evaluated against each iteration's current points. GPU batching accepts supported operation descriptions, field samples, selections, and packed input through the lower-level path. The current deformation kernel reapplies supplied displacement samples per iteration; it does not reevaluate an arbitrary JS field on the GPU. Preserve that distinction.

The normal view should schedule GPU work without sketch authors acquiring devices or awaiting each renderer stage. Explicit asynchronous boundaries remain appropriate when GPU-computed modeling data must be read by subsequent JS. Do not introduce hidden synchronous readbacks or claim all fluent chains compile into shaders. A field compiler/graph planner is a separate architectural investment.

Instances should share prototype geometry until an operation requires unique topology. Per-instance transforms and attributes must not force duplication. Make realization explicit, following the useful distinction illustrated by Blender's [Realize Instances](https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/instances/realize_instances.html). Mesh-only and mixed geometry collections need honest typed capabilities; a curve should not pretend to have editable faces.

## Implementation order and acceptance

0. **Export correctness and missing camera control.** Reproduce and fix the reported exported-line defect with its own regression fixture. Add the main Studio projection switch using the existing camera/viewport support. Keep these changes independently reviewable from the API redesign.
1. **Contract and example pass.** Settle the proposed imports, geometry domains, edit ownership, `view`, and projected-curve carrier. Write three acceptance sketches: terrain, instanced forms, and a paper composition with selectable hatch/hidden lines. Mark future capabilities explicitly. Keep the current renderer underneath.
2. **First working slice.** Deliver four-point `plane`, the common mesh facade, generic shape-preserving `subdivide`, displacement/steps integration, and the default `view`. Prove subdivision on a box and custom mixed-face mesh as well as the plane. This is the first useful deliverable, not a rename-only PR.
3. **Primitive expansion and advanced interpretation.** Add sphere/cylinder/cone/torus through the same mesh contract; expose readable line collections and provenance-preserving `strokes`; remove capture/flag boilerplate from the three M5 demos. Keep complex extrusion behavior unchanged until implemented deliberately.
4. **Query/GPU ergonomics and repetition.** Add prepared query/batch facades, reusable force integration, instance-on-points helpers, and explicit realization. Measure serialization, transfers, refinement, and readback separately from shader time. Avoid turning this pass into a GPU renderer rewrite.

Acceptance includes immutable reuse and selection ownership; point/edge/face attribute transfer; shared topology and no accidental triangulation ink; intentional world/paper units; named pens and imperial paper; source dash/style continuity; camera-only updates without model RNG; multiple views without ambient state; CPU/GPU agreement within the existing precision policy; and unchanged committed exports on failed/obsolete work. Use existing Docker gates for implementation changes and document deliberate ink differences. Do not silently replace golden fixtures.

The API passes its creative test when a user can change `plane(...).subdivide(...)` to another mesh source and keep the downstream selection, attribute, deformation, query, and drawing workflow. Primitive convenience and low-level access must meet at that same geometry contract.

