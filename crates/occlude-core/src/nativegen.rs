//! Native-harness fill generators — the native analogue of the JS fill
//! modules, for goldens, benches, stress scenes, and replay fixtures. The
//! PIPELINE never calls anything here (spec: the engine decides what
//! survives to paper, never what gets drawn); these produce the supplied
//! ink that `Prepared::finish` consumes, exercising the real two-pass path.
//! The algorithms are the pre-redesign engine generators, verbatim.
//!
//! POLICY: goldens built on these are PIPELINE fixtures, not fill fixtures.
//! The product fills are the JS modules in packages/occlude/src/fills and
//! already differ (anchor rotation, coarsen); never compare native-generated
//! ink against JS-generated ink across the two.

use crate::clip::clip_spans;
use crate::fill::SuppliedFill;
use crate::fragment::Span;
use crate::pipeline::{prepare, RenderInput, RenderOutput};
use crate::primitive::{Line, Primitive};
use crate::region::Region;
use crate::rng::Pcg32;
use crate::vec2::{v, Vec2};

#[derive(Debug, Clone, Copy)]
pub struct HatchPass {
    /// Degrees.
    pub angle: f64,
    /// Line spacing in mm.
    pub spacing: f64,
    /// Phase offset in mm along the hatch normal.
    pub offset: f64,
    /// Anchor the ruling to the shape instead of the paper: a line passes
    /// through the region's bbox centre (plus `offset`), so every shape
    /// gets identical marks wherever it sits — the halftone case.
    pub shape_anchor: bool,
}

/// Harness-side fill spec, resolved into supplied ink per surviving shape.
#[derive(Debug, Clone)]
pub enum NativeFill {
    Hatch(Vec<HatchPass>),
    Stipple { density: f64, min_dist: f64 },
}

/// One-call harness render: prepare, generate the registered fills against
/// the surviving shapes' real post-deform outlines (exactly what the JS
/// runtime does between the passes), finish. Shapes named in `fills` must
/// carry `FillKind::Pending`. Stipple seeds mix the input seed with the
/// shape index exactly as the old engine generator did.
pub fn render_with(input: RenderInput, fills: &[(usize, NativeFill)]) -> RenderOutput {
    let seed = input.seed;
    let n = input.shapes.len();
    let prepared = prepare(input);
    let mut supplied: Vec<Option<SuppliedFill>> = vec![None; n];
    for job in prepared.fill_jobs() {
        let Some((_, spec)) = fills.iter().find(|(i, _)| *i == job.shape) else {
            continue;
        };
        let region = Region::new(job.contours.to_vec(), job.winding, job.convex);
        let fill = match spec {
            // Each ruling is its own pen stroke: a chain of one.
            NativeFill::Hatch(passes) => SuppliedFill {
                chains: passes
                    .iter()
                    .flat_map(|pass| hatch_region(&region, pass))
                    .map(|p| vec![p])
                    .collect(),
                dots: Vec::new(),
            },
            NativeFill::Stipple { density, min_dist } => SuppliedFill {
                chains: Vec::new(),
                dots: stipple_region(
                    &region,
                    *density,
                    *min_dist,
                    seed ^ (job.shape as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15),
                ),
            },
        };
        supplied[job.shape] = Some(fill);
    }
    prepared.finish(supplied)
}

/// Precomputed hatch ink as a Custom fill — the one-liner for harness
/// shapes built at construction time (contours in hand, convexity known).
pub fn custom_hatch(
    contours: &[Vec<Primitive>],
    winding: crate::region::WindingRule,
    convex: bool,
    pass: &HatchPass,
) -> crate::fill::FillKind {
    let region = Region::new(contours.to_vec(), winding, convex);
    crate::fill::FillKind::Custom(hatch_region(&region, pass))
}

