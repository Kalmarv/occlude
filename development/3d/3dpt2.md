# Occlude: M6–M7 surface drawing and selected M8 foundations

Implementation handoff for Codex · 14 September 2026

## 1. Assignment and intended outcome

Implement this batch in the isolated development checkout/container. Finish the small remaining API consistency pass, implement M6 surface intersections, deliver M7 surface drawing and surface-mapped patterns with Krbn-style tonal and curvature-following hatch, and add the selected M8 foundations and connected-region extrusion described below.

The outcome is a procedural drawing environment in which an artist can construct geometry, select and edit parts, generate or map marks on its surfaces, and turn those marks into a plotted drawing through Occlude's own renderer. Surface drawing is the main creative payoff of this batch. Deliver usable sketches and editable geometry, not only internal kernels or an API showcase.

This is one implementation assignment with internal checkpoints. Progress through its required scope without treating each checkpoint as a separate user approval request. Resolve routine implementation choices against the repository's design laws and this spec. Preserve existing user work and development isolation. Do not deploy to production or operate a plotter.

The reviewed baseline is `dev` at `000c9cb0e86af431ee48e4b8a3129d7fcf23e52c`. Fetch the latest `dev` before starting; inspect intervening commits, especially any orientation helper added since this review. Integrate existing work rather than implementing it twice. Record the exact starting and final commits in the handoff.

Read `CLAUDE.md`, any applicable `AGENTS.md`, `development/3d/API-CONTRACT.md`, `API-REQUIREMENTS-AUDIT.md`, `FINAL-REPORT.md`, `paper-world-depth/README.md`, `docs/three.md`, and relevant tests before editing. The earlier M0–M5 handoff is historical context, not the current capability list.

## 2. User motivation and decisions

The user wants declarative, composable, terse, ergonomic creative coding. Blender Geometry Nodes and Houdini are the procedural mental models; R3F/drei are references for approachable, reusable building blocks. Existing Occlude steps, selections, fields, forces, and queries should carry naturally into 3D.

The artist should express what to make and how it should behave. They should not repeatedly assemble topology arrays, pack GPU input, match query results by index, thread captured surface objects, or derive orientation matrices by hand. Low-level data and operations must remain accessible when needed.

Do not respond by creating a helper for every example. Audit and reuse the existing vocabulary first. In particular, **use `t.times` for repetition instead of adding a competing repetition helper to replace `Array.from`**. Existing map/ease/noise, collections, curves, units, image sampling, and stroke tools are assets to extend. Arrays remain valid for vectors and explicit collections. A callback is useful when it evaluates a value on a point, face, curve, instance, or surface location; wrapping a static array in a zero-argument callback is not an API improvement.

Other settled decisions:

- Own the line renderer and keep WebGPU important in execution and interactive exploration.
- Use clean everyday imports from `occlude/3d`; preserve `view` and ordinary `strokes`. Keep low-level `*3` machinery in the advanced layer.
- Geometry creation does not implicitly draw. Geometry and derived marks remain inspectable data.
- A plane remains four points and one quad. Generic subdivision remains shape-preserving. It is distinct from smooth subdivision and from primitive tessellation resolution.
- Preserve named-pen `stroke:` and existing `fill:` conventions. Complete pen models carry width/feed/delay settings; color remains an instance option. Do not split pens into competing logical/physical definitions.
- Explicit paper, pens, seed, camera, assets, and execution context determine the result. Support imported libraries and one-off paper/pen values, including imperial paper. No ambient current scene, camera, material, light, UV map, or RNG.
- Fill and opacity remain independent. Surface shading does not silently change a mesh's occlusion role or create an opaque paper rectangle.
- Preserve the distinction between camera exploration and committed vector output. Editing camera code and rerunning is also a supported workflow.
- Saved results retain their committed output/settings; downloaded sketches retain enough inputs to regenerate. Do not depend on newly edited external libraries when reopening a result.
- Keep one plot-duration estimator. Raster-only appearance or variable simulated pen widths cannot substitute for plot-realizable output.

## 3. Authoritative milestone scope

The user supplied this roadmap. Do not renumber it or invent an M10 deliverable.

| Roadmap area | Required in this batch | Left for later |
| --- | --- | --- |
| API cleanup | Existing-tool reuse; selection/step parity; query-result consumption; orientation and topology access; ordinary docs/examples | A new general lazy graph compiler or visual node editor |
| M6 — Surface intersections | Mesh–mesh intersection curves, both-source attribution, contact policies, chaining, construction access, visibility and styling | Using intersections to split/reconstruct solid topology |
| M7 — Surface drawing | Surface locations and coordinates, corner UVs, mapped vector patterns, tangent fields, tracing, surface spacing, curvature-following hatch, tonal density, crosshatch, scalar isolines | Automatic arbitrary-mesh UV unwrapping, exact analytic smooth-surface renderer, suggestive contours |
| Selected M8 — Procedural modeling | Adjacency, domain-aware attribute transfer, editable attributes in frozen steps, connected-region extrusion, preservation through existing subdivision | Inset, bevel, smooth subdivision, selective refinement, general remeshing |
| M9 — Cutting/reconstruction | Preserve useful source/support information for a future implementation | Surface splitting, capping arbitrary cuts, robust Booleans |
| Ongoing stroke vocabulary | Curve resampling and trimming needed for mapped/traced marks; supported deterministic variation through the existing pipeline | General extension, repeated sketch-stroke machinery, bounded fitting, importance-based abstraction unless already available |

