# 3D line art

Build geometry in world coordinates, then return `lineArt3(...)` beside ordinary shapes. The camera projects geometry into the sketch's drawable frame. Studio computes hidden lines on its worker's WebGPU device and sends the resulting strokes through the same pen, preview, planning and export pipeline as 2D drawings.

```ts live
import { sketch, lineArt3, box3, label, pen, mm } from 'occlude';

export default sketch({
  seed: 42,
  cameras3: { boxes: { kind: 'orthographic', span: 4.5, eye: [5, 7, 6], target: [0, 0, 0], near: 0.1, far: 30 } },
  pens: { outline: pen({ color: '#18202A', width: mm(0.3) }) },
}, () => [
  lineArt3({
    id: 'boxes',
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

A scene's optional `id` names its camera in `sketch({ cameras3: { [id]: camera } }, ...)`. That configuration overrides the scene's default camera before classification, in both Studio and headless rendering. Scene IDs must be unique and cannot start with `@`. Unnamed scenes receive `@1`, `@2`, and so on in classification-request order; name scenes explicitly when their order can change. The scene value keeps its declared default camera; the classified `frame.camera` is the effective captured view.

The default coordinate system is right-handed with Z up. Camera `eye`, `target`, and optional `up` use world coordinates. Orthographic cameras require `span`; perspective cameras require `fovDegrees`. Both require positive `near` and a greater `far`. Camera span and FOV control apparent scale independently of paper units.

A camera's optional `viewport` belongs on the scene and uses absolute paper millimetres: `{ x, y, width, height }`. Otherwise the sketch's aspect and margins determine its rectangle. Sketch `origin` and `yUp` conventions remain valid. Ordinary groups transform the **projected drawing**; change world positions before making the scene to transform the model itself. Ordinary clips, masks, labels, and named pens compose in returned tree order. Resolved 3D strokes do not become opaque regions.

## Selecting lines

Each line set has a unique `id`, named `stroke`, optional `select(feature)`, and `visibility: 'visible' | 'hidden'` (default visible). Higher `priority` owns overlapping source intervals; `overdraw: true` explicitly retains duplicates. Selection callbacks read captured feature rows and must be pure. Features retain object/source IDs, flags, crease angle, edge attributes and incident face attributes. Crease angles are measured in world geometry independently of the camera. Exactly coplanar neighboring triangles have no crease; flat ground-cell seams are omitted by a crease/silhouette/boundary selector, while tower-to-ground folds and outer boundaries remain eligible. Visibility then removes portions hidden by the model.

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

`constructStrokes3(classified, lineSets, options)` returns inspectable projected stroke data: source parts/parameters, points, cumulative paper arclength, length, closure and break reasons. Use `{ chain: false }` to retain separate segments, or the default source-based chaining. Building another style from the same classified data does not dispatch visibility again. `classified.stats` reports candidates, dispatches, refinements, transferred bytes and wall time. On a GPU with timestamp-query support, optional `gpuMs` records the summed visibility compute-pass time; it excludes upload, readback, CPU refinement and finishing. An absent value means timing is unavailable, while zero can reflect a very short or empty workload. Use total wall time to judge interaction performance.

`t.strokes3(strokes, { modifiers, pass? })` explicitly draws projected data through the current paper frame and the ordinary Occlude modifier stack. Projected coordinates remain physical paper millimetres. Seeded effects derive their key from the source-chain identity, line-set/pen identity and optional nonempty `pass` string, together with the sketch seed. Reordering emitted rows or filtering unrelated sources does not reshuffle decimation or noise. Use distinct pass IDs for deliberately different repeated interpretations; the default pass repeats the same pattern. Changing the selected chain's topology can change its identity. A group transforms the finished 2D drawing, so a second placement can reuse the same classification. The complete selected source chain anchors modifier distances and sampling before visibility cuts. Both `dash → wobble` and `wobble → dash` keep their phase through hidden intervals and paper cropping. `reference.points` and `sourceRanges` retain that relationship alongside each run's visible points. Near/far clipping currently defines the available source anchor; arbitrary source geometry behind the eye is not projected. Topology-changing pre-stage modifiers (`smooth`, `roughen`, `deform`) are not applicable to this source-linked interpretation; edit the model before classifying instead.

```ts live
import { sketch, paper, pen, mm, box3, lineArt3, drawing3, FeatureSelection3, FeatureKind3, constructStrokes3, group, label, dash, wobble } from 'occlude';

