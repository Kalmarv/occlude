# Stored surface-coordinate checkpoint

Base: `bce6f2b`. Built-in primitives retain typed `uv` and `chart` corner columns.
Geometry, source IDs and fixed triangulation remain unchanged. Sphere/cone/axis
poles retain one geometric point with separate sector-midpoint corner values;
periodic seams and cap islands retain separate coordinates without duplication.
Sweep uses normalized represented profile/path arclength; revolve uses angular
fraction and represented profile arclength. Original profile coordinates provide
cap charts. The operation does not infer a smooth analytic surface or unwrap an
arbitrary mesh.

`planarUV` and `cylindricalUV` store explicit projections in ordinary columns,
retain unrelated attributes, and restore interpolated UV/categorical chart
transfer. Frames use the supplied current geometry coordinates, with no ambient
world/camera state. Later deformation preserves stored charts. Explicitly
repeating projection after a transform gives a world-fixed intention.
Cylindrical faces spanning half a turn or enclosing the axis require subdivision
or a separate planar cap chart. Degenerate planar charts remain explicit through
surface-location diagnostics.

Focused tests check all generators, poles/seams, unequal arclength, signed
revolutions, frame projection, deformation, mirror/extraction/subdivision and
realization. Existing missing-chart tests now use a custom mesh, since plane
intentionally includes coordinates. All existing docs ink is unchanged. The new
`three#26` sample-band rebind example is the only baseline addition. Initial docs
hashing caught an unsupported non-null assertion in the live-example JS converter;
the example now uses typed corner UVs. Failure and correction logs are separate.
Church output remains 15601 chains, 96037 draw mm, 16515 travel mm and 381.0 min.

This is the coordinate prerequisite for M7 mapping/tracing, not the whole M7
milestone. Vector mapping, image bridge, tracing/tone/coverage, GPU evaluation,
connected extrusion and the broad acceptance workflow remain required.

All nine Docker gates passed. Dev stamp `bce6f2b-surface-uv` serves the new
implementation. Focused Playwright checks of `three#26` pass imports/Monaco,
SVG output and a nonfallback NVIDIA adapter with no page errors; the screenshot
was inspected. `rest-coordinates` is saved in the dev sketch store with exact
source readback. See `deployment.json` and `live/report.json`.