These are concrete completion boundaries. Do not replace M7 with more paper-space hatch presets or a future-facing interface. Do not declare all of M8 or M9 complete. Connected-region extrusion belongs in the batch but must not make surface drawing wait for an entire modeling suite.

## 4. Starting point and implementation seams

The current branch already has immutable meshes, common primitives, shape-preserving subdivision, curves/profiles, sweep/revolve, sampling/scatter, shared-prototype instances, prepared queries, CPU forces, explicit GPU batches, retained views, surface-supported paper hatch, model-plane sections, projection switching, and source-aware output planning.

| Existing area | Reuse or extend |
| --- | --- |
| `packages/occlude/src/three/api/mesh.ts`, `collection.ts`, `instances.ts` | Geometry revisions, domain rows, edit passes, selections, instance provenance |
| `three/geometry/surface.ts`, `model.ts`; `api/subdivide.ts` | Authoring polygons and fixed render triangulation, ownership, topology/attribute transfer |
| `api/query.ts`, `force.ts`, `sampling.ts` | Prepared targets, source-linked batches, reusable fields, triangle/barycentric sample locations |
| `three/curves/surface.ts`, `plane.ts`, `section.ts`, `hatch.ts` | Surface-supported source curves, exact incidence, section construction; generalize beyond one surface and `section|hatch` |
| `three/features/snapshot.ts`, `visibility/scene.ts`, `interval.ts`, `worldInterval.ts` | Feature capture, candidates, original-world refinement, support exclusion and interval unions |
| `api/view.ts`, `projected.ts`, `three/strokes/*` | Retained interpretation, full source references, readable visible/hidden collections, pen interpretation |
| `compute/webgpu/*`, `three/timing.ts` | GPU host lifetime, batched execution, retained resources, exclusive phase measurements |
| Studio runner/editor/worker and `three/constructionPanel.ts` | Imports, Monaco, async execution, camera controls, adoption/cancellation, persistence |

Current hatch curves already lie on surfaces. Their ruling direction and spacing originate in paper coordinates. Preserve that useful mode while adding **surface-originated** curves and mappings. Do not rewrite the renderer to achieve this.

The current export correction preserves original world triangles and affine source locations for robust depth decisions. Its independent ray/box and ray/triangle fixtures are non-negotiable regression coverage. Never solve new on-surface artifacts with a global epsilon, blanket short-line suppression, or an offset that changes model coordinates.

## 5. API cleanup: make existing concepts compose

### 5.1 Audit before adding names

Create a short contract table mapping each proposed operation to existing 2D and 3D capabilities. Reuse a name when its semantics match. Add a new operation only for a distinct missing capability. Update the existing topic docs; lead `docs/three.md` with ordinary `occlude/3d` examples and move advanced mechanics later in that page.

Keep examples readable. Terse authoring does not mean compressed, multi-statement lines or hidden contracts. Remove ordinary-example uses of raw geometry mutation, manual query-result maps, feature bit masks, and explicit surface snapshot threading where the new API can carry that work.

### 5.2 Collections and topology relationships

Bring 3D collections into parity with existing meaningful selection operations: `find`, `some`/`every` where consistent, membership, `union`, `intersect`, `subtract`, and `complement`. Set operations require the same source revision and domain. Preserve deterministic source order, IDs, and typed attributes; do not silently remap a selection from another mesh.

Expose domain relationships without forcing index arithmetic: a face's points/edges, an edge's incident faces/endpoints, connected points/faces, and connected components of a face selection. Return normal collections wherever possible. Audit existing 2D relationship spellings first. Cache adjacency by immutable topology revision; point motion need not rebuild topology, while topology edits invalidate it.

Raw indices remain available for advanced kernels. Ordinary fields should be able to ask about incident geometry directly.

### 5.3 Frozen edit passes and attributes

Extend the current 3D editor beyond `next.move`. Add the existing-style attribute update operations for point/edge domains and a consistent face/corner equivalent. Make point geometry participate in frozen `.steps` and ordinary transforms wherever meaningful; retain richer sample provenance through those operations.

Each pass reads one frozen input. Batched edits do not change subsequent reads within the same pass. Attributes needed for evolving state should be initialized before stepping so their types are stable. Define merge/conflict behavior by matching 2D semantics where applicable. Reject asynchronous step callbacks and escaped editors as today. Preserve iteration and history behavior.

Audit multi-attribute initialization too: use the existing field-map spelling where the meaning matches, and ensure every initializer reads the same incoming revision. Do not make artists relearn a different callback/container convention for each geometry domain.

### 5.4 Query results as reusable inputs

Replace normal sketches' `new Map(results.map(...))` bookkeeping with a source-bound result collection that can expose a field and source selections. Keep every source row, including misses. A field adapter evaluates an already captured result; it must not dispatch a new GPU query per point.

Illustrative target:

```ts
const hits = await query(roof).batch(t).nearest(terrain.points);
const shaded = terrain.attribute(
  'distance',
  hits.field((point, hit) => hit?.distance ?? 10),
);
```

Retain the current explicit async boundary, scalar CPU query path, distance-versus-parameter distinction, and prepared-target cache. Field adapters validate their source revision; provide an explicit documented remap/attribute-capture route when the caller intentionally moves to another revision. Matching an ID alone is not proof that an old spatial answer is valid on edited geometry.

### 5.5 Rotation and orientation

