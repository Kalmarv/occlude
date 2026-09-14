# User feedback to revisit at final handoff

Include these items explicitly in the final M5 handoff; do not silently implement the deferred API/control choices.

- **Camera controls and iteration:** changing/overwriting the camera and rerunning a sketch is a valid expected workflow. The user has further camera-control ideas and wants to discuss them together later. The current retained Commit view path rejects eager fixed projected strokes; revisit that interaction and whether ordinary camera editing/rerendering should be the default.
- **Crease tolerance:** the user noticed inconsistent base-grid lines in the section-towers example and suggested a user-controlled crease tolerance. Discuss this after the current implementation work. Numerical false creases on exactly coplanar surfaces are a correctness bug being fixed now; an artistic angle threshold is a separate deferred choice.
- **Verification quality:** the user correctly pointed out that unintended base-grid lines should have been caught before their report. Browser success and screenshots alone did not prove semantic feature correctness. Explicit camera-invariant flat-edge and real shallow-fold regressions now address the reported gap.
- **Later geometry/style work:** box-box intersection curves and Krbn-style curvature-following hatch were discussed and accepted as post-M5 work.
