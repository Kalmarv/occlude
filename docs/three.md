# 3D line art

Ordinary sketches import their 3D vocabulary from `occlude/3d`: `plane`, `box`, `sphere`, `cylinder`, `cone`, `torus`, `mesh`, `sweep`, `revolve` and point `grid` build geometry; `subdivide`, `displace`, `steps`, `extrude` and attribute fields edit it as immutable values; `instanceOnPoints` repeats it; `intersections`, `mapSurface`, `isolines`, `trace` and `t.hatch` derive supported curves on it; `view` projects everything through a camera into the sketch's drawable frame, where ordinary `strokes`, clips, masks, labels and named pens apply. Nothing draws itself: geometry and marks stay inspectable data until a view interprets them. Hidden lines are computed by the exact geometric classifier on the CPU, in Studio's worker as in headless rendering, so both produce the same strokes; Studio's WebGPU device serves surface evaluation and the construction viewport. The strokes go through the same pen, preview, planning and export pipeline as 2D drawings. The explicit scene stages (`lineArt3`, feature masks, classification) remain available for advanced work at the end of this page.

## Procedural mesh values

Import the ordinary 3D vocabulary from `occlude/3d`. `plane(width = 1, height = width)` creates four points, four edges and one +Z quad centered in XY. `box(size = 1)` accepts a scalar or a dimension triple. `mesh(points, faces)` takes ownership of validated polygon topology. `obj(text)` reads a Wavefront OBJ file from a modeller into the same value, stood upright from the file's Y-up frame. Each returns the same immutable mesh value with `.points`, `.edges` and `.faces` collections.

`subdivide(levels = 1)` preserves the represented surface: planar convex quads split into four quads, triangles into four triangles, and concave or folded polygons refine their validated triangles. Shared edges get one midpoint. A plane at level five has 32×32 quads. It does not smooth a box or push points onto an analytic sphere. The entire request is checked before allocation; defaults are 250,000 faces and 500,000 points, configurable with `{ maxFaces, maxPoints }`. The point budget uses a conservative upper bound.

Point rows expose `id`, `index`, `x/y/z` and immutable attributes both by name and through `.attributes`. `attribute(name, field)` preserves types in later fields; `{ transfer: 'nearest' }` protects numeric categories during refinement. Continuous numbers and numeric vectors interpolate. Other categories choose the first contributor in canonical ID order; missing columns remain missing. Child faces inherit attributes, and child boundary edges copy their parent's edge attributes. Newly introduced interior edges have no edge attributes, so their typed values are optional. Parent IDs remain available as provenance. Built-in row names—including coordinates, `id`, `index`, `attributes`, `normal`, `area` and `length`—are reserved.

`displace(field)` is one immutable displacement pass: a triple per point, or a number along the vertex normal (`{ along: 'z' }` or a triple picks another direction). `steps(count, (current, next, k) => …, { every })` accumulates edits while reads remain frozen; the everyday step is the shorthand `steps(count, { move: p => [dx, dy, dz], set })` (a numeric move follows the vertex normal), which desugars to that rule over every point. Select from `current.points` inside each pass; a prior revision's selection is rejected. History includes the initial state, every requested completed iteration and the final state, with continuing `.iteration` counts. Fields run as ordinary synchronous JavaScript; they are not implicitly compiled into GPU shaders.

```ts live
import { sketch, paper, pen, mm, inch } from 'occlude';
import { plane, box, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, paper: paper({ width: inch(8.5), height: inch(11), color: '#F5F0E6' }), pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  shade: pen({ width: mm(0.18), color: '#A84932' }),
} }, t => {
  const terrain = plane(5, 5).subdivide(3)
    .attribute('mobility', p => Math.max(0, 1 - Math.hypot(p.x, p.y) / 3))
    .displace(p => [0, 0, t.noise(p.x * 0.7, p.y * 0.7) * 0.7])
    .steps(4, (current, next, k) => {
      next.move(current.points, p => [0, 0, Math.sin(p.x + k * 0.1) * p.mobility * 0.03]);
    });
  return view([terrain, box([0.9, 0.9, 1.8]).translate([0, 0, 1])], {
    camera: orthographic({ eye: [6, 8, 5], target: [0, 0, 0], span: 10 }),
    stroke: 'ink',
    hatch: { spacing: mm(2), angle: 35, stroke: 'shade' },
  });
});
```

`view` is the explicit drawing boundary. It automatically captures geometry and hatch ownership and retains its interpretation for camera commits. Default ink includes visible boundaries, silhouettes and creases of at least 30°. Set `creaseAngle` in degrees on the view to change that default, or on an object to give it its own threshold: `torus(1.2, 0.1, { creaseAngle: 180 })` or `mesh.style({ creaseAngle: 60 })`; instances take their prototype's. 180 never draws an object's creases (smooth shading), 0 draws every fold. An object can likewise carry its own pen, `sphere(7, { stroke: 'fine' })` or `mesh.style({ stroke: 'fine' })`: the default drawing uses it for that object's lines and for its hatch where the recipe names no pen, and the view's `stroke` covers the rest. `style(geometry, { stroke, fillPen, creaseAngle })` is the one place to say how things are drawn: on a value or a list of them (`style(rings, { fillPen: 'red', creaseAngle: 180 })` returns the styled list), setting the fields named and keeping the rest, so styles compose. A mesh scaled by zero on any axis becomes nothing: no faces, drawing and hiding nothing, so a loop that passes through zero carries on. `orthographic` defaults to span 6 and `perspective` to a 45° vertical FOV; both require an eye and default their target to the origin, near distance to 0.1, and far distance to at least 100 (expanded for distant cameras). Explicit near/far values remain available.

Collections support iteration, `find`, `some`, `every`, `filter`, `map`, `groupBy` and `extract`. `has(row)` checks an actual owned row, not a copied object or matching ID. `union`, `intersect` and `subtract` require the same source revision and domain; their results follow source order. `complement()` selects the remaining rows of the complete source domain, including when called on a filtered group. Groups are selections with a `.key`. Face extraction retains shared mesh topology; extracting points produces point geometry and extracting edges produces curve data. Those types do not claim editable mesh faces. `faceAttribute` and `faceAttributes` store face fields; `edgeAttribute` stores edge fields. Transforms return new values and pivot on the object's own `origin`, which primitives are born with at the world origin and `translate` carries along: `.translate(triple)`, `.rotate(degreesTriple)` or `.rotate('z', degrees, { about?: 'origin' | 'world' | triple, local?: true })`, and `.scale(scalarOrTriple, { about? })`. A `local` rotation reads its axis in the object's accumulated `orientation`; a bare `rotate([0, 0, 90])` turns the object where it stands, not around the world. Turning or scaling about another pivot carries the origin along with the rest of the object, so the next default rotation still turns in place. Keys: values are matched between renders by their position in the sketch's evaluation order, which is enough for ordinary sketches. When that order is unstable (a loop whose count changes, a conditional branch), a factory `{ key }` option or `.withKey(key)` gives a value a stable identity; `view` and the curve derivations accept `key` the same way. Keys never change the ink, only what Studio can carry across edits.

## Interpreting projected intervals

An optional `view` callback replaces default ink emission. `lines.visible` and `lines.hidden` contain classified intervals, with readable `.kinds` sets, original features, support and captured attributes. `strokes` accepts these collections directly and retains the full source reference through filtering, physical-paper conversion, clipping and supported post modifiers. It does not flatten them into anonymous contours. `stroke:`, group pen defaults and ordinary clips/masks keep their usual meanings.

```ts live
import { sketch, pen, mm, strokes, dash, clip, rect } from 'occlude';
import { box, view, perspective } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  hidden: pen({ width: mm(0.15), color: '#A84932' }),
} }, () => clip(rect(5, 5, 90, 90), view([
  box([2.8, 1.4, 1.4]),
  box([0.9, 0.9, 2.6]).translate([0.5, 0.2, 0.5]),
], {
  camera: perspective({ eye: [5, 7, 6], target: [0, 0, 0.3], fovDegrees: 25 }),
}, lines => [
  strokes(lines.visible, { stroke: 'ink' }),
  strokes(lines.hidden.filter(c => c.kinds.has('crease')), {
    stroke: 'hidden', modifiers: [dash(mm(2), mm(1))],
  }),
])));
```

Custom interpretation callbacks may rerun for a camera change. Keep them pure: capture stable geometry/style inputs and do not consume mutable RNG or mutate outside state. JavaScript closures cannot be magically serialized or snapshotted. Already classified projected collections remain bound to their source camera; using them outside a retained callback requires reclassification when that camera changes. Advanced access to the same renderer and `projectedLines(classified)` is available through `occlude/3d/advanced`.

### Curved primitives

`sphere(radius = 1, {segments = 32, rings = 16, key?})` uses shared latitude
rings and one point at each pole. `rings` counts pole-to-pole bands (minimum
2); angular segment counts are integers of at least 3.

`cylinder(radius = 1, height = 2, {segments = 32, caps = true, key?})` and
`cone(radius = 1, height = 2, {segments = 32, caps = true, key?})` are centered
on the Z axis, from `-height/2` to `+height/2`. The cone's apex is at the top.
Caps share their rim points with the sides; `caps: false` leaves open rims.

`torus(radius = 1, tubeRadius = 0.25, {segments = 32, tubeSegments = 12, key?})`
lies in XY. Its radius measures the tube centerline, so its outer radius is
`radius + tubeRadius`. The tube radius must be smaller than the centerline
radius; self-intersecting and pinched tori are not accepted.

These are ordinary polygon meshes. They support the same attributes,
selections, transforms, frozen steps and subdivision as imported geometry.
Increasing construction resolution samples the curved form more closely;
`.subdivide()` preserves the existing polygon surface and does not round it.
Seams share points and render triangulation does not add authoring edges.
Dimensions must be positive and finite. Primitive size is unlimited by default;
an explicit `maxPoints`/`maxFaces` is checked before generating arrays.

```ts live
import { sketch, pen, mm } from 'occlude';
import { sphere, cylinder, cone, torus, view, orthographic } from 'occlude/3d';
export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  shade: pen({ width: mm(0.18), color: '#A84932' }),
} }, () => view([
  sphere(0.7, { segments: 16, rings: 8 }).translate([-1.2, -1.2, 0.8]),
  cylinder(0.6, 1.6, { segments: 16 }).translate([1.2, -1.2, 0.8]),
  cone(0.7, 1.8, { segments: 16 }).translate([-1.2, 1.2, 0.9]),
  torus(0.65, 0.22, { segments: 16, tubeSegments: 8 }).translate([1.2, 1.2, 0.5]),
], {
  camera: orthographic({ eye: [6, 8, 7], target: [0, 0, 0.5], span: 7.5 }),
  stroke: 'ink', hatch: { spacing: mm(2), angle: 35, stroke: 'shade' },
}));
```

The terrain acceptance sketch combines the same workflow with a sphere and
explicit Letter paper.

