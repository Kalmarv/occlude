# Shared triangle boundary interval regression

The instanced-cone visual check exposed isolated exported dots. With seed 42,
36 cones and the original 40-degree camera, the hardware SVG contained 18
zero-length round-cap paths. The wider 50-degree acceptance framing exposed
80 positive but spurious CPU visible intervals before correction.

`fixture.json` captures one exact camera-space segment and the three occluding
triangles. Their hidden intervals left a gap from 0.0028182323102754737 to
0.0028182323102754897 inside a convex cone's hidden rear rim.

Adjacent triangles traverse their common boundary in opposite directions.
Robust predicates guarantee determinant signs, but approximate magnitudes need
not be exact negatives after argument permutation. Independently computing
roots from those magnitudes opened the false gap. Side predicates now order
shared edge endpoints canonically before evaluation, giving the same interval
root on both sides. No epsilon, minimum length, union tolerance or coordinate
shift was introduced.

The independent regression uses analytic convex-cone face normals in world
space to identify fully hidden rim edges. Both projections fail without the
fix and pass with it. Near clipping deliberately opens the cone and preserves
real visible runs; a separate 2e-9-wide open gap remains visible. The existing
36 hardware precision cases and four physical-budget controls also pass.

The final instance Playwright verifier asserts zero stray dot paths in the
actual exported SVG, camera commit without modeling, and portable reopen.
See ../instances-api/served/report.json and ../instances-api/precision/report.json.
All prior 232 documentation ink entries remain unchanged. Full Docker gates
are recorded in ../instances-api/gates.json. The correction and instance facade
are committed separately so the visibility change can be reviewed on its own.

The pinned Freestyle comparator still reports the same two crossing-box coverage
differences (6/8 pass). Closing the perspective cube's false visible gap and merging its adjoining
hidden runs changes the independent sample count from 177 to 174, and unrepresentable interior samples
from 3 to 0. The test updates only those explicit counts; coverage lengths and
strict failure behavior are unchanged. `reference/freestyle-comparison.json`
records the new result against the unchanged pinned Blender data.