/// Generate hatch lines for a region, already clipped to the region.
/// Returns exact line primitives.
pub fn hatch_region(region: &Region, pass: &HatchPass) -> Vec<Primitive> {
    // Physical floor, then a hard line budget against the bbox diagonal —
    // a near-zero spacing must not request hundreds of thousands of lines.
    let diag = region.bbox.width().hypot(region.bbox.height());
    let spacing = pass.spacing.max(0.02).max(diag / 100_000.0);
    let theta = pass.angle.to_radians();
    let dir = Vec2::from_angle(theta);
    let nrm = dir.perp();
    // Project bbox corners onto the normal to find the band of offsets.
    let b = &region.bbox;
    let corners = [
        v(b.min.x, b.min.y),
        v(b.max.x, b.min.y),
        v(b.max.x, b.max.y),
        v(b.min.x, b.max.y),
    ];
    let (mut omin, mut omax) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut dmin, mut dmax) = (f64::INFINITY, f64::NEG_INFINITY);
    for c in corners {
        omin = omin.min(c.dot(nrm));
        omax = omax.max(c.dot(nrm));
        dmin = dmin.min(c.dot(dir));
        dmax = dmax.max(c.dot(dir));
    }
    // Phase: paper-anchored rulings are multiples of spacing in paper space
    // (adjacent same-spec fills align); shape-anchored ones centre the
    // ruling on the region, so small shapes render identically anywhere.
    let phase = if pass.shape_anchor {
        pass.offset + (b.min + (b.max - b.min) * 0.5).dot(nrm)
    } else {
        pass.offset
    };
    let k0 = ((omin - phase) / spacing).ceil() as i64;
    let k1 = ((omax - phase) / spacing).floor() as i64;
    let pad = spacing * 0.5;
    let mut out = Vec::new();
    for k in k0..=k1 {
        let o = k as f64 * spacing + phase;
        let a = nrm * o + dir * (dmin - pad);
        let bpt = nrm * o + dir * (dmax + pad);
        let span = Primitive::Line(Line::new(a, bpt));
        if region.convex {
            // Closed form for convex regions: the chord between the first and
            // last boundary crossings, no classify pass.
            let ts = region.crossings(&span, &span.bbox());
            if ts.len() >= 2 {
                let piece = span.sub(ts[0], *ts.last().unwrap());
                if piece.length() > 1e-9 {
                    out.push(piece);
                }
            }
            continue;
        }
        // General case: clip the spanning line to the region.
        let mut spans = vec![Span {
            t0: 0.0,
            t1: 1.0,
            visible: true,
        }];
        clip_spans(&span, &mut spans, region, true);
        for s in spans.iter().filter(|s| s.visible) {
            let piece = span.sub(s.t0, s.t1);
            if piece.length() > 1e-9 {
                out.push(piece);
            }
        }
    }
    out
}

/// Bridson Poisson-disk stipple inside a region. `density` ∈ (0, 1] scales
/// the disk radius: r = min_dist / density, so 1.0 is the tightest packing
/// and lower densities spread points out. Deterministic for a given seed.
pub fn stipple_region(region: &Region, density: f64, min_dist: f64, seed: u64) -> Vec<Vec2> {
    let b = &region.bbox;
    let (w, h) = (b.width(), b.height());
    if w <= 0.0 || h <= 0.0 || !w.is_finite() || !h.is_finite() {
        return Vec::new();
    }
    // Physical floor and a hard grid budget: the Poisson grid is ≈2wh/r²
    // cells, so a zero/tiny min_dist must not request gigabytes.
    const MAX_CELLS: f64 = 4_000_000.0;
    let r = (min_dist / density.clamp(0.05, 1.0))
        .max(0.05)
        .max((2.0 * w * h / MAX_CELLS).sqrt());
    let cell = r / std::f64::consts::SQRT_2;
    let cols = (w / cell).ceil() as usize + 1;
    let rows = (h / cell).ceil() as usize + 1;
    let mut grid: Vec<i32> = vec![-1; cols * rows];
    let mut points: Vec<Vec2> = Vec::new();
    let mut active: Vec<usize> = Vec::new();
    let mut rng = Pcg32::new(seed);

    let cell_of = |p: Vec2| -> (usize, usize) {
        let cx = (((p.x - b.min.x) / cell) as usize).min(cols - 1);
        let cy = (((p.y - b.min.y) / cell) as usize).min(rows - 1);
        (cx, cy)
    };
    let fits = |p: Vec2, points: &[Vec2], grid: &[i32]| -> bool {
        if p.x < b.min.x || p.x > b.max.x || p.y < b.min.y || p.y > b.max.y {
            return false;
        }
        let (cx, cy) = cell_of(p);
        let x0 = cx.saturating_sub(2);
        let y0 = cy.saturating_sub(2);
        for gy in y0..(cy + 3).min(rows) {
            for gx in x0..(cx + 3).min(cols) {
                let idx = grid[gy * cols + gx];
                if idx >= 0 && points[idx as usize].dist(p) < r {
                    return false;
                }
            }
        }
        true
    };

    let first = v(rng.range(b.min.x, b.max.x), rng.range(b.min.y, b.max.y));
    points.push(first);
    active.push(0);
    let (cx, cy) = cell_of(first);
    grid[cy * cols + cx] = 0;

    const K: usize = 24;
    while !active.is_empty() {
        let pick = (rng.next_u32() as usize) % active.len();
        let base = points[active[pick]];
        let mut placed = false;
        for _ in 0..K {
            let ang = rng.range(0.0, std::f64::consts::TAU);
            let rad = rng.range(r, 2.0 * r);
            let cand = base + Vec2::from_angle(ang) * rad;
            if fits(cand, &points, &grid) {
                let idx = points.len();
                points.push(cand);
                active.push(idx);
                let (cx, cy) = cell_of(cand);
                grid[cy * cols + cx] = idx as i32;
                placed = true;
                break;
            }
        }
        if !placed {
            active.swap_remove(pick);
        }
    }
    // One `inside` test per point, no intersections (spec). The engine
    // re-filters identically at finish; this trims the transfer.
    points
        .into_iter()
        .filter(|&p| region.inside(p) && !region.on_boundary(p, 1e-9))
        .collect()
}