```ts live
import {sketch,paper,pen,mm,inch} from 'occlude';
import {plane,sphere,view,orthographic} from 'occlude/3d';
export default sketch({seed:42,paper:paper({width:inch(8.5),height:inch(11),color:'#F5F0E6'}),margin:5,pens:{ink:pen({width:mm(.3),color:'#18202A'}),shade:pen({width:mm(.18),color:'#A84932'})}},t=>{
  const terrain=plane(6,6).subdivide(5)
    .attribute('mobility',p=>Math.max(0,1-Math.hypot(p.x,p.y)/3))
    .displace(p=>[0,0,t.noise(p.x*.7,p.y*.7)*.8])
    .steps(8,(current,next,k)=>next.move(current.points,p=>[0,0,Math.sin(p.x+k*.1)*p.mobility*.01]));
  return view([terrain,sphere(.8).translate([0,0,1.6])],{
    camera:orthographic({eye:[6,8,5],target:[0,0,0],span:12}),stroke:'ink',
    hatch:{spacing:mm(1.4),angle:35,stroke:'shade'},
  });
});
```

### Instances on points

`instanceOnPoints(prototype, points, {scale?, rotate?, offset?, key?})` places
one shared mesh prototype at every selected point. The optional fields read
the source point rows. Scale accepts a scalar or triple; rotation accepts XYZ
Euler degrees or a rotation value about the prototype origin; offset is added to the point's world
position. The resulting value owns transforms and attributes and retains its
source rows. No prototype topology is copied while placing or editing instances.

Use `.instances` for `map`, `filter`, `groupBy` and `extract`. Each row contains
`id`, `index`, `source`, `transform`, an attribute map, and flattened attributes
copied from its source point. `.attribute(name, field)` adds or replaces a typed
instance column. `.transform(field)` replaces the supplied `translate`,
`rotate` or `scale` components and retains omitted components; `.translate(field)`
adds a world-space displacement. Scale, then rotation, then translation apply
to the prototype. These edits return a new instance value and reuse its mesh.
The row name `transform` is reserved in addition to the ordinary mesh row names.

`view(instances, options)` accepts instances directly, including in arrays with
ordinary meshes. Hatch eligibility is selected once on prototype faces; the
paper hatch lattice is resolved for each transformed instance. Feature
attributes include instance columns; projected rows expose `.instance` with
placement ID, source point ID/index and optional prototype key. Prototype
edge/curve columns take
precedence on collisions. Rendering computes transformed coordinates and
visibility for each object; sharing authoring geometry is not a claim of GPU
instanced drawing or a visibility speedup.

`.realize({maxPoints?, maxFaces?})` explicitly produces one ordinary mesh with
a disconnected copy of each instance's topology. It preserves shared edges
within each copy, mirrors winding for negative scales, and records prototype,
instance and source-point IDs in derived provenance. Instance attributes are
copied to the point/edge/face domains; existing prototype columns win collisions.
Realization derives new IDs deterministically; selecting a subset preserves
those IDs. Realization is unlimited by default; an explicit `maxPoints`/`maxFaces`
is checked before duplication.
An instance value has no editable mesh faces: realize it before mesh operations.

```ts live
import {sketch,pen,mm} from 'occlude';
import {grid,cone,instanceOnPoints,view,perspective} from 'occlude/3d';
export default sketch({seed:42,pens:{ink:pen({width:mm(.25),color:'#18202A'})}},t=>{
  const sites=grid({cols:6,rows:6,spacing:1.2})
    .attribute('height',()=>t.rnd(.5,1.8));
  const forms=instanceOnPoints(cone(.4,1),sites.points,{scale:p=>[1,1,p.height]});
  return view(forms,{camera:perspective({eye:[8,10,8],target:[0,0,.5],fovDegrees:50}),stroke:'ink'});
});
```

### Prepared queries and forces

`query(mesh)` captures a target revision and prepares its CPU spatial index.
It accepts any ordinary mesh, including a realized instance collection. Edits
produce a different target; an existing query continues to read its captured
revision. Positions accept triples or point rows with `x/y/z`.

- `.nearest(position, {within?})` returns the nearest surface point within a
  world-distance bound, or `null`. Inside a closed object still means nearest
  *surface*, not containment.
- `.ray(origin, direction, {near?, far?})` returns the first two-sided hit.
  Direction need not be normalized. `near` and `far` bound the parameter `t` in
  `origin + direction * t` (defaults 0 and infinity).
- `.segment(from, to)` uses `t` between 0 and 1. A zero-length segment is an
  exact contact query, returning `t: 0` for contact or `null` for a miss.

Hits include `position`, `normal`, world `distance`, `triangle`, `barycentric`
coordinates and a typed `face` row. Ray/segment hits additionally include `t`.
Parallel or coplanar rays have no isolated hit. Bounds are inclusive and ties
choose the earliest triangle in the captured target.

`prepared.batch()` supplies synchronous CPU batches. In `sketchAsync`, use
`prepared.batch(t)` and await its results to use the execution host (WebGPU in
Studio, explicit CPU execution in the headless renderer). It offers:

- `.nearest(points, {position?, within?})`;
- `.rays(points, {direction, origin?, near?, far?})`;
- `.segments(points, {to, from?})`.

Options may be constants or fields evaluated on source point rows. The default
position/origin/from is the point itself. Every result is `{source, hit}`,
including misses; arrays preserve selection order and retain the actual source
rows. `results.field((point, hit) => value)` evaluates a captured answer without another query; `results.sources((point, hit) => condition)` returns a normal source selection with typed extraction. A field accepts only rows actually queried on the captured revision, including misses. It rejects copied rows or a later geometry revision even when IDs match. Capture the answer into an attribute before deformation when you want a stored reference measurement, or query the edited geometry for current answers. Fields are captured before awaiting. Empty selections return empty
results. There is no synchronous GPU readback or implicit device acquisition
in a geometry factory. A batch bound to `t` expires with that sketch execution.

Owned CPU targets reuse their spatial index. The GPU host retains up to four
recent targets, bounded by its triangle-buffer budget; eviction or a new target
revision causes preparation again. Diagnostics report `targetCacheHit` and
`targetUploadBytes`; query transfer totals include target uploads. Authors do
not manage GPU buffers or device lifetime.

Reusable `force` recipes are ordinary CPU fields evaluated against each
iteration's current points:

- `force.attract(target, {strength = 1})` moves toward a world point;
- `force.plane({origin, normal, side, strength = 1})` corrects violations of
  `'below'` (nonpositive signed distance) or `'above'` (nonnegative signed
  distance). Normal magnitude is irrelevant; strength lies between 0 and 1;
- `force.project(preparedQuery, {strength = 1, within?})` moves toward the
  nearest surface, returning zero for a miss;
- `force.sum(...forces)` adds displacements and forwards the iteration number.

Use separate frozen passes when a constraint must observe another force's
committed move. Summing forces evaluates all of them on the same input.
Arbitrary JavaScript force functions are not compiled or reevaluated on the GPU.
The advanced module retains packed deformation/query access for that purpose.

This sketch first applies attraction and a sided plane constraint, then uses
GPU query batches to clip the relief under a bounded tilted roof and select
nearby faces for hatch. The roof is query geometry; only the final terrain is
drawn.

```ts live
import {sketchAsync,pen,mm} from 'occlude';
import {plane,query,force,view,orthographic} from 'occlude/3d';
export default sketchAsync({seed:42,pens:{ink:pen({width:mm(.3),color:'#18202A'}),shade:pen({width:mm(.18),color:'#A84932'})}},async t=>{
  const pull=force.attract([0,0,.4],{strength:.015});
  const ceiling=force.plane({origin:[0,0,.8],normal:[0,0,1],side:'below'});
  let terrain=plane(4,4).subdivide(4).displace(p=>[0,0,t.noise(p.x,p.y)*.9])
    .steps(4,(current,next)=>next.move(current.points,pull),(current,next)=>next.move(current.points,ceiling));
  const roof=plane(3,3).rotate([0,15,0]).translate([0,0,.4]).faceAttribute('roof',true);
  const target=query(roof),batch=target.batch(t);
  const roofHits=await batch.rays(terrain.points,{origin:p=>[p.x,p.y,3],direction:[0,0,-2]});
  const nearby=await batch.nearest(terrain.points,{within:.35});
  const captured = terrain.attributes({
    ceiling: roofHits.field((_, hit) => hit?.position[2] ?? 2),
    nearRoof: nearby.field((_, hit) => hit !== null),
  }).displace(p => [0, 0, Math.min(0, p.ceiling - p.z)]);
  const drawing = captured.faceAttribute('shade', f => f.points.some(p => p.nearRoof));
  return view(drawing,{camera:orthographic({eye:[6,8,5],target:[0,0,.2],span:7.5}),stroke:'ink',hatch:{spacing:mm(1.8),angle:35,stroke:'shade',select:f=>f.shade}});
});
```


## Curves, paths and circle profiles

`polyline(points, { closed? })` owns a piecewise-linear path through 3D vectors.
A closed path connects its final point to its first: do not repeat the first
point. `curve(t => [x, y, z], { segments: 64, closed? })` samples a parameterized
path uniformly in t, once during modeling. Open paths include both endpoints;
closed paths omit t=1 and share the seam. These are polygonal curves, not an
analytic spline representation. `circle(radius = 1, { segments: 64 })` constructs
a counterclockwise circle profile in XY using the same curve data.

Curve constructors check an explicit `maxPoints` (unlimited by default) before
sampling or topology allocation. Adjacent duplicate points and malformed or non-finite inputs are
rejected. A circle has at least three segments. Geometry coordinates are world
units; `view` handles camera projection into the explicit paper frame.

Curves expose `.points`, `.edges`, typed `.attribute` / `.edgeAttribute`, selection
and extraction, `.translate`, `.rotate`, `.scale`, `.displace` and frozen `.steps`.
Their point passes and history follow mesh semantics. Curve edits keep point and
edge IDs and attributes; extracted mesh edges retain those same IDs while
becoming independent curve geometry. Curves have no face domain. Extracting
points removes connectivity; extracting edges retains only their used points.

The ordinary `view` accepts curves alongside meshes and instances. Curve edges
are wire features with shared endpoint IDs and source edge attributes; meshes
can hide them, but a curve does not occlude another object. The existing visible
and hidden projected collections, named pens and retained camera commits apply.
A view-wide hatch recipe decorates mesh surfaces and does not fill curve loops.

```ts live
import { sketch, pen, mm } from 'occlude';
import { box, circle, curve, polyline, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
} }, () => {
  const block = box([1.6, 1.6, 2]);
  const spiral = curve(t => [
    1.5 * Math.cos(t * Math.PI * 6),
    1.5 * Math.sin(t * Math.PI * 6),
    (t - 0.5) * 3.5,
  ], { segments: 180 });
  const ring = circle(1.2, { segments: 64 }).translate([0, 0, 2.1]);
  const path = polyline([[-2, -1, -1.5], [0, 0, -1.5], [2, 1, -1.5]])
    .attribute('lift', p => p.index === 1 ? 0.25 : 0)
    .steps(3, { move: p => [0, 0, p.lift] });
  const frame = box([4.4, 4.4, 4.4]).edges
    .filter(e => e.a.z < 0 && e.b.z < 0).extract();
  return view([block, spiral, ring, path, frame], {
    camera: orthographic({ eye: [6, 8, 5], target: [0, 0, 0], span: 9.5 }),
    stroke: 'ink',
  });
});
```


## Constructing meshes from profiles

`revolve(profile, options)` rotates an XZ meridian in x >= 0 around the Z axis.
`segments` defaults to 32; `angle` defaults to 360 degrees and may be negative.
Every angular step must be smaller than 180 degrees. A full turn shares its
seam, and exact axis points become single shared vertices. Open profile ends
remain open: a vessel can have an open mouth and a closed bottom by starting
its profile on the axis. Axis-to-axis spans create no zero-area faces. An
interior axis contact that would pinch two surface fans together is rejected.
For a partial turn, `caps: true` closes the angular cuts of a **closed** profile.
It does not seal the circular boundaries of an open profile. Profile ordering
sets winding: tracing the outside from bottom to top produces outward faces.

