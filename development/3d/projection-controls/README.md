# Main Studio projection controls

The actual Studio construction toolbar has Orthographic/Perspective plus
Span/FOV controls. Target-plane framing, target, direction and up survive a
switch. A 45-degree perspective default moves the eye outward when required;
when it would move inward, the FOV narrows instead, preserving the existing
near distance and depth-buffer precision. Clipping planes stay fixed in world
space. Exploration is retained independently for each scene. Reset restores
the selected scene's committed camera; a new execution resets exploration.

The served image on 127.0.0.1:5273 passed all Docker gates (`gates.json`).
Main Studio Playwright/NVIDIA verification covers:

- Both projections, visible field labels, FOV editing, orbit and zoom.
- Perspective face picking and copying the actual camera through the clipboard.
- Both-mode reset and independent exploration across two scenes.
- Unchanged committed SVG and no model RNG/model execution during exploration.
- Perspective Commit view, captured geometry reuse, camera configuration,
  portable download and reopening with identical committed camera/plan.
- Invalid, obsolete and cancelled camera commits preserving the previous plan.

`camera-commit.json`, `camera-config.json`, `two-scenes.json` and `report.json`
record those checks. Unit tests separately verify target-plane projection and
world clipping-plane equivalence. Screenshots show the actual Studio UI;
`camera-commit.svg` is the committed exported drawing.

```sh
DISPLAY=:93 OCCLUDE_GPU_EVIDENCE=../../development/3d/projection-controls \
OCCLUDE_CONSTRUCTION_CHECK=1 OCCLUDE_CAMERA_CHECK=1 \
OCCLUDE_CAMERA_CONFIG_CHECK=1 OCCLUDE_PROJECTION_CHECK=1 \
pnpm --filter occlude-studio exec node tools/verify-scenes.mjs
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-projection-scenes.mjs
```

The network report includes expected 404 responses for a pen library not yet
saved and for no unfinished plot; the store explicitly uses 404 for those
empty states. There are no page JavaScript errors. Public Cloudflare Access
remains enabled; browser verification uses the served origin directly.