Inspect any newly landed helper first. Supply coherent operations for rotating around an axis and aligning a local axis to a direction, with reference/up direction and twist when needed. These are distinct geometric questions. They should work as values/fields for geometry, curve frames, and instance transforms without user-authored Euler conversions.

Use degrees at the public boundary to match Occlude. Define composition order, local/world space, and origin pivot. Internally use a stable rotation/frame representation; conversion to legacy Euler storage must not become a loss-prone mandatory round trip. Handle parallel, antiparallel, and degenerate inputs deterministically. A smooth direction field must not acquire arbitrary roll flips at a coordinate-axis boundary. Expose existing vector operations in the 3D vocabulary as needed, accepting point rows or anonymous triples.

## 6. Shared surface-location and curve contracts

Implement a shared contract before building separate intersection and hatch implementations.

### 6.1 Surface locations

An internal surface location contains an owned mesh revision, placement identity where applicable, original triangle/face identity, barycentric or equivalent affine source coordinates, and explicit coordinate interpretation. World position is derived from that source. Keep exact construction/provenance information required by `worldInterval.ts`; rounded GPU positions are not authoritative source data.

Expose a convenient field context: current position, geometric normal, optional smooth normal, UV/chart coordinates, tangent frame, typed interpolated attributes, and source identity. State which values are model, world, or chart coordinates. The artist does not need to construct this record.

Do not conflate a position, a direction, and a normal under transforms. Use the appropriate normal transform for nonuniform scale and preserve orientation under mirrors. Geometric normals/support drive visibility; an interpolated normal used for shading does not replace the actual surface.

### 6.2 Supported curve data

Generalize the current supported-curve carrier so a segment can reference one or more source surfaces and placements. Intersections need support from both participating meshes. Mapped and traced curves need their actual surface support. Curve points/edges, attributes, chain identity, and uncut source parameters remain inspectable.

Split segments whenever their support triangle/chart changes. Geometrically coincident endpoints may share a chain node while retaining distinct per-segment support locations. UV seam values must not be collapsed merely because their world positions match. At a branch, retain a graph rather than inventing a continuous path through unrelated branches.

Do not grant self-occlusion exemption by user labels or whole object IDs. Validate source ownership and segment incidence. Exempt only actual supporting triangles; other faces on the same mesh can still occlude a curve. The two-source case must protect a legitimate intersection seam without exposing ink behind the rest of either object.

Surface-bound data follows the exact geometry revision it was computed on. For topology-preserving deformation, provide explicit rebinding through retained face/vertex identity and barycentric coordinates. Do not mutate previously captured curves when a mesh changes. For topology changes, use the operation's explicit transfer map or regenerate with a useful diagnostic. Never silently project to the nearest unrelated surface.

### 6.3 Placement and instancing

Separate prototype-local attachment from world-space queries involving placements. A pattern on a prototype can be repeated with instances; an intersection between two world placements depends on those placements. A prototype revision alone is insufficient to identify the latter.

Convenient APIs must bind these automatically for unambiguous inputs. If one prototype appears at several placements, require or supply explicit placement-bound inputs rather than associating curves with whichever matching object appears first. `view` must accept the resulting supported curves alongside meshes/instances. Reuse prototype geometry where valid; do not require realization for ordinary mapped shading. An explicit realization path can be used for construction queries that currently require a world mesh, with documented cost.

## 7. M6: mesh–mesh intersection curves

Provide a generic operation, provisionally `intersections(a, b)`, over the supported mesh/placement inputs. It returns construction geometry with both-source attribution; it does not split either mesh or perform a Boolean. Input authoring topology is unchanged.

### 7.1 Algorithm and robustness

- Use spatial bounds/BVH candidate generation in world geometry. Do not compare every triangle pair unconditionally.
- Compute the actual intersection of represented triangles, retaining support and source parameters on both sides. Reuse robust predicates and original-world refinement. An f32 hit is only a candidate unless its classification is certified.
- Canonicalize shared-edge/vertex constructions so neighboring triangle pairs produce the same endpoint relationships. Chain using topology/provenance and robust constructions, never screen-distance welding.
- Deduplicate pieces introduced by triangulation. Preserve genuine disconnected components, closed loops, branches, and tiny positive geometric separations.
- Support open and closed valid meshes within the existing mesh validity contract. Reject invalid topology explicitly rather than repairing it invisibly.
- Budget candidates, intermediate contacts, segments, and output topology before unbounded allocation. Make expensive work cancellable at meaningful boundaries and report capacity errors without replacing the last committed drawing.

### 7.2 Contact policy

Document and test transverse intersections, tangent points, shared edges, and coplanar overlap separately. Transverse contacts produce curve segments. Isolated point contacts are point/contact data, not invented zero-length strokes. Coplanar area overlap has no unique interior intersection curve: expose overlap-boundary contact curves/metadata and avoid drawing triangulation diagonals. Default ink should distinguish or intentionally select the contact classes; do not silently claim coplanar input is disjoint.

Canonical geometry should be invariant to input order, triangle ordering, and equivalent retessellation within the stated representation/tolerance contract. Source labels may swap when arguments swap; the geometric answer should not. Closed contact curves must close topologically, not merely appear closed after paper snapping.

### 7.3 Rendering and construction reuse

Register a readable intersection feature kind and source attributes. Feed intersections through ordinary classification, visible/hidden interval selection, stroke interpretation, modifiers, and planning. Preserve complete source phase through occlusion and cropping.