`sweep(profile, path, options)` carries an XY profile along an unbranched 3D
path. Use a circle for a tube, an open polyline for a ribbon, or another closed
curve for a shaped section. `normal` optionally specifies the world direction
of the profile's initial +X; it is projected perpendicular to the first tangent.
The default chooses the least-aligned coordinate axis deterministically.
At corners, tangents bisect the incoming/outgoing unit directions. Subsequent
frames use minimal rotations between tangents, and closed paths distribute
frame-closure twist by arc length. Exact reversals have no unique frame and
receive a diagnostic. The profile's counterclockwise order gives outward faces.

Sweep `scale` is a positive scalar or a field on the **path point rows**, captured
once. `twist` is a total angle in degrees distributed along path length; closed
paths require whole turns. `caps: true` closes the two ends of an open path with
a closed profile. Closed paths share their seam; an open profile stays a ribbon.

Both operations return ordinary meshes. Subdivision, displacement, frozen
steps, queries, face selection, hatching, instancing and the normal view all
continue to work. Revolve copies profile point attributes and transfers profile
edge attributes to side faces. Sweep combines path and profile point columns
and transfers both edge domains to side faces; profile columns win name
collisions. Angular/end caps have empty face attributes, so inherited face
columns are optional. Derived point/face provenance records source IDs;
generated edges start with empty attributes. No ambient counters are involved.

Construction budgets are unlimited by default; set explicit `maxPoints`/`maxFaces` with
`maxPoints` and `maxFaces`. General cap triangulation has a separate
`maxCapPoints` budget (default 2,048) because its cost is quadratic. Checks precede
expanded topology allocation and sweep scale-field evaluation. Meridian/profile
planarity accepts relative 1e-10 roundoff from prior transforms; coordinates are
preserved, not snapped. Near-axis points are never merged into exact axis points.
A swept quad can be nonplanar: its fixed pair of triangles defines the surface.
Shape-preserving subdivision may refine such a face through that triangulation.
These operations do not resolve global self-intersections or perform a boolean
union; a large profile on a tight path can intersect itself.

```ts live
import { sketch, pen, mm } from 'occlude';
import { polyline, circle, curve, revolve, sweep, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  shade: pen({ width: mm(0.18), color: '#A84932' }),
} }, () => {
  const vessel = revolve(polyline([
    [0, 0, -1.3], [0.8, 0, -1.3], [1, 0, -0.6],
    [0.7, 0, 0.3], [0.45, 0, 0.7], [0.5, 0, 1.3],
  ]), { segments: 40 }).translate([-1.7, 0, 0])
    .faceAttribute('shade', f => f.normal[2] > 0);
  const route = curve(t => [
    0.7 * Math.cos(t * Math.PI * 4),
    0.7 * Math.sin(t * Math.PI * 4),
    (t - 0.5) * 3,
  ], { segments: 64 }).attribute('radius', p => 0.8 + 0.2 * Math.cos(p.z * 2));
  const tube = sweep(circle(0.16, { segments: 16 }), route, {
    caps: true, scale: p => p.radius,
  }).translate([1.4, 0, 0]);
  const ribbon = sweep(polyline([[-0.25, 0, 0], [0.25, 0, 0]]),
    curve(t => [t * 3 - 1.5, 1.6, 0.3 * Math.cos(t * Math.PI * 2)], { segments: 24 }),
    { twist: 180 }).translate([0, 0, -1.5]);
  return view([vessel, tube, ribbon], {
    camera: orthographic({ eye: [7, 10, 7], target: [0, 0, 0], span: 9.5 }),
    stroke: 'ink',
    hatch: { spacing: mm(2), angle: 35, stroke: 'shade', select: f => f.shade === true },
  });
});
```


## Sampling and scattering on surfaces

`t.sample(mesh, { count })` generates independent area-weighted points on the
mesh's represented triangles. `t.scatter(mesh, { spacing })` rejects candidates
that are too close to previously accepted points. Its spacing is a bare number
in **world units**, measured by Euclidean distance across all selected surfaces,
including disconnected or nearby sheets. It is not paper spacing or geodesic
distance. These mesh overloads coexist with the existing 2D shape sampling and
scatter methods; 2D behavior is unchanged.

Both accept `weight: face => number` (or a constant): a nonnegative finite
per-face candidate weight, captured once. Sampling probability is proportional
to triangle area times that weight; zero excludes a face. Scatter uses the same
candidate distribution, with fixed minimum spacing. Weight affects candidate
probability, not the spacing radius, and does not promise a particular final
density after rejection. Select faces through zero weights or extract a face
selection into a mesh first. Mesh instances must be explicitly realized before
surface sampling.

Both return `SurfaceSamples`, point geometry with ordinary `.points`, attributes,
selection/extraction, displacement and translation. Every row adds `.sample`:
an owned original `position`, triangle `normal`, `triangle` index, original
triangle `vertices`, `barycentric` weights, a typed `face` row and the immutable
source surface in `.sample.source`.
`.target` retains the original immutable mesh. Moving a sample does not silently
reproject it: `.sample` continues to describe where it was generated. The name
`sample` is reserved alongside the existing geometry row names.

Continuous numeric point columns and equal-sized numeric vectors interpolate
barycentrically. Categorical columns and columns declared with transfer
`'nearest'` use the largest barycentric weight, breaking ties by source point ID.
Missing point columns remain missing; face columns are inherited and point
columns take precedence on name collisions. Source face/point IDs also appear
in point provenance. Instancing and query batches preserve the full point-row type, so placement
fields, `instance.source` and query `result.source` retain sample normals and
typed source faces.

Randomness comes from an independent stream of the sketch seed. Repeating the
same call gives the same points; `key` selects a separate stream when desired
(otherwise the mesh key, then a default key). Sampling and scatter use separate
streams. Camera-only commits reuse generated geometry and consume no sampling
randomness.

Sampling returns exactly `count` points (an explicit `maxPoints` caps it); a
positive count with no positive weighted area is an error. Scatter has no point
limit by default and stops after `maxAttempts: 100000` rejected candidates. It stops at the first
limit, so the point limit is a cap, not a promised count or proof of maximal
packing. Empty weighted domains produce no scatter points. `.generation` records
the original `attempts`, `accepted` count and stopping `reason`, retained after
selection or editing. Limits are checked before expanded output allocation.
The sparse neighbor grid diagnoses spacing too small for its coordinate range.
This is CPU modeling; the resulting instances and view use the existing renderer.

```ts live
import { sketch, pen, mm } from 'occlude';
import { plane, cone, sphere, alignAxis, instanceOnPoints, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  shade: pen({ width: mm(0.15), color: '#647767' }),
} }, t => {
  const terrain = plane(5).subdivide(4)
    .displace(p => [0, 0, 0.6 * t.noise(p.x * 0.5, p.y * 0.5)])
    .faceAttribute('ground', true);
  const sites = t.scatter(terrain, {
    spacing: 0.45, maxPoints: 70, maxAttempts: 4000,
    weight: f => f.normal[2] > 0.85 ? 1 : 0,
  }).attribute('height', p => 0.8 + 0.4 * t.noise(p.x, p.y));
  const trees = instanceOnPoints(cone(0.14, 0.7, { segments: 8 }).translate([0, 0, 0.35]), sites.points, {
    scale: p => [1, 1, p.height],
    rotate: p => alignAxis('z', p.sample.normal),
  });
  const marks = t.sample(terrain, { count: 12 });
  const stones = instanceOnPoints(sphere(0.08, { segments: 8, rings: 4 }), marks.points);
  return view([terrain, trees, stones], {
    camera: orthographic({ eye: [6, 8, 6], target: [0, 0, 0.2], span: 9.5 }),
    stroke: 'ink',
    hatch: { spacing: mm(3), angle: 35, stroke: 'shade', select: f => f.ground === true },
  });
});
```

## Hatch families and model sections

`view` accepts one `hatch` recipe or an array of recipes. Each recipe has a
`spacing`, optional `angle` (45 degrees by default), `offset`, `stroke`, `select`
and semantic `key`. Spacing, angle, offset and stroke can be constants or fields
on the mesh's typed face rows, so one recipe can rule tagged faces in another
pen: `stroke: f => f.ring ? 'red' : 'fine'`. A recipe without a pen uses the
object's `fillPen` (`torus(…, { fillPen: 'red' })` or `style({ fillPen })`, as in
2D), then the object's `stroke`, then the view's. Eligibility and field values are captured once when the
view is created; camera commits regenerate the paper ruling without reevaluating
those fields. An array supplies multiple families, including crosshatching.
Each family's pen affects only its own ink. Spacing and offset use physical
paper lengths; angles remain paper-directed, not curvature-following.

`sections: [{ origin, normal, stroke?, key?, attributes? }, ...]` intersects the
same owned mesh with planes. Origin and normal are in the mesh's model space.
For instances they are prototype-space planes: each resulting section moves
with its instance. A fixed world cutting plane is a different operation; the
advanced `section3` API can section explicitly realized world geometry. A
section's pen defaults to the view's pen. Keys are optional and must be unique
within the hatch or section list; automatic keys depend on list position.

Hatch and sections retain source/support provenance on the same geometry
revision. No `hatch.surface` / `sections.surface` threading is needed. A custom
view callback still replaces all default ink; use `c.kinds.has('hatch')` or
`c.kinds.has('section')` on its visible/hidden collections to interpret them.
`c.attributes.hatchFamily` and `c.attributes.sectionPlane` expose recipe keys.
The existing per-mesh one-million-segment limits remain in force. Sections are
mesh–plane intersections, not boolean union or mesh–mesh intersection curves.

```ts live
import { sketch, pen, mm } from 'occlude';
import { box, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  shade: pen({ width: mm(0.15), color: '#56626A' }),
  section: pen({ width: mm(0.25), color: '#A84932' }),
} }, () => {
  const model = box([2.4, 1.8, 2.8])
    .faceAttribute('spacing', f => f.normal[2] > 0 ? 2 : 3);
  return view(model, {
    camera: orthographic({ eye: [5, 7, 6], span: 5 }), stroke: 'ink',
    hatch: [
      { spacing: f => mm(f.spacing), angle: 35, stroke: 'shade' },
      { spacing: f => mm(f.spacing * 2), angle: -35, stroke: 'shade', select: f => f.normal[2] > 0 },
    ],
    sections: [-0.8, 0, 0.8].map(height => ({
      origin: [0, 0, height], normal: [0, 0, 1], stroke: 'section',
    })),
  });
});
```

## Measuring 3D execution

Classified scenes and modeling batch reports expose `stats.timings`, typed as
`PhaseTimings3` from `occlude/3d/advanced`. In Studio these are also present in
the render worker's `three.scenes` and `three.modeling` diagnostics. A custom
backend may omit phase data. The native CPU and GPU paths report all keys,
using zero when a phase does no work or is shorter than clock resolution.

