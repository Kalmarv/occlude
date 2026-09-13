# Isolated Studio host

The dev Compose override runs the existing `server.mjs` against the verified image's `dist`, with `HOST=0.0.0.0` and `PORT=5273`. This preserves the tunnel's bundled module URLs while enabling the same library and saved-result APIs used by Studio. The Vite source server remains separate. No application server code or Dockerfile change is needed.

The resolved Compose configuration was checked: all source/store mounts are inside `/home/kalmarv/containers/occlude-3d`. The dev stores remain under that checkout's `packages/occlude-studio/dev-store`. Only the isolated dev service was recreated; no production store, container or machine connection was used.

The served image passed the full `pnpm check` recorded in HATCH.md. After changing the host command, `/api/version`, `/api/sketches`, `/api/assets`, `/api/fills` and `/api/results` answer 200 JSON. Empty pen/paper stores and absent plot progress answer explicit JSON 404s by design, rather than Vite's missing routes. Direct Playwright passes eight live examples and main Studio GPU rendering/cached-plan SVG export against the new host; see `playwright-host/report.json`.

This enables persistent workflows but does not establish the full M5 save/reopen acceptance. Captured camera/backend/realized-model provenance, changed-library round trips and camera interaction still need implementation and verification.