The result must also be usable for curve resampling, queries, selecting adjacent regions, and surface-trace seeding. Do not return an opaque render-only node. Retain the information M9 will need, without implementing cutting/capping/Booleans in this batch.

## 8. M7: surface coordinates and mapping

### 8.1 Corner-domain attributes

Add a face-corner domain without disconnecting shared geometric vertices. At minimum support UV coordinates and the identity/interpolation required to carry them through triangulation, transforms, extraction, subdivision, realization, and connected-region extrusion. One vertex can have different UV values on adjacent face corners.

Define triangle-to-polygon-corner correspondence, including fixed triangles on deformed nonplanar faces. Preserve separate UV islands, orientation and seam identity. Respect existing attribute transfer policies: continuous numeric values interpolate; categorical values inherit by a documented rule; IDs are provenance, not averaged columns. New topology cannot promise attributes that are absent.

Generic typed corner attributes are useful; specialized UV storage must not become an incompatible second attribute system. Geometric normal computation and optional shading normals remain separate even when both use corner information.

### 8.2 Initial mappings

Provide predictable UVs for existing plane, box, sphere, cylinder, cone and torus primitives. Preserve geometric topology and handle seams/caps/poles explicitly. Existing generic subdivision refines UVs while preserving the represented geometry; it must not introduce a special analytic sphere projection.

Support caller-supplied corner UVs on custom meshes, plus explicit planar and cylindrical projection helpers for meshes without UVs. Sweep/revolve should generate and transfer useful coordinates from profile/path parameters, with arc-length-based choices documented. Full arbitrary-mesh unwrapping and packing are outside this batch.

Treat three mapping intentions distinctly:

| Mapping intention | Expected behavior |
| --- | --- |
| Stored chart/rest-surface coordinates | Pattern stays attached through object motion and topology-preserving deformation. |
| Object/world projection | Pattern is evaluated in the explicitly chosen reference space; world-fixed projection can move relative to an object intentionally. |
| Paper-directed hatch | Existing behavior; lattice is rebuilt for the resolved view/paper. |

Do not rebuild stored rest coordinates from deformed positions on every frame. That makes a supposedly attached texture swim. UV overlap can intentionally map the same pattern to several islands; do not silently choose one triangle. Degenerate UV triangles and poles require explicit handling, bounded output, and clear diagnostics.

### 8.3 Mapping existing vector geometry

Implement one operation, provisionally `mapSurface(mesh, pattern, options)`, that maps existing resolved 2D material/curve data through a selected chart to supported 3D curves. Reuse current 2D generators and selection tools. Frame-dependent 2D shape conversion still goes through the bound toolkit; raw numeric chart coordinates must not accidentally be resolved as percentages of paper.

Clip/split input curves against chart triangles, then map using surface barycentrics. Handle islands and periodic seams without connecting unrelated regions or double-drawing a shared boundary. Preserve source curve parameters so phase and selection survive subdivision into surface pieces. Curved input needs controlled adaptive approximation where an exact representation is unavailable; report the approximation contract honestly.

This must work for more than straight hatch: include mapped stripes, a curved vector motif, and a procedurally generated pattern. Resulting curves are editable/queryable data and are occluded by the represented surface and other geometry normally.

Reuse `t.image` and existing image assets as sampled data sources for scalar tone, density, or other attributes. Add the coordinate bridge required for UV sampling rather than a second image loader. Define origin convention, wrapping/clamping, interpolation/footprint filtering, and luminance conversion. Capture asset content/identity and sampling options for persistence. No raster image is emitted in place of plotted strokes.

## 9. M7: tangent fields and tracing

### 9.1 Field sources

Support tangent fields from a user callback, UV directions, a projected world direction, surface scalar gradients, and an estimated curvature direction. Reuse the existing field/force vocabulary and generic math where meanings match. Surface evaluation is a new domain, not a reason to duplicate every scalar utility.

Project arbitrary direction inputs onto the actual tangent plane. Handle zero/near-degenerate direction through explicit stop/fallback rules; do not normalize NaNs. Use smooth or transported direction information to avoid every triangle becoming an unrelated hatch patch.

Curvature directions on meshes are estimates, not exact analytic geometry. Implement and document neighborhood, weighting, smoothing, boundary and crease policies. A principal direction is an unoriented line: choose its sign consistently with the previous tracing direction. At flat regions, umbilics, singularities, or low-confidence estimates, use a deterministic documented fallback or terminate gracefully. Do not claim a globally continuous nonzero direction field on arbitrary closed surfaces.

### 9.2 Surface tracer

Trace from explicit or seeded surface locations while remaining on the represented mesh. Walk across actual adjacent triangles, transporting direction as necessary. Avoid nearest-point projection at each step as the sole attachment method: nearby folds or disconnected sheets can cause jumps.

Make step size, maximum arclength/steps, boundary/crease policy, loop detection, and termination reasons explicit. Refine steps according to directional/geometric error and split at every support transition. Treat seams as coordinate boundaries, not automatically physical cuts; continuation must use the correct neighboring chart where intended.

Preserve deterministic seed identities and line direction choices. A change in camera must not reseed a surface-space pattern. Reusing the same captured pattern with two cameras must produce the same source curves before view clipping.

### 9.3 Spacing and coverage

Provide actual surface-aware spacing/coverage control for hatch traces, including bounded candidate seeding and termination near existing lines. Distinguish spacing measured in chart units from physical distance along the represented surface. Equal UV spacing does not promise equal surface spacing.

