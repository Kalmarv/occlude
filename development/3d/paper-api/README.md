# Paper composition acceptance target

`../api-examples/paper-composition.ts` is executed in the actual served Studio
with Playwright, NVIDIA Vulkan and a non-fallback WebGPU adapter. The verifier
instruments model/interpretation observations; it does not change the target's
geometry, pens, camera or emitted ink.

The target verifies imperial Letter dimensions/color and named pen widths;
positive visible, hidden-crease and hatch intervals; hatch support belonging to
selected decorated faces; and zero false point paths in shade ink. The exported
shade segments respect physical-paper clip and mask bounds in orthographic and
perspective projections. The generous original clip happens to contain all
shade ink, so a deliberately smaller clip supplies a non-vacuous clipping
control. Removing both operators produces paths outside that smaller clip and
through the mask. These negative controls are recorded separately in the report.
The 0.01mm border allowance accounts for the existing 0.005mm output grid; it is
a verification tolerance, not a visibility-kernel change.

Projection exploration leaves the committed SVG unchanged. Commit recomputes
interpretation without a model callback rerun. Download/reopen retains the exact
camera, hash, SVG, pens and plan settings. Monaco diagnostics and browser page
errors are clean. The orthographic screenshot was visually inspected.

`report.json` holds both projections, interval observations, clip/mask checks
and negative controls. `portable.ts` is the actual downloaded perspective
sketch, including instrumentation. Full Docker gates for this slice are in
`../demo-migration/build.log`. This acceptance target is distinct from the
user-edited store demo; no claim is made that it resolves the fresh bottom
artifact report.
