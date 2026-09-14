# Curvature estimation slice (fork B, 2026-09-14)

Files: `packages/occlude/src/three/geometry/curvature.ts`,
`packages/occlude/test/three-curvature.test.ts` (7 tests, all pass; library
typecheck clean). Not yet exported from `occlude/3d`; the main slice wires
`direction.curvature(...)` on top of it.

## API

- `estimateCurvature3(surface, { smoothing?: 1, creaseDegrees?: 60 })` returns a
  frozen `CurvatureEstimate3` with `corners[triangle][corner]` records
  `{ normal, min, max, kMin, kMax, confidence }`. Cached per snapshot surface and
  option key (at most four configurations per surface, oldest evicted).
- `curvatureAt3(estimate, triangle, barycentric)` returns
  `{ min, max, kMin, kMax, confidence }` with unit `max`/`min` in the triangle
  plane and orthogonal to each other.

## Method and policies

- Per-triangle tensor: least-squares fit of the corner-normal differences along
  the three edges in the triangle's own tangent frame (Rusinkiewicz 2004 idea;
  no code borrowed). Six equations, three unknowns.
- Corner normals: angle-weighted average of triangle normals within the corner's
  **smooth sector** (incident triangles connected across edges whose dihedral is
  below `creaseDegrees`). Sharper edges and open boundaries end a sector, so
  boundary vertices use their one-sided ring and nothing crosses a crease.
- Accumulation: each triangle's tensor is rotated into each corner sector's
  frame (rotation carrying the triangle normal onto the sector normal about their
  common perpendicular) and summed with the corner angle as weight.
- Smoothing (`smoothing` passes, default 1): each sector tensor is replaced by the
  angle-weighted average of itself (weight 1) and the tensors of the other two
  corners of every triangle in the sector, each rotated into its frame. Corners of
  the same triangle lie inside the smooth neighbourhood by construction, so the
  pass never averages across a crease.
- Principal values: eigenpairs of the 2x2 tensor, `kMax >= kMin` by value;
  positive when the surface bends away from its outward normal.
- Confidence: `|kMax - kMin| / (|kMax| + |kMin| + eps)`, `eps = 1e-9 / bounding
  diagonal`. Umbilics (sphere) and flat regions report ≈ 0 and a caller should
  fall back deterministically; cylinder reports > 0.8.
- Interpolation: corner directions are lines; signs are aligned with corner 0,
  the barycentric average is projected onto the triangle plane and
  re-orthogonalised. A degenerate triangle or a vanishing average returns corner
  0's frame (or a fixed tangent frame) with confidence 0.

## Measured on the test meshes (centroid samples)

| Mesh | Expected | Observed bound asserted |
| --- | --- | --- |
| cylinder r=2 (48 segments), side | kMax 0.5, kMin 0, max ⟂ axis | kMax within 15%, |kMin| < 0.05, directions within 5° |
| sphere r=2 (48×24), mid-latitudes | 0.5 both, umbilic | both within 20%, confidence < 0.2 |
| plane | 0 | < 1e-9, confidence 0 |
| saddle z = 0.25(x²−y²) | kMin < 0 < kMax | asserted |
| torus R=3 r=1 (48×24), outer rim | kMax 1, kMin 0.25 | kMax ± 0.25, kMin ± 0.1 |
| box | flat faces, sharp edges | 0 with crease policy; nonzero with creaseDegrees 180 |

Known limits: chordal underestimation on coarse tessellations; no true
Voronoi-area weighting (corner angles instead); estimates only, never analytic
smooth-surface curvature; no claim of a globally continuous nonzero direction
field on closed surfaces.
