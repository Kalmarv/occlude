# Imperial paper composition acceptance

The named demo is [demos/paper-composition.ts](demos/paper-composition.ts). Import it into Studio with the starter `pigma-01-black` pen and `Letter` paper library entries. It uses US Letter (8.5 × 11 inches), two differently colored instances of the same imported pen model, a one-off caption pen, a retained 3D drawing with physical hatch, and ordinary 2D clipping, labels and a mask panel.

The portable [downloaded sketch](playwright-paper-composition/paper-composition.ts) bundles those definitions and the committed camera. It can be imported without those library entries. The [SVG](playwright-paper-composition/composition.svg) and [Studio screenshot](playwright-paper-composition/composition.png) show the camera-committed composition.

`packages/occlude-studio/tools/verify-paper-composition.mjs` uses direct Playwright and the actual served main Studio with a nonfallback NVIDIA GPU. It orbits and commits the camera, downloads through the UI, replaces the pen and paper API libraries with incompatible definitions, and reopens the downloaded source. Assertions require identical plan hash, physical paper, full resolved pens, plan settings, camera and SVG. All three ink colors must occur in the SVG. The report records the before/committed/reopened values and browser errors. This verifies downloaded-source regeneration; saved-result reopening without modeling is separately covered by STUDIO-ADOPTION.md and its regression evidence.

Run from the worktree root:

```sh
DISPLAY=:93 pnpm --filter occlude-studio exec node tools/verify-paper-composition.mjs
```

Evidence: [report.json](playwright-paper-composition/report.json). The screenshot was visually inspected for composition, mask behavior and ink colors. No production deployment or plotter connection is involved.

Validation for this slice: isolated container `pnpm check` passed all gates (Rust, TS, library and Studio types, live docs, unchanged docs ink, build, WASM hash and smoke). WASM remains `615f9d1b7a63396d451fd33aac18b559`. This slice adds demo/evidence files and a browser verifier; application code is unchanged. The browser check ran against the existing served `9cbf24b` application. Production container IDs and start times remained unchanged.
