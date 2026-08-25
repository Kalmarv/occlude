//! Built-in fills. Fills are texture, not solid black: hatch lines, stipple
//! dots. Generated lazily for surviving shapes only, in paper space (mm), so
//! density scales with paper size, and hatch phase is global — adjacent
//! same-spec fills stay aligned.

use crate::clip::clip_spans;
use crate::fragment::Span;
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
}

#[derive(Debug, Clone)]
pub enum FillKind {
    /// One entry per pass; crosshatch is just several passes.
    Hatch(Vec<HatchPass>),
    Stipple {
        density: f64,
        min_dist: f64,
    },
    /// Pre-generated primitives (custom TS fill functions). They go through
    /// the normal occlusion path like everything else.
    Custom(Vec<Primitive>),
    /// Opaque with zero ink: occludes everything beneath it, draws nothing.
    /// The primitive of hidden-line rendering.
    Mask,
}

/// Generate hatch lines for a region, already clipped to the region.
/// Returns exact line primitives.
pub fn hatch_region(region: &Region, pass: &HatchPass) -> Vec<Primitive> {
    let spacing = pass.spacing.max(1e-3);
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
    // Global phase: offsets are multiples of spacing (plus offset) in paper
    // space, so hatches of adjacent shapes with the same spec align.
    let k0 = ((omin - pass.offset) / spacing).ceil() as i64;
    let k1 = ((omax - pass.offset) / spacing).floor() as i64;
    let pad = spacing * 0.5;
    let mut out = Vec::new();
    for k in k0..=k1 {
        let o = k as f64 * spacing + pass.offset;
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
///
/// Containment is point-based, consistent with the rest of the system: ink
/// width is never taken into account (a dot centred on the boundary is kept,
/// exactly as a stroke is cut at the boundary regardless of its nib).
pub fn stipple_region(region: &Region, density: f64, min_dist: f64, seed: u64) -> Vec<Vec2> {
    let r = (min_dist / density.clamp(0.05, 1.0)).max(1e-3);
    let b = &region.bbox;
    let (w, h) = (b.width(), b.height());
    if w <= 0.0 || h <= 0.0 {
        return Vec::new();
    }
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
    // One `inside` test per point, no intersections (spec).
    points
        .into_iter()
        .filter(|&p| region.inside(p) && !region.on_boundary(p, 1e-9))
        .collect()
}
