# Supported curve consumers and render timeout

Base commit: `342424496c6ecff574bb1b3a15669e0d681ea0f2`.

Supported curve references now use their authored chain identity and parameter
order. Exact-world collinear support splits collapse in the reference polyline;
visible pieces map back onto that canonical reference. Attribute selection,
construction selection, presentation corners and disabled output chaining retain
the complete reference. Different source chains and graph branches do not join.
Legacy mesh edges, section curves and paper hatch retain their prior behavior.
Focused tests compare both reference data and actual planned wobble/dash output
under equivalent support subdivision.

`t.sample(curves, {count?, spacing?, maxPoints?, maxSupports?, key?})` returns
ordinary editable point geometry with retained curve interpretation. Spacing is
in model/world units and uses a floating arc-length metric. Generated positions
use exact affine interpolation on the supported segment. Each context exposes
all incident surface locations, rather than choosing an arbitrary normal at a
crease or a multi-surface seam. `.sample.on(meshOrInstances)` selects actual
source ownership. Selection, attribute edits, transformations and frozen steps
retain the interpretation. Explicit `.rebind(reboundCurves)` refreshes positions
through owned curve lineage and retained exact fractions; matching labels do not
permit rebinding to an unrelated regenerated graph.

Surface locations accept internal exact weights and retain exact represented
positions through rebinding, including triangle-order changes under mirrors.
The original numeric barycentric path remains unchanged for existing callers.
Open chains include endpoints, closed chains omit the duplicate seam, branches
and selection gaps stay separate, and isolated contact points remain point data.
Sampling requires a representable positive chain metric. It is a bounded
synchronous point operation, not a new async tracing or mapping implementation.

Studio's render watchdog is raised from 20 seconds to 60 seconds as requested.
It includes sketch execution/construction time. Edit/undo preemption remains a
separate mechanism so replacing a long-running sketch stays responsive.

The deliberate `three#24` baseline update reflects canonical supported reference
traversal; `three#25` adds the sampled-seam example. All other docs hashes and
church routing are unchanged. The full M6/M7/selected-M8 goal remains open:
additional curve consumers, mapping/tracing/tone, region extrusion, GPU evaluation,
and the full workflow/performance acceptance are still required.

All nine Docker gates passed. Dev serves `3424244-curve-sampling`; focused
Playwright checks passed for examples 24 and 25 with no page errors or Monaco
diagnostics and a nonfallback NVIDIA adapter. The sampled-seams screenshot was
inspected and its source saved/read back in the dev sketch store. A 22.4-second
render completed with the browser watchdog recorded at 60,000 ms. See
`deployment.json`, `live/timeout.json`, and `live/report.json`.