| Field | Measured host work |
| --- | --- |
| `captureMs` | Owned input copies/structured cloning, and view feature/hatch realization |
| `queueMs` | Waiting for this host or resource's previous job |
| `setupMs` | Device/pipeline preparation and buffer allocation, including awaited compilation |
| `packingMs` | Normalization and construction of GPU input arrays |
| `uploadSubmitMs` | CPU time in `queue.writeBuffer` calls |
| `dispatchSubmitMs` | Bind groups, command encoding, copies and queue submission |
| `readbackWaitMs` | Awaiting mapped results: queued GPU execution, transfers and promise scheduling |
| `readbackCopyMs` | Copying mapped data to owned CPU arrays and unmapping |
| `refinementMs` | CPU numeric refinement and reconstruction of GPU query/interval results |
| `candidateMs` | Visibility broad-phase pairing and bounded batch gathering |
| `finalizeMs` | Interval unions, result assembly and deformed-point reconstruction |
| `validationWaitMs` | Awaited GPU validation scopes |
| `cpuMs` | Explicit CPU reference modeling or visibility classification |
| `unattributedMs` | Remaining orchestration, bookkeeping and cleanup |
| `wallMs` | Entire measured operation boundary, equal to the other host fields' sum |

These are exclusive host phases. Parents add child phases without also adding
child wall time. A queued call's wall time includes its own wait; do not sum
concurrent calls to estimate the batch's elapsed wall time. Cached query targets
report zero target upload bytes on reuse, and their original preparation time
is counted only on the cache miss.

`uploadSubmitMs` measures submission, not physical PCIe transfer time.
`readbackWaitMs` includes GPU work and transfer completion; it is not a pure
copy-duration measurement. `transferBytes` records upload plus readback volume.
Visibility's optional `gpuMs` uses device compute-pass timestamps, excludes
host work, and is never added to these host phases. Deformation and query
kernels do not currently expose shader timestamps; absence does not mean zero
shader time. Do not infer a speedup from shader time alone.

View phase totals begin before feature/hatch realization and end after
classification. Modeling totals begin at the toolkit batch's input capture and
end after its result and validation complete. Geometry creation, earlier
`view(...)` construction, final 2D finishing/planning and worker messaging are
outside those boundaries. The phase-accounting workload measures view capture
and CPU snapshot creation separately for an aligned CPU/GPU comparison. The
older outer `stats.wallMs` fields retain their narrower kernel-specific scopes;
use `stats.timings.wallMs` for the boundaries described here.

```ts live
import { sketch, paper, pen, mm, strokes } from 'occlude';
import { box, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42,
  paper: paper({ width: mm(100), height: mm(100) }),
  pens: { ink: pen({ width: mm(0.25), color: '#18202A' }) },
}, () => view(box([2, 1.5, 2.5]), {
  camera: orthographic({ eye: [5, 7, 6], span: 5 }),
}, lines => {
  const stats = lines.visible.source.stats;
  console.info('3D phases', stats.timings, 'shader ms', stats.gpuMs);
  return strokes(lines.visible, { stroke: 'ink' });
}));
```


## Consuming captured queries

This relief uses one batched roof query. The resulting field reads each source
point and its captured hit directly; points outside the roof keep their original
height. Query fields work with ordinary geometry fields and do not submit GPU
work when evaluated. To retain a measurement through later motion, first call
`mesh.attribute('restDistance', hits.field((point, hit) => hit?.distance ?? 10))`,
then transform that returned mesh. The attribute is intentionally a stored
measurement; it does not become a fresh spatial query after the move.

```ts live
import { sketchAsync, pen, mm } from 'occlude';
import { plane, query, view, orthographic } from 'occlude/3d';

export default sketchAsync({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
  shade: pen({ width: mm(0.18), color: '#A84932' }),
} }, async t => {
  const terrain = plane(4).subdivide(4)
    .displace(p => [0, 0, t.noise(p.x, p.y) * 0.9]);
  const roof = plane(2.7).rotate([0, 15, 0]).translate([0, 0, 0.25]);
  const hits = await query(roof).batch(t).rays(terrain.points, {
    origin: p => [p.x, p.y, 3],
    direction: [0, 0, -1],
  });
  const relief = terrain.displace(hits.field((point, hit) => [
    0, 0, hit ? Math.min(0, hit.position[2] - point.z) : 0,
  ]));
  return view(relief, {
    camera: orthographic({ eye: [6, 8, 5], target: [0, 0, 0.2], span: 7 }),
    creaseAngle: 0,
    stroke: 'ink',
    hatch: { spacing: mm(1.8), angle: 35, stroke: 'shade' },
  });
});
```

### Evolving attributes in frozen passes

Initialize several columns with `.attributes({ name: field, ... })`. Every field
reads the same incoming geometry, including when it replaces an existing column.
Meshes and curves also have `.edgeAttributes`; meshes have `.faceAttributes`.
Mesh point transfer policies can be set with
`.attributes(fields, { transfer: { category: 'nearest' } })` and survive later
attribute replacement unless explicitly changed.

Within `.steps`, `next.set(points, field)` merges a partial attribute record into
selected points. It also accepts a single point row. `next.setEdges` and
`next.setFaces` update their corresponding domains; `next.setEdge` and
`next.setFace` accept single rows. Initialize columns before stepping: edits
preserve each column's value kind and numeric-vector dimension. Literal values
such as `0` widen to `number` in the evolving state.

All reads in a pass see its incoming state. Moves accumulate; the last write to
each attribute wins. Separate passes observe the preceding pass's committed
state. Callbacks must be synchronous, and an editor cannot escape its pass.
Point clouds and surface samples also support `.steps`, rotation and scaling.
Samples retain their captured surface interpretation in fields and history;
moving a sample point does not reproject its original surface location.

```ts live
import { sketch, pen, mm } from 'occlude';
import { plane, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
} }, () => {
  const sheet = plane(4).subdivide(3)
    .attributes({ age: 0, velocity: p => 0.08 * Math.cos(p.x) * Math.cos(p.y) })
    .steps(6, (current, next) => {
      next.set(current.points, p => ({ age: p.age + 1, velocity: p.velocity * 0.9 }));
      next.move(current.points, p => [0, 0, p.velocity]);
    });
  return view(sheet, {
    camera: orthographic({ eye: [5, 7, 5], target: [0, 0, 0], span: 6 }),
    stroke: 'ink',
  });
});
```

### Topology relationships

Mesh rows expose ordinary collections: `face.points`, `face.edges`,
`face.adjacent`, `edge.points`, `edge.faces`, and `point.edges`, `point.faces`,
`point.adjacent`. Edge endpoints `a` and `b` are the same typed point rows.
Relations follow polygon edges, without adding triangulation diagonals.

A face selection has `.points` and `.edges`, plus `.boundaryEdges()`,
`.adjacent()`, `.connected()` and `.components()`. Point selections have
`.edges` and `.faces`, plus `.adjacent()`, `.connected()` and `.components()`;
edge selections have `.points`, `.edges` (themselves), `.faces()`, plus
`.adjacent()`, `.connected()` and `.components()`. Filtering, grouping and set
operations preserve these capabilities. Row fields retain attributes across
every relation.

`.adjacent()` collects one-hop neighbors and LEAVES THE MEMBERS OUT, so it is
the ring around a selection; `sel.union(sel.adjacent())` is the selection grown
by that ring. Every kind says it the same way, and so does 2D. Two edges are
neighbors through a shared END, as two faces are through a shared edge. `.connected()` expands through the whole
source domain and includes its starting rows. `.components()` instead partitions
the selected induced graph. Faces connect through shared edges, not merely a
shared vertex or equal coordinates. `.boundaryEdges()` selects edges incident to
exactly one selected face. All results use deterministic source order and keep
the original revision's ownership checks.

Adjacency is cached by topology revision and reused through point motion and
attribute edits. Measurements still follow the current positions. Extraction,
subdivision, winding changes and topology edits establish a new revision.
Point-only geometry does not acquire mesh face or edge capabilities.


### Axis rotations and alignment

`axisAngle(axis, degrees)` creates a right-handed rotation around `'x'`, `'y'`,
`'z'` or a nonzero direction. `alignAxis(localAxis, direction, options?)` rotates
one local axis onto a target direction. Directions may be triples or point rows.
Both return immutable rotation values accepted by mesh/curve/point `.rotate`
and instance `rotate` fields. Geometry's optional second `.rotate` argument is
its origin pivot; instance transforms scale about the prototype origin, rotate,
then translate. Negative scale still mirrors geometry and reverses winding.

`rotation.apply(vector)` rotates a vector about zero. `a.then(b)` applies `a`
first, then `b`; `.inverse()` undoes a rotation. These values retain quaternion
data through composition and serialization; no Euler conversion is required.
For example, a rotated curve-frame normal can be passed through the existing
`sweep(..., { normal: orientation.apply([1, 0, 0]) })` option.

Alignment defaults to the shortest turn, with a deterministic local reference
for exact antiparallel directions. That reference depends on the fixed local
axis, not on which coordinate component of the target happens to be largest.
No stateless orientation convention is continuous at every possible direction.
For a sequence crossing the antipodal singularity, use
`alignAxis('z', tangent, { previous: orientation })` to transport the preceding
frame with the shortest incremental turn.

Use `{ up: worldReference, localUp: localReference }` to constrain roll instead.
References are projected perpendicular to their respective aligned axes;
parallel references are rejected. Omitting `localUp` uses a fixed local
perpendicular. An up constraint and `previous` are mutually exclusive. Optional
`twist` adds a final turn in degrees around the resulting world direction.
With `previous`, that twist is incremental, so do not repeatedly supply an
absolute twist angle unless accumulating it is intended.

```ts live
import { sketch, pen, mm } from 'occlude';
import { box, pointCloud, axisAngle, alignAxis, instanceOnPoints, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
} }, t => {
  const sites = pointCloud(t.times(7, (_, u) => [4 * (u - 0.5), 0, 0]));
  const fin = box([0.12, 0.55, 0.8]).translate([0, 0, 0.4]);
  const fins = instanceOnPoints(fin, sites.points, {
    rotate: p => alignAxis('z', [p.x * 0.5, 0.3, 1], {
      localUp: [0, 1, 0], up: [0, 1, 0], twist: p.index * 10,
    }),
  });
  const base = box([4.8, 0.8, 0.12])
    .rotate(axisAngle('z', 4)).translate([0, 0, -0.12]);
  return view([base, fins], {
    camera: orthographic({ eye: [5, 7, 5], target: [0, 0, 0.3], span: 6.2 }),
    stroke: 'ink',
  });
});
```


### Regular point grids

`grid({ cols, rows, layers?: 1, spacing?: 1, maxPoints?: 100000, key? })`
from `occlude/3d` creates centered point geometry in model coordinates. A scalar
spacing applies to every axis; an XYZ triple sets each axis separately. One
layer gives an XY grid. Counts are nonnegative integers, spacing is positive,
and the point budget is checked before allocation. A zero count gives an empty
grid. Use ordinary `.translate`, `.rotate`, `.scale`, `.attributes` and `.steps`
to place and edit the result.

Each point has `i`, `j` and `k` attributes for its column, row and layer. X varies
fastest, then Y, then Z; filtering preserves the original coordinates and IDs.
This is a point domain for placement and construction. `t.grid` continues to
lay out paper cells, and mesh topology remains explicit through mesh factories.

### Corner attributes

A corner is a point as used by one polygon. A box has eight geometric points
and 24 corners, so neighboring faces can keep different values at a shared
point. Corners do not duplicate or move geometric points.

