# Batched surface queries (M3 in progress)

`SurfaceQueries3` captures an owned surface and prepares a deterministic world
BVH. Ray, segment and nearest-point batches reuse that snapshot. Results contain
triangle row, source face ID, position, geometric normal, barycentric weights and
distance. Rays are two-sided; near/far are inclusive parameters in the supplied
direction vector's units. Segments use t in [0,1]. Parallel/coplanar rays have no
isolated intersection. Nearest results measure Euclidean world distance and can
be limited by maxDistance. Equal-distance ties use the lowest captured triangle
row. Degenerate triangles, zero ray directions and invalid bounds are diagnosed.

`GpuSurfaceQueries3` uploads prepared triangles once, then runs nearest and ray
batches on the explicit host device. Query buffers are bounded and reused within
a batch; requests are serialized, snapshotted at submission, and cancellable.
The initial GPU kernel scans triangles per query without allocating the pair
product. A default 50-million triangle-test limit fails explicitly; callers can
reduce a batch or deliberately raise the work limit. GPU acceleration with a
BVH and large-scene query performance remain hardening work.

Near-boundary, near-parallel, close-distance and unrepresentable f32 cases route
to the CPU BVH. Ordinary GPU winners are reconstructed against their original
f64 triangle so returned positions/attributes do not alias readback buffers.
Current uncertainty thresholds and extreme-scale behavior still need the wider
M5 adversarial audit; this slice is not a universal precision proof.

The worker can run both query kinds against one prepared target in one request.
The demo queries 64 raised-grid vertices against a sloped ceiling after GPU
deformation, then constrains 22 vertices using the returned nearest points.
Constraint distance is stored as a point attribute. Camera orbit reuses the
constrained geometry and does not repeat construction or queries.

Evidence: `three-queries.test.ts` checks analytic two-sided hits and segment
bounds, nearest face/edge/vertex positions, barycentric weights, input ownership,
empty/invalid batches, and CPU BVH parity with all triangles on a rotated grid.
Direct Playwright in `playwright-queries/report.json` checks 100 nearest queries
and 100 rays against CPU results on a tilted grid (including a nearly parallel
long ray), with batch size 17 forcing six dispatches each; source face IDs and
input snapshot ownership, cancellation and explicit work limits are exercised.
The 64-query worker demo uses one dispatch and no uncertainty fallback. Boundary
fixtures do refine frequently; no GPU speedup claim is made.

Remaining scope includes M2 ordered modifiers and phase, M3 selection/public async
integration and instance/point-cloud/polyline APIs, and M4–M5. The optional
software-adapter lane remains unverified; hardware evidence is NVIDIA Turing.

Final isolated-image gates pass: Rust 11.8s, TS 20.5s, library types 5.2s,
Studio types 5.1s, docs 12.4s, unchanged ink 14.7s, build 35.3s, smoke 2.2s.
WASM MD5 remains `c21c4ef21cb4091b6019b1aa440f6bea`. Hardware acceptance uses
Playwright against the served bundle; no production service was restarted.
