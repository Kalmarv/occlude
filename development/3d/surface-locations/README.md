# Owned surface locations and explicit sample rebinding

Shared foundation for `3dpt2.md`, parent `8f50ce6`. The complete assignment is
still active. This checkpoint does not deliver M6 intersections, primitive UV
factories, mapped/traced curves, tonal hatch, the new GPU batch, or region
extrusion.

A location owns a source snapshot, triangle/face/vertex identities and affine
weights. It exposes model coordinates and geometric normals, optional captured
placement coordinates, separate interpolated point/face/corner attributes,
chart coordinates and tangent derivatives. Numeric fields follow existing
weighted sampling arithmetic; categorical/nearest fields use greatest weight
and canonical source ID. Triangle corner values remain separate at seams.

UV/chart columns default to `uv`/`chart`; sampling/scatter and rebind can select
other names. Missing and degenerate charts are explicit statuses. Incomplete UV
pairs, mixed chart identities, nearest-only active coordinates and unrepresentable
frames are diagnosed. UV orientation uses the robust determinant; tangent-frame
orientation accounts for mirrored placement. The internal location constructor
accepts an explicit current model-space shading normal and applies the inverse
transpose to placement, separately from geometric support. Rebind drops that
optional normal unless the caller evaluates it again. Public sampling currently
uses geometric normals; smooth-normal field generation remains later work.

Attachment lineage is separate from oriented adjacency. Unchanged incidence can
survive motion, attribute edits, winding reversal and index reorder. An
independently created surface with identical generated labels cannot inherit an
attachment. Topology changes require regeneration or an explicit transfer. The
triangle identity lookup is weakly cached per owned revision, avoiding a whole
mesh search for each rebound sample. Placement revisions are captured by input
identity and validated content; equal labels on different inputs do not identify
the same placement. Existing captured locations do not mutate with their input.

`t.sample` and `t.scatter` expose this context through `.sample` and preserve the
original random draw schedule and sample-normal arithmetic in its representable
range. `.rebind(target)` evaluates retained attachments without reseeding or
nearest projection. It preserves point IDs, captured/edited point columns and
generation statistics, refreshes the target schemas, resets positions onto the
attachment and starts a new point-edit history. Old values remain frozen.

The modeling mirror test now counts negative scale axes rather than multiplying
them, so a determinant underflow cannot silently lose winding reversal. This
changes tiny mirrored inputs that previously had incorrect orientation; ordinary
existing examples are expected to retain their ink.

Eleven new tests cover analytic positions and derivatives, seams, typed domain
separation, edited point state, custom coordinates, invalid charts, model/world
normal transforms, tiny mirrors, placement identity, lineage and rebinding.
Existing sampling, topology and corner regressions also run. A live `three#23`
example repeats the same sites on a rest sheet and its deformation.

All nine Docker gates pass on the final source. All 243 prior stable drawings
retain their hashes; the new example gives 244 stable and two unstable entries.
Church remains 15,601 chains / 96,037 mm draw / 16,515 mm travel / 381.0 minutes /
bridge 0 / Euler 15,593 / coincident 18.1 mm. WASM remains
`8bf0034cb79606aa8d6c7293496a1b7e`.

All 24 live examples pass in actual Studio with empty Monaco diagnostics,
nonfallback NVIDIA Turing GPU execution and SVG output. The rest/deformed pin
example was visually inspected. Four independent paper-box cameras retain
maximum interval error 0 across 96 edges and 1,685 curves; nine world-depth
probes pass. The complete-curve oracle includes the existing tiny-path cases;
there is no short-line suppression or support offset.

Dev stamp: `8f50ce6-surface-locations`. Running image:
`sha256:d24f9bb5550a90736a4383cb370e863f3a873cf3263dbca6dfd13850c8c871b2`.
Only isolated Compose service `dev`, port 5273, was recreated. No store writes
or production actions were made. Logs are normalized only by trimming trailing
whitespace; large paper reports use reproducible gzip alongside an ignored
local JSON copy.

Reproduce from the isolated checkout:

```sh
OCCLUDE_BUILD_STAMP=8f50ce6-surface-locations docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev build dev
docker compose -p occlude-3d -f docker-compose.yml -f compose.3d.yml --profile dev up -d dev
cd packages/occlude-studio
DISPLAY=:93 OCCLUDE_API_EVIDENCE=../../development/3d/surface-locations/live node --input-type=module < ../../development/3d/surface-locations/verify-live.mjs
DISPLAY=:93 OCCLUDE_PAPER_FIXTURE=../../development/3d/paper-world-depth/after OCCLUDE_API_EVIDENCE=../../development/3d/surface-locations/paper node tools/verify-paper-box-oracle.mjs
DISPLAY=:93 OCCLUDE_API_EVIDENCE=../../development/3d/surface-locations/world-depth node tools/verify-world-depth.mjs
```

Next: multi-source supported curves and their query/construction consumers,
retaining exact original-world source information through rendering. Primitive
charts, M6 contacts, M7 mapping/tracing/tone/GPU evaluation, region extrusion and
the full acceptance/integration/performance audit remain required.