Use `.cornerAttributes({ name: valueOrField })` or
`.cornerAttribute(name, valueOrField)` to initialize columns. A corner exposes
`point`, `face`, `localIndex`, and the ordinary row identity and attributes.
`face.corners` and `point.corners` are owned collections; face and point
selections also provide `.corners()`. A corner selection can recover `.points`
and `.faces()`. Its `.extract()` returns readonly corner rows, since corners
alone do not define a mesh.

`next.setCorner(row, patch)` and `next.setCorners(selection, patchOrField)`
update initialized columns in frozen `.steps` passes. Every field reads the
incoming revision, including fields reached through another domain. As with
point and face state, assignments merge by column and the last assignment wins.

Transforms, face extraction and realization preserve corner values and their
provenance. Subdivision interpolates numeric columns within each parent face;
it never averages across a seam. Categorical columns use a deterministic
source, and `{ transfer: { label: 'nearest' } }` preserves numeric labels.
If a quad's numeric corner field is not affine, subdivision refines its fixed
triangles to preserve the field across the original diagonal. Missing columns
remain missing. Corner attributes store data; drawing remains explicit.

This sheet stores heat per corner, then exchanges it through shared points and faces.
Each pass reads the preceding heat values. The resulting face averages select
an ordinary paper-directed hatch, while point averages shape the sheet.

```ts live
import { sketch, pen, mm, meanBy } from 'occlude';
import { plane, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  warm: pen({ width: mm(0.2), color: '#A84932' }),
} }, () => {
  const sheet = plane(4, 4).subdivide(3)
    .cornerAttributes({
      heat: c => Math.max(0, 1 - Math.hypot(c.face.center[0] + 0.7, c.point.y) / 2),
    })
    .steps(4, (current, next) => {
      next.setCorners(current.corners, c => ({
        heat: 0.5 * meanBy(c.point.corners, p => p.heat)
          + 0.5 * meanBy(c.face.corners, p => p.heat),
      }));
    })
    .faceAttributes({ heat: f => meanBy(f.corners, c => c.heat) })
    .displace(p => [0, 0, meanBy(p.corners, c => c.heat)]);
  return view(sheet, {
    camera: orthographic({ eye: [5, 7, 6], target: [0, 0, 0.3], span: 5.5 }),
    stroke: 'ink',
    hatch: { spacing: mm(1.5), angle: 35, stroke: 'warm', select: f => f.heat > 0.3 },
  });
});
```

### Surface locations and rebinding

A sampled point's `.sample` retains its owned source revision, triangle,
vertex identities and barycentric coordinates. `position` and `normal` describe
that attachment; `modelPosition` and `modelNormal` make the model interpretation
explicit. `space` is `'model'` for ordinary mesh sampling. These values do not
follow later independent edits to the sampled point geometry.

The context separates typed `pointAttributes`, `faceAttributes` and
`cornerAttributes`. Numeric source values interpolate inside the triangle;
nearest and categorical values choose the largest barycentric weight, with
source ID breaking ties. Missing source columns stay missing. `.face` retains
the existing typed face row.

When triangle corners contain finite `uv` pairs and a consistent optional
`chart` identity, `.sample.uv` gives affine chart coordinates. `frame.du` and
`frame.dv` are derivatives in model units per chart unit; `tangent` and
`bitangent` are normalized directions, and `orientation` records chart
handedness. `chartStatus` distinguishes `'missing'`, `'regular'` and
`'degenerate'`. A degenerate chart has coordinates but no tangent frame.
Sampling/scatter options `uvAttribute` and `chartAttribute` select different
column names. Active UV coordinates require interpolated values; a `nearest`
transfer policy belongs on discrete columns instead. Different seam sides keep
their own corner values. Mixed chart identities or
partially specified UVs on one triangle are diagnosed.

Use `samples.rebind(editedMesh)` to place the samples onto a topology-preserving
revision. This evaluates the retained triangle weights; it does not sample again
or search for a nearby surface. Point IDs, captured point columns and generation
statistics remain unchanged. The sample context refreshes from the target,
including its new attribute types. Rebinding resets point positions to their
attachments and starts a new edit history. Previously captured samples remain
unchanged.

Rebinding requires shared authoring lineage and unchanged face/triangle/corner
relationships. Point motion, attribute edits and mirrors qualify. An unrelated
mesh with matching generated IDs does not. Subdivision and other topology
changes require regeneration or an explicit topology transfer.

This example repeats the same sampled sites before and after a deformation.
Corner coordinates control pin height, and retained triangle normals orient the
pins. The two placements use the same point IDs and chart values.

```ts live
import { sketch, pen, mm } from 'occlude';
import { plane, box, instanceOnPoints, alignAxis, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
} }, t => {
  const rest = plane(2.6, 2.6).subdivide(3).cornerAttributes({
    uv: c => [(c.point.x + 1.3) / 2.6, (c.point.y + 1.3) / 2.6],
    chart: 'sheet',
  });
  const sites = t.sample(rest, { count: 70 });
  const bent = rest.displace(p => [0, 0, 0.45 * Math.sin(p.x * 2) * Math.cos(p.y)]);
  const attached = sites.rebind(bent);
  const pin = box([0.06, 0.06, 0.25]).translate([0, 0, 0.125]);
  const flatPins = instanceOnPoints(pin, sites.points, {
    scale: p => [1, 1, 0.6 + p.sample.cornerAttributes.uv[0]],
    rotate: p => alignAxis('z', p.sample.normal),
  });
  const bentPins = instanceOnPoints(pin, attached.points, {
    scale: p => [1, 1, 0.6 + p.sample.cornerAttributes.uv[0]],
    rotate: p => alignAxis('z', p.sample.normal),
  });
  return view([
    rest.translate([-1.6, 0, 0]), flatPins.translate([-1.6, 0, 0]),
    bent.translate([1.6, 0, 0]), bentPins.translate([1.6, 0, 0]),
  ], {
    camera: orthographic({ eye: [5, 9, 8], target: [0, 0, 0.2], span: 7.2 }),
    stroke: 'ink',
  });
});
```

### Surface intersections

`intersections(a, b)` returns construction curves where two meshes meet. Both
inputs can also be instance sets. `intersections([a, b, c, ...])` takes a list
and finds the seams between every two different objects in it, in one value
with one source per object; instances of one set never meet each other in
either form. For substantial work, use `await t.intersections(a, b)` or
`await t.intersections(list)` in an async sketch: it yields to the event loop
and observes sketch cancellation. Geometry, source attachments and contact
classification are computed on the CPU before camera interpretation.

```ts live
import { sketchAsync, strokes, label, pen, mm } from 'occlude';
import { box, view, orthographic } from 'occlude/3d';

export default sketchAsync({
  seed: 42,
  pens: {
    outline: pen({ width: mm(0.3), color: '#18202A' }),
    seam: pen({ width: mm(0.5), color: '#A84932' }),
  },
}, async t => {
  const block = box([2.8, 1.5, 1.6]);
  const tower = box([1, 1, 2.8]).translate([0.6, 0.3, 0.6]);
  const seams = await t.intersections(block, tower);
  return [
    view([block, tower, seams], {
      camera: orthographic({ eye: [5, 7, 6], target: [0, 0, 0.4], span: 4.6 }),
    }, lines => [
      strokes(lines.visible.filter(c => !c.kinds.has('intersection')), { stroke: 'outline' }),
      strokes(lines.visible.filter(c => c.kinds.has('intersection')), { stroke: 'seam' }),
    ]),
    label('CROSSING / FORMS', 8, 94, 4, { stroke: 'outline' }),
  ];
});
```

The inputs remain unchanged. The result has ordinary `points` and `edges`
collections; `seams.edges.filter(e => e.contact === 'transverse').extract()`
retains the selected supported curves. Pass the curves and their supporting
meshes or instance sets to `view`. Visibility considers both supporting surfaces
and other scene geometry. Scene labels do not establish attachment ownership.
Selecting an instance subset preserves its placement relationship to the original
set; moving it creates new placements and requires new intersection geometry.

Edges expose `contact`: `transverse`, `shared-edge`, or `coplanar-boundary`.
Coplanar overlap produces its boundary, never its interior triangulation lines.
Isolated tangent contacts are point data with `attributes.contact` equal to
`tangent-point`; they do not invent zero-length ink. Default `view` draws all
three edge classes; filter the construction or projected attributes when they
need different treatment. No Boolean, mesh splitting or capping is performed.

Edge extraction retains its complete source reference through visibility and
cropping. `rebind(mesh)` refreshes a one-source
attachment after an incidence-preserving edit; multiple sources require one mesh
per source in `curves.sources` order. If intersection supports separate, regenerate
with `intersections` instead of projecting a seam onto a nearby surface.

`maxPairs` limits placement pairs (default 4096). Optional `budget` controls
contact, arrangement and graph capacities. Capacity errors reject the operation;
an async sketch adopts only its completed result. Surface generators retain
exact coordinates and validated supporting triangles internally. The existing
GPU visibility path refines rational curve candidates on the CPU.

### Sampling supported curves

`t.sample(curves, { spacing: 0.3 })` redistributes points along each contiguous
source chain in model/world units. `count` selects a number per chain instead;
the default is 32. Open chains include both endpoints (a single requested point
uses the midpoint), while closed chains omit the duplicate seam. Branches and
selection gaps remain separate. Isolated contact points are already available
through `curves.points`; curve sampling samples positive-length paths.

```ts live
import { sketchAsync, label, pen, mm } from 'occlude';
import { box, view, orthographic, instanceOnPoints, alignAxis } from 'occlude/3d';

export default sketchAsync({ seed: 42, pens: {
  ink: pen({ width: mm(0.3), color: '#18202A' }),
} }, async t => {
  const block = box([2.8, 1.5, 1.6]);
  const tower = box([1, 1, 2.8]).translate([0.6, 0.3, 0.6]);
  const seams = await t.intersections(block, tower);
  const sites = t.sample(seams, { spacing: 0.3 });
  const markers = instanceOnPoints(box([0.08, 0.08, 0.12]), sites.points, {
    rotate: p => alignAxis('z', p.sample.tangent),
  });
  return [
    view([block, tower, markers], {
      camera: orthographic({ eye: [5, 7, 6], target: [0, 0, 0.4], span: 4.6 }),
      stroke: 'ink',
    }),
    label('FOLLOW / THE SEAM', 8, 94, 4, { stroke: 'ink' }),
  ];
});
```

The result is ordinary editable point geometry: select, capture attributes,
transform, run frozen steps, issue spatial queries from its points, or instance
another mesh on them. Each point's `sample` retains its curve chain, source
parameter, world tangent and exact position. Spacing uses a floating arc-length
metric; each resulting attachment is constructed exactly on its support triangles.
`maxPoints` and `maxSupports` bound the generation.

`p.sample.locations` exposes all incident surface contexts: position, normal,
UV/chart, and interpolated attributes. `p.sample.on(block)` or
`p.sample.on(anInstanceSubset)` selects contexts by actual source ownership.
It returns an array because creases and UV seams can have more than one valid
face context; the sampler does not choose a surface normal arbitrarily.

Moving sampled points preserves their original interpretation. To put them back
on an explicitly rebound curve, use `sites.rebind(reboundCurves)`. Unrelated or
regenerated curves require new sampling even when their labels match. Exact
source fractions survive rebound geometry; old sample values stay unchanged.

Supported curve stroke references follow the authored chain and omit redundant
collinear triangle splits. Visibility, construction selection and attribute-based
style selection retain the full reference; changing support tessellation does
not reseed wobble or restart dash distance along an unchanged chain. Legacy mesh
edges, sections and paper hatch retain their existing interpretation.

