//! The deferred render pipeline: nothing is clipped until `render` runs.
//!
//! Layer 2 — cull: z-sort, bbox index over opaque regions, containment cull,
//!           off-paper cull, "clean" marking (no later occluder overlaps).
//! Layer 3 — fills: generated lazily, only for surviving shapes.
//! Layer 4 — clip: each primitive visited once; the index is queried per
//!           primitive (a 2000-vertex polyline against one circle tests only
//!           nearby segments), occluders run front to back with early-out.
//!           Clip regions apply first with polarity inverted.
//! Layer 5 — cleanup and fragment output.

use crate::bbox::BBox;
use crate::cleanup::{dedupe_seams, spans_to_fragments};
use crate::clip::{clip_spans, fully_hidden};
use crate::fill::{FillKind, SuppliedFill};
use crate::fragment::{Frag, Span};
use crate::index::SpatialIndex;
use crate::modifier::{FieldCtx, FieldGrid, FieldUse, Modifier, Param, Stage};
use crate::primitive::{Line, Primitive};
use crate::region::{Region, WindingRule};
use crate::vec2::{v, Vec2};
#[cfg(feature = "parallel")]
use rayon::prelude::*;
use std::sync::Arc;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Pen {
    pub name: String,
    pub width: f64,
    pub color: String,
    pub feed: f64,
    #[serde(rename = "penDown")]
    pub pen_down: f64,
    #[serde(rename = "penUp")]
    pub pen_up: f64,
    #[serde(rename = "penDelay")]
    pub pen_delay_ms: f64,
}

impl Default for Pen {
    fn default() -> Pen {
        Pen {
            name: "default".into(),
            width: 0.3,
            color: "#111111".into(),
            feed: 3000.0,
            pen_down: 0.0,
            pen_up: 5.0,
            pen_delay_ms: 100.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ShapeRec {
    /// Outline contours, transformed and snapped. Open shapes have one
    /// contour that simply doesn't close.
    pub contours: Vec<Vec<Primitive>>,
    pub closed: bool,
    pub convex: bool,
    pub winding: WindingRule,
    /// Stroke pen; None = noStroke.
    pub stroke: Option<u32>,
    /// Fill pen + spec; Some = this shape is opaque and occludes.
    pub fill: Option<(u32, FillKind)>,
    pub z: f64,
    /// Endpoint-join tolerance, paper mm; 0 = not opted into bridging.
    pub bridge_mm: f64,
    /// Indices into `RenderInput::clips` active for this shape.
    pub clips: Vec<u32>,
    /// Ordered modifier program. Post-stage entries run over this shape's
    /// final fragments after occlusion and cleanup, in list order.
    pub modifiers: Vec<Modifier>,
}

#[derive(Debug, Clone)]
pub struct ClipDef {
    pub contours: Vec<Vec<Primitive>>,
    pub winding: WindingRule,
    pub convex: bool,
    /// Complement: clipped shapes keep the region's OUTSIDE.
    pub invert: bool,
}

#[derive(Debug, Clone)]
pub struct RenderInput {
    pub shapes: Vec<ShapeRec>,
    pub clips: Vec<ClipDef>,
    pub pens: Vec<Pen>,
    /// Paper rect in mm; the outermost clip. None = unbounded (preview).
    pub paper: Option<BBox>,
    pub seed: u64,
    /// Coarsening factor for preview (multiplies hatch spacing / stipple
    /// distance). 1.0 = exact.
    pub coarsen: f64,
    /// Rasterised field grids (field space); `field_uses` reference them.
    pub fields: Vec<FieldGrid>,
    /// Engine field uses referenced by `Param::Field`: grid + per-use
    /// sampling transform + domain refs into `clips`.
    pub field_uses: Vec<FieldUse>,
    /// Debug: also return every shape's full pre-occlusion geometry run
    /// through its post-stage program (decimate skipped) — ghosts that
    /// wobble and dash exactly like the surviving ink.
    pub debug_ghost: bool,
}

#[derive(Debug, Default, Clone)]
pub struct RenderStats {
    pub shapes_in: usize,
    pub culled_off_paper: usize,
    pub culled_contained: usize,
    pub clean: usize,
    pub fragments: usize,
    pub fill_prims: usize,
}

#[derive(Debug)]
pub struct RenderOutput {
    /// Global primitive table: outline primitives in shape order, then
    /// generated fill primitives. `Frag::origin` indexes into it.
    pub prims: Vec<Primitive>,
    pub frags: Vec<Frag>,
    pub stats: RenderStats,
    /// Post-modified pre-occlusion geometry for the debug ghost view;
    /// empty unless `debug_ghost` was requested.
    pub ghost: Vec<Primitive>,
}

/// Occluders are stored in ascending z-rank order, so an index query result
/// (ascending ids) iterated in reverse runs front-to-back.
struct Occluder {
    rank: usize,
    region: Arc<Region>,
}

struct ClipCtx<'a> {
    occluders: &'a [Occluder],
    occ_index: &'a SpatialIndex,
    my_rank: usize,
}

/// Provisional-origin marker for fill primitives generated inside a shape's
/// parallel task; rebased to the global table during the merge.
const GEN_FLAG: u32 = 1 << 31;

#[derive(Default)]
struct ShapeOut {
    gen_prims: Vec<Primitive>,
    frags: Vec<Frag>,
    /// Sub-nib tap candidates, resolved against ink coverage after merge.
    taps: Vec<Frag>,
}

/// Pass 1 of the two-pass render: pre-stage modifiers, z-sort, primitive
/// tables, opaque regions, culling — everything that exists before fills
/// do. `finish` consumes it with the supplied fill ink. Owns its inputs, so
/// its lifetime is a plain value (one synchronous call frame in the worker;
/// no module-level state).
pub struct Prepared {
    shapes: Vec<ShapeRec>,
    pens: Vec<Pen>,
    seed: u64,
    fields: Vec<FieldGrid>,
    field_uses: Vec<FieldUse>,
    debug_ghost: bool,
    stats: RenderStats,
    rank: Vec<usize>,
    prim_table: Vec<Primitive>,
    outline_range: Vec<(usize, usize)>,
    contour_ranges: Vec<Vec<(usize, usize)>>,
    shape_region: Vec<Option<Arc<Region>>>,
    occluders: Vec<Occluder>,
    occ_index: SpatialIndex,
    clip_regions: Vec<(Region, bool)>,
    paper_region: Option<Region>,
    alive: Vec<bool>,
    clean: Vec<bool>,
}

/// One surviving filled shape awaiting between-pass ink: its index and the
/// post-deform outline the fill generator must see.
pub struct FillJob<'a> {
    pub shape: usize,
    pub contours: &'a [Vec<Primitive>],
    pub winding: WindingRule,
    pub convex: bool,
}

impl Prepared {
    /// Shapes whose fill ink is generated between the passes: alive after
    /// culling, closed, and marked Pending. The contours are post-pre-stage
    /// (deform/smooth/roughen applied) — the outline as it will be inked.
    pub fn fill_jobs(&self) -> Vec<FillJob<'_>> {
        self.shapes
            .iter()
            .enumerate()
            .filter(|(i, s)| {
                self.alive[*i]
                    && s.closed
                    && matches!(s.fill, Some((_, FillKind::Pending)))
            })
            .map(|(i, s)| FillJob {
                shape: i,
                contours: &s.contours,
                winding: s.winding,
                convex: s.convex,
            })
            .collect()
    }
}

