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
use crate::modifier::{FieldGrid, Modifier, Param, Stage};
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
    /// Ordered modifier program. Post-stage entries run over this shape's
    /// final fragments after occlusion and cleanup, in list order.
    pub modifiers: Vec<Modifier>,
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
    /// Rasterised scalar fields referenced by `Param::Field` modifier
    /// parameters (paper-mm grids).
    pub fields: Vec<FieldGrid>,
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

    // ---- Pre-stage modifiers: deform shape geometry BEFORE the solve, so
    // occlusion, fills and culling all follow the modified contours. This is
    // the conscious-choice stage: curves shatter into polylines here, and
    // only wrapped shapes pay for it.
    let pre_shapes: Vec<ShapeRec>;
    let shapes: &[ShapeRec] = if input
        .shapes
        .iter()
        .any(|s| s.modifiers.iter().any(|m| m.stage() == Stage::Pre))
    {
        pre_shapes = input
            .shapes
            .iter()
            .enumerate()
            .map(|(i, s)| apply_pre(s, i, input.seed, &input.fields))
            .collect();
        &pre_shapes
    } else {
        &input.shapes
    };

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
    let mut shape_bbox: Vec<BBox> = Vec::with_capacity(n);
    for s in shapes {
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
        if !any_later && shapes[i].clips.is_empty() && on_paper {
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
        let s = &shapes[i];
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
    // ---- Post-stage modifiers: each shape's ordered program runs over its
    // final ink, AFTER occlusion and cleanup, so what a modifier touches is
    // final visible strokes. One frag at a time through the whole program
    // preserves global frag order (and therefore plot order).
    let mut frags = frags;
    let has_post = input
        .shapes
        .iter()
        .any(|s| s.modifiers.iter().any(|m| m.stage() == Stage::Post));
    if has_post {
        let mut interp = PostInterp {
            seed: input.seed,
            fields: &input.fields,
            prim_table: &mut prim_table,
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
            interp.run(f, prog, is_stroke, &mut out);
        }
        frags = out;
    }

    stats.fragments = frags.len();
    RenderOutput {
        prims: prim_table,
        frags,
        stats,
    }
}

/// Post-stage modifier interpreter: threads one fragment through a shape's
/// program, op by op. Ops may drop the fragment (decimate) or replace it
/// with many (wobble); generated geometry is appended to the prim table.
struct PostInterp<'a> {
    seed: u64,
    fields: &'a [FieldGrid],
    prim_table: &'a mut Vec<Primitive>,
    cur: Vec<Frag>,
    next: Vec<Frag>,
    pts: Vec<Vec2>,
    dense: Vec<Vec2>,
}

impl PostInterp<'_> {
    fn run(&mut self, f: Frag, prog: &[Modifier], is_stroke: bool, out: &mut Vec<Frag>) {
        self.cur.clear();
        self.cur.push(f);
        for m in prog {
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
                    Modifier::Dash { len, gap } => self.dash(f, *len, *gap),
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
        let p = p.at(self.fields, mid.x, mid.y);
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
        let fields = self.fields;
        let jiggle = |p: Vec2| -> Vec2 {
            let a = amp.at(fields, p.x, p.y);
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
            self.next.push(Frag { origin, t0: 0.0, t1: 1.0, geom: dotp, ..f });
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
                self.dense.push(v(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
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
    /// Chop the fragment into dashes by physical length. The cuts are exact
    /// t-sub-ranges of the original primitive — curves stay curves; the prim
    /// table does not grow.
    fn dash(&mut self, f: Frag, len: f64, gap: f64) {
        if f.dot || len <= 0.0 {
            self.next.push(f);
            return;
        }
        let total = f.geom.length();
        if total <= 1e-9 {
            self.next.push(f);
            return;
        }
        // Arc-length → local-t: lines and arcs are uniform-speed in t; a
        // cubic gets a sampled cumulative-length table.
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
                    let frac = if c1 > c0 { (target - c0) / (c1 - c0) } else { 0.0 };
                    ((i - 1) as f64 + frac) / n as f64
                }
            }
        };
        let period = len + gap.max(0.0);
        let mut s0 = 0.0;
        while s0 < total - 1e-9 {
            let s1 = (s0 + len).min(total);
            let (ta, tb) = (t_of(s0), t_of(s1));
            let g0 = f.t0 + ta * (f.t1 - f.t0);
            let g1 = f.t0 + tb * (f.t1 - f.t0);
            self.next.push(Frag {
                origin: f.origin,
                t0: g0,
                t1: g1,
                geom: f.geom.sub(ta, tb),
                ..f.clone()
            });
            s0 += period;
        }
    }
}

// ---- Pre-stage geometry ops -------------------------------------------

/// Apply a shape's pre-stage modifiers to its contours, in program order.
/// Contours flatten to polylines once (0.05 mm), the ops transform points,
/// and line primitives are rebuilt at the end. Convexity is conservatively
/// dropped — deformed geometry makes no promises.
fn apply_pre(s: &ShapeRec, shape_idx: usize, seed: u64, fields: &[FieldGrid]) -> ShapeRec {
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
                for poly in &mut polys {
                    chaikin(poly, *passes, closed);
                }
            }
            Modifier::Roughen { amp, detail } => {
                for (ci, poly) in polys.iter_mut().enumerate() {
                    resample_polyline(poly, detail.max(0.2), closed);
                    let n = poly.len();
                    let (lo, hi) = if closed { (0, n) } else { (1, n.saturating_sub(1)) };
                    for (i, p) in poly.iter_mut().enumerate().take(hi).skip(lo) {
                        let a = amp.at(fields, p.x, p.y);
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
                for poly in &mut polys {
                    resample_polyline(poly, detail.max(0.2), closed);
                    for p in poly.iter_mut() {
                        let ox = dx.at(fields, p.x, p.y);
                        let oy = dy.at(fields, p.x, p.y);
                        *p = v(p.x + ox, p.y + oy);
                    }
                }
            }
            _ => {}
        }
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