### Advanced: supported curve graphs

Kernel integrations can construct `SurfaceCurves` from `surfaceCurveNetwork3`
through `occlude/3d/advanced`. Sources use owned `surfaceBinding3` values; nodes
carry exact homogeneous coordinates, and segments declare their actual support
triangles. Every endpoint must lie on every declared support. Ordinary sketches
use the surface generators above, which maintain this information automatically.

## Stored surface coordinates

`plane`, `box`, `sphere`, `cylinder`, `cone`, and `torus` now include typed
`uv` pairs and `chart` identities on their ordinary corner domain. Geometric
vertices remain shared: a seam, cap rim or pole can carry different coordinates
on its incident face corners. `t.sample(model, { count })` exposes the
interpolated coordinates and tangent frame through `point.sample`.

| Generator | Stored coordinates |
| --- | --- |
| `plane` | Unit-square XY chart, from the negative to positive corners. |
| `box` | One outward-wound unit-square chart per face, identified by face ID. |
| `sphere` | Angular `u` and south-to-north latitude `v`; each pole corner uses its sector's midpoint `u`. |
| `cylinder`, `cone` | One-turn `u`, bottom-to-top `v`; caps have separate normalized planar XY charts. |
| `torus` | Major-angle `u` and tube-angle `v`, with separate corner values at both periodic seams. |
| `sweep` | Normalized represented profile arclength `u` and path arclength `v`; start/end caps use the original profile's XY bounding box. |
| `revolve` | Fraction of the signed angular sweep `u` and normalized represented profile arclength `v`; axis corners use their sector midpoint. Partial-turn caps use the profile's XZ bounding box. |

These are coordinates on the represented polygon mesh, not an analytic smooth
surface or equal-area unwrap. Pole fans have triangular chart domains. A pattern
outside those triangles does not map to the pole. Cap islands intentionally
reuse the unit square; chart identity lets a consumer distinguish them. Closed
profiles/paths include their closing edge in the arclength denominator. Revolve
includes axis-only profile edges in that denominator even when they emit no skin.

The following example selects sample points in stored UV bands **before**
deforming the sheet. Explicit rebinding moves those same attachments onto the
changed mesh; it neither reseeds nor computes a fresh projection.

```ts live
import { sketch, label, pen, mm, strokes } from 'occlude';
import { plane, box, instanceOnPoints, alignAxis, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  outline: pen({ width: mm(0.25), color: '#18202A' }),
  marks: pen({ width: mm(0.2), color: '#A84932' }),
} }, t => {
  const rest = plane(4, 3).subdivide(3);
  const sites = t.sample(rest, { count: 320 }).points
    .filter(p => Math.floor(p.sample.cornerAttributes.uv[0] * 8) % 2 === 0).extract();
  const sheet = rest.displace(p => [0, 0, 0.45 * Math.sin(p.x * 1.8) * Math.cos(p.y)]);
  const marks = instanceOnPoints(box([0.04, 0.04, 0.08]).faceAttribute('mark', true), sites.rebind(sheet).points, {
    rotate: p => alignAxis('z', p.sample.normal),
  });
  return [
    view([sheet, marks], {
      camera: orthographic({ eye: [5, 7, 6], span: 5.3 }),
    }, lines => [
      strokes(lines.visible.filter(c => !c.faceAttributes.some(a => a.mark)), { stroke: 'outline' }),
      strokes(lines.visible.filter(c => c.faceAttributes.some(a => a.mark)), { stroke: 'marks' }),
    ]),
    label('REST / COORDINATES', 8, 94, 4, { stroke: 'outline' }),
  ];
});
```

Custom meshes use the same corner columns:

```ts
const charted = model.cornerAttributes({
  uv: c => [c.point.x / 4, c.point.y / 3] as const,
  chart: 'sheet',
});
```

`planarUV(model, { origin, u, v, chart })` stores a planar projection. `u` and `v`
are model vectors spanning one chart unit (defaults +X/+Y), and can be oblique.
`cylindricalUV(model, { origin, axis, seam, height, chart })` stores one-turn
angular `u` and axial `v`: defaults are +Z, a +X seam, and one model unit of height.
It unwraps each face across the seam. Faces spanning half a turn or surrounding
the projection axis require subdivision or a separate planar cap chart. Primitive
caps already have appropriate charts. Both helpers replace only `uv` and `chart`,
retain other columns, and set UV transfer to interpolation.

Projections evaluate the mesh's current coordinates once. Moving/deforming the
returned mesh preserves those stored values. Calling the helper again after a
world-space transform intentionally reprojects against that explicit frame.
There is no ambient world frame or automatic per-camera UV regeneration. Existing
paper-directed `view(..., { hatch })` remains a separate view-dependent tool.

Corner UVs also survive extraction, realization, mirroring and shape-preserving
subdivision. Mirrors preserve the association between a corner and its vertex.
A degenerate projected UV triangle is reported as `sample.chartStatus ===
'degenerate'`, with no tangent frame; missing custom coordinates report `missing`.
Mixed chart identities inside one triangle or malformed UV values are errors.


## Mapping vector patterns onto surfaces

`mapSurface(mesh, pattern, options)` puts existing 2D material onto a surface
through its stored chart coordinates. The pattern is any resolved `Material`
(or an array of them): `curve(points)` and `material(points)` build one from
numeric chart coordinates, and existing generators, selections and edits apply
before mapping. Each pattern segment is clipped against the chart triangles
and mapped with the triangle's own affine weights, so every resulting point is
exactly incident to its supporting triangle and the mesh occludes the marks as
it occludes anything else. Straight pattern segments map exactly; a curved
motif is represented by the polyline you supply, and its accuracy is the 2D
flattening's own count, spacing or tolerance. The result is ordinary supported
curve data: editable, queryable, samplable and drawn with `strokes`.

Numeric coordinates are chart units, never paper percentages. Material in
sketch units (`t.material(shape)`, `t.sample(shape, { count })`) names the
rectangle that should cover the chart through `frame: { x, y, width, height }`.
`chart` selects one island of a multi-chart mesh (a box face, a cylinder cap);
without it, overlapping islands each receive the pattern. A UV seam keeps its
own nodes: the two ends of a ring around a cylinder share a position but not a
graph node. Where one physical sheet folds onto itself in chart space, the
extra sheets become numbered `layer` chains rather than an error or a silent
choice. Edges carry `chart`, `component`, `pattern` and `layer` plus the
material's edge columns; nodes interpolate its point columns. Source phase is
the pattern's own parameter, so dashes and selections survive splitting into
surface pieces, chart gaps and occlusion.

`await t.mapSurface(...)` in `sketchAsync` runs the same construction with
event-loop yields and cancellation for substantial patterns; the synchronous
form suits ordinary sketches. Budgets (`maxCandidates`, `maxInputSegments`,
`budget.maxNodes`, ...) are unlimited by default; an explicit cap refuses the work
before allocating it.

```ts live
import { sketch, curve, label, pen, mm } from 'occlude';
import { plane, mapSurface, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: { ink: pen({ width: mm(0.25), color: '#18202A' }) } }, t => {
  const sheet = plane(4).subdivide(4)
    .displace(p => [0, 0, 0.4 * Math.sin(p.x) * Math.cos(p.y)]);
  const stripes = t.times(16, (_, u) => curve([[0, u], [1, u]], { closed: false }));
  const marks = mapSurface(sheet, stripes);
  return [
    view([sheet, marks], { camera: orthographic({ eye: [5, 7, 5], span: 6 }), stroke: 'ink' }),
    label('MAPPED STRIPES', 8, 94, 4, { stroke: 'ink' }),
  ];
});
```

A pattern attached to the rest shape stays attached: map onto the undeformed
mesh, then `rebind` the marks to the deformed revision (the same triangles,
the same affine weights, no reseeding and no projection). Mapping directly onto
the deformed mesh gives identical geometry because the chart is stored, not
recomputed. A closed ring maps to a topologically closed loop.

```ts live
import { sketch, curve, strokes, label, pen, mm } from 'occlude';
import { plane, mapSurface, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  motif: pen({ width: mm(0.2), color: '#A84932' }),
} }, t => {
  const rest = plane(4).subdivide(4);
  const ring = (cx, cy, r) =>
    curve(t.times(40, k => [cx + r * Math.cos(k * Math.PI / 20), cy + r * Math.sin(k * Math.PI / 20)]));
  const motif = t.times(5, (_, u) => t.times(5, (_, v) => ring(0.1 + 0.8 * u, 0.1 + 0.8 * v, 0.07))).flat();
  const attached = mapSurface(rest, motif);
  const sheet = rest.displace(p => [0, 0, 0.5 * Math.sin(p.x * 1.5) * Math.cos(p.y)]);
  const marks = attached.rebind(sheet);
  return [
    view([sheet, marks], { camera: orthographic({ eye: [5, 7, 5], span: 6 }) }, lines => [
      strokes(lines.visible.filter(c => !c.kinds.has('mapped')), { stroke: 'ink' }),
      strokes(lines.visible.filter(c => c.kinds.has('mapped')), { stroke: 'motif' }),
    ]),
    label('REST MOTIF / REBOUND', 8, 94, 4, { stroke: 'ink' }),
  ];
});
```

Marks attached to a prototype repeat with its instances through
`marks.place(instances)`: attachments are re-evaluated on every placed triangle
without realizing the mesh, and each copy's edges carry its `instance` ID.

## Surface fields, light and images

Surface generators read fields over the surface. Each callback receives a
surface location: `position` and `normal` (world when placed), `modelPosition`
and `modelNormal`, `uv` and `chart`, unit chart directions `tangentU` and
`tangentV`, `pointAttributes`, `faceAttributes` and `cornerAttributes`, plus
`triangle` and `barycentric` for anyone who needs them. Direction fields
return a vector (projected onto the tangent plane by the consumer) or `null`
for "no direction here"; tone fields return 0 (light, no marks) to 1 (dark,
full requested coverage).

The ingredients compose rather than preset a look:

- A plain vector is a world direction projected onto the surface.
- `s => s.tangentU` follows the chart; `across(field)` turns any direction a
  quarter turn within the tangent plane, which is the natural crosshatch.
- `gradient(scalar)` is the per-triangle gradient of a scalar field (exact for
  the linear interpolant of its vertex values).
- `curvature('max' | 'min', { smoothing, creaseDegrees, minConfidence })`
  is the estimated principal direction on the represented mesh: an unoriented
  line whose sign follows the trace, `null` at umbilics and flat regions below
  `minConfidence`, and never averaged across a crease. It is an estimate of a
  polygon mesh, not analytic geometry.
- `light({ direction, ambient, ramp, space })` is an explicit tone recipe:
  `direction` points toward the light, illumination is
  `ambient + (1 - ambient) * ramp(max(0, n·L))` on the geometric normal (world
  by default) and tone is its complement, so a face turned away reaches
  `1 - ambient`. There is no hidden camera light.
- `t.image(name).surface({ channel, origin, wrap, area, uv })` samples an
  uploaded image over the chart: `channel` lum, dark or a; chart (0, 0) at the
  image's bottom-left by default (or `top-left`); `wrap` clamp or repeat;
  `area` a box half-size in chart units applied once as a prefilter; Rec. 709
  luminance. The placement rectangle of 2D sampling plays no part.