Spatial occupancy tests must not cause unrelated nearby sheets to suppress each other's hatch. Include surface/topology information in proximity decisions. Do not call global Euclidean point separation geodesic line spacing. Report the actual algorithm and limits; exact geodesic optimization is not required.

A production hatch generator should cover a region with a bounded, repeatable algorithm, not require users to hand-place hundreds of seeds or tune numerical integrator constants for each primitive.

## 10. M7: tone, hatching, crosshatch and contours

### 10.1 Surface hatch as a reusable result

Expose a convenient seeded entry, provisionally `t.hatch(meshOrInstances, options)`, that generates supported surface curves. Its options include direction, surface spacing, optional tone, and documented budgets. Reuse the same source-curve contract as mapped patterns and intersections. Because seeding reads execution randomness, it belongs on the bound toolkit. Pure lower-level tracing can accept explicit seeds.

Use an explicit asynchronous return for the host-backed hatch operation, consumed with `sketchAsync` and `await`. This allows batched GPU evaluation and real worker cancellation without pretending that a synchronous field can wait for GPU data. Small pure geometry kernels can remain synchronous. Whichever public signatures are settled, update the live examples to reflect actual execution rather than hiding a Promise inside a geometry value.

Retain the existing `view(..., { hatch: ... })` paper-directed shortcut with unchanged unit meaning. New surface spacing is in explicit model/world units; bare numbers on the existing paper hatch must not silently change meaning. An optional paper-density adjustment is a view interpretation policy over stable source data, not a claim that fixed surface spacing stays constant in millimeters under every camera.

Support crosshatch as multiple direction families over the same surface data. Reuse arrays/collections and `t.times` when appropriate. Family identity is stable and each family can have a named pen. Do not create a separate tracing engine for each family count.

### 10.2 Tone fields

Define a tone convention, recommended `0 = light/no hatch`, `1 = dark/full requested coverage`. Accept constants or surface fields. Provide a compact explicit directional-light recipe if no existing field tool expresses it ergonomically: light direction convention, normal source, ambient term, response/ramp, and coordinate space must be documented. The artist can replace or combine it with attributes, procedural noise, distance, or an image field.

Implement darkening through line density/coverage, family activation and/or length, with physical pen width still controlled by the selected pen. Do not assume SVG alpha, raster gradients, pressure-sensitive width, or a fictitious pen can be plotted. Multiple passes/width effects must be deliberate realizable marks.

Prefer stable nested line selections or deterministic candidate acceptance as tone changes, so nearby tone values do not regenerate an unrelated pattern. Variable-density placement must consider changing tone along a trace, not only the first seed's value. Document tonal approximation and verify monotonic density on controlled fixtures; do not claim calibrated optical reflectance for arbitrary paper/ink.

Direct tone from explicit lights is enough for this batch. Cast shadows, ambient occlusion, and global illumination are outside scope unless already implemented independently. View-dependent lighting is allowed only as an explicit input; never introduce a hidden camera light.

### 10.3 Contour vocabulary

Deliver scalar isolines on meshes for height, distance, noise and captured attributes, plus cross-contours derived from surface directions/coordinates. Preserve the same source support and chaining rules. Numeric fields evaluated at vertices yield isolines of the documented interpolated field; arbitrary nonlinear fields need refinement/error controls and must not be described as exact from vertex samples alone.

Existing silhouettes remain view-dependent renderer features. Surface isolines/cross-contours are separate reusable model data. Suggestive contours require additional view/curvature conditions and are deferred; do not relabel ordinary mesh edges or scalar isolines as suggestive contours.

## 11. Selected M8: connected-region extrusion

Implement connected-region extrusion through the ordinary mesh/edit workflow. It must operate on adjacent selected faces, unlike the current independent-face operation. Keep independent-face extrusion available with its own semantics. Do not disguise the difference behind a large mode-flag function.

Minimum supported contract: find connected components of a face selection; each component has one displacement vector, optionally computed by a field over the frozen region. A convenience scalar normal distance may be provided only with a well-defined region direction. Variable per-face offsets with complicated corner miters are not implied.

- Retain a translated cap with shared internal topology and create side faces around each boundary loop, including holes where valid.
- Define how selected source faces are replaced, how unselected incident geometry remains connected, and how original/child IDs are retained or derived.
- Preserve attributes/provenance on cap and sides; define side UV generation and cap UV transfer. Do not overwrite user columns silently with operation labels.
- Reuse the frozen-pass transaction and selection checks. Reject conflicting edits or invalid input before publishing a new mesh.
- Handle zero displacement, reversed displacement, multiple disconnected selections, open surfaces, and selections touching existing boundaries explicitly.
- A selected closed component with no boundary needs a stated diagnostic/alternative; do not fabricate an extrusion wall.
- Preserve fixed triangulation rules for represented nonplanar faces. Detect/report invalid output; this is not a Boolean repair service for self-intersecting extrusions.

Maintain the existing subdivision contract and carry new corner attributes through it. Do not implement smooth subdivision, inset or bevel merely to expand this milestone's checklist. A useful acceptance case is a connected selected patch extruded from a textured sheet, with its cap/sides queryable and surface patterns generated on the resulting mesh.

## 12. Rendering integration, precision and identity

All new curves enter the same feature capture → candidate generation → robust interval visibility → source chaining → 2D interpretation → clipping/finishing → planning/export path. Extend discriminants, serializers and bindings together. Do not flatten supported curves to anonymous polylines at an API boundary and lose their support or source parameters.

