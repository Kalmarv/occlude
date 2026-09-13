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
Only the dev service should be built/launched. It serves the verified production bundle via Vite preview on port 5273; this avoids raw /@fs module URLs through Cloudflare. Rebuild the isolated dev image to publish changes. For local source HMR, run Vite separately on an unused localhost port. Hardware-browser acceptance is separate.

## Gates

- M0: complete. Isolated dev image built and service launched on 0.0.0.0:5273. Baseline pnpm check passed all gates: Rust 14.2s, TS 20.1s, library types 4.7s, Studio types 4.3s, docs 12.1s, ink 14.0s, build 35.2s, smoke 2.2s. WASM MD5 f74997a8bc946afc3bbaf4c26c313909. These are local Docker gates, not a remote CI run. Full baseline build log is task-local (baseline-build.log).
- M1: camera, CPU oracle, actual GPU interval compute/readback, depth viewport and Occlude SVG laboratory verified on NVIDIA hardware with Playwright. See M1.md and playwright-m1/report.json. Full pnpm check passed for the bundled slice; original 2D ink baseline unchanged. The optional SwiftShader rerun reports device loss and remains a hardening item. Worker/revision integration and full scene API remain pending.
- M2–M5: not implemented. No large-scene performance or full MVP completion claim.