Combine them in ordinary JavaScript: `s => Math.max(0, 2 * sun(s) - 1)`
activates a second family only in shadow, `s => sun(s) * ivy(s)` multiplies a
light by an image, and attributes, noise and distances are fields like any
other. Light and image recipes are data the host can evaluate in one GPU batch;
arbitrary callbacks run on the CPU.

The same sphere, three ingredients: meridians follow the gradient of height,
parallels run across it, and an explicit light decides where each family is
dense enough to draw.

```ts live
import { sketchAsync, label, pen, mm } from 'occlude';
import { sphere, gradient, across, light, view, perspective } from 'occlude/3d';

export default sketchAsync({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  warm: pen({ width: mm(0.18), color: '#A84932' }),
  cool: pen({ width: mm(0.18), color: '#2A6F8A' }),
} }, async t => {
  const ball = sphere(1.6, { segments: 32, rings: 16 });
  const height = gradient(s => s.position[2]);
  const sun = light({ direction: [-1, -2, 2], ambient: 0.1, ramp: 'smooth' });
  const meridians = await t.hatch(ball, { spacing: 0.12, direction: height, tone: s => 0.25 + 0.75 * sun(s), stroke: 'warm' });
  const parallels = await t.hatch(ball, { spacing: 0.12, direction: across(height), tone: s => Math.max(0, 1.6 * sun(s) - 0.6), stroke: 'cool' });
  return [
    view([ball, meridians, parallels], { camera: perspective({ eye: [4, -6, 3], target: [0, 0, 0], fovDegrees: 36 }), stroke: 'ink' }),
    label('GRADIENT / ACROSS / LIGHT', 8, 94, 4, { stroke: 'ink' }),
  ];
});
```

## Surface hatch

`await t.hatch(meshOrInstances, options)` traces lines across the represented
surface. It walks from triangle to actual adjacent triangle, transporting the
direction across each fold, so nearby folds and separate sheets are never
confused; it reads execution randomness for its seeds, so it lives on the
toolkit and gives the same lines for the same sketch and seed under any
camera. Options:

- `direction`: a vector or direction field; `spacing`: surface distance between
  neighbouring lines in model/world units (not chart units, not paper).
- `tone`: 0..1 constant or field (default 1); `stroke`: a pen name recorded on
  the lines so `view`'s default drawing uses it.
- `step` (default spacing / 2), `maxLength` and `maxSteps` per direction from a
  seed, `seeds` random restarts per surface, `maxTraces`, `maxSegments`,
  `maxTotalSteps`, `creaseDegrees` (default 60; 180 crosses every fold),
  `fallback` direction where the field reports none (an umbilic, a flat
  region): by default the chart's u direction, else world +X projected onto
  the surface.

One call is one family of lines. Crosshatch is a second call with its own
direction, tone and pen, and both values go into the same view; each call
keeps its own occupancy, so the two families cross freely.

Coverage is Jobard–Lefer style: every accepted line proposes new seeds one
spacing to either side, reached by walking across the surface, and a line stops
when it comes within half a spacing of an existing line of the same connected
component with an agreeing normal. That test is Euclidean distance with
topology and orientation guards, not geodesic distance, so equal spacing is
approximate on strongly curved regions. Lines are traced at full density
regardless of tone; each line's lineage gives it a lane number, and tone
selects lanes in nested octaves: lane 0 draws wherever tone is positive, odd
lanes need tone above 1/2, lanes divisible by two but not four above 1/4, and
so on. Halving the tone removes every other remaining line, and a segment is
drawn where the tone at both of its ends exceeds its lane's threshold, so
density follows tone along a line without regenerating the pattern. Ink
density is therefore quantized to those octaves; this is a tonal
approximation, not calibrated reflectance.

```ts live
import { sketchAsync, paper, label, pen, mm, inch } from 'occlude';
import { torus, view, orthographic } from 'occlude/3d';

export default sketchAsync({
  seed: 42,
  paper: paper({ width: inch(8.5), height: inch(11), color: '#F5F0E6' }),
  pens: { ink: pen({ width: mm(0.2), color: '#18202A' }) },
}, async t => {
  const model = torus(1.4, 0.45, { segments: 36, tubeSegments: 14 });
  // Lit from above: the top keeps every other lane (tone 0.3), the sides and
  // the inner throat fill in as the surface turns away.
  const marks = await t.hatch(model, {
    direction: s => s.tangentU,
    spacing: 0.1,
    tone: s => 0.3 + 0.7 * (1 - Math.max(0, s.normal[2])),
  });
  return [
    view([model, marks], { camera: orthographic({ eye: [5, 7, 5], span: 5 }), stroke: 'ink' }),
    label('TONAL HATCH', 8, 94, 4, { stroke: 'ink' }),
  ];
});
```

Here the first call follows the estimated maximum-curvature direction of a
custom deformed mesh under an explicit light, and the second runs across it in
another pen and appears only in shadow. Where curvature is undecided the
built-in fallback (the chart direction) takes over.

```ts live
import { sketchAsync, label, pen, mm } from 'occlude';
import { plane, curvature, across, light, view, perspective } from 'occlude/3d';

export default sketchAsync({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  shade: pen({ width: mm(0.18), color: '#56626A' }),
  cross: pen({ width: mm(0.18), color: '#A84932' }),
} }, async t => {
  const relief = plane(5, 4).subdivide(4)
    .displace(p => [0, 0, 0.6 * Math.sin(p.x * 1.4) * Math.cos(p.y * 1.1) + 0.15 * t.noise(p.x, p.y)]);
  const sun = light({ direction: [-2, 1, 3], ambient: 0.05 });
  const form = await t.hatch(relief, { spacing: 0.12, direction: curvature('max'), tone: sun, stroke: 'shade' });
  const cross = await t.hatch(relief, { spacing: 0.12, direction: across(curvature('max')), tone: s => Math.max(0, 2 * sun(s) - 1), stroke: 'cross' });
  return [
    view([relief, form, cross], { camera: perspective({ eye: [6, -8, 6], target: [0, 0, 0], fovDegrees: 38 }), stroke: 'ink' }),
    label('CURVATURE / CROSSHATCH', 8, 94, 4, { stroke: 'ink' }),
  ];
});
```

An image drives tone the same way. The ivy photograph's dark channel selects
lanes on a gently bent sheet; the marks are plotted lines, never a raster.

```ts live
import { sketchAsync, label, pen, mm } from 'occlude';
import { plane, view, orthographic } from 'occlude/3d';

export default sketchAsync({ seed: 42, pens: { ink: pen({ width: mm(0.2), color: '#18202A' }) } }, async t => {
  const sheet = plane(6, 4).subdivide(3).displace(p => [0, 0, 0.3 * Math.sin(p.x * 0.9)]);
  const ivy = t.image('ivy.png').surface({ channel: 'dark', area: 0.01 });
  const marks = await t.hatch(sheet, { direction: [1, 0.35, 0], spacing: 0.07, tone: ivy });
  return [
    view([sheet, marks], { camera: orthographic({ eye: [1, -6, 7], target: [0, 0, 0], span: 6.5 }), stroke: 'ink' }),
    label('IMAGE TONE', 8, 94, 4, { stroke: 'ink' }),
  ];
});
```

`trace(mesh, seeds, direction, { step, maxLength, maxSteps, creaseDegrees })`
is the pure lower-level tracer: explicit seeds (sampled or scattered points, or
surface locations), both directions from each, no spacing control, no tone,
no randomness. Loops close exactly when a trace returns to its start triangle.
Every emitted piece records the triangle it was traced in.

## Scalar isolines and cross-contours

`isolines(mesh, field, { count })` builds supported curves where a scalar
crosses each level. The field is a numeric attribute by name, or a callback over
a row that carries the point's `x`, `y`, `z` and attributes together with the
corner's `uv` and `chart`, so `p => p.z` and `c => c.uv[1]` (a cross-contour of
the stored coordinates) both read naturally. Values interpolate linearly inside
each represented triangle, so a nonlinear field is only as accurate as the
mesh. Levels are `{ count }` evenly inside the range, `{ spacing, offset? }`,
or an explicit `{ levels: [...] }` array.
Edges carry `level` and `levelIndex`. Seams keep their own chains; a level
through a vertex passes through it once. Silhouettes remain view features;
these are reusable model data.

```ts live
import { sketch, label, pen, mm } from 'occlude';
import { plane, cylinder, isolines, view, orthographic } from 'occlude/3d';

export default sketch({ seed: 42, pens: { ink: pen({ width: mm(0.25), color: '#18202A' }) } }, () => {
  const relief = plane(3, 3).subdivide(4)
    .displace(p => [0, 0, 0.5 * Math.sin(p.x * 2) * Math.cos(p.y * 1.5)]);
  const heights = isolines(relief, p => p.z, { count: 7 });
  const tube = cylinder(0.6, 2.2, { segments: 24 }).translate([2.6, 0, 1.1]);
  const rings = isolines(tube, c => c.chart === 'side' ? c.uv[1] : -1, { count: 8 });
  return [
    view([relief, heights, tube, rings], { camera: orthographic({ eye: [5, 7, 6], span: 6 }), stroke: 'ink' }),
    label('ISOLINES / CROSS-CONTOURS', 8, 94, 4, { stroke: 'ink' }),
  ];
});
```

## Connected-region extrusion

`mesh.extrude(faces, offset, { key })` raises a connected selection as one
region. Each connected component of the selection becomes a translated cap
that keeps its face and corner IDs, attributes and UVs, and every region
boundary edge (open sheet edges and hole loops included) grows one wall.
`offset` is a model vector, a callback over the frozen region (`index`,
`faces`, `normal`, `center`, `area`), or `{ distance }` along the region's
area-weighted mean normal, which is refused when the region's faces cancel.
Zero vectors and boundary-free closed shells are errors, not silent geometry;
self-intersecting results are not repaired. Independent per-face extrusion
remains the advanced `extrudeFaces3`. Walls carry a side chart
`key:side:<component>` with `uv = [loop fraction, 0|1]`, so surface patterns
on the result can address caps and walls separately through `chart`.

Attributes evolve in frozen passes first: here a face field is diffused with
`next.setFaces` over several steps, the warm region is selected with ordinary
collections, extruded as one region, and shaded through the same surface
fields as any other mesh.

```ts live
import { sketchAsync, label, meanBy, pen, mm } from 'occlude';
import { plane, light, view, orthographic } from 'occlude/3d';

export default sketchAsync({ seed: 42, pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  shade: pen({ width: mm(0.18), color: '#56626A' }),
} }, async t => {
  const sheet = plane(4, 4).subdivide(3)
    .faceAttributes({ heat: f => Math.exp(-3 * (f.center[0] ** 2 + f.center[1] ** 2)) })
    .steps(4, (current, next) => {
      next.setFaces(current.faces, f => ({
        heat: 0.5 * f.heat + 0.5 * meanBy(f.adjacent, a => a.heat),
      }));
    });
  const warm = sheet.faces.filter(f => f.heat > 0.2);
  const model = sheet.extrude(warm, { distance: 0.7 }, { key: 'plateau' });
  const marks = await t.hatch(model, {
    direction: s => s.tangentU, spacing: 0.1, stroke: 'shade',
    tone: light({ direction: [-1, -1, 2], ambient: 0.1 }),
  });
  return [
    view([model, marks], { camera: orthographic({ eye: [5, 7, 6], span: 5.5 }), stroke: 'ink' }),
    label('DIFFUSED / EXTRUDED', 8, 94, 4, { stroke: 'ink' }),
  ];
});
```

