# Paper composition bottom: independent box oracle

Fresh store source is captured in source.ts. No demo or renderer was changed.

`inspect-paper-box.ts` captures ordinary mesh-edge visibility for the saved camera, perspective, and two underside cameras. `oracle.py` independently intersects rays with axis-aligned box slabs using exact rational world coordinates. It does not use renderer triangles, camera transforms, interval helpers, or predicates. All 96 edge intervals agree with the CPU within 1e-12. Main Studio Playwright on the non-fallback NVIDIA adapter agrees within 8.05e-16 (gpu/report.json), with clean Monaco and browser diagnostics.

The tower reaches y=0.8; the block reaches y=0.75. A small bottom notch is geometrically expected. The two overlapping bottom faces are separate surfaces, not an implicit Boolean union.

The saved view and perspective variant export no zero-length paths. Underside views export two and three zero-length paths respectively. The verifier deliberately reports failure for this symptom and saves all four SVGs; do not describe it as a clean four-view export pass.

The CPU capture retains all ordinary box edges and only the curve records with a visible interval shorter than 1e-10 for diagnosis; that selection does not alter classification or ink.

`trace.py` traces nine microscopic hatch intervals on block face f4. Its rational world-space endpoints use normalized barycentric weights to preserve the supporting plane exactly. The tower bottom is -0.7999999999999999 while the block bottom is -0.8. Consequently the exact box oracle also finds positive gaps (roughly 2.6e-16–4.4e-16 in source parameter). Camera-space classification gives roughly 1.0e-15–2.2e-15. These collapse to point paths on the output grid. An exact shared-bottom input control removes all nine starting gaps in the independent oracle; the control does not modify the demo or renderer. This is not evidence of missing box-edge occlusion, and removing all small intervals with a global tolerance would also remove real gaps. The output treatment of quantized line degeneracies needs a deliberate policy; no numerical tolerance or demo coordinate workaround was applied here.

`paper_trace.py` additionally follows all 23 visible box-edge fragments in the saved view through independent projection, full-source input snapping, interval selection, rectangle clipping and masking. Every fragment matches its exported SVG segment to the four-decimal export precision (maximum endpoint difference 0.00005 mm). This includes the short bottom notch from the tower overhang and the cut at the composition clip bottom, y=240.08 mm. It uses no renderer camera, stroke-construction or clipping helper.

This evidence does not establish or fix temporal construction-preview flicker. The original request in 3dapi.md refers to exported lines. The fresh report did not identify a camera or specific fragment beyond “at the bottom.” Keep the report open rather than equating correct box contours with resolution of every symptom.

Reproduce from the worktree root:

```
pnpm --filter occlude exec tsx tools/inspect-paper-box.ts
python3 development/3d/paper-box-oracle/oracle.py
python3 development/3d/paper-box-oracle/trace.py
python3 development/3d/paper-box-oracle/paper_trace.py
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-paper-box-oracle.mjs
```
