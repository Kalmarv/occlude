# The studio

The studio is the browser app you draw in: an editor, a live preview and a control rail, as a small multi-page app (the studio itself, plus Sketches, Evolve, Fills, Assets, Machine, Results and these docs). It is served by the studio server, which also owns the store — plain files under the studio's own `sketches/`, `fills/`, `assets/` and `results/` directories, shared by every browser that reaches that server. `localStorage` keeps the working sketch, the UI layout and caches of pens and profiles. A rebuild needs no restart: the server reads `dist`, and reports its build id, per request.

## Saving, snapshots, forks

**Save** (Ctrl/Cmd+S) writes the editor's text to the named sketch. The store is a git repository underneath, and every save is a commit, so a save is never lost.

**Snapshot** — the camera in the top bar — freezes the source *with the seed it rendered under*: the server commits the current file, then tags that commit with the seed (and any draw overrides), a label and the time. A snapshot is what you reopen when you want last week's drawing rather than last week's recipe.

**Fork** makes a new sketch from the current source, or from a snapshot or an older save, with a `// fork of <parent> @ <ref>` first line that the Sketches page reads to draw the branch.

Deleting a sketch takes it off the Sketches page but keeps its commits and its snapshot tags in git: a deleted sketch can be restored whole. A save cannot be deleted; git keeps every one.

Thumbnails are painted from the preview at save and snapshot time, and regenerated only when the server does not have one — never because it is stale. Regenerating means running the sketch, so a mended snapshot thumbnail shows today's pens and paper, not the ones it was made with.

The **lineage graph** on a card is a reading of git, not a stored structure: time runs up the card, a rail is solid between two kept nodes and a hairline through a folded run of saves (click to expand it), snapshots fan sideways from the save they hang off, and the current render caps the head. Clicking a node opens its actions — open, evolve, fork, and a gallery for a snapshot.

## Seeds and variations

The status bar reads `seed <base>`, or `seed <base> +N` when the seed carries N draw overrides, with `reroll` and `copy url` beside it. A long, override-heavy seed rides the URL fragment rather than the query, and a reader accepts either form. An override whose address no longer matches a draw in the source is listed and dropped, which is how a stale tail sheds itself. *Seeds and randomness* on the getting-started page has the grammar and the rules.

## Evolve

Evolve chooses among variations of a drawing without touching its source. Nine tiles: the middle is the current candidate, eight are mutations of it, and the last is a fresh random seed. A mutation re-answers a few of the sketch's own random draws — how many follows the `variation` control — and each chosen draw either takes a new unit float or is nudged by a Gaussian, so a variation is the same source and seed with a handful of decisions changed.

Hover a sheet for a moment and that tile shows large. Click a variation to make it the middle and the page *cools*: the draws that changed become unlikely to move again, the others keep their accumulated heat, and the variation percentage falls. **Again** is the inverse — it re-rolls the eight mutations and warms them a little — but only once the lineage is a couple of picks deep, so it stays a nudge rather than a step. Clicking the middle cools it without changing anything else.

`Keep` writes exactly one snapshot of the middle, labelled `evolved`. `Open in studio` keeps it, then opens it with the overrides in its seed. Back and the lineage crumbs jump to an earlier entry and truncate the strip. Nothing is written until Keep.

## Freeze

Freeze turns a run into a drawing. Every random call that ran **once** is replaced by the value it drew — a number for `rnd`, `true` or `false` for `chance`, the chosen item for `pick` — and the seed is pinned in the sketch's options with an override for every draw that stays. That second half is the point: removing a call from a stream would otherwise move everything downstream, and the overrides hold the rest where it was.

A call that ran more than once has no single value and stays a draw; the toast reports how many were written and how many stayed. Freeze needs a render, lands in the source as one undoable edit (Ctrl+Z), and cannot move the library's own draws — scatter, settle and fills are not addressed, so ink from those can still shift.

## Fills and assets

The Fills page lists the built-ins (read-only) and your own fills, each thumbnail rendered through the real engine on a circle and a rotated square, so a shape-aligned texture shows its anchoring. `New` opens the editor on a fill file, edits preview live, and Save (Ctrl/Cmd+S) writes it. Saving a fill that saved sketches use warns first, because their ink changes the next time they render; Clone keeps them exactly as plotted. Fills is the contract; *Images and imports* covers `svg()` and `image()`, and the Assets page is where a file comes from — upload by button or drag-drop, then copy the ready-made reference snippet from the card. The demo assets the package ships sit in that same store as ordinary cards.

## Machine

The Machine page is the plotter's own page — Web Serial hands a port to one page at a time — with the profile, the calibration cards, a serial log, and **Bed level**: the lift map as a heat grid of per-cell thresholds, cool where the pen needs the least lift. A selected cell shows its threshold, a `−800`/`+800` pulse nudge (one rung), an `unresolved` marker meaning clean at every rung, and `Test this cell`, which plots the ladder for that one cell so you can watch it. Edits go straight into the active profile and persist immediately — there is no undo — and park at the bed corner and Set bed origin before testing a cell. *Device notes* is the plotter's own paper: pen cycles, origins, calibration cards.

## Inspecting a material

The Debug menu's `material` checkbox turns on the material inspector: the sketch re-runs with its declarations instrumented, and the pane lists every material by variable name (`t.inspect(label, material)` names one that never lands in a variable). Pick points or edges in the preview, colour them by a column, and page to a row; the table says what a row is — an index in this state, in material coordinates, before drawing transforms. It changes nothing, costs nothing when off, and a frozen result has no inspectable material.

## Where the drawing goes

Plotting & saving covers the rest of the machine side: ranges, the per-pen exports, `Save result` (which freezes the selected chains, their SVG and the settings, and reopens without running the source) and Resume. The Plot panel's repair tools — Marks, Paint region, Plot only — are on that page too.
