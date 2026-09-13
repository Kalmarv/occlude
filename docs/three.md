# 3D line art

Build geometry in world coordinates, then return `lineArt3(...)` beside ordinary shapes. The camera projects geometry into the sketch's drawable frame. Studio computes hidden lines on its worker's WebGPU device and sends the resulting strokes through the same pen, preview, planning and export pipeline as 2D drawings.

```ts live
import { sketch, lineArt3, box3, label, pen, mm } from 'occlude';

export default sketch({
  seed: 42,
  pens: { outline: pen({ color: '#18202A', width: mm(0.3) }) },
}, () => [
  lineArt3({
    objects: [
      { id: 'wide', surface: box3([3, 1, 1]) },
      { id: 'tall', surface: box3([1, 2, 2], [0.3, 0, 0.2]) },
    ],
    camera: { kind: 'orthographic', span: 4.5, eye: [5, 7, 6], target: [0, 0, 0], near: 0.1, far: 30 },
    lineSets: [{ id: 'visible', stroke: 'outline' }],
  }),
  label('CROSSING BOXES', 8, 94, 4),
]);
```

`surface3(positions, polygons)` constructs a polygon surface. `box3(size, center)` is an editable box factory. A scene captures its input geometry when `lineArt3` is called; later edits to the original surface do not change that drawing. IDs must be unique across objects and wires. Set `lineSource: false` to keep an object only as an occluder, or `occluder: false` to draw its lines without hiding other geometry.

The default coordinate system is right-handed with Z up. Camera `eye`, `target`, and optional `up` use world coordinates. Orthographic cameras require `span`; perspective cameras require `fovDegrees`. Both require positive `near` and a greater `far`. Camera span and FOV control apparent scale independently of paper units.

A camera's optional `viewport` belongs on the scene and uses absolute paper millimetres: `{ x, y, width, height }`. Otherwise the sketch's aspect and margins determine its rectangle. Sketch `origin` and `yUp` conventions remain valid. Ordinary groups transform the **projected drawing**; change world positions before making the scene to transform the model itself. Ordinary clips, masks, labels, and named pens compose in returned tree order. Resolved 3D strokes do not become opaque regions.

## Selecting lines

Each line set has a unique `id`, named `stroke`, optional `select(feature)`, and `visibility: 'visible' | 'hidden'` (default visible). Higher `priority` owns overlapping source intervals; `overdraw: true` explicitly retains duplicates. Selection callbacks read captured feature rows and must be pure. Features retain object/source IDs, flags, crease angle, edge attributes and incident face attributes.

```ts live
import { sketch, lineArt3, box3, FeatureKind3, pen, mm } from 'occlude';

export default sketch({
  pens: { outline: pen({ color: '#18202A', width: mm(0.35) }), hidden: pen({ color: '#A47E6B', width: mm(0.2) }) },
}, () => lineArt3({
  objects: [{ id: 'box', surface: box3([2, 2, 2]) }],
  camera: { kind: 'perspective', fovDegrees: 24, eye: [5, 7, 6], target: [0, 0, 0], near: 0.1, far: 30 },
  lineSets: [
    { id: 'back', stroke: 'hidden', visibility: 'hidden' },
    { id: 'outline', stroke: 'outline', select: f => (f.flags & FeatureKind3.silhouette) !== 0 },
  ],
}));
```

Scenes chain compatible source edges and preserve visibility breaks. `strokes: { cornerDegrees, minLength, endpointTolerance }` controls splitting and filtering; lengths are paper millimetres. It does not join unrelated edges merely because their projected endpoints touch. Box-to-box intersection curves are not generated yet.

## Headless and host execution

A normal `sketch` can return a deferred scene. Compile it with `compileSketchAsync` or render it with `renderAsync`; synchronous entry points report that async rendering is required. The headless default uses the geometric CPU reference. To use WebGPU, create a host-owned `new GpuSceneCompute3(navigator.gpu)` and pass it as `{ compute3 }` to the async entry point. Reuse it across runs and `await compute3.dispose()` when the host closes. Importing the library and rendering ordinary 2D sketches never request a GPU adapter. Studio supplies this resource automatically and reports unavailable WebGPU rather than silently changing compute paths.

