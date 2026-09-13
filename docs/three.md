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

## Points, edges and instances

`PointSelection3(surface)` captures point positions, attributes, original-edge neighbors and boundary status. `EdgeSelection3(surface)` captures original polygon edges with endpoints, center, length, incident faces and attributes; triangulation diagonals are excluded. Both support iteration, `filter`, `map`, `groupBy` and `union`. Derive selections from one captured selection before unioning them. Point `adjacent()` follows original edges; edge `points()` selects its endpoints.

`editPoints3(surface, selection, callback)` returns an owned surface with optional position and attribute replacements. `editEdges3(surface, selection, callback)` replaces selected edge attributes. Every callback reads frozen rows from the edit's input; all patches commit after the callbacks finish. Omitted point fields stay unchanged; supplied attribute objects replace that row's attributes, so spread existing attributes to retain them. IDs and fixed triangulation survive these edits. A selection from a previous surface value cannot edit a later value. Selection predicates retain their captured measurements even if the original editable geometry changes.

`pointCloud3(positions)` makes editable point-only data, with no implied edges or faces. Interpret those points explicitly as an open polyline through a scene wire's `points` array. Scene objects can share a surface and set individual `transform: { translate, rotate, scale, origin }` values. Those transforms act in world space before projection; rotations are XYZ degrees and mirrored scales preserve winding. A scene captures a shared surface once, so later edits to that source do not alter its instances.

```ts live
import { sketch, box3, PointSelection3, EdgeSelection3, editPoints3, editEdges3, pointCloud3, lineArt3, FeatureKind3, pen, mm } from 'occlude';

export default sketch({ pens: {
  outline: pen({ width: mm(0.3), color: '#18202A' }),
  accent: pen({ width: mm(0.4), color: '#A84932' }),
} }, t => {
  let shape = box3([1.3, 1.3, 1.3]);
  const top = new PointSelection3(shape).filter(p => p.position[2] > 0);
  shape = editPoints3(shape, top, p => ({ position: [p.position[0] + 0.25, p.position[1], p.position[2] + 0.4] }));
  const rim = new EdgeSelection3(shape).filter(e => e.center[2] > 1);
  shape = editEdges3(shape, rim, e => ({ ...e.attributes, marked: true }));
  const samples = pointCloud3(t.times(25, (_, u) => [6 * u - 3, -0.6, 1.1 + 0.4 * Math.sin(u * Math.PI * 2)]));
  return lineArt3({
    objects: [
      { id: 'left', surface: shape, transform: { translate: [-1.5, 0, 0] } },
      { id: 'right', surface: shape, transform: { translate: [1.5, 0, 0], rotate: [0, 0, 25], scale: [-1, 1, 1] } },
    ],
    wires: [{ id: 'gesture', points: samples.points.map(p => p.position) }],
    camera: { kind: 'orthographic', span: 6.5, eye: [4, 7, 6], target: [0, 0, 0.5], near: 0.1, far: 30 },
    lineSets: [
      { id: 'visible', stroke: 'outline' },
      { id: 'marked', stroke: 'accent', priority: 1, select: f => (f.flags & FeatureKind3.marked) !== 0 },
    ],
  });
});
```

## Reusing visibility and styling strokes

`await t.classify3(scene)` resolves a captured scene to immutable feature records and visible/hidden parameter intervals. Repeated requests for the same scene within an execution share both pending work and completed results. `FeatureSelection3(classified).filter(...)` selects those records; a line set can use that selection directly. Selections from another classified snapshot are rejected.

`constructStrokes3(classified, lineSets, options)` returns inspectable projected stroke data: source parts/parameters, points, cumulative paper arclength, length, closure and break reasons. Use `{ chain: false }` to retain separate segments, or the default source-based chaining. Building another style from the same classified data does not dispatch visibility again.

`t.strokes3(strokes, { modifiers })` explicitly draws projected data through the current paper frame and the ordinary Occlude modifier stack. Projected coordinates remain physical paper millimetres. A group transforms the finished 2D drawing, so a second placement can reuse the same classification. The complete selected source chain anchors modifier distances and sampling before visibility cuts. Both `dash → wobble` and `wobble → dash` keep their phase through hidden intervals and paper cropping. `reference.points` and `sourceRanges` retain that relationship alongside each run's visible points. Near/far clipping currently defines the available source anchor; arbitrary source geometry behind the eye is not projected. Topology-changing pre-stage modifiers (`smooth`, `roughen`, `deform`) are not applicable to this source-linked interpretation; edit the model before classifying instead.

