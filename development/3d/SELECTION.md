# Point/edge selections and instance geometry

`PointSelection3` and `EdgeSelection3` capture immutable resolved rows and derive filtered/grouped views over that capture. Point rows include original-edge neighbors and boundary status; edge rows include endpoints, center, length, incident faces and attributes. They deliberately exclude triangulation diagonals. Unions require views from the same capture. Edge-to-point conversion shares the captured data.

`editPoints3` and `editEdges3` apply captured membership to an exact source surface value, reject a different source/changed identity, evaluate callbacks against frozen rows from one input, then commit owned copies. Positions, attributes, semantic IDs and fixed triangles have explicit preservation/replacement semantics documented on the topic page. A callback failure leaves the input untouched. Membership predicates retain their original measurements; edit callbacks see the edit operation's input state.

`pointCloud3` creates the same editable point schema with empty faces/edges; it draws nothing implicitly. Open scene wires explicitly interpret position arrays, including points from a cloud.

Scene objects now accept world-space instance transforms. Shared source geometry is captured once per scene. Each instance receives its own projection/features/source-object identity; mirrored transformations use the existing winding-preserving geometry transform before feature extraction. Paper group transforms remain separate and act after projection.

Evidence:

- `three-selection.test.ts`: captured row isolation, original topology adjacency, boundary/edge selection, grouping/unions, edit atomicity, stable IDs/triangles, stale-source rejection, marked-edge feature extraction, point-cloud editing and transformed/mirrored instance equivalence.
- A fourth live 3D example edits top vertices, marks rim edges, instantiates shared geometry twice (including a mirror) and renders a sampled open wire.
- Direct Playwright runs all four 3D examples on NVIDIA hardware, opens the new example in the main Studio and exports SVG. Its marked pen color must survive export. Curated proof is in `playwright-selection`.
- The previous 223 stable docs examples retain their hashes. The new example adds one explicitly pinned hash.

Remaining full-spec work includes ordered stroke modifiers/phase and reusable public styling, main Studio camera/viewport/caching/persistence, M4 hatch/sections, and M5 adversarial topology/numerics, performance/reference fixtures and handoff. This slice is not full MVP completion.

Final isolated-image `pnpm check`: Rust 10.6s, TS 21.3s, library types 5.2s, Studio types 4.7s, docs 12.4s, ink 14.1s, build 35.3s, smoke 2.3s. WASM remains `c21c4ef21cb4091b6019b1aa440f6bea`. Production container start times remain unchanged. The preview-host library/machine endpoint limitations recorded in SCENES.md remain in the browser report; the docs-to-Studio flow supplies its captured libraries.