## Reuse across views

Geometry and marks are values: one patterned mesh can be drawn by several
views on one sheet, with ordinary clips, masks and labels around them, and a
patterned prototype repeats with its instances. Each `view` has its own key,
camera and paper `viewport`; Studio orbits and commits one view without
rerunning the sketch's modeling randomness or touching the other. Named pens
carry width and color; a one-off pen is just another entry in `pens`.

```ts live
import { sketch, paper, curve, strokes, clip, mask, rect, label, pen, mm } from 'occlude';
import { plane, box, grid, instanceOnPoints, mapSurface, view, orthographic, perspective } from 'occlude/3d';

export default sketch({ seed: 42, paper: paper({ width: mm(210), height: mm(148) }), pens: {
  ink: pen({ width: mm(0.25), color: '#18202A' }),
  pattern: pen({ width: mm(0.18), color: '#A84932' }),
  note: pen({ width: mm(0.3), color: '#2A6F8A' }),
} }, t => {
  const rest = plane(3).subdivide(3);
  const waves = t.times(9, (_, u) => curve(t.times(24, (_, v) => [v, 0.1 + 0.8 * u + 0.03 * Math.sin(v * Math.PI * 4)]), { closed: false }));
  const sheet = rest.displace(p => [0, 0, 0.35 * Math.sin(p.x * 2) * Math.cos(p.y * 2)]);
  const marks = mapSurface(rest, waves).rebind(sheet);
  const tile = box([0.5, 0.5, 0.2]);
  const tileMarks = mapSurface(tile, t.times(4, (_, u) => curve([[0.15 + 0.7 * u, 0.1], [0.15 + 0.7 * u, 0.9]], { closed: false })), { chart: 'f1' });
  const tiles = instanceOnPoints(tile, grid({ cols: 4, rows: 2, spacing: 0.7 }).translate([0, -2.4, 0]).points, { rotate: p => [0, 0, p.i * 15] });
  const model = [sheet, marks, tiles, tileMarks.place(tiles)];
  const draw = lines => [
    strokes(lines.visible.filter(c => !c.kinds.has('mapped')), { stroke: 'ink' }),
    strokes(lines.visible.filter(c => c.kinds.has('mapped')), { stroke: 'pattern' }),
  ];
  // The plan is a zoomed detail clipped to its framed panel; the oblique view
  // shows the whole model. Both read the same captured geometry and marks.
  const panel = rect(3, 4, 44, 88);
  return [
    clip(panel, view(model, { key: 'plan', camera: orthographic({ eye: [0, -0.4, 10], target: [0, -0.4, 0], up: [0, 1, 0], span: 4.2 }), viewport: { x: 5, y: 8, width: 95, height: 130 } }, draw)),
    panel,
    view(model, { key: 'oblique', camera: perspective({ eye: [5, -7, 5], target: [0, -0.6, 0], fovDegrees: 40 }), viewport: { x: 110, y: 8, width: 95, height: 130 } }, draw),
    mask(rect(56, 86, 20, 7)),
    label('PLAN DETAIL', 6, 96, 3, { stroke: 'note' }),
    label('OBLIQUE', 58, 90, 3, { stroke: 'note' }),
    label('ONE MODEL / TWO VIEWS', 58, 96, 3, { stroke: 'ink' }),
  ];
});
```

## Advanced: explicit scenes and stages

This section exposes `lineArt3` and its explicit stages for advanced work. Ordinary sketches use `view` and the values above; the same renderer, cameras and pens are underneath. The camera projects geometry into the sketch's drawable frame.

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

### Selecting lines

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

### Headless and host execution

A normal `sketch` can return a deferred scene. Compile it with `compileSketchAsync` or render it with `renderAsync`; synchronous entry points report that async rendering is required. The headless default uses the geometric CPU reference. To use WebGPU, create a host-owned `new GpuSceneCompute3(navigator.gpu)` and pass it as `{ compute3 }` to the async entry point. Reuse it across runs and `await compute3.dispose()` when the host closes. Importing the library and rendering ordinary 2D sketches never request a GPU adapter. Studio supplies this resource automatically and reports unavailable WebGPU rather than silently changing compute paths.

Each execution retains its classified scene results in `run.scenes3`. Repeating the same scene value within that execution reuses its visibility calculation. The main Studio 3D viewport retains captured geometry during exploration. Switching projection, orbiting and zooming leave the committed drawing unchanged; Commit view reclassifies the retained model and saves the chosen camera. A fresh sketch execution still rebuilds its model.

### Procedural construction

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

### Points, edges and instances

`PointSelection3(surface)` captures point positions, attributes, original-edge neighbors and boundary status. `EdgeSelection3(surface)` captures original polygon edges with endpoints, center, length, incident faces and attributes; triangulation diagonals are excluded. Both support iteration, `filter`, `map`, `groupBy` and `union`. Derive selections from one captured selection before unioning them. Point `adjacent()` follows original edges; edge `points` selects its endpoints.

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

### Reusing visibility and styling strokes

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


### Phase through hidden intervals

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


### Plane-section contours

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


### Surface hatch and crosshatch

`hatch3(surface, families, { maxSegments? })` captures a per-face pattern recipe. `families` is an array or a callback from a frozen face measurement to an array; return `[]` to leave a face unhatched. Each family has a unique `id`, `spacing`, paper-space `angle` in clockwise degrees, optional `offset`, and optional attributes. Add a second family for crosshatch. The callback runs once during capture, so model attributes can control density or direction without another callback during camera changes.

Pair `surface: hatch.surface` and `hatch` on the scene object. Generation waits until the camera and drawable paper frame are known. `mm(1)` means one millimetre between paper rulings; bare numbers and other length tags use the ordinary drawable units, even with a custom scene viewport. The pattern is view-dependent and is regenerated from its captured recipe for a different camera. Changing only a selector, pen or stroke modifier reuses classified geometry.

Rulings share one paper-origin lattice across every face of an object that has the same spacing, angle and offset, and a ruling is one stroke across all of those faces: its pieces meet at the edges between triangles and faces, so the pen stays down along it (a fold that hides part of a ruling still breaks it there). Each piece is lifted onto its supporting triangle with perspective-correct source weights. Folded faces therefore have piecewise surface support; this is not curvature-following hatch. Edge-on projected triangles produce no hatch. Coincident outer boundary strokes are omitted. Rulings are generated only across the sheet's band plus one sheet diagonal of overscan on either side, so a face seen from close by (the inside of a sphere around the camera) costs no more than the paper it covers while styles that reach past the edge keep their anchors. `maxSegments` (default unlimited) caps candidate segments and ruling iterations when set.

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
    const lines = constructStrokes3(classified, [
      { id: 'edges', stroke: 'outline', select: f => (f.flags & (FeatureKind3.crease | FeatureKind3.silhouette | FeatureKind3.boundary)) !== 0 },
      { id: 'hatch', stroke: 'fine', select: f => (f.flags & FeatureKind3.hatch) !== 0 },
      { id: 'sections', stroke: 'accent', select: f => (f.flags & FeatureKind3.section) !== 0 },
    ]);
    return [
      clip(rect(4, 4, 92, 84), t.strokes3(lines)),
      mask(rect(60, 75, 32, 13)),
      label('HATCH / SECTIONS', 61, 78, 2.5, { stroke: 'outline' }),
      label('PAPER SPACING', 61, 83, 2, { stroke: 'outline' }),
      label('SURFACE STUDY', 8, 94, 4, { stroke: 'outline' }),
    ];
  });
});
```

### Construction view in Studio

Open any live example above in Studio, then use the small **camera / sketch** switch at the bottom right of the sheet. The camera view draws the model in exactly the drawing's box, at the same pan and zoom, so switching moves nothing. Controls follow Blender: drag (or middle-drag) orbits about the target, shift+drag pans, ctrl+drag or the wheel zooms, shift+wheel and ctrl+wheel pan, numpad 1/3/7 are front/right/top (ctrl for back/left/bottom), 5 toggles projection, 2/4/6/8 step the orbit, ctrl+2/4/6/8 pan, Home frames the model. Click a mesh face to inspect its source ID and captured modeling attributes. **Commit view** reclassifies the retained model for the camera and writes it into the sketch's `view(..., { camera: orthographic({ eye, target, span }) })` call (or `perspective({ ..., fovDegrees })`), adding the factory to the `occlude/3d` import when needed; an explicit `lineArt3` scene falls back to `cameras3` configuration. **Copy** puts the same source on the clipboard. The scene menu selects among the sketch's captured scenes.

The **Projection** menu switches between orthographic and perspective. **Span** is the vertical size in scene units; **FOV °** is the perspective vertical field of view in degrees. Switching preserves the target, viewing direction, up vector and apparent scale at the target plane. The first perspective switch starts from 45° and adjusts eye distance; it narrows that FOV when needed to retain at least the existing near distance and avoid degrading depth-buffer precision. Near/far distances move with the eye so the world-space clipping planes stay fixed. Different depths naturally change apparent size under perspective. Reset, copy, orbit, zoom and face picking work in either mode. Projection changes are exploratory until **Commit view**; saving or downloading after committing preserves the projection and its parameters.

Construction keeps normalized world-space mesh and wire buffers on the GPU. Orbit updates a camera uniform; depth testing and camera clipping happen in the construction shader. Orbiting does not rerun modeling, surface queries or vector visibility, and does not change the committed paper drawing or its exports. Returning to the paper view shows the same cached result. **Commit view** classifies the explored camera against retained geometry and publishes a new vector drawing, preserving labels, clipping and styles. It does not rerun modeling. **Commit view** also writes the camera into `cameras3` in the editor without running the model again. Save or download the sketch to keep that configuration; rerendering or reopening it uses the committed camera. **Save result** captures the exact camera and drawing without requiring regeneration. Saved results preserve the camera actually used by their plan.

**Save result** preserves the selected plan and its exact SVG, resolved paper color, pens and timing settings. A 3D result also retains the committed camera frame, realized source meshes and attributes, generated curve attachments, compiled source, seed, engine and available GPU adapter details. Reopening that result uses its saved plan; it does not rerun deformation or read a new camera from the editor. Library changes do not replace the captured pens or paper. Construction preview cameras are exploratory and are not substituted for the committed camera in this record.

GPU interval refinement uses a physical paper budget of `min(0.005 mm, narrowest resolved nib / 20)`. All pens available to the execution count, because a retained classification can later be interpreted with another pen. Half the budget goes to interval endpoints; the other half is reserved for double-precision projection. Polygon triangles and authored straight segments introduce no smooth-surface tessellation approximation. The host converts the interval allocation into a source-parameter tolerance using the greatest projected speed along the clipped features, including perspective depth changes and off-page geometry. Uncertain GPU cuts are refined on the CPU. Refinement and the CPU reference retain the original world-space triangle and affine source points, so transforming almost coplanar surfaces into camera space cannot reverse their depth order. Exact predicates distinguish equal planes from a one-bit coordinate separation; they do not merge real gaps. Near/far clipping still applies at the occluding surface hit. Classification statistics report `paperToleranceMm` and `parameterTolerance`.

This budget is measured before the planner's existing input snap and is not a guarantee for arbitrary numeric magnitudes: double precision cannot recover detail already lost in the supplied coordinates. Paper size, camera and pen changes belong to the execution; a camera commit recomputes the projection-dependent tolerance. Pixel dimensions of the construction preview do not control vector precision.