pub fn prepare(input: RenderInput) -> Prepared {
    let RenderInput {
        shapes: input_shapes,
        clips,
        pens,
        paper,
        seed,
        coarsen: _,
        fields,
        field_uses,
        debug_ghost,
    } = input;
    let n = input_shapes.len();
    let mut stats = RenderStats {
        shapes_in: n,
        ..Default::default()
    };

    // Clip regions, built first: field domains (`within()` bounds) ride
    // this table and pre-stage modifiers sample fields before the solve.
    // (region, keep_inside): a normal clip keeps inside, an inverted one
    // keeps outside — the same polarity bit clip_spans already speaks.
    let clip_regions: Vec<(Region, bool)> = clips
        .iter()
        .map(|c| (Region::new(c.contours.clone(), c.winding, c.convex), !c.invert))
        .collect();

    // ---- Pre-stage modifiers: deform shape geometry BEFORE the solve, so
    // occlusion, fills and culling all follow the modified contours. This is
    // the conscious-choice stage: curves shatter into polylines here, and
    // only wrapped shapes pay for it.
    let _z = crate::profile::zone("1 pre-modifiers");
    let shapes: Vec<ShapeRec> = if input_shapes
        .iter()
        .any(|s| s.modifiers.iter().any(|m| m.stage() == Stage::Pre))
    {
        let ctx = FieldCtx {
            grids: &fields,
            uses: &field_uses,
            domains: &clip_regions,
        };
        input_shapes
            .iter()
            .enumerate()
            .map(|(i, s)| apply_pre(s, i, seed, &ctx, &pens))
            .collect()
    } else {
        input_shapes
    };

    drop(_z);
    let _z = crate::profile::zone("2 sort+prim-tables");
    // ---- Layer 2: sort by z (stable on draw index) ----
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        shapes[a]
            .z
            .partial_cmp(&shapes[b].z)
            .unwrap()
            .then(a.cmp(&b))
    });
    let mut rank = vec![0usize; n];
    for (r, &i) in order.iter().enumerate() {
        rank[i] = r;
    }

    // Shape outline bboxes and global primitive ids.
    let mut prim_table: Vec<Primitive> = Vec::new();
    let mut outline_range: Vec<(usize, usize)> = Vec::with_capacity(n);
    let mut contour_ranges: Vec<Vec<(usize, usize)>> = Vec::with_capacity(n);
    let mut shape_bbox: Vec<BBox> = Vec::with_capacity(n);
    for s in &shapes {
        let start = prim_table.len();
        let mut b = BBox::EMPTY;
        let mut ranges = Vec::with_capacity(s.contours.len());
        for c in &s.contours {
            let cs = prim_table.len();
            for p in c {
                b = b.union(&p.bbox());
                prim_table.push(*p);
            }
            ranges.push((cs, prim_table.len()));
        }
        outline_range.push((start, prim_table.len()));
        contour_ranges.push(ranges);
        shape_bbox.push(b);
    }

    drop(_z);
    let _z = crate::profile::zone("3 region-build");
    // Opaque regions, built once and shared with the fill layer.
    let mut shape_region: Vec<Option<Arc<Region>>> = vec![None; n];
    let mut occluders: Vec<Occluder> = Vec::new();
    for &i in &order {
        let s = &shapes[i];
        if s.fill.is_some() && s.closed {
            let region = Arc::new(Region::new(s.contours.clone(), s.winding, s.convex));
            shape_region[i] = Some(region.clone());
            occluders.push(Occluder {
                rank: rank[i],
                region,
            });
        }
    }
    let occ_boxes: Vec<BBox> = occluders.iter().map(|o| o.region.bbox).collect();
    let occ_index = SpatialIndex::build(&occ_boxes);

    let paper_region: Option<Region> = paper.map(|p| {
        let pts = [
            v(p.min.x, p.min.y),
            v(p.max.x, p.min.y),
            v(p.max.x, p.max.y),
            v(p.min.x, p.max.y),
        ];
        Region::new(
            vec![vec![
                Primitive::Line(Line::new(pts[0], pts[1])),
                Primitive::Line(Line::new(pts[1], pts[2])),
                Primitive::Line(Line::new(pts[2], pts[3])),
                Primitive::Line(Line::new(pts[3], pts[0])),
            ]],
            WindingRule::NonZero,
            true,
        )
    });

    drop(_z);
    let _z = crate::profile::zone("4 cull");
    // ---- Cull ----
    let mut alive = vec![true; n];
    let mut clean = vec![false; n];
    let mut query_buf: Vec<u32> = Vec::new();
    for i in 0..n {
        let b = &shape_bbox[i];
        if b.is_empty() {
            alive[i] = false;
            continue;
        }
        // Off-paper cull (bleed is legal; only fully-off-paper dies).
        if let Some(p) = &paper {
            if !b.overlaps(p) {
                alive[i] = false;
                stats.culled_off_paper += 1;
                continue;
            }
        }
        // Later opaque regions overlapping this shape.
        {
            let _q = crate::profile::zone("4a cull-query");
            occ_index.query(b, &mut query_buf);
        }
        let _c = crate::profile::zone("4b cull-contains");
        let mut any_later = false;
        let mut contained = false;
        for &oi in query_buf.iter() {
            let o = &occluders[oi as usize];
            if o.rank <= rank[i] {
                continue;
            }
            any_later = true;
            // Containment cull: fully inside one later opaque region.
            if o.region.bbox.contains_box(b) && region_contains_bbox(&o.region, b) {
                #[cfg(feature = "cull-debug")]
                eprintln!("CULL shape {} by occluder rank {}", i, o.rank);
                contained = true;
                break;
            }
        }
        if contained {
            alive[i] = false;
            stats.culled_contained += 1;
            continue;
        }
        // Clean: no later occluder overlap, no clips, fully on paper.
        let on_paper = paper.map(|p| p.contains_box(b)).unwrap_or(true);
        if !any_later && shapes[i].clips.is_empty() && on_paper {
            clean[i] = true;
            stats.clean += 1;
        }
    }

    Prepared {
        shapes,
        pens,
        seed,
        fields,
        field_uses,
        debug_ghost,
        stats,
        rank,
        prim_table,
        outline_range,
        contour_ranges,
        shape_region,
        occluders,
        occ_index,
        clip_regions,
        paper_region,
        alive,
        clean,
    }
}

