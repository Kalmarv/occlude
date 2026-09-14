# Generic profile construction: revolve and sweep

Both operations consume the existing curve data and return the common Mesh.
Their shared path-ordering helper accepts one connected unbranched component,
preserves its first edge's direction and diagnoses empty, branching, disconnected
or collapsed paths. Expanded point/face budgets are checked before construction;
cap contours have their own configurable budget because general ear clipping is
quadratic.

Revolve rotates an XZ meridian around Z, preserving full-turn seams and sharing
exact axis points. Axis-to-axis spans create no zero-area faces. Pinched interior
axis contacts are rejected. Signed partial turns can cap a closed profile's
angular cuts. Open profile ends remain open; they are not automatically sealed.
Point columns copy from profile points, side-face columns from profile edges,
with source provenance on derived rows. Cap face columns are empty/optional.

Sweep uses bisected corner tangents, minimally transported profile frames and
arc-length-distributed closure correction for closed paths. Initial normal,
positive path-point scale fields, whole-turn closed-path twist and optional end
caps are explicit. Open profiles produce ribbons. Profile columns take precedence
when merging profile/path point and edge attributes. Swept nonplanar quads retain
fixed triangles; no boolean or global self-intersection repair is implied.

Twelve focused tests cover independent polygonal cone, sector, prism and torus
volumes; winding and shared seams/rims/poles; open vessels/tubes/ribbons;
transported profiles and closed spatial paths; typed source columns and
provenance; immutable downstream subdivision/steps/query workflows; invalid
paths/frames/caps and pre-allocation budgets; and camera-only commits without
rerunning models or sampled scale fields.

A torus subdivision check originally assumed every source quad would produce
four child quads. Exact nonplanarity in the stored floating-point coordinates
makes some faces use the existing triangle-preserving refinement. The corrected
check verifies preserved volume and manifold shared topology instead of assuming
that mathematically coplanar inputs are exactly coplanar stored coordinates.

Main Studio Playwright checks the live vessel/tube/ribbon example, typed Monaco
imports and negative number-to-string probes, NVIDIA GPU dispatch, projection
commit without model rerun, and exact portable reopen. Four additional geometric
visibility oracles cover revolved and swept octagonal prisms in both projections.
For a rear line (-2,0,-2)..(2,0,-2), viewed from (0,0,5), their hidden intervals
are [1/4,3/4] orthographically and [1/16,15/16] perspectively. Expected values come
from geometry, not agreement between two implementations of the same predicate.

The live tube uses 16 profile segments so facet angles do not sit at the default
30-degree crease threshold. Only three#15 adds a docs ink baseline; all 235 prior
entries are unchanged. Church before/after remains 15,601 chains, 96,037 mm draw,
16,515 mm travel and 381.0 minutes. All nine Docker gates and sixteen served
live examples pass. Source and served Studio checks both pass, including all
four analytic GPU interval checks and exact camera/portable reopen.

```sh
DISPLAY=:93 OCCLUDE_API_EXAMPLE=profiles \
OCCLUDE_API_EVIDENCE=../../development/3d/profile-construction/served \
pnpm --filter occlude-studio exec node tools/verify-mesh-api.mjs
```

The entire redesign is not complete. Surface sampling/scatter, M5 demo migration,
detailed phase timings,
the remaining paper acceptance/underside investigation and the final
requirement-by-requirement audit remain open.