```ts live
import { sketchAsync, paper, pen, mm, box3, lineArt3, FeatureSelection3, FeatureKind3, constructStrokes3, group, label, dash, wobble } from 'occlude';

export default sketchAsync({
  paper: paper({ width: mm(200), height: mm(200) }), seed: 42,
  pens: { outline: pen({ width: mm(0.3), color: '#18202A' }), hidden: pen({ width: mm(0.2), color: '#A84932' }) },
}, async t => {
  const scene = lineArt3({
    objects: [{ id: 'box', surface: box3([1.4, 1.4, 1.4]) }],
    camera: { kind: 'orthographic', span: 3.8, eye: [5, 7, 6], target: [0, 0, 0], near: 0.1, far: 30 },
    viewport: { x: 10, y: 25, width: 80, height: 140 }, lineSets: [],
  });
  const classified = await t.classify3(scene);
  const features = new FeatureSelection3(classified);
  const visible = constructStrokes3(classified, [{ id: 'visible', stroke: 'outline', select: features }]);
  const hidden = constructStrokes3(classified, [{ id: 'hidden', stroke: 'hidden', visibility: 'hidden' }]);
  const contour = constructStrokes3(classified, [{ id: 'contour', stroke: 'outline', select: features.filter(row => (row.feature.flags & FeatureKind3.silhouette) !== 0) }]);
  return [
    t.strokes3(visible, { modifiers: [wobble({ amount: mm(0.12), wavelength: mm(8) })] }),
    t.strokes3(hidden, { modifiers: [dash(mm(2), mm(1))] }),
    group({ translate: [mm(100), 0] }, t.strokes3(contour)),
    label('EDGES / HIDDEN', 5, 95, 3), label('SILHOUETTE', 55, 95, 3),
  ];
});
```


## Phase through hidden intervals

These three copies share one classification. The rust-colored interval is behind the box; it uses the same source anchor as the visible ink. The second and third rows show that modifier order matters without restarting the pattern at the occluder. The paper adapter carries source selections through the ordinary planner and SVG export, including gaps smaller than the usual bridge tolerance.

```ts live
import { sketchAsync, paper, pen, mm, box3, lineArt3, constructStrokes3, group, label, dash, wobble } from 'occlude';

export default sketchAsync({
  paper: paper({ width: mm(200), height: mm(180) }), margin: 0, seed: 42,
  pens: { ink: pen({ width: mm(0.35), color: '#18202A' }), hidden: pen({ width: mm(0.35), color: '#A84932' }) },
}, async t => {
  const classified = await t.classify3(lineArt3({
    camera: { kind: 'orthographic', span: 10, eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], near: 0.1, far: 10 },
    viewport: { x: 0, y: -60, width: 200, height: 200 },
    objects: [{ id: 'blocker', surface: box3([1.6, 1, 1]), lineSource: false }],
    wires: [{ id: 'wire', points: [[-4, 0, 0], [0, 0, 0], [4, 0, 0]] }], lineSets: [],
  }));
  const visible = constructStrokes3(classified, [{ id: 'visible', stroke: 'ink' }]);
  const hidden = constructStrokes3(classified, [{ id: 'hidden', stroke: 'hidden', visibility: 'hidden' }]);
  const dashes = dash(mm(7), mm(4));
  const tremor = wobble({ amount: mm(2), wavelength: mm(15) });
  return [
    label('DASH', 10, 12, 3, { stroke: 'ink' }),
    t.strokes3([...visible, ...hidden], { modifiers: [dashes] }),
    label('WOBBLE / DASH', 10, 40, 3, { stroke: 'ink' }),
    group({ translate: [0, mm(50)] }, t.strokes3([...visible, ...hidden], { modifiers: [tremor, dashes] })),
    label('DASH / WOBBLE', 10, 68, 3, { stroke: 'ink' }),
    group({ translate: [0, mm(100)] }, t.strokes3([...visible, ...hidden], { modifiers: [dashes, tremor] })),
  ];
});
```