impl Prepared {
    /// Pass 2: clip supplied fill ink to its regions, occlude, clean up,
    /// run post-stage modifiers, bridge, and emit fragments. `supplied` is
    /// indexed by shape; shapes without an entry (or with a non-Pending
    /// fill) proceed without between-pass ink.
    pub fn finish(mut self, supplied: Vec<Option<SuppliedFill>>) -> RenderOutput {
        let n = self.shapes.len();
        let shapes = &self.shapes;
        let alive = &self.alive;
        let clean = &self.clean;
        let rank = &self.rank;
        let occluders = &self.occluders;
        let occ_index = &self.occ_index;
        let clip_regions = &self.clip_regions;
        let paper_region = &self.paper_region;
        let shape_region = &self.shape_region;
        let contour_ranges = &self.contour_ranges;
        let outline_range = &self.outline_range;
        let pens = &self.pens;
        let seed = self.seed;
        let prim_table_ro = &self.prim_table;
        let supplied = &supplied;

        // ---- Layers 3–5, sharded by shape (spec: after culling, shapes are
        // independent). Generated fill primitives get shape-local provisional
        // origins (GEN_FLAG | local index) that are rebased during the
        // deterministic merge, so the output is identical to the serial run.
        let min_pen_width = pens
            .iter()
            .map(|p| p.width)
            .fold(f64::INFINITY, f64::min)
            .min(0.3);

        let process = |i: usize| -> ShapeOut {
            let mut so = ShapeOut::default();
            if !alive[i] {
                return so;
            }
            let s = &shapes[i];
            let pen_width =
                |pen: u32| -> f64 { pens.get(pen as usize).map(|p| p.width).unwrap_or(0.3) };
            let ctx = ClipCtx {
                occluders,
                occ_index,
                my_rank: rank[i],
            };
            let shape_clips: Vec<(&Region, bool)> = s
                .clips
                .iter()
                .filter_map(|&c| clip_regions.get(c as usize))
                .map(|(r, keep)| (r, *keep))
                .chain(paper_region.iter().filter(|_| !clean[i]).map(|r| (r, true)))
                .collect();
            let mut query_buf: Vec<u32> = Vec::new();

            // Stroke outline. Sub-nib judgement is per CONTOUR for closed
            // shapes: a tiny circle's arcs are each below the nib, but drawing
            // the whole ring lays a solid dot of diameter 2r + nib — legitimate
            // ink with better tone than a bare tap. Only a contour whose TOTAL
            // length is sub-nib degrades to a tap.
            let _sz = crate::profile::zone("5a outline-clip");
            if let Some(stroke_pen) = s.stroke {
                let threshold = pen_width(stroke_pen);
                for &(cs, ce) in &contour_ranges[i] {
                    // Clip every primitive of the contour to pieces, then judge
                    // the pieces as connected RUNS — a contour is one pen
                    // stroke, open or closed, however many primitives lower
                    // it. (Per-primitive judgment made fine-stepped polylines
                    // vanish: every segment individually sub-nib, demoted to
                    // a tap, swallowed by coverage — and finer steps made it
                    // worse.)
                    let from = so.frags.len();
                    for gi in cs..ce {
                        let prim = prim_table_ro[gi];
                        clip_one(
                            gi as u32,
                            &prim,
                            threshold,
                            stroke_pen,
                            i as u32,
                            &shape_clips,
                            &ctx,
                            clean[i],
                            &mut query_buf,
                            &mut so.frags,
                        );
                    }
                    judge_runs(&mut so, from, threshold, s.closed, stroke_pen, i as u32);
                }
            }

            drop(_sz);
            let _sz = crate::profile::zone("5b fills");
            // Fill ink: supplied between the passes (Pending) or carried
            // pre-generated (Custom). Both are clipped to the shape's own
            // region first — a fill is ink inside the region.
            let Some((fill_pen, kind)) = &s.fill else {
                return so;
            };
            if !s.closed {
                return so;
            }
            let Some(region) = &shape_region[i] else {
                return so;
            };
            let threshold = pen_width(*fill_pen);
            let gen_one = |prim: Primitive, so: &mut ShapeOut, query_buf: &mut Vec<u32>| {
                let origin = GEN_FLAG | so.gen_prims.len() as u32;
                so.gen_prims.push(prim);
                clip_one(
                    origin,
                    &prim,
                    threshold,
                    *fill_pen,
                    i as u32,
                    &shape_clips,
                    &ctx,
                    clean[i],
                    query_buf,
                    &mut so.frags,
                );
            };
            // A chain is one connected pen stroke: clip every primitive to
            // the region, then to the occluders, and judge the surviving
            // pieces as connected RUNS exactly like an outline contour. A
            // lone ruling cut into disjoint pieces is several runs, judged
            // apart; a fine-stepped polyline is one run, drawable ink.
            let clip_chain = |chain: &[Primitive], so: &mut ShapeOut, query_buf: &mut Vec<u32>| {
                let from = so.frags.len();
                for prim in chain {
                    let mut spans = vec![Span {
                        t0: 0.0,
                        t1: 1.0,
                        visible: true,
                    }];
                    clip_spans(prim, &mut spans, region, true);
                    for sp in spans.iter().filter(|sp| sp.visible) {
                        gen_one(prim.sub(sp.t0, sp.t1), so, query_buf);
                    }
                }
                judge_runs(so, from, threshold, false, *fill_pen, i as u32);
            };
            match kind {
                FillKind::Pending => {
                    if let Some(Some(fill)) = supplied.get(i) {
                        for chain in &fill.chains {
                            clip_chain(chain, &mut so, &mut query_buf);
                        }
                        // Intentional taps: engine-stipple semantics — strictly
                        // inside the region (edge dots drop), occludable, never
                        // routed through tap resolution.
                        for &p in &fill.dots {
                            if !region.inside(p) || region.on_boundary(p, 1e-9) {
                                continue;
                            }
                            if point_visible(p, &shape_clips, &ctx, &mut query_buf) {
                                let origin = GEN_FLAG | so.gen_prims.len() as u32;
                                let dotp = Primitive::Line(Line::new(p, p));
                                so.gen_prims.push(dotp);
                                so.frags.push(Frag {
                                    origin,
                                    t0: 0.0,
                                    t1: 1.0,
                                    pen: *fill_pen,
                                    shape: i as u32,
                                    dot: true,
                                    bridge: false,
                                    geom: dotp,
                                });
                            }
                        }
                    }
                }
                FillKind::Custom(prims) => {
                    // Pre-generated ink carries no chain structure: each
                    // primitive is its own stroke.
                    for prim in prims {
                        clip_chain(std::slice::from_ref(prim), &mut so, &mut query_buf);
                    }
                }
                // Opaque with zero ink: the occluder was registered in
                // prepare; there is nothing to generate.
                FillKind::Mask => {}
            }
            so
        };

        let _z = crate::profile::zone("5 clip+fills");
        #[cfg(feature = "parallel")]
        let outputs: Vec<ShapeOut> = (0..n).into_par_iter().map(process).collect();
        #[cfg(not(feature = "parallel"))]
        let outputs: Vec<ShapeOut> = (0..n).map(process).collect();

        let mut stats = std::mem::take(&mut self.stats);
        let mut prim_table = std::mem::take(&mut self.prim_table);
        let contour_ranges = &self.contour_ranges;

        // Deterministic merge in input order: rebase generated origins.
        let mut frags: Vec<Frag> = Vec::new();
        let mut taps: Vec<Frag> = Vec::new();
        let mut gen_range: Vec<(usize, usize)> = vec![(0, 0); n];
        for (i, so) in outputs.into_iter().enumerate() {
            let base = prim_table.len() as u32;
            stats.fill_prims += so.gen_prims.len();
            gen_range[i] = (base as usize, base as usize + so.gen_prims.len());
            let shape_taps = so.taps;
            prim_table.extend(so.gen_prims);
            let rebase = |mut f: Frag| {
                if f.origin & GEN_FLAG != 0 {
                    f.origin = base + (f.origin & !GEN_FLAG);
                }
                f
            };
            frags.extend(so.frags.into_iter().map(rebase));
            taps.extend(shape_taps.into_iter().map(rebase));
        }

        drop(_z);
        let _z = crate::profile::zone("6 dedupe");
        let mut frags = dedupe_seams(frags, min_pen_width.max(1e-6));
        // Sub-nib candidates become dots only where their ink is not already
        // laid down by kept strokes — the coverage half of the nib rule.
        let pen_widths: Vec<f64> = pens.iter().map(|p| p.width).collect();
        crate::cleanup::resolve_taps(&mut frags, taps, &pen_widths);
        let frags = frags;
        drop(_z);
        let _z = crate::profile::zone("7 post-modifiers");
        // ---- Post-stage modifiers: each shape's ordered program runs over its
        // final ink, AFTER occlusion and cleanup, so what a modifier touches is
        // final visible strokes. One frag at a time through the whole program
        // preserves global frag order (and therefore plot order).
        let mut frags = frags;
        let has_post = shapes
            .iter()
            .any(|s| s.modifiers.iter().any(|m| m.stage() == Stage::Post));
        if has_post {
            let mut interp = PostInterp {
                seed,
                fields: FieldCtx {
                    grids: &self.fields,
                    uses: &self.field_uses,
                    domains: &self.clip_regions,
                },
                prim_table: &mut prim_table,
                contour_ranges,
                dash_tables: std::collections::HashMap::new(),
                dash_chains: std::collections::HashMap::new(),
                cur: Vec::new(),
                next: Vec::new(),
                pts: Vec::new(),
                dense: Vec::new(),
            };
            let mut out: Vec<Frag> = Vec::with_capacity(frags.len());
            for f in frags.drain(..) {
                let si = f.shape as usize;
                let prog = &shapes[si].modifiers;
                if prog.iter().all(|m| m.stage() != Stage::Post) {
                    out.push(f);
                    continue;
                }
                // Stroke-vs-fill is a property of the ORIGINAL fragment; a
                // wobbled segment of an outline is still outline ink even
                // though its origin now points at a generated primitive.
                let (p0, p1) = outline_range[si];
                let is_stroke = (f.origin as usize) >= p0 && (f.origin as usize) < p1;
                interp.run(f, prog, is_stroke, shapes[si].closed, &mut out);
            }
            frags = out;
        }

        drop(_z);
        // ---- Bridge pass: shapes that OPT IN (bridge_mm > 0) get their stroke
        // endpoints greedily joined pen-down across gaps up to their tolerance
        // (per pen). Connectors are real fragments (debug-visible, flagged) and
        // share exact endpoints with the strokes they join, so downstream chain
        // merging assembles the long serpentines automatically. On hatch-dense
        // work this converts most pen lifts into tiny drawn connectors — the
        // artistic trade the per-sketch tolerance controls. Connectors span
        // GAPS only: never along existing ink (the no-double-draw rule).
        if shapes.iter().any(|s| s.bridge_mm > 0.0) {
            let _z = crate::profile::zone("8 bridge");
            bridge_pass(shapes, &mut frags, &mut prim_table);
        }
        // ---- Debug ghost: full pre-occlusion geometry through each shape's
        // post program (decimate skipped so deleted strokes stay inspectable).
        // Wobble displaces by position, so ghosts align exactly with the
        // surviving ink's tremor; hidden portions get the same treatment the
        // visible ones did.
        let ghost: Vec<Primitive> = if self.debug_ghost {
            let mut gtable = prim_table.clone();
            let mut interp = PostInterp {
                seed,
                fields: FieldCtx {
                    grids: &self.fields,
                    uses: &self.field_uses,
                    domains: &self.clip_regions,
                },
                prim_table: &mut gtable,
                contour_ranges,
                dash_tables: std::collections::HashMap::new(),
                dash_chains: std::collections::HashMap::new(),
                cur: Vec::new(),
                next: Vec::new(),
                pts: Vec::new(),
                dense: Vec::new(),
            };
            let mut gfrags: Vec<Frag> = Vec::new();
            for (i, s) in shapes.iter().enumerate() {
                let prog: Vec<Modifier> = s
                    .modifiers
                    .iter()
                    .filter(|m| m.stage() == Stage::Post && !matches!(m, Modifier::Decimate { .. }))
                    .cloned()
                    .collect();
                let (p0, p1) = outline_range[i];
                let (g0, g1) = gen_range[i];
                for id in (p0..p1).chain(g0..g1) {
                    let f = Frag::whole(id as u32, prim_table[id], 0, i as u32);
                    if prog.is_empty() {
                        gfrags.push(f);
                    } else {
                        let is_stroke = id >= p0 && id < p1;
                        interp.run(f, &prog, is_stroke, s.closed, &mut gfrags);
                    }
                }
            }
            gfrags.into_iter().map(|f| f.geom).collect()
        } else {
            Vec::new()
        };

        stats.fragments = frags.len();
        RenderOutput {
            prims: prim_table,
            frags,
            stats,
            ghost,
        }
    }
}