export default sketch({
  paper: paper({ width: mm(200), height: mm(200) }), seed: 42,
  pens: { outline: pen({ width: mm(0.3), color: '#18202A' }), hidden: pen({ width: mm(0.2), color: '#A84932' }) },
}, () => {
  const scene = lineArt3({
    objects: [{ id: 'box', surface: box3([1.4, 1.4, 1.4]) }],
    camera: { kind: 'orthographic', span: 3.8, eye: [5, 7, 6], target: [0, 0, 0], near: 0.1, far: 30 },
    viewport: { x: 10, y: 25, width: 80, height: 140 }, lineSets: [],
  });
  return drawing3(scene, (classified, t) => {
    const features = new FeatureSelection3(classified);
    const visible = constructStrokes3(classified, [{ id: 'visible', stroke: 'outline', select: features }]);
    const hidden = constructStrokes3(classified, [{ id: 'hidden', stroke: 'hidden', visibility: 'hidden' }]);
    const contour = constructStrokes3(classified, [{ id: 'contour', stroke: 'outline', select: features.filter(row => (row.feature.flags & FeatureKind3.silhouette) !== 0) }]);
    return [
      t.strokes3(visible, { pass: 'expressive', modifiers: [wobble({ amount: mm(0.12), wavelength: mm(8) })] }),
      t.strokes3(hidden, { modifiers: [dash(mm(2), mm(1))] }),
      group({ translate: [mm(100), 0] }, t.strokes3(contour)),
      label('EDGES / HIDDEN', 5, 95, 3), label('SILHOUETTE', 55, 95, 3),
    ];
  });
});
```


`drawing3(scene, (classified, t) => tree)` retains the paper interpretation as a pure callback. Its `t.strokes3` is bound to the current drawing's paper frame. Build models and consume random draws before this callback; select and style the supplied classified snapshot inside it. Returning ordinary labels, groups, clips and masks preserves paper composition order.

For headless or host integration, `await commitCamera3(run, scene, camera, { compute3?, signal? })` returns a new execution ready for `render(...)`. It never calls the original sketch function: world geometry is shared, the changed scene is classified again, and unaffected scenes reuse their classification. The new run captures the explicit camera, resolved paper and pens. The previous run remains exportable and unchanged. Use a scene from the new run's `scenes3` map for a subsequent commit.

A returned `lineArt3` node is already retained. Eager `t.strokes3(...)` output is fixed projected data tied to its original view; camera commitment rejects such edits for the changed scene. Use `drawing3` when the interpretation should run again for a new view. Callbacks and their captured style functions must remain pure. Studio's **Commit view** control uses this retained composition path.


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


## Plane-section contours

`section3(surface, planes, { tolerance?, maxSegments? })` intersects fixed mesh triangles with planes `{ id, origin, normal, attributes? }` in the surface's model coordinates. It returns inspectable segments, barycentric source positions, supporting triangle indices and an owned frozen `surface`. Pass that exact surface and the returned `curves` together to a scene object. A later model edit requires new sections; the renderer rejects curves paired with another surface. Object transforms move the captured surface and its curves together. To cut with world-space planes, transform the mesh before generating its sections.

Select `FeatureKind3.section` to style these curves. Section features carry `sectionPlane`, plane attributes and the supporting faces' attributes. Other faces of the same object can still occlude them. Coplanar patches contribute their boundary, without internal triangulation diagonals; isolated tangent vertices produce no stroke. Folded faces are intersected as their fixed triangles. Source endpoint IDs connect compatible pieces, so a triangulation crossing does not introduce a dash restart.

The default zero-distance tolerance is `64 * Number.EPSILON` times the largest mesh coordinate relative to the plane origin. An explicit `tolerance` uses model units. Vertices inside that tolerance are treated as on-plane; no arbitrary vertex relocation occurs. `maxSegments` bounds intermediate candidate segments (default one million); exceeding it throws instead of dropping curves.

```ts live
import { sketchAsync, grid3, FaceSelection3, extrudeFaces3, section3, lineArt3, FeatureKind3, label, pen, mm } from 'occlude';

