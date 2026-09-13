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

Each execution retains its classified scene results in `run.scenes3`. Repeating the same scene value within that execution reuses its visibility calculation. Cross-execution model/camera caching, the main Studio 3D viewport, and the public GPU modeling toolkit are still being integrated.