/// One-call render for native consumers (goldens, benches, replay without a
/// fills sidecar): Custom/Mask fills work as always; Pending fills produce
/// no ink unless supplied.
pub fn render(input: &RenderInput) -> RenderOutput {
    prepare(input.clone()).finish(Vec::new())
}

/// Greedy endpoint matching within per-shape tolerances. Each fragment end
/// joins at most one connector; pairs need dist ≤ min(tolA, tolB) and > the
/// snap grid (exact touches already merge downstream).
fn bridge_pass(shapes: &[ShapeRec], frags: &mut Vec<Frag>, prims: &mut Vec<Primitive>) {
    #[derive(Clone, Copy)]
    struct End {
        frag: usize,
        pos: Vec2,
        tol: f64,
        pen: u32,
    }
    let mut ends: Vec<End> = Vec::new();
    for (fi, f) in frags.iter().enumerate() {
        if f.dot || f.bridge {
            continue;
        }
        let tol = shapes[f.shape as usize].bridge_mm;
        if tol <= 0.0 {
            continue;
        }
        for pos in [f.geom.eval(f.t0), f.geom.eval(f.t1)] {
            ends.push(End {
                frag: fi,
                pos,
                tol,
                pen: f.pen,
            });
        }
    }
    if ends.is_empty() {
        return;
    }
    let max_tol = ends.iter().fold(0.0f64, |m, e| m.max(e.tol));
    let cell = max_tol.max(1e-3);
    let key = |p: Vec2| ((p.x / cell).floor() as i64, (p.y / cell).floor() as i64);
    // Cell buckets in CSR form: (cell, end index) sorted, so a cell's ends
    // are a slice in ascending index order — exactly the insertion order
    // the greedy match's tie-breaking depends on — and one map lookup finds
    // the slice. No per-cell Vec, no SipHash.
    let mut cells: Vec<((i64, i64), usize)> = ends.iter().enumerate().map(|(i, e)| (key(e.pos), i)).collect();
    cells.sort_unstable();
    let items: Vec<usize> = cells.iter().map(|c| c.1).collect();
    let mut grid: crate::fasthash::FxHashMap<(i64, i64), (usize, usize)> =
        crate::fasthash::FxHashMap::default();
    {
        let mut s = 0;
        while s < cells.len() {
            let k = cells[s].0;
            let mut e = s + 1;
            while e < cells.len() && cells[e].0 == k {
                e += 1;
            }
            grid.insert(k, (s, e));
            s = e;
        }
    }
    // Union-find over fragments, seeded with EXACT-endpoint connectivity
    // (strokes already chained by shared endpoints count as one component),
    // so no pair of joins can ever close a loop or double-connect two
    // already-linked runs — the greedy match stays a forest of open trails.
    let mut parent: Vec<usize> = (0..frags.len()).collect();
    fn find(parent: &mut Vec<usize>, mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }
    {
        let mut by_exact: crate::fasthash::FxHashMap<(i64, i64), usize> =
            crate::fasthash::FxHashMap::default();
        let q = 1e-4;
        for e in &ends {
            let k = ((e.pos.x / q).round() as i64, (e.pos.y / q).round() as i64);
            match by_exact.get(&k) {
                Some(&other) => {
                    let (a, b) = (find(&mut parent, e.frag), find(&mut parent, other));
                    if a != b {
                        parent[a] = b;
                    }
                }
                None => {
                    by_exact.insert(k, e.frag);
                }
            }
        }
    }
    let mut used = vec![false; ends.len()];
    // Deterministic order: iterate ends as built (frag order = plot order).
    for i in 0..ends.len() {
        if used[i] {
            continue;
        }
        let a = ends[i];
        let (kx, ky) = key(a.pos);
        let mut best: Option<(f64, usize)> = None;
        for dx in -1..=1 {
            for dy in -1..=1 {
                let Some(&(s, e)) = grid.get(&(kx + dx, ky + dy)) else {
                    continue;
                };
                for &j in &items[s..e] {
                    if j == i || used[j] {
                        continue;
                    }
                    let b = ends[j];
                    if b.frag == a.frag || b.pen != a.pen {
                        continue;
                    }
                    if find(&mut parent, a.frag) == find(&mut parent, b.frag) {
                        continue; // already connected — a join would loop
                    }
                    let d = a.pos.dist(b.pos);
                    if d > a.tol.min(b.tol) || d <= 2e-4 {
                        continue; // out of tolerance, or already an exact touch
                    }
                    if best.map_or(true, |(bd, _)| d < bd) {
                        best = Some((d, j));
                    }
                }
            }
        }
        if let Some((_, j)) = best {
            used[i] = true;
            used[j] = true;
            let b = ends[j];
            let (ra, rb) = (find(&mut parent, a.frag), find(&mut parent, b.frag));
            parent[ra] = rb;
            let origin = prims.len() as u32;
            let geom = Primitive::Line(crate::primitive::Line::new(a.pos, b.pos));
            prims.push(geom);
            frags.push(Frag {
                origin,
                t0: 0.0,
                t1: 1.0,
                pen: a.pen,
                shape: frags[a.frag].shape,
                dot: false,
                bridge: true,
                geom,
            });
        }
    }
}