export default sketchAsync({ seed: 42, pens: {
  outline: pen({ width: mm(0.3), color: '#18202A' }),
  sections: pen({ width: mm(0.25), color: '#A84932' }),
} }, async t => {
  let surface = grid3(6, 6, [4, 4]);
  surface.faces.forEach(face => { face.attributes.height = t.rnd(0.5, 1.5); });
  const selected = new FaceSelection3(surface).filter(f => f.index % 6 % 2 === 0 && Math.floor(f.index / 6) % 2 === 0);
  surface = extrudeFaces3(surface, selected, f => Number(f.attributes.height), { operation: 'section-towers' });
  const curves = section3(surface, [0.2, 0.4, 0.6, 0.8, 1, 1.2].map((height, i) => ({
    id: `level-${i}`, origin: [0, 0, height], normal: [0, 0, 1], attributes: { height },
  })));
  return [lineArt3({
    objects: [{ id: 'relief', surface: curves.surface, curves }],
    camera: { kind: 'orthographic', span: 5.5, eye: [5, 7, 6], target: [0, 0, 0.4], near: 0.1, far: 30 },
    lineSets: [
      { id: 'edges', stroke: 'outline', select: f => (f.flags & (FeatureKind3.crease | FeatureKind3.silhouette | FeatureKind3.boundary)) !== 0 },
      { id: 'sections', stroke: 'sections', select: f => (f.flags & FeatureKind3.section) !== 0 && f.faceAttributes.some(a => Number(a.height) > 0.7) },
    ],
  }), label('MODEL SECTIONS', 8, 94, 4, { stroke: 'outline' })];
});
```


## Surface hatch and crosshatch

`hatch3(surface, families, { maxSegments? })` captures a per-face pattern recipe. `families` is an array or a callback from a frozen face measurement to an array; return `[]` to leave a face unhatched. Each family has a unique `id`, `spacing`, paper-space `angle` in clockwise degrees, optional `offset`, and optional attributes. Add a second family for crosshatch. The callback runs once during capture, so model attributes can control density or direction without another callback during camera changes.

Pair `surface: hatch.surface` and `hatch` on the scene object. Generation waits until the camera and drawable paper frame are known. `mm(1)` means one millimetre between paper rulings; bare numbers and other length tags use the ordinary drawable units, even with a custom scene viewport. The pattern is view-dependent and is regenerated from its captured recipe for a different camera. Changing only a selector, pen or stroke modifier reuses classified geometry.

Rulings share one paper-origin lattice across every triangle of a modeled face. Each segment is lifted onto its supporting triangle with perspective-correct source weights. Folded faces therefore have piecewise surface support; this is not curvature-following hatch. Edge-on projected triangles produce no hatch. Coincident outer boundary strokes are omitted, and no page-side cull removes possible style overscan. Candidate segments and ruling iterations are bounded by `maxSegments` (default one million); increase spacing or that explicit budget if generation exceeds it.

Select `FeatureKind3.hatch`. Captured feature records retain `hatchFamily`, `hatchFace`, `hatchLine`, resolved `hatchSpacingMm`, family attributes and source face attributes. A generated feature's `curve` contains inspectable model-space endpoint positions, barycentric weights and supporting triangle indices before camera clipping. Hatch and sections can share the same immutable source: generate sections first, then pass `sections.surface` to `hatch3`. Trusted immutable snapshots are reused rather than copied again.

This example declares its square sheet and margin so its downloaded source uses the same paper mapping when reopened.

```ts live
import { sketchAsync, grid3, FaceSelection3, extrudeFaces3, transformSurface3, section3, hatch3, lineArt3, drawing3, FeatureKind3, constructStrokes3, clip, rect, mask, label, paper, pen, mm } from 'occlude';

