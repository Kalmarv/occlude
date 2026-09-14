# Generic corner domain

Shared foundation for `3dpt2.md`, parent `1baa409`. The full M6/M7/selected-M8
assignment remains open. This checkpoint adds storage and editing, not surface
mapping, tracing, intersections, or connected-region extrusion.

There is one corner per polygon vertex, kept in polygon winding order without
splitting geometric points. Fixed triangles map to polygon-local corner indices.
Legacy raw surfaces acquire empty canonical corner records at assembly. Snapshots
freeze nested corner attributes and provenance. IDs and schema are validated.

Ordinary `.corners`, `.cornerAttributes`, `.cornerAttribute`, `setCorner` and
`setCorners` retain typed point/face relationships and the fourth mesh attribute
domain. Selection ownership is by actual row, source revision and domain. Field
maps and passes use frozen incoming values; initialized schemas, async/escaped
editor checks and column conflict rules match the existing domains.

Transforms and mirrors preserve the corner/point pairing. Face extraction keeps
corner columns and policies. Instance realization namespaces corner IDs and
includes instance metadata. Numeric subdivision transfer stays within the parent
face, preserving discontinuous values at shared geometric points. Non-affine
numeric corner quads refine their fixed triangles, rather than changing the field
across the original diagonal. Missing columns stay missing; categorical and
explicit nearest columns retain a deterministic source. Advanced independent
extrusion currently transfers cap corners; its new side corners remain empty.
Full extrusion transfer belongs to the required region-extrusion implementation.

Ten focused tests cover seams, frozen nested data, mirrors, extraction, domain
relationships, revision/schema checks, history, subdivision and realization.
The non-affine quad test independently checks a diagonal midpoint's UV value.
An additional Studio test captures a committed scene, serializes/reopens its
JSON and verifies all 24 distinct box corners on eight geometric points.

A new `three#22` live example evolves heat through corner/point/face relations,
using existing `meanBy`, then interprets face averages as ordinary paper hatch.
It does not claim surface-originated hatch. No existing example is intentionally
changed. Church and the existing world-depth precision oracles remain regressions.

All nine Docker gates pass on the final source. All 242 prior stable drawings
retain their hashes; `three#22` adds one, giving 243 stable and two unstable
examples. Church remains 15,601 chains / 96,037 mm draw / 16,515 mm travel /
381.0 minutes / bridge 0 / Euler 15,593 / coincident 18.1 mm. WASM remains
`8bf0034cb79606aa8d6c7293496a1b7e`.

All 23 live examples pass in actual Studio with empty Monaco diagnostics, SVG
export and a nonfallback NVIDIA Turing adapter. The new example was visually
inspected. Four independent paper-box camera cases retain maximum interval
error 0 across 96 edges and 1,685 curves; nine world-depth probes also pass.
The paper report uses its complete-curve oracle, including the existing tiny
path cases; no short-line suppression or support offsets were added.

Dev build stamp: `1baa409-corner-domain`. Running image:
`sha256:0bdd814808f4a273eb3ecdba3c63a0a625b2f02f9a7781e3c03ba51a30e88739`.
Only isolated Compose service `dev`, port 5273, was recreated. No sketch-store
writes or production actions were made. Log trailing whitespace is trimmed;
the large paper JSON is also stored as deterministic gzip.

Reproduction from the isolated checkout:

```sh
OCCLUDE_BUILD_STAMP=1baa409-corner-domain docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev build dev
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev up -d dev
cd packages/occlude-studio
DISPLAY=:93 OCCLUDE_API_EVIDENCE=../../development/3d/corner-domain/live node --input-type=module < ../../development/3d/corner-domain/verify-live.mjs
DISPLAY=:93 OCCLUDE_PAPER_FIXTURE=../../development/3d/paper-world-depth/after OCCLUDE_API_EVIDENCE=../../development/3d/corner-domain/paper node tools/verify-paper-box-oracle.mjs
DISPLAY=:93 OCCLUDE_API_EVIDENCE=../../development/3d/corner-domain/world-depth node tools/verify-world-depth.mjs
```

Next: owned surface locations and explicit topology-preserving rebinding, then
the shared multi-source supported-curve carrier. Primitive/custom UV mapping,
M6 intersections, M7 tracing/tone/GPU evaluation, connected-region extrusion,
acceptance demos, integration and performance evidence remain required.
