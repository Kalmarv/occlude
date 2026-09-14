# Reported paper-composition bottom overlap

Inspected the current dev-store source at http://127.0.0.1:5273/api/sketches/paper-composition in the main Studio with Playwright and NVIDIA Vulkan. Store source and camera were read without saving or modifying the sketch.

The block bottom is -1.6/2 = -0.8. The tower bottom is 0.6 - 2.8/2 = -0.7999999999999999. The bottom faces overlap in XY and are effectively coplanar in the float32 construction renderer. Their perimeter wires remain separate model edges; these solids have not been boolean-unioned.

Captured paper drawing/SVG, construction view and underside. Static screenshots establish the overlapping geometry but do not establish temporal flicker. User clarification requested: interactive construction view versus paper drawing. No renderer or geometry fix applied; do not mark the reported artifact resolved.

The captured paper SVG contains 198 single-segment paths and zero quantized zero-length paths. This rules out the previously observed stray endpoint-dot symptom in this capture; it does not prove every bottom edge is correct.
