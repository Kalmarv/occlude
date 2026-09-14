# Connected-region extrusion (fork A, 2026-09-14)

Files: `packages/occlude/src/three/geometry/extrude.ts` (kernel
`extrudeRegion3`, `regionDirection3`), `Mesh.extrude` in
`packages/occlude/src/three/api/mesh.ts`, tests
`packages/occlude/test/three-extrude-region.test.ts` (8 tests). Not committed,
not deployed, not in docs/index yet (main slice integrates).

## Signature

```ts
mesh.extrude(faces: MeshFaces, offset: Vec3 | ((region: ExtrudeRegion) => Vec3) | { distance: number | ((region) => number) }, { key?: string } = {}): Mesh
```

`ExtrudeRegion = { index, faces: MeshFaces (one connected component), normal?: Vec3, center, area }`.
The selection must come from `mesh.faces()` of this revision (same ownership
check as frozen editors). Components are `faces.components()` in source order.

## Decisions

- One vector per component. `{ distance }` uses the area-weighted mean normal
  and is refused (error names the region) when that mean's length is below
  half the summed area (faces cancel, e.g. a folded strip). Zero vector on any
  component is an error naming it; negative/reversed vectors recess.
- Cap = selected faces translated: face IDs, corner IDs, corner attributes
  (UV/chart included), face attributes and fixed triangulation retained.
  Points incident only to faces of one component and not on any region
  boundary edge move in place; every other point used by the component gets a
  copy `['extrude', key, 'point', pointId]` (attributes copied, provenance
  `extrude`). The original point stays with the unselected faces.
- Walls: one planar quad `[a, b, b', a']` per region boundary edge (exactly
  one selected incident face), including open sheet edges and hole loops. IDs
  `['extrude', key, 'side', edgeId]`; face attributes copied from the incident
  selected face; corners copied from that face's corners at the shared vertices
  with `uv = [loop arclength fraction, 0|1]` and `chart = key + ':side:' +
  component` where those columns exist. No `role`/`parentFace` columns.
- Generated edges (cap copies of boundary edges and the vertical rising from
  each boundary edge's start vertex) inherit that boundary edge's attributes
  with `extrude` provenance.
- Closed component without boundary edges → error suggesting `translate`.
  Two components touching only at a vertex with every incident face selected →
  error (extrude separately). Foreign selection → error.
- IDs are deterministic per key; repeating an extrusion on generated caps
  nests IDs and stays unique (assembly rejects collisions).

## Limits

- Self-intersection of recessed or crossing walls is not detected; only
  invalid topology (non-manifold, winding) is reported by assembly.
- Loop chart fractions at a pinched boundary vertex (region boundary passing
  a vertex twice) pick the lowest edge index deterministically; the chart may
  restart there.
- Point-domain `interpolate` transfers are unaffected; no attribute averaging.
