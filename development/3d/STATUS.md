# 3D implementation evidence

Original specification: [spec.md](spec.md). All M0–M5 requirements remain in scope.

## Isolation

- Starting commit: c705cdeb6a575eecc2759572e8d43dbb8e4316d2 (clean production checkout).
- Independent local clone: /home/kalmarv/containers/occlude-3d.
- Work branch: feat/3d-webgpu; authorized remote progress destination: origin/dev.
- Compose project: occlude-3d; image: occlude-3d-dev:latest; bind: 0.0.0.0:5273 (Cloudflare tunnel).
- Source and dev-store bind mounts resolve inside the independent clone.
- Existing containers observed before work: occlude-studio-1 (b992b42d6f33), occlude-dev-1 (415b0e14233b). No production restart, deployment, store mutation or plotter connection authorized.

## Reproduce

From the isolated clone:

```sh
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev config
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev build dev
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev up -d dev
```

The dev image builds WASM from source and runs pnpm check, including smoke tests.
Only the dev service should be built/launched. It serves the verified production bundle and the existing Studio APIs via server.mjs on port 5273; this avoids raw /@fs module URLs through Cloudflare and enables isolated library/result storage. Rebuild the isolated dev image to publish changes. For local source HMR, run Vite separately on an unused localhost port. Hardware-browser acceptance is separate.

## Gates

- M0: complete. Isolated dev image built and service launched on 0.0.0.0:5273. Baseline pnpm check passed all gates: Rust 14.2s, TS 20.1s, library types 4.7s, Studio types 4.3s, docs 12.1s, ink 14.0s, build 35.2s, smoke 2.2s. WASM MD5 f74997a8bc946afc3bbaf4c26c313909. These are local Docker gates, not a remote CI run. Full baseline build log is task-local (baseline-build.log).
- M1: camera, CPU oracle, actual GPU interval compute/readback, depth viewport and Occlude SVG laboratory verified on NVIDIA hardware with Playwright. See M1.md and playwright-m1/report.json. Full pnpm check passed for the bundled slice; original 2D ink baseline unchanged. The optional SwiftShader rerun reports device loss and remains a hardening item. Dedicated construction-worker ownership, revision-aware scheduling, cancellation and restart are now verified in the production bundle; see WORKER.md and playwright-worker/report.json. The additive async sketch compiler/renderer and Studio worker execution boundary are implemented; see ASYNC.md. Deferred lineArt3 scenes now resolve in the async compiler and render through an explicit lazy GPU resource in the main Studio worker; see SCENES.md. The async toolkit now exposes GPU deformation and surface queries; see TOOLKIT.md. The main Studio construction viewport now supports orbit, zoom and source-face picking without rerunning modeling; see CONSTRUCTION.md. Committing a preview camera against retained drawing composition remains pending.
- M2: polygon topology, feature extraction, projected BVH, streamed mesh visibility and lab feature filtering implemented; see MESH.md. Hardware source and served-bundle verification pass; full pnpm check passes with unchanged 2D ink for the mesh slice. Basic interval-priority line sets, source chaining and protected paper-stroke integration now pass; see STROKES.md. Reusable classification, feature selections, independent line styles and ordinary modifier stacks are implemented; see STYLING.md. Source-chain modifier evaluation now preserves dash/wobble phase across visibility cuts and paper cropping; see PHASE.md. Other milestone requirements remain pending.
- M3: editable grid, face selection/measures, independent extrusion with parentage, transforms, frozen passes and hardware GPU displacement/adjacency are implemented; see MODEL.md. Batched CPU/GPU surface queries now constrain the procedural demo; see QUERIES.md. Point/edge selection and edits, point-only data and world-space instance transforms are now implemented; see SELECTION.md. Remaining workflow and hardening requirements are pending.
- M4: source-supported plane sections, ordinary visibility and attribute-driven section styling are implemented; see SECTIONS.md. Physical paper hatch/crosshatch and a composite with named pens, labels, clipping and masking are implemented; see HATCH.md. Full isolated pnpm check and source/served-bundle Playwright checks pass on NVIDIA hardware. Camera interaction, persistence and remaining acceptance requirements are pending.
- M5: saved results now retain committed camera/realized geometry/backend provenance; see CAPTURE.md. The changed-library source and served-bundle browser round trips pass. Hardening and handoff remain unfinished. Large-scene CPU/GPU and orbit baselines are now measured; see PERFORMANCE.md. GPU visibility is slower on the measured fixtures. Retained world buffers now bring large-scene orbit to approximately 30 FPS in the main Studio; see RETAINED-VIEWPORT.md. No full MVP completion claim.
