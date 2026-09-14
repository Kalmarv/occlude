# Implementation contracts

These decisions implement the original specification; they do not reduce its acceptance gates.

## Data ownership

Model geometry is CPU-owned f64 data: polygon topology, stable semantic IDs and point/edge/face attributes. Derived triangulation retains face parentage. Uploads copy mutable public arrays into revision-bound snapshots. A render session owns its camera, candidate index, GPU resources and classified intervals. No global active scene, camera or GPU job.

Four separate values cross the pipeline: editable geometry, immutable render snapshot, classified line drawing, physical plot plan. Line-set predicates and styles consume the same classified snapshot. They do not cause another visibility dispatch. Changing geometry, camera or candidate generators invalidates only the dependent stages. Narrower nib/error requirements may require refinement.

## Coordinates and numerical boundary

World coordinates are right-handed with Z up. Camera space looks along negative Z; near and far are positive distances. Projection maps depth to WebGPU's [0,1] range. Paper mapping uses an explicit drawable rectangle in millimeters and reverses vertical direction at that boundary. World units never inherit paper units.

CPU clipping precedes perspective division and retains original parameters and triangle parentage. GPU positions are locally normalized f32; CPU source positions remain f64 for reconstruction/refinement. Initial visibility classifies segment/triangle occlusion half-spaces, unions hidden intervals and complements them. A conservative projected BVH supplies bounded candidate batches; no large-scene all-pairs allocation. Uncertain GPU classifications return flags for CPU refinement. The runtime derives a paper/nib-dependent interval tolerance; PAPER-PRECISION.md records the tested allocation and numerical limits. It is not an arbitrary-magnitude guarantee.

## Lifecycle

An explicit asynchronous renderer owns a lazy GPU session. Ordinary 2D imports and synchronous 2D execution never request an adapter. Upload, dispatch, readback and refinement boundaries check cancellation; completed obsolete jobs cannot publish. Buffers are released after submitted work is safe, or invalidated on device loss. Committed output captures camera, realized procedural geometry, backend/precision provenance and existing complete paper/pen definitions.

## Geometry edits

Independent-face extrusion replaces each selected cap, duplicates its translated vertices and adds perimeter side quads, preserving unaffected shared input vertices. Positive distance follows the oriented normal; negative reverses displacement; zero is a no-op. New IDs derive from operation, parent and local ordinal. New elements copy intensive attributes; extensive attributes require an explicit distribution policy. Adjacent independent extrusions may create coincident walls; initial examples use nonadjacent selected faces and diagnostics describe that limit. Frozen passes select and evaluate against their input snapshot, then commit edits in stable order. Stale selections are rejected.

## Drawing and planning

Feature classification retains all flags, source/support identity, attributes, original parameters and hidden/visible intervals. Line sets resolve overlapping interval ownership by stable priority unless authored overdraw is explicit. Compatible source runs chain before length selection; T/X ambiguities stop chains. Occlusion, clipping, dash and deliberate breaks retain separate run identity through existing recording and ordered-chain planning.

Surface hatch returns supported 3D curves at requested paper spacing; it shares visibility with edges. Planar faces use a shared face family, not per-triangle phase. Folded faces use their fixed piecewise triangles with barycentric support. Sections are surface/plane intersections. Paper styles modify resolved strokes after visibility; normal paper clipping, labels, masks, named pens and the single physical timing/export pipeline remain authoritative.

## Extension points and provenance

Curved hatch can supply additional supported candidate curves; import can supply the same editable polygon data. Neither requires a second renderer. Smooth silhouettes, connected-region extrusion and the other post-MVP features remain deferred as specified. Implementation is independent geometry/WGSL code; Blender documentation supplies behavior references only. Pinned Blender 5.2.1 comparisons and current hardware-browser evidence are recorded in ACCEPTANCE.md.

For current lifecycle acceptance, limitations and user-approved recovery deferrals, see [HANDOFF.md](HANDOFF.md). Earlier milestones do not establish automatic recovery acceptance.