Preserve original world/affine source constructions when projecting. The existing paper budget is based on `min(0.005 mm, resolved pen width / 20)` over applicable pens, with the current allocation between interval reconstruction and projection. New approximation from mapping/tracing must be budgeted explicitly: either refine before export within an updated total budget or state the model-approximation tolerance separately. Do not silently spend the entire existing allowance twice. The 2D input snap grid remains a separate contribution.

Camera-dependent display resampling may refine a captured curve without changing its seed, semantic identity or intended surface path. A more demanding camera/paper/nib combination must trigger further refinement or a clear quality diagnostic. Curved source geometry is not made exact by subdividing a coarse representation after its provenance has been discarded.

Stable identity must survive input reorder where the existing contract guarantees it, filtering unrelated lines, instance selection, camera orbit, and visibility splitting. Keys should not require the artist to label every generated segment. Do not use global allocation counters or GPU completion order. Different topology/programs may change identities; state the limit honestly.

Keep dash phase and deterministic variation anchored to the full source curve. Trimming a selected interval does not silently reset the whole source. Surface-space variation that changes geometry must happen before visibility classification; ordinary paper-space post modifiers retain their existing semantics. Optional fitting must never bridge a visibility break or move a curve off its support; general fitting is deferred here.

## 13. WebGPU work and performance contract

WebGPU is part of this batch, not a last-step checkbox. Continue using the existing worker-owned host, resource leases, cancellation/adoption protocol, pipeline/buffer reuse, bounded caches and retained viewport.

Implement a useful new M7 GPU batch path for evaluating surface locations/attributes and supported built-in tone inputs, including UV image sampling when used. Reuse packed triangle/corner data and evaluate many locations per dispatch. Keep a CPU reference path and inspectable source-linked results. A trivial shader demonstration or only the already-existing viewport does not satisfy this deliverable.

Arbitrary JS fields remain CPU computations captured at explicit boundaries. Do not invent a general JS-to-WGSL compiler. Irregular topology edits, exact contact reconstruction, and the first correct surface tracer may run on CPU. GPU acceleration of M6 candidate generation or tracing is optional only after profiling identifies a useful workload; correctness and the shared contracts come first.

GPU f32 evaluation cannot decide near-degenerate support, topology, or visibility without the established refinement policy. Quantized tone/family decisions should be stable across backends: refine ambiguous thresholds or use an explicitly shared quantization contract. Preserve final CPU/GPU topology agreement within documented tolerances rather than promising cross-device byte identity.

Measure end-to-end work: target preparation, CPU field evaluation, packing, upload submission, dispatch, readback, refinement, tracing/chaining, paper finishing and SVG generation. GPU timestamps are a separate measure. The previous workload suite did not show a GPU visibility speedup; do not infer a new one from shader time alone. Report cold/warm medians with scene/mark counts, bytes, cache hits, termination/capacity counts and hardware details.

Use bounded cancellation checkpoints in long CPU loops and between GPU batches. Superseded work must not replace a committed plan. Do not add unbounded per-point readbacks, a hidden GPU device per helper, or an unbounded cache keyed by immutable revisions.

Checking a signal in a synchronous loop does not let a worker receive new cancellation messages. Long-running orchestration must yield to the event loop or use an explicit async execution path. Keep bounded synchronous kernels honest about that limitation; provide a host-scheduled path for substantial intersection/mapping workloads where needed and expose the resulting async boundary in authoring examples.

Automatic worker restart and device-loss recovery remain explicitly user-deferred. Preserve existing error reporting and the last committed result; do not reopen that separate project in this batch.

## 14. Public API acceptance sketches

The new operation names below are **target syntax**, not claims that the baseline supports them. Reconcile spellings with any newly landed API and the reuse audit. Preserve the semantics and ergonomic level. Turn the final versions into live, typechecked examples in the existing docs and actual Studio demos; do not leave pseudocode as completion evidence.

### A. Intersections are drawable construction geometry

```ts
import { sketch, pen, mm, strokes } from 'occlude';
import { box, cylinder, intersections, view, perspective } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  seam: pen({ width: mm(0.25), color: '#A84932' }),
} }, () => {
  const block = box([2.5, 1.5, 1.5]);
  const tube = cylinder(0.65, 2.8).rotate([0, 35, 0]);
  const seams = intersections(block, tube);

  return view([block, tube, seams], {
    camera: perspective({ eye: [5, 7, 5], target: [0, 0, 0], fovDegrees: 40 }),
  }, lines => [
    strokes(lines.visible.filter(c => !c.kinds.has('intersection')), { stroke: 'ink' }),
    strokes(lines.visible.filter(c => c.kinds.has('intersection')), { stroke: 'seam' }),
  ]);
});
```

The callback deliberately selects its own ink vocabulary; default `view` behavior must also work. Add a variation that resamples the seams and uses their surface locations to seed another operation. New constructors must not require raw surface capture IDs.

### B. Tonal surface hatch with explicit paper and lighting

