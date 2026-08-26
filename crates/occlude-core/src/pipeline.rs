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
use crate::fill::{hatch_region, stipple_region, FillKind};
use crate::fragment::{Frag, Span};
use crate::index::SpatialIndex;
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
    /// Indices into `RenderInput::clips` active for this shape.
    pub clips: Vec<u32>,
    /// Post-occlusion decimation: each FINAL outline fragment is dropped
    /// with this probability (0 = keep all). Deterministic from the sketch
    /// seed — the distressed-plot modifier.
    pub decimate_stroke: f64,
    /// Same, for fill ink (hatch lines, stipple dots, custom fill strokes).
    pub decimate_fill: f64,
}

#[derive(Debug, Clone)]
pub struct ClipDef {
    pub contours: Vec<Vec<Primitive>>,
    pub winding: WindingRule,
    pub convex: bool,
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
}

pub fn render(input: &RenderInput) -> RenderOutput {
    let n = input.shapes.len();
    let mut stats = RenderStats {
        shapes_in: n,
        ..Default::default()
    };

    // ---- Layer 2: sort by z (stable on draw index) ----
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        input.shapes[a]
            .z
            .partial_cmp(&input.shapes[b].z)
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
    let mut shape_bbox: Vec<BBox> = Vec::with_capacity(n);
    for s in &input.shapes {
        let start = prim_table.len();
        let mut b = BBox::EMPTY;
        for c in &s.contours {
            for p in c {
                b = b.union(&p.bbox());
                prim_table.push(*p);
            }
        }
        outline_range.push((start, prim_table.len()));
        shape_bbox.push(b);
    }

    // Opaque regions, built once and shared with the fill layer.
    let mut shape_region: Vec<Option<Arc<Region>>> = vec![None; n];
    let mut occluders: Vec<Occluder> = Vec::new();
    for &i in &order {
        let s = &input.shapes[i];
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

    // Clip regions.
    let clip_regions: Vec<Region> = input
        .clips
        .iter()
        .map(|c| Region::new(c.contours.clone(), c.winding, c.convex))
        .collect();
    let paper_region: Option<Region> = input.paper.map(|p| {
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
        if let Some(p) = &input.paper {
            if !b.overlaps(p) {
                alive[i] = false;
                stats.culled_off_paper += 1;
                continue;
            }
        }
        // Later opaque regions overlapping this shape.
        occ_index.query(b, &mut query_buf);
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
        let on_paper = input.paper.map(|p| p.contains_box(b)).unwrap_or(true);
        if !any_later && input.shapes[i].clips.is_empty() && on_paper {
            clean[i] = true;
            stats.clean += 1;
        }
    }

    // ---- Layers 3–5, sharded by shape (spec: after culling, shapes are
    // independent). Generated fill primitives get shape-local provisional
    // origins (GEN_FLAG | local index) that are rebased during the
    // deterministic merge, so the output is identical to the serial run.
    let min_pen_width = input
        .pens
        .iter()
        .map(|p| p.width)
        .fold(f64::INFINITY, f64::min)
        .min(0.3);
    let coarsen = if input.coarsen > 0.0 {
        input.coarsen
    } else {
        1.0
    };
    drop(query_buf);

    let process = |i: usize| -> ShapeOut {
        let mut so = ShapeOut::default();
        if !alive[i] {
            return so;
        }
        let s = &input.shapes[i];
        let pen_width =
            |pen: u32| -> f64 { input.pens.get(pen as usize).map(|p| p.width).unwrap_or(0.3) };
        let ctx = ClipCtx {
            occluders: &occluders,
            occ_index: &occ_index,
            my_rank: rank[i],
        };
        let shape_clips: Vec<&Region> = s
            .clips
            .iter()
            .filter_map(|&c| clip_regions.get(c as usize))
            .chain(paper_region.iter().filter(|_| !clean[i]))
            .collect();
        let mut query_buf: Vec<u32> = Vec::new();

        // Stroke outline.
        if let Some(stroke_pen) = s.stroke {
            let (p0, p1) = outline_range[i];
            let threshold = pen_width(stroke_pen);
            for local in 0..(p1 - p0) {
                let prim = prim_table[p0 + local];
                clip_one(
                    (p0 + local) as u32,
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
        }

        // Fill.
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
        match kind {
            FillKind::Hatch(passes) => {
                for pass in passes {
                    let mut pass = *pass;
                    pass.spacing *= coarsen;
                    for prim in hatch_region(region, &pass) {
                        gen_one(prim, &mut so, &mut query_buf);
                    }
                }
            }
            FillKind::Stipple { density, min_dist } => {
                // Decorrelate per shape: with one global seed, shapes with
                // similar bboxes generate nearly identical Poisson patterns
                // in paper space, and occlusion slivers then reveal
                // near-duplicate dots from neighbouring shapes (clumpy,
                // structured borders). Still fully deterministic per sketch
                // seed; shape 0 keeps the unmixed seed.
                let shape_seed =
                    input.seed ^ (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
                let pts = stipple_region(region, *density, *min_dist * coarsen, shape_seed);
                for p in pts {
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
                            geom: dotp,
                        });
                    }
                }
            }
            FillKind::Custom(prims) => {
                for prim in prims {
                    // Custom fill primitives are clipped to their own region
                    // first — a fill is ink inside the region.
                    let mut spans = vec![Span {
                        t0: 0.0,
                        t1: 1.0,
                        visible: true,
                    }];
                    clip_spans(prim, &mut spans, region, true);
                    for sp in spans.iter().filter(|sp| sp.visible) {
                        let piece = prim.sub(sp.t0, sp.t1);
                        gen_one(piece, &mut so, &mut query_buf);
                    }
                }
            }
            // Opaque with zero ink: the occluder was registered above; there
            // is nothing to generate.
            FillKind::Mask => {}
        }
        so
    };

    #[cfg(feature = "parallel")]
    let outputs: Vec<ShapeOut> = (0..n).into_par_iter().map(process).collect();
    #[cfg(not(feature = "parallel"))]
    let outputs: Vec<ShapeOut> = (0..n).map(process).collect();

    // Deterministic merge in input order: rebase generated origins.
    let mut frags: Vec<Frag> = Vec::new();
    for so in outputs {
        let base = prim_table.len() as u32;
        stats.fill_prims += so.gen_prims.len();
        prim_table.extend(so.gen_prims);
        frags.extend(so.frags.into_iter().map(|mut f| {
            if f.origin & GEN_FLAG != 0 {
                f.origin = base + (f.origin & !GEN_FLAG);
            }
            f
        }));
    }

    let frags = dedupe_seams(frags, min_pen_width.max(1e-6));
    // Decimation: seeded per-fragment coin flip AFTER occlusion and cleanup,
    // so what disappears is final visible ink.
    let frags: Vec<Frag> = frags
        .into_iter()
        .filter(|f| {
            let shape = &input.shapes[f.shape as usize];
            let (p0, p1) = outline_range[f.shape as usize];
            let is_stroke = (f.origin as usize) >= p0 && (f.origin as usize) < p1;
            let p = if is_stroke {
                shape.decimate_stroke
            } else {
                shape.decimate_fill
            };
            if p <= 0.0 {
                return true;
            }
            let mut h = input
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
        })
        .collect();
    stats.fragments = frags.len();
    RenderOutput {
        prims: prim_table,
        frags,
        stats,
    }
}

/// Clip a single primitive through clip regions (keep inside) then occluders
/// (keep outside, front to back with early-out), then cleanup + emit.
#[allow(clippy::too_many_arguments)]
fn clip_one(
    origin: u32,
    prim: &Primitive,
    threshold: f64,
    pen: u32,
    shape: u32,
    clips: &[&Region],
    ctx: &ClipCtx,
    clean: bool,
    query_buf: &mut Vec<u32>,
    out: &mut Vec<Frag>,
) {
    if clean {
        // The nib-width rule applies on the fast path too: detail below one
        // nib is a dot, not a line (tiny hatch chords at region corners).
        if prim.length() >= threshold {
            out.push(Frag::whole(origin, *prim, pen, shape));
        }
        return;
    }
    // Per-primitive index query: only occluders near THIS primitive.
    let pb = prim.bbox();
    ctx.occ_index.query(&pb, query_buf);
    // Fast path: nothing in front of this primitive and no clips — the
    // common case for long polylines where only a few segments cross an
    // occluder. No span allocation at all.
    let any_later = query_buf
        .iter()
        .any(|&oi| ctx.occluders[oi as usize].rank > ctx.my_rank);
    if !any_later && clips.is_empty() {
        if prim.length() >= threshold {
            out.push(Frag::whole(origin, *prim, pen, shape));
        }
        return;
    }
    let mut spans = vec![Span {
        t0: 0.0,
        t1: 1.0,
        visible: true,
    }];
    for clip in clips {
        clip_spans(prim, &mut spans, clip, true);
        if fully_hidden(&spans) {
            return;
        }
    }
    // Ascending ids = ascending rank; reverse = front-to-back.
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
        clip_spans(prim, &mut spans, &occ.region, false);
        if fully_hidden(&spans) {
            return;
        }
    }
    spans_to_fragments(origin, prim, &spans, threshold, pen, shape, out);
}

fn point_visible(p: Vec2, clips: &[&Region], ctx: &ClipCtx, query_buf: &mut Vec<u32>) -> bool {
    for clip in clips {
        if !clip.inside(p) {
            return false;
        }
    }
    let pb = BBox::new(p, p);
    ctx.occ_index.query(&pb, query_buf);
    for k in (0..query_buf.len()).rev() {
        let occ = &ctx.occluders[query_buf[k] as usize];
        if occ.rank <= ctx.my_rank {
            break;
        }
        if !occ.region.on_boundary(p, crate::clip::ON_BOUNDARY_EPS) && occ.region.inside(p) {
            return false;
        }
    }
    true
}

/// Does the region contain the whole bbox? Exact: the bbox as a rect region.
fn region_contains_bbox(region: &Region, b: &BBox) -> bool {
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