Each execution retains its classified scene results in `run.scenes3`. Repeating the same scene value within that execution reuses its visibility calculation. Cross-execution model/camera caching and the main Studio 3D viewport are still being integrated.

## Procedural construction

`grid3(columns, rows, size)` and `surface3` return editable geometry. `FaceSelection3` reads face normal, area, center, adjacency and attributes. `extrudeFaces3(surface, selection, distance, { operation })` independently replaces selected caps and adds side faces while preserving parentage. Positive distance raises a cap along its normal, negative distance recesses it, and zero leaves its topology alone. Select nonadjacent faces; connected-region extrusion is a different operation. The operation name supplies stable IDs for generated elements.

Use `sketchAsync` for modeling batches. `await t.deform3(surface, { iterations, relaxation, displacements, pinned })` returns editable geometry after all passes. Displacements are world-coordinate vectors, one per point per iteration; `pinned` holds point indices fixed. Each pass gathers neighbors from the previous pass. Ordinary JavaScript fields can generate displacement vectors before submission.

`await t.querySurface3(surface, { rays, segments, nearest })` batches queries against one captured surface. It returns matching arrays of hits or nulls. Rays use `{ origin, direction, near?, far? }`, segments use `[start, end]`, and nearest queries use `{ point, maxDistance? }`. A hit includes its source face ID, point, normal, barycentric coordinates and distance. Ray distance is the parameter multiplying its direction; segment distance is in `[0,1]`; nearest distance is Euclidean world distance. Intersections are two-sided; parallel/coplanar rays have no isolated hit.

```ts live
import { sketchAsync, grid3, FaceSelection3, extrudeFaces3, transformSurface3, lineArt3, FeatureKind3, pen, mm } from 'occlude';

export default sketchAsync({ seed: 42, pens: { outline: pen({ width: mm(0.3), color: '#18202A' }) } }, async t => {
  let surface = grid3(6, 6, [4, 4]);
  surface.faces.forEach(face => { face.attributes.height = t.rnd(0.4, 1.1); });
  const selected = new FaceSelection3(surface).filter(f => f.index % 6 % 2 === 0 && Math.floor(f.index / 6) % 2 === 0);
  surface = extrudeFaces3(surface, selected, f => Number(f.attributes.height), { operation: 'towers' });
  surface = await t.deform3(surface, {
    iterations: 16, relaxation: 0.02,
    displacements: surface.points.map(p => [0, 0, 0.003 * Math.sin(p.position[0] * 2)]),
    pinned: surface.points.flatMap((p, i) => Math.abs(p.position[0]) === 2 || Math.abs(p.position[1]) === 2 ? [i] : []),
  });
  const ceiling = transformSurface3(grid3(1, 1, [8, 8]), { translate: [0, 0, 0.7] });
  const hits = await t.querySurface3(ceiling, { nearest: surface.points.map(p => ({ point: p.position })) });
  surface.points.forEach((point, i) => {
    const hit = hits.nearest[i];
    if (hit && point.position[2] > hit.point[2]) point.position = hit.point;
  });
  return lineArt3({
    objects: [{ id: 'relief', surface }],
    camera: { kind: 'orthographic', span: 6, eye: [5, 7, 6], target: [0, 0, 0.3], near: 0.1, far: 30 },
    lineSets: [{ id: 'visible', stroke: 'outline', select: f => (f.flags & (FeatureKind3.boundary | FeatureKind3.silhouette)) !== 0 || f.creaseAngle > 25 }],
  });
});
```

Await each batch before making dependent CPU edits. Inputs are captured when submitted; later edits do not change an in-flight batch. The async compiler's signal applies to both modeling and scene resolution. Headless execution uses the CPU reference; Studio supplies the GPU implementation. A GPU failure is reported and does not silently rerun modeling on the CPU. Per-run operation diagnostics are available in `run.modeling3`.