```ts
import { sketchAsync, paper, pen, mm, inch } from 'occlude';
import { torus, view, orthographic } from 'occlude/3d';

export default sketchAsync({
  seed: 42,
  paper: paper({ width: inch(8.5), height: inch(11), color: '#F5F0E6' }),
  pens: { ink: pen({ width: mm(0.2), color: '#18202A' }) },
}, async t => {
  const model = torus(1.4, 0.45);
  const marks = await t.hatch(model, {
    direction: s => s.tangentU,
    spacing: 0.08,
    tone: s => 0.2 + 0.8 * Math.max(0, -s.normal[2]),
  });
  return view([model, marks], {
    camera: orthographic({ eye: [5, 7, 5], span: 5 }),
    stroke: 'ink',
  });
});
```

Here the direction is a surface tangent and spacing is in model units. Also demonstrate estimated-curvature tracing on a deformed/custom mesh, a second crosshatch family in another named pen, and an explicit directional-light tone recipe. A torus-only analytic shortcut does not satisfy arbitrary-mesh tracing.

### C. Existing 2D geometry becomes a surface pattern

```ts
import { sketch, curve as curve2d, pen, mm } from 'occlude';
import { plane, mapSurface, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
} }, t => {
  const sheet = plane(4).subdivide(4)
    .displace(p => [0, 0, 0.4 * Math.sin(p.x) * Math.cos(p.y)]);
  const stripes = t.times(16, (_, u) => curve2d([[0, u], [1, u]]));
  const marks = mapSurface(sheet, stripes, { uv: 'uv' });

  return view([sheet, marks], {
    camera: orthographic({ eye: [5, 7, 5], span: 6 }),
    stroke: 'ink',
  });
});
```

The numeric 2D material is interpreted in chart coordinates, not paper units. Include a curved motif and an image-driven tone variation in companion examples. Test attaching before deformation and explicitly rebinding after it, in addition to generating marks on an already-deformed surface.

### D. Stateful procedural edits and connected extrusion

Add a compact example that initializes point/face attributes, changes an attribute with `next.set`-style edits through several frozen passes, selects a connected multi-face region with ordinary collections, extrudes it as one region, and shades the cap/sides through normal surface fields. No advanced `grid3`/`FaceSelection3` import or manual attribute mutation should be needed.

### E. Reuse and multi-view composition

Reuse one captured patterned mesh in orthographic and perspective views, with existing 2D labels, clips and masks. Orbit/commit one view without re-running modeling randomness or changing the other. Include a repeated patterned prototype and preserve named-pen libraries with per-instance color options and a one-off pen. Do not require a new scene lifecycle to accomplish this.

## 15. Verification: semantic assertions and actual Studio output

Write tests for the new mathematical/ownership contracts and independently check the result. Tests must not simply duplicate implementation formulas. Existing visual baselines are useful but do not replace geometric oracles.

| Area | Required assertions |
| --- | --- |
| API consistency | Existing repetition tools in examples; collection set operations and wrong-revision failures; attributes evolve in frozen steps; point/curve/mesh domain capabilities remain honest; query result fields dispatch once and preserve misses. |
| Orientation | Parallel/antiparallel directions, twist/reference direction, mirrored/nonuniform placement, continuity on a varying normal field, invalid-axis diagnostics. |
| M6 contacts | Analytic plane/box/prism cases; crossing boxes; oblique contacts; exact shared edges; coplanar patch boundary; tangent point; disjoint and one-ULP-separated geometry; input order and triangle order; closed loops and branches. |
| M6 visibility | Support on both meshes; unrelated faces still hide the seam; both cameras and near/far clipping; existing bottom-face world-depth regressions remain correct. |
| UV/corners | Seam values without duplicated geometry; sphere/cylinder caps and poles; overlapping islands; custom UV input; extraction/subdivision/realization/extrusion transfers; degenerate chart diagnostics. |
| Mapping | Affine mapping with known expected points; seam splits; no diagonal artifacts; curved source phase; patterns move/deform with their captured reference; world-projected mapping intentionally behaves differently. |
| Tracing | Plane and cylinder reference paths; adjacent-triangle continuity; no jumps across close sheets; boundaries, creases, loops and singularity fallback; support validation on every emitted piece; error/budget termination. |
| Tone/hatch | Surface spacing versus UV spacing; stable seeds under camera changes; monotonic ink coverage on tone ramps; family identity and pen isolation; image sample mapping/filtering; no paper-fixed appearance in the surface-mapped demo. |
| Extrusion | Adjacent patch, holes where supported, multiple components, negative/zero offsets, open boundary, invalid/conflicting selection; shared topology, cap/side provenance and UVs; no silent self-intersection repair claim. |
| Output | Visible/hidden selection, dash/style phase through crop/occlusion, pen dimensions, imperial paper, actual SVG/G-code plan consistency, no lost full-source references. |
| Runtime | CPU/reference and GPU agreement; bounded memory/caches; canceled/obsolete work cannot replace committed output; camera controls, saved result and portable sketch reopen. |

Use an independently authored analytical or exact/rational oracle for critical intersection and depth cases. Compare full interval/segment coverage and topology where possible, not only sparse sample points. Blender/Krbn can supply visual/reference comparisons, but do not assume their output is an infallible oracle or require byte-identical SVG.

Main Studio verification must include real imports and Monaco diagnostics, the served built bundle, a nonfallback GPU where available, orthographic/perspective switching, orbit, picking, Commit view, save/download/reopen, and actual vector exports. Laboratory-only checks do not prove the user workflow. Record the exact scene, seed, camera, paper/nibs, backend, adapter and build for a failure.

Benchmark a simple mapped plane, curved primitive crosshatch, custom curved mesh, intersecting assembly, repeated prototypes and increasing hatch density. Use the same final workloads on CPU/GPU, cold/warm measurements and explicit trace/segment counts. A report may honestly show no speedup; it may not substitute kernel timings for end-to-end work.