/// Post-stage modifier interpreter: threads one fragment through a shape's
/// program, op by op. Ops may drop the fragment (decimate) or replace it
/// with many (wobble); generated geometry is appended to the prim table.
struct PostInterp<'a> {
    seed: u64,
    fields: FieldCtx<'a>,
    prim_table: &'a mut Vec<Primitive>,
    contour_ranges: &'a [Vec<(usize, usize)>],
    /// Per-shape outline arc-length tables for phase-continuous dashing.
    dash_tables: std::collections::HashMap<u32, Vec<ContourLens>>,
    /// Streaming dash phase for generated (non-outline) chains, keyed by
    /// (shape, op slot): (chain end point, accumulated arc length).
    dash_chains: std::collections::HashMap<(u32, usize), (Vec2, f64)>,
    cur: Vec<Frag>,
    next: Vec<Frag>,
    pts: Vec<Vec2>,
    dense: Vec<Vec2>,
}

/// One contour's primitive arc lengths: prim range, cumulative lengths
/// (cum[k] = length before the k-th prim of the contour), and total.
struct ContourLens {
    start: usize,
    end: usize,
    cum: Vec<f64>,
    total: f64,
}

impl PostInterp<'_> {
    fn run(
        &mut self,
        f: Frag,
        prog: &[Modifier],
        is_stroke: bool,
        closed: bool,
        out: &mut Vec<Frag>,
    ) {
        self.cur.clear();
        self.cur.push(f);
        for (slot, m) in prog.iter().enumerate() {
            if m.stage() != Stage::Post {
                continue;
            }
            self.next.clear();
            let mut cur = std::mem::take(&mut self.cur);
            for f in cur.drain(..) {
                match m {
                    Modifier::Decimate { stroke, fill } => {
                        let p = if is_stroke { stroke } else { fill };
                        if self.keep_decimated(&f, p) {
                            self.next.push(f);
                        }
                    }
                    Modifier::Wobble { amp, wavelength } => self.wobble(f, amp, *wavelength),
                    Modifier::Dash { len, gap, offset } => {
                        self.dash(f, *len, *gap, *offset, slot, closed)
                    }
                    // Pre-stage ops already ran on the contours.
                    Modifier::Smooth { .. }
                    | Modifier::Roughen { .. }
                    | Modifier::Deform { .. } => unreachable!("pre-stage op in post interpreter"),
                }
            }
            self.cur = cur;
            std::mem::swap(&mut self.cur, &mut self.next);
        }
        out.append(&mut self.cur);
    }

    /// Seeded per-fragment coin flip; deterministic from the sketch seed.
    fn keep_decimated(&self, f: &Frag, p: &Param) -> bool {
        let mid = f.geom.eval(0.5);
        let p = p.at(&self.fields, mid);
        if p <= 0.0 {
            return true;
        }
        let mut h = self
            .seed
            .wrapping_add((f.shape as u64) << 32)
            .wrapping_add((f.origin as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
            ^ f.t0.to_bits().rotate_left(17);
        // splitmix64 finalizer
        h = h.wrapping_add(0x9E37_79B9_7F4A_7C15);
        h = (h ^ (h >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        h = (h ^ (h >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        h ^= h >> 31;
        (h as f64 / u64::MAX as f64) >= p.min(1.0)
    }

    /// Flatten the fragment's final stroke and displace the vertices with
    /// seeded smooth noise — hand tremor on the surviving ink.
    fn wobble(&mut self, f: Frag, amp: &Param, wavelength: f64) {
        let wl = wavelength.max(1.0);
        let freq = 1.0 / wl;
        let seed = self.seed;
        let fields = &self.fields;
        let jiggle = |p: Vec2| -> Vec2 {
            let a = amp.at(fields, p);
            v(
                p.x + a * value_noise(seed ^ 0x570B_B1E5, p.x * freq, p.y * freq),
                p.y + a * value_noise(seed ^ 0x0135_E2A7, p.x * freq, p.y * freq),
            )
        };
        if amp.literal().is_some_and(|a| a <= 0.0) {
            self.next.push(f);
            return;
        }
        if f.dot {
            let p = jiggle(f.geom.start());
            let dotp = Primitive::Line(Line::new(p, p));
            let origin = self.prim_table.len() as u32;
            self.prim_table.push(dotp);
            self.next.push(Frag {
                origin,
                t0: 0.0,
                t1: 1.0,
                geom: dotp,
                ..f
            });
            return;
        }
        self.pts.clear();
        // Flatten for curvature, then resample by arc length: the noise
        // needs a vertex every ~wl/8 along the stroke, and a straight
        // span flattens to a single segment that would carry no tremor
        // between its endpoints.
        f.geom.flatten(0.02, &mut self.pts);
        let step = (wl / 8.0).clamp(0.2, 5.0);
        self.dense.clear();
        for w2 in self.pts.windows(2) {
            let (a, b) = (w2[0], w2[1]);
            let len = (b.x - a.x).hypot(b.y - a.y);
            let n = (len / step).ceil().max(1.0) as usize;
            for k in 0..n {
                let t = k as f64 / n as f64;
                self.dense
                    .push(v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
            }
        }
        if let Some(&tail) = self.pts.last() {
            self.dense.push(tail);
        }
        for w2 in self.dense.windows(2) {
            let a = jiggle(w2[0]);
            let b = jiggle(w2[1]);
            let seg = Primitive::Line(Line::new(a, b));
            let origin = self.prim_table.len() as u32;
            self.prim_table.push(seg);
            self.next.push(Frag {
                origin,
                t0: 0.0,
                t1: 1.0,
                geom: seg,
                ..f.clone()
            });
        }
    }
}

impl PostInterp<'_> {
    /// Chop the fragment into dashes by physical length, phase-continuous
    /// along the outline: the pattern position is the ABSOLUTE arc length
    /// from the contour's start, so occlusion cuts and arc joints never
    /// reset it. On closed contours the period is snapped to divide the
    /// contour length, so the pattern meets itself seamlessly. The cuts
    /// stay exact t-sub-ranges — curves stay curves.
    fn dash(&mut self, f: Frag, len: f64, gap: f64, offset: f64, slot: usize, closed: bool) {
        if f.dot || len <= 0.0 {
            self.next.push(f);
            return;
        }
        let total = f.geom.length();
        if total <= 1e-9 {
            self.next.push(f);
            return;
        }
        let period = len + gap.max(0.0);

        // Pattern base: arc length of this fragment's start within its
        // contour (outline frags), or streaming continuity for generated
        // chains (e.g. dash after wobble); standalone strokes start at 0.
        let si = f.shape;
        let (base, eff_len, eff_period) =
            if let Some((c_start, c_total)) = self.contour_pos(si, f.origin as usize) {
                let along = c_start + prefix_len(&self.prim_table[f.origin as usize], f.t0);
                if closed && c_total > period {
                    // Fit the period to the contour so the seam disappears.
                    let count = (c_total / period).round().max(1.0);
                    let r = c_total / (count * period);
                    (along, len * r, period * r)
                } else {
                    (along, len, period)
                }
            } else {
                let start_pt = f.geom.start();
                let key = (si, slot);
                let base = match self.dash_chains.get(&key) {
                    Some(&(end_pt, phase))
                        if (end_pt.x - start_pt.x).hypot(end_pt.y - start_pt.y) < 1e-9 =>
                    {
                        phase
                    }
                    _ => 0.0,
                };
                self.dash_chains.insert(key, (f.geom.end(), base + total));
                (base, len, period)
            };

        // Arc-length → local t (lines and arcs are uniform-speed; cubics
        // get a sampled table).
        let table: Option<Vec<f64>> = match f.geom {
            Primitive::Cubic(_) => {
                const N: usize = 32;
                let mut cum = Vec::with_capacity(N + 1);
                cum.push(0.0);
                let mut prev = f.geom.start();
                for k in 1..=N {
                    let p = f.geom.eval(k as f64 / N as f64);
                    cum.push(cum[k - 1] + (p.x - prev.x).hypot(p.y - prev.y));
                    prev = p;
                }
                Some(cum)
            }
            _ => None,
        };
        let t_of = |s: f64| -> f64 {
            match &table {
                None => s / total,
                Some(cum) => {
                    let target = s / total * cum[cum.len() - 1];
                    let n = cum.len() - 1;
                    let i = cum.partition_point(|&c| c < target).clamp(1, n);
                    let (c0, c1) = (cum[i - 1], cum[i]);
                    let frac = if c1 > c0 {
                        (target - c0) / (c1 - c0)
                    } else {
                        0.0
                    };
                    ((i - 1) as f64 + frac) / n as f64
                }
            }
        };

        // The fragment covers pattern positions [base, base+total). Emit
        // every dash interval [k*p - offset, k*p - offset + len) ∩ that.
        let first = ((base + offset - eff_len) / eff_period).floor() as i64;
        let mut k = first;
        loop {
            let ds = k as f64 * eff_period - offset;
            if ds >= base + total {
                break;
            }
            let de = ds + eff_len;
            let s0 = ds.max(base);
            let s1 = de.min(base + total);
            if s1 - s0 > 1e-9 {
                let (ta, tb) = (t_of(s0 - base), t_of(s1 - base));
                let g0 = f.t0 + ta * (f.t1 - f.t0);
                let g1 = f.t0 + tb * (f.t1 - f.t0);
                self.next.push(Frag {
                    origin: f.origin,
                    t0: g0,
                    t1: g1,
                    geom: f.geom.sub(ta, tb),
                    ..f.clone()
                });
            }
            k += 1;
        }
    }

    /// For an outline primitive: (arc length from its contour's start to
    /// the primitive's start, contour total length). Lazily builds the
    /// per-shape table. None for generated primitives.
    fn contour_pos(&mut self, shape: u32, origin: usize) -> Option<(f64, f64)> {
        let ranges = self.contour_ranges.get(shape as usize)?;
        if !ranges.iter().any(|&(s, e)| origin >= s && origin < e) {
            return None;
        }
        let prim_table = &self.prim_table;
        let tables = self.dash_tables.entry(shape).or_insert_with(|| {
            ranges
                .iter()
                .map(|&(s, e)| {
                    let mut cum = Vec::with_capacity(e - s + 1);
                    cum.push(0.0);
                    for p in &prim_table[s..e] {
                        let last = *cum.last().unwrap();
                        cum.push(last + p.length());
                    }
                    let total = *cum.last().unwrap();
                    ContourLens {
                        start: s,
                        end: e,
                        cum,
                        total,
                    }
                })
                .collect()
        });
        let c = tables
            .iter()
            .find(|c| origin >= c.start && origin < c.end)?;
        Some((c.cum[origin - c.start], c.total))
    }
}

/// Arc length from a primitive's start to parameter t0. Lines and arcs
/// are uniform-speed in t; cubics measure the actual sub-curve, so dash
/// phase stays exact on strongly non-uniform cubics too.
fn prefix_len(origin: &Primitive, t0: f64) -> f64 {
    if t0 <= 0.0 {
        return 0.0;
    }
    match origin {
        Primitive::Cubic(_) => origin.sub(0.0, t0).length(),
        _ => origin.length() * t0,
    }
}

// ---- Pre-stage geometry ops -------------------------------------------

/// Apply a shape's pre-stage modifiers to its contours, in program order.
/// Contours flatten to polylines once (0.05 mm), the ops transform points,
/// and line primitives are rebuilt at the end. Convexity is conservatively
/// dropped — deformed geometry makes no promises.
fn apply_pre(s: &ShapeRec, shape_idx: usize, seed: u64, fields: &FieldCtx, pens: &[Pen]) -> ShapeRec {
    if !s.modifiers.iter().any(|m| m.stage() == Stage::Pre) {
        return s.clone();
    }
    let closed = s.closed;
    let mut polys: Vec<Vec<Vec2>> = s
        .contours
        .iter()
        .map(|c| contour_polyline(c, 0.05, closed))
        .collect();
    for m in &s.modifiers {
        match m {
            Modifier::Smooth { passes } => {
                let _z = crate::profile::zone("1a smooth");
                for poly in &mut polys {
                    chaikin(poly, *passes, closed);
                }
            }
            Modifier::Roughen { amp, detail } => {
                let _z = crate::profile::zone("1b roughen");
                for (ci, poly) in polys.iter_mut().enumerate() {
                    resample_polyline(poly, detail.max(0.2), closed);
                    let n = poly.len();
                    let (lo, hi) = if closed {
                        (0, n)
                    } else {
                        (1, n.saturating_sub(1))
                    };
                    for (i, p) in poly.iter_mut().enumerate().take(hi).skip(lo) {
                        let a = amp.at(fields, *p);
                        if a <= 0.0 {
                            continue;
                        }
                        let key = seed
                            .wrapping_add((shape_idx as u64) << 40)
                            .wrapping_add((ci as u64) << 24)
                            .wrapping_add(i as u64);
                        let jx = hash01(key.wrapping_mul(2)) * 2.0 - 1.0;
                        let jy = hash01(key.wrapping_mul(2) + 1) * 2.0 - 1.0;
                        *p = v(p.x + jx * a, p.y + jy * a);
                    }
                }
            }
            Modifier::Deform { dx, dy, detail } => {
                let _z = crate::profile::zone("1c deform");
                let target = detail.max(0.2);
                let map = |p: Vec2| {
                    let d = fields.vector(dx, dy, p);
                    v(p.x + d.x, p.y + d.y)
                };
                for poly in &mut polys {
                    // Adaptive floor: small shapes need proportionally finer
                    // source sampling — guarantee ≥64 segments per contour.
                    let len: f64 = poly
                        .windows(2)
                        .map(|w| (w[1].x - w[0].x).hypot(w[1].y - w[0].y))
                        .sum();
                    let step = target.min(len / 64.0).max(0.2);
                    resample_polyline(poly, step, closed);
                    // Displace with OUTPUT-adaptive subdivision: the field
                    // can stretch space (a vortex core stretches tangent
                    // spacing many-fold), so bisect source edges until the
                    // displaced neighbours sit within `detail` — the drawn
                    // polyline's spacing is bounded regardless of stretch.
                    let n = poly.len();
                    if n < 2 {
                        continue;
                    }
                    let edges = if closed { n } else { n - 1 };
                    let mut out: Vec<Vec2> = Vec::with_capacity(n * 2);
                    for i in 0..edges {
                        let (a, b) = (poly[i], poly[(i + 1) % n]);
                        subdivide_map(&map, a, b, map(a), map(b), target, 7, &mut out);
                    }
                    if !closed {
                        out.push(map(poly[n - 1]));
                    }
                    *poly = out;
                }
            }
            _ => {}
        }
    }
    // Never emit a segment shorter than the stroke nib: the clip layer's
    // nib rule drops sub-nib primitives individually, which would punch
    // holes in a connected chain. Merging to the nib introduces error
    // below the nib — invisible by the system's own tolerance.
    let min_seg = s
        .stroke
        .and_then(|p| pens.get(p as usize))
        .map(|p| p.width)
        .unwrap_or(0.3)
        .max(0.05);
    for poly in &mut polys {
        simplify_polyline(poly, min_seg, closed);
    }
    let contours: Vec<Vec<Primitive>> = polys
        .iter()
        .map(|poly| polyline_prims(poly, closed))
        .filter(|c| !c.is_empty())
        .collect();
    ShapeRec {
        contours,
        convex: false,
        ..s.clone()
    }
}

/// Flatten a contour to a polyline. Closed contours arrive with the last
/// point duplicating the first; drop it so the polyline is cyclic.
fn contour_polyline(contour: &[Primitive], tol: f64, closed: bool) -> Vec<Vec2> {
    let mut pts: Vec<Vec2> = Vec::new();
    let mut buf: Vec<Vec2> = Vec::new();
    for p in contour {
        buf.clear();
        p.flatten(tol, &mut buf);
        let skip = usize::from(!pts.is_empty());
        pts.extend(buf.iter().copied().skip(skip));
    }
    if closed && pts.len() > 1 {
        let (a, b) = (pts[0], pts[pts.len() - 1]);
        if (a.x - b.x).hypot(a.y - b.y) < 1e-9 {
            pts.pop();
        }
    }
    pts
}

/// Insert vertices so no edge (including a closed polyline's implicit
/// closing edge) exceeds `step`.
fn resample_polyline(poly: &mut Vec<Vec2>, step: f64, closed: bool) {
    let n = poly.len();
    if n < 2 {
        return;
    }
    let mut out: Vec<Vec2> = Vec::with_capacity(n * 2);
    let edges = if closed { n } else { n - 1 };
    for i in 0..edges {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let len = (b.x - a.x).hypot(b.y - a.y);
        let k = (len / step).ceil().max(1.0) as usize;
        for j in 0..k {
            let t = j as f64 / k as f64;
            out.push(v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
        }
    }
    if !closed {
        out.push(poly[n - 1]);
    }
    *poly = out;
}

/// Chaikin corner cutting; converges to a quadratic B-spline. Open
/// polylines keep their endpoints.
fn chaikin(poly: &mut Vec<Vec2>, passes: u32, closed: bool) {
    for _ in 0..passes {
        let n = poly.len();
        if n < 3 {
            return;
        }
        let mut out: Vec<Vec2> = Vec::with_capacity(n * 2);
        let cut = |a: Vec2, b: Vec2, out: &mut Vec<Vec2>| {
            out.push(v(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25));
            out.push(v(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75));
        };
        if closed {
            for i in 0..n {
                cut(poly[i], poly[(i + 1) % n], &mut out);
            }
        } else {
            out.push(poly[0]);
            for i in 0..n - 1 {
                cut(poly[i], poly[i + 1], &mut out);
            }
            out.push(poly[n - 1]);
        }
        *poly = out;
    }
}

/// Emit the image of source edge (a, b) under `f`, bisecting in SOURCE
/// space until the displaced chord is both short enough (`target`) and
/// FLAT enough — the midpoint's image must sit within `SAG_TOL` of the
/// chord midpoint. The flatness test is what catches tight curls: near a
/// vortex core the curve can turn sharply between samples that are well
/// within the length bound. Pushes f(a) and refined interior points; the
/// caller's next edge (or explicit tail) supplies f(b).
fn subdivide_map<F: Fn(Vec2) -> Vec2>(
    f: &F,
    a: Vec2,
    b: Vec2,
    fa: Vec2,
    fb: Vec2,
    target: f64,
    depth: u32,
    out: &mut Vec<Vec2>,
) {
    const SAG_TOL: f64 = 0.05;
    if depth == 0 {
        out.push(fa);
        return;
    }
    let m = v((a.x + b.x) / 2.0, (a.y + b.y) / 2.0);
    let fm = f(m);
    let chord = (fb.x - fa.x).hypot(fb.y - fa.y);
    let dev = (fm.x - (fa.x + fb.x) / 2.0).hypot(fm.y - (fa.y + fb.y) / 2.0);
    if chord <= target && dev <= SAG_TOL {
        // An S-curve is point-symmetric about its midpoint and fools the
        // single-sample test (folding maps produce exactly those); confirm
        // with the quarter points before accepting the chord.
        let q1 = v((a.x + m.x) / 2.0, (a.y + m.y) / 2.0);
        let q3 = v((m.x + b.x) / 2.0, (m.y + b.y) / 2.0);
        let fq1 = f(q1);
        let fq3 = f(q3);
        let d1 = (fq1.x - (fa.x + fm.x) / 2.0).hypot(fq1.y - (fa.y + fm.y) / 2.0);
        let d3 = (fq3.x - (fm.x + fb.x) / 2.0).hypot(fq3.y - (fm.y + fb.y) / 2.0);
        if d1 <= SAG_TOL && d3 <= SAG_TOL {
            out.push(fa);
            return;
        }
    }
    subdivide_map(f, a, m, fa, fm, target, depth - 1, out);
    subdivide_map(f, m, b, fm, fb, target, depth - 1, out);
}

/// Merge chain vertices so no segment falls below `min_seg`. Endpoints of
/// open chains are preserved (the final point replaces the last kept one
/// when it lands too close); closed chains drop a last point that crowds
/// the start.
fn simplify_polyline(poly: &mut Vec<Vec2>, min_seg: f64, closed: bool) {
    if poly.len() < 3 || min_seg <= 0.0 {
        return;
    }
    let mut out: Vec<Vec2> = Vec::with_capacity(poly.len());
    out.push(poly[0]);
    let last_idx = poly.len() - 1;
    for (i, &p) in poly.iter().enumerate().skip(1) {
        let l = *out.last().unwrap();
        let d = (p.x - l.x).hypot(p.y - l.y);
        if d >= min_seg {
            out.push(p);
        } else if !closed && i == last_idx && out.len() > 1 {
            *out.last_mut().unwrap() = p;
        }
    }
    // Closed: keep popping while the wrap segment is sub-nib — a single
    // pop can leave the NEXT point still crowding the start (found by the
    // qa sweep: a dropped 0.13mm closing edge broke the loop). Points
    // pairwise ≥ min_seg can't stack near the start, so this pops at most
    // a handful.
    while closed && out.len() > 2 {
        let (a, b) = (out[0], *out.last().unwrap());
        if (a.x - b.x).hypot(a.y - b.y) < min_seg {
            out.pop();
        } else {
            break;
        }
    }
    *poly = out;
}

fn polyline_prims(poly: &[Vec2], closed: bool) -> Vec<Primitive> {
    let n = poly.len();
    let mut prims = Vec::with_capacity(n);
    if n < 2 {
        return prims;
    }
    let edges = if closed { n } else { n - 1 };
    for i in 0..edges {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        if (b.x - a.x).hypot(b.y - a.y) > 1e-9 {
            prims.push(Primitive::Line(Line::new(a, b)));
        }
    }
    prims
}

/// splitmix64 finalizer → [0, 1).
fn hash01(mut h: u64) -> f64 {
    h = h.wrapping_add(0x9E37_79B9_7F4A_7C15);
    h = (h ^ (h >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h = (h ^ (h >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^= h >> 31;
    h as f64 / (u64::MAX as f64 + 1.0)
}

/// Seeded smooth 2D value noise in [-1, 1]: hashed lattice + smoothstep
/// bilinear. Deterministic; good enough for hand-tremor.
fn value_noise(seed: u64, x: f64, y: f64) -> f64 {
    let xf = x.floor();
    let yf = y.floor();
    let (tx, ty) = (x - xf, y - yf);
    let sx = tx * tx * (3.0 - 2.0 * tx);
    let sy = ty * ty * (3.0 - 2.0 * ty);
    let lattice = |ix: i64, iy: i64| -> f64 {
        let mut h = seed
            .wrapping_add((ix as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
            .wrapping_add((iy as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F));
        h = (h ^ (h >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        h = (h ^ (h >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        h ^= h >> 31;
        (h as f64 / u64::MAX as f64) * 2.0 - 1.0
    };
    let (x0, y0) = (xf as i64, yf as i64);
    let a = lattice(x0, y0);
    let b = lattice(x0 + 1, y0);
    let c = lattice(x0, y0 + 1);
    let d = lattice(x0 + 1, y0 + 1);
    let top = a + (b - a) * sx;
    let bot = c + (d - c) * sx;
    top + (bot - top) * sy
}

/// Clip a single primitive through clip regions (keep inside) then occluders
/// (keep outside, front to back with early-out), then cleanup + emit.
#[allow(clippy::too_many_arguments)]
/// Clip one primitive against its clips and the occluders in front of it
/// and emit its visible PIECES. No nib judgment happens here — pieces are
/// judged as connected runs by `judge_runs`, whatever path produced them.
#[allow(clippy::too_many_arguments)]
fn clip_one(
    origin: u32,
    prim: &Primitive,
    threshold: f64,
    pen: u32,
    shape: u32,
    clips: &[(&Region, bool)],
    ctx: &ClipCtx,
    clean: bool,
    query_buf: &mut Vec<u32>,
    out: &mut Vec<Frag>,
) {
    if clean {
        out.push(Frag::whole(origin, *prim, pen, shape));
        return;
    }
    // Per-primitive index query: only occluders near THIS primitive.
    let pb = prim.bbox();
    {
        let _q = crate::profile::zone("5q clip-query");
        ctx.occ_index.query(&pb, query_buf);
    }
    // Fast path: nothing in front of this primitive and no clips — the
    // common case for long polylines where only a few segments cross an
    // occluder. No span allocation at all.
    let any_later = query_buf
        .iter()
        .any(|&oi| ctx.occluders[oi as usize].rank > ctx.my_rank);
    if !any_later && clips.is_empty() {
        out.push(Frag::whole(origin, *prim, pen, shape));
        return;
    }
    let mut spans = vec![Span {
        t0: 0.0,
        t1: 1.0,
        visible: true,
    }];
    for (clip, keep_inside) in clips {
        clip_spans(prim, &mut spans, clip, *keep_inside);
        if fully_hidden(&spans) {
            return;
        }
    }
    // Ascending ids = ascending rank; reverse = front-to-back.
    let _s = crate::profile::zone("5s clip-spans-loop");
    for k in (0..query_buf.len()).rev() {
        let occ = &ctx.occluders[query_buf[k] as usize];
        if occ.rank <= ctx.my_rank {
            break; // everything remaining is at or behind us
        }
        if let Primitive::Line(l) = prim {
            if !occ.region.bbox.intersects_segment(l.p0, l.p1) {
                continue; // diagonal's bbox overlapped, the segment doesn't
            }
        }
        if let Primitive::Arc(a) = prim {
            // An occluder entirely INSIDE the arc's circle can never touch
            // the stroke: the stroke lives at distance exactly r from the
            // centre, and every point of the region is strictly closer.
            // This is what makes stacks of concentric rings O(n) instead
            // of O(n²) — each ring skips all the smaller ones in front.
            let bb = &occ.region.bbox;
            let far = [
                v(bb.min.x, bb.min.y),
                v(bb.max.x, bb.min.y),
                v(bb.min.x, bb.max.y),
                v(bb.max.x, bb.max.y),
            ]
            .iter()
            .map(|p| p.dist(a.center))
            .fold(0.0, f64::max);
            if far < a.r {
                continue;
            }
        }
        clip_spans(prim, &mut spans, &occ.region, false);
        if fully_hidden(&spans) {
            return;
        }
    }
    spans_to_fragments(origin, prim, &spans, threshold, pen, shape, out);
}

/// THE nib rule, in one place. The pieces pushed to `so.frags` since `from`
/// are one contour's or one chain's visible ink, in stroke order. Group
/// them into RUNS the pen draws without lifting (a piece that starts where
/// the previous one ended continues the stroke; a closed contour's last
/// run wraps into its first) and judge each run by its TOTAL length: a run
/// at or above the nib stays as its pieces; a sub-nib run is ink the pen
/// can only tap — it becomes ONE tap candidate at its length-weighted
/// centroid (a sub-nib circle's two arcs tap once at the centre, never as
/// a peanut), resolved later against coverage. Whether a piece came from
/// the clean fast path, an occluder span, or a region clip is invisible
/// here — one mechanism, no special cases.
fn judge_runs(so: &mut ShapeOut, from: usize, threshold: f64, closed: bool, pen: u32, shape: u32) {
    if so.frags.len() <= from {
        return;
    }
    let pieces: Vec<Frag> = so.frags.drain(from..).collect();
    let mut runs: Vec<Vec<Frag>> = Vec::new();
    for piece in pieces {
        let continues = runs
            .last()
            .and_then(|r| r.last())
            .is_some_and(|prev| prev.geom.end().dist(piece.geom.start()) <= 1e-9);
        match runs.last_mut() {
            Some(run) if continues => run.push(piece),
            _ => runs.push(vec![piece]),
        }
    }
    if closed && runs.len() > 1 {
        let wraps = runs
            .last()
            .and_then(|r| r.last())
            .zip(runs.first().and_then(|r| r.first()))
            .is_some_and(|(last, first)| last.geom.end().dist(first.geom.start()) <= 1e-9);
        if wraps {
            let mut last = runs.pop().unwrap();
            last.append(&mut runs[0]);
            runs[0] = last;
        }
    }
    for run in runs {
        let total: f64 = run.iter().map(|f| f.geom.length()).sum();
        if total >= threshold {
            so.frags.extend(run);
            continue;
        }
        let (mut cx, mut cy, mut wsum) = (0.0, 0.0, 0.0);
        for f in &run {
            let m = f.geom.eval(0.5);
            let w = f.geom.length().max(1e-9);
            cx += m.x * w;
            cy += m.y * w;
            wsum += w;
        }
        let c = v(cx / wsum, cy / wsum);
        let dotp = Primitive::Line(Line::new(c, c));
        let origin = GEN_FLAG | so.gen_prims.len() as u32;
        so.gen_prims.push(dotp);
        so.taps.push(Frag {
            origin,
            t0: 0.0,
            t1: 1.0,
            pen,
            shape,
            dot: true,
            bridge: false,
            geom: dotp,
        });
    }
}

fn point_visible(p: Vec2, clips: &[(&Region, bool)], ctx: &ClipCtx, query_buf: &mut Vec<u32>) -> bool {
    for (clip, keep_inside) in clips {
        if clip.inside(p) != *keep_inside {
            return false;
        }
    }
    let pb = BBox::new(p, p);
    ctx.occ_index.query(&pb, query_buf);
    // Nearest-rank occluder first: for a point, hidden-by-any is order-
    // independent, and the shape drawn right after this one is the likeliest
    // cover (nested contour bands: each band's dots are mostly under the
    // next band) — one test settles most dots instead of one per occluder.
    let first_above = query_buf.partition_point(|&oi| ctx.occluders[oi as usize].rank <= ctx.my_rank);
    for &oi in &query_buf[first_above..] {
        let occ = &ctx.occluders[oi as usize];
        if !occ.region.on_boundary(p, crate::clip::ON_BOUNDARY_EPS) && occ.region.inside(p) {
            return false;
        }
    }
    true
}

/// Does the region contain the whole bbox? Exact: the bbox as a rect region.
/// A cheap corner test rejects the overwhelmingly common "no" first — the
/// exact split-at-crossings check (and its rect-Region construction) only
/// runs for near-positives.
fn region_contains_bbox(region: &Region, b: &BBox) -> bool {
    let corners = [
        v(b.min.x, b.min.y),
        v(b.max.x, b.min.y),
        v(b.max.x, b.max.y),
        v(b.min.x, b.max.y),
    ];
    if !corners
        .iter()
        .all(|&p| region.inside(p) || region.on_boundary(p, crate::clip::ON_BOUNDARY_EPS))
    {
        return false;
    }
    let pts = [
        v(b.min.x, b.min.y),
        v(b.max.x, b.min.y),
        v(b.max.x, b.max.y),
        v(b.min.x, b.max.y),
    ];
    let rect = Region::new(
        vec![vec![
            Primitive::Line(Line::new(pts[0], pts[1])),
            Primitive::Line(Line::new(pts[1], pts[2])),
            Primitive::Line(Line::new(pts[2], pts[3])),
            Primitive::Line(Line::new(pts[3], pts[0])),
        ]],
        WindingRule::NonZero,
        true,
    );
    region.contains_region(&rect)
}