export default sketchAsync({ seed: 42, paper: paper({ width: mm(200), height: mm(200) }), margin: 5, pens: {
  outline: pen({ width: mm(0.3), color: '#18202A' }),
  fine: pen({ width: mm(0.18), color: '#56626A' }),
  accent: pen({ width: mm(0.25), color: '#A84932' }),
} }, async t => {
  let surface = grid3(6, 6, [4, 4]);
  surface.faces.forEach(face => {
    face.attributes.height = t.rnd(0.5, 1.5);
    face.attributes.spacing = t.rnd(1.5, 2.5);
  });
  const selected = new FaceSelection3(surface).filter(f => f.index % 6 % 2 === 0 && Math.floor(f.index / 6) % 2 === 0);
  surface = extrudeFaces3(surface, selected, f => Number(f.attributes.height), { operation: 'hatched-towers' });
  surface = await t.deform3(surface, { iterations: 8, relaxation: 0,
    displacements: surface.points.map(p => p.position[2] > 0 ? [0.003 * Math.sin(p.position[1]), 0.002 * Math.cos(p.position[0]), 0] : [0, 0, 0]),
  });
  const ceiling = transformSurface3(grid3(1, 1, [8, 8]), { translate: [0, 0, 1.1] });
  const hits = await t.querySurface3(ceiling, { nearest: surface.points.map(p => ({ point: p.position })) });
  surface.points.forEach((p, i) => { const hit = hits.nearest[i]; if (hit && p.position[2] > hit.point[2]) p.position = hit.point; });
  const sections = section3(surface, [0.2, 0.4, 0.6, 0.8].map((height, i) => ({ id: `level-${i}`, origin: [0, 0, height], normal: [0, 0, 1] })));
  const hatch = hatch3(sections.surface, face => {
    if (face.attributes.role !== 'side' && face.attributes.role !== 'cap') return [];
    const spacing = Number(face.attributes.spacing);
    return [
      { id: 'shade', spacing: mm(spacing), angle: face.normal[2] > 0.5 ? 35 : -35 },
      ...(face.normal[2] > 0.5 ? [{ id: 'cross', spacing: mm(spacing * 2), angle: -35 }] : []),
    ];
  });
  const scene = lineArt3({
    objects: [{ id: 'relief', surface: hatch.surface, hatch, curves: sections }],
    camera: { kind: 'orthographic', span: 5.5, eye: [5, 7, 6], target: [0, 0, 0.4], near: 0.1, far: 30 }, lineSets: [],
  });
  return drawing3(scene, (classified, t) => {
    const strokes = constructStrokes3(classified, [
      { id: 'edges', stroke: 'outline', select: f => (f.flags & (FeatureKind3.crease | FeatureKind3.silhouette | FeatureKind3.boundary)) !== 0 },
      { id: 'hatch', stroke: 'fine', select: f => (f.flags & FeatureKind3.hatch) !== 0 },
      { id: 'sections', stroke: 'accent', select: f => (f.flags & FeatureKind3.section) !== 0 },
    ]);
    return [
      clip(rect(4, 4, 92, 84), t.strokes3(strokes)),
      mask(rect(60, 75, 32, 13)),
      label('HATCH / SECTIONS', 61, 78, 2.5, { stroke: 'outline' }),
      label('PAPER SPACING', 61, 83, 2, { stroke: 'outline' }),
      label('SURFACE STUDY', 8, 94, 4, { stroke: 'outline' }),
    ];
  });
});
```

## Construction view in Studio

Open any live example above in Studio, then choose **3D** above the paper view. Drag to orbit, scroll to zoom, and click a mesh face to inspect its source ID and captured modeling attributes. The scene menu selects among the sketch's captured 3D scenes. **Reset camera** restores that scene's committed camera; **Copy camera** copies explicit camera values for use in the sketch.

Construction keeps normalized world-space mesh and wire buffers on the GPU. Orbit updates a camera uniform; depth testing and camera clipping happen in the construction shader. Orbiting does not rerun modeling, surface queries or vector visibility, and does not change the committed paper drawing or its exports. Returning to the paper view shows the same cached result. **Commit view** classifies the explored camera against retained geometry and publishes a new vector drawing, preserving labels, clipping and styles. It does not rerun modeling. **Commit view** also writes the camera into `cameras3` in the editor without running the model again. Save or download the sketch to keep that configuration; rerendering or reopening it uses the committed camera. **Save result** captures the exact camera and drawing without requiring regeneration. Saved results preserve the camera actually used by their plan.

**Save result** preserves the selected plan and its exact SVG, resolved paper color, pens and timing settings. A 3D result also retains the committed camera frame, realized source meshes and attributes, generated curve attachments, compiled source, seed, engine and available GPU adapter details. Reopening that result uses its saved plan; it does not rerun deformation or read a new camera from the editor. Library changes do not replace the captured pens or paper. Construction preview cameras are exploratory and are not substituted for the committed camera in this record.

GPU interval refinement uses a physical paper budget of `min(0.005 mm, narrowest resolved nib / 20)`. All pens available to the execution count, because a retained classification can later be interpreted with another pen. Half the budget goes to interval endpoints; the other half is reserved for double-precision projection. Polygon triangles and authored straight segments introduce no smooth-surface tessellation approximation. The host converts the interval allocation into a source-parameter tolerance using the greatest projected speed along the clipped features, including perspective depth changes and off-page geometry. Uncertain GPU cuts are refined on the CPU. Classification statistics report `paperToleranceMm` and `parameterTolerance`.

This budget is measured before the planner's existing input snap and is not a guarantee for arbitrary numeric magnitudes: double precision cannot recover detail already lost in the supplied coordinates. Paper size, camera and pen changes belong to the execution; a camera commit recomputes the projection-dependent tolerance. Pixel dimensions of the construction preview do not control vector precision.