## 16. Isolation, Docker and delivery workflow

Use an isolated fork/branch or the established isolated dev checkout. Historical handoff path: `/home/kalmarv/containers/occlude-3d`; historical served port: `5273`. Verify actual paths, mounts, branch, services and stores before use. A separate Git branch alone does not isolate runtime stores or container mounts.

Preserve uncommitted user changes. Snapshot/compare dev demo sources before updating them; install new demos under distinct names instead of overwriting user-edited sketches. Production services, stores and plotter connections are outside scope.

The established isolated Compose commands, once their configuration is verified, are:

```sh
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev config
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev build dev
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev up -d dev
```

Name only the isolated `dev` service. Confirm host networking/port and store mounts in the resolved config. The override serves built assets through `server.mjs`; the root dev definition alone is not equivalent. Follow the repository build-stamp mechanism so tested, served and reported code can be correlated.

Run the repository's required `pnpm check`/Docker gates for final delivery: Rust tests, TS tests, library typechecks, Studio typecheck, live docs, ink baseline, build, WASM identity and server/assets smoke. Use `check.mjs` as the current authority for exact gates. The reviewed baseline reports all nine gates passing, with unchanged church routing and a deliberate `three#16` ink correction; those are prior results, not evidence for this batch.

If Rust or the protocol changes, update both sides, rebuild WASM, and verify served/package identity. Preserve the old hash only when no relevant source change occurred. Run required before/after church stats for toolpath-affecting changes. Deliberate ink changes must be explained in the same change as their baseline update; do not mass-regenerate goldens to make failures disappear.

Commit coherent checkpoints and follow the existing authorized dev-branch workflow. Do not merge/deploy production. Report locally/container-verified results as such; do not claim remote CI or authenticated public-origin checks unless actually performed. Keep captured failures and follow-up corrections distinguishable in the evidence.

## 17. Internal checkpoints and definition of done

These checkpoints are one assignment. M6 and M7 share the surface-data foundation but neither should wait for unrelated M9 work.

1. **Contract/reuse checkpoint:** inspect latest code, inventory existing helpers, settle ordinary signatures and domain/coordinate rules, and add target examples. Record which names are reused and why genuinely new operations are needed.
2. **Shared data/API checkpoint:** selection/edit parity, query field adapters, topology adjacency, corner attributes, surface locations and multi-source curve support. Preserve the old renderer's tested behavior.
3. **M6 checkpoint:** construction intersections, contact policy, chaining and ordinary rendering. Deliver an independent geometry oracle and an editable crossing-forms demo.
4. **M7 mapping checkpoint:** primitive/custom UVs, vector-pattern mapping and image sampling bridge; deforming-sheet and repeated-pattern demos.
5. **M7 tracing/tone checkpoint:** generic tangent tracing, curvature direction estimate, surface spacing, crosshatch and scalar isolines; curved primitive and custom mesh demonstrations; useful GPU surface-evaluation batch.
6. **Selected M8 checkpoint:** connected-region extrusion and complete transfer through it; ordinary procedural relief example. Keep inset/bevel/smooth subdivision out of the completion claim.
7. **Integration checkpoint:** main Studio workflows, performance reports, all required gates, dev delivery and concise final handoff.

Final handoff must include: starting/final commits, exact delivered scope, public API examples, source/test/evidence mapping, Docker reproduction commands, measured CPU/GPU costs and memory limits, dev demo names, precision/approximation contracts, known limitations, and any remaining defects. State explicitly that M9, broader M8 modeling, suggestive contours, full UV unwrapping, and automatic recovery remain outside this batch.

Do not declare completion if the impressive result only works on a primitive-specific shortcut, if curves detach/swim during the intended deformation workflow, if ordinary examples still manage capture/ID plumbing, or if exported ink disagrees with the surface visibility contract. The artist should be able to substitute a custom supported mesh for a primitive and keep the downstream mapping, field, selection and drawing workflow.

## 18. Reference material

- [Reviewed Occlude implementation](https://github.com/Kalmarv/occlude/tree/000c9cb0e86af431ee48e4b8a3129d7fcf23e52c) and its `development/3d/FINAL-REPORT.md`: starting architecture and completed work.
- [Krbn](https://github.com/vpalos/Krbn): visual reference for surface-direction hatch, tone, crosshatch and form contours. Its primitive analytic curves and mesh streamline paths inform the goal; importing its renderer is not the task.
- [Houdini dihedral](https://www.sidefx.com/docs/houdini/vex/functions/dihedral.html) and [maketransform](https://www.sidefx.com/docs/houdini/vex/functions/maketransform.html): rotation/alignment and reference-frame concepts.
- [Houdini xyzdist](https://www.sidefx.com/docs/houdini/vex/functions/xyzdist.html) and [primuv](https://www.sidefx.com/docs/houdini/vex/functions/primuv.html): reusable surface locations and attribute evaluation.
- Repository `development/3d/reference/`: existing pinned Blender Line Art/Freestyle comparisons and their documented limits. Reuse the development reference setup where useful; it is not an application dependency.

Borrow established concepts and algorithms through appropriate references. Respect repository licensing rules; do not transplant Blender/Houdini implementation code into Occlude. Reuse Occlude's own primitives, geometry, clipping, field, pen, planning and export infrastructure wherever their contracts already fit.

