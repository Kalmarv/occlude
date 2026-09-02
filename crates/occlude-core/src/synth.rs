//! Synthetic supplied ink for the native HARNESS — benches, stress scenes,
//! property tests, examples. This is benchmark INPUT, not a fill
//! implementation: the product fills are the JS modules in
//! packages/occlude/src/fills, the one truth, and nothing here knows what
//! hatch or stipple look like. The Rust golden consumes a committed
//! JS-generated scene + sidecar instead (tests/fixtures/golden), so cargo
//! test stays hermetic and node-free while still rendering product ink.

use crate::bbox::BBox;
use crate::fill::{FillKind, SuppliedFill};
use crate::pipeline::{prepare, FillJob, RenderInput, RenderOutput};
use crate::primitive::{Line, Primitive};
use crate::rng::Pcg32;
use crate::vec2::{v, Vec2};

/// Bounding box of a set of contours.
pub fn bbox_of(contours: &[Vec<Primitive>]) -> BBox {
    contours
        .iter()
        .flatten()
        .fold(BBox::EMPTY, |b, p| b.union(&p.bbox()))
}

/// Parallel lines at `angle_deg` across a bbox, `spacing` apart, unclipped
/// — the pipeline clips them to the region like any supplied ink.
pub fn spanning_lines(b: &BBox, spacing: f64, angle_deg: f64) -> Vec<Primitive> {
    let spacing = spacing.max(0.02);
    let dir = Vec2::from_angle(angle_deg.to_radians());
    let nrm = dir.perp();
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
    if !omin.is_finite() || !omax.is_finite() {
        return Vec::new();
    }
    let k0 = (omin / spacing).ceil() as i64;
    let k1 = (omax / spacing).floor() as i64;
    let pad = spacing * 0.5;
    (k0..=k1)
        .map(|k| {
            let o = k as f64 * spacing;
            Primitive::Line(Line::new(
                nrm * o + dir * (dmin - pad),
                nrm * o + dir * (dmax + pad),
            ))
        })
        .collect()
}

/// Pre-generated line ink for a shape built at construction time.
pub fn custom_lines(contours: &[Vec<Primitive>], spacing: f64, angle_deg: f64) -> FillKind {
    FillKind::Custom(spanning_lines(&bbox_of(contours), spacing, angle_deg))
}

/// A jittered lattice of dots over a bbox, deterministic from `seed`. Dots
/// outside the region are supplied too — the engine keeps strictly-inside
/// ones only, which is exactly the behaviour a harness wants to exercise.
pub fn lattice_dots(b: &BBox, spacing: f64, seed: u64) -> Vec<Vec2> {
    let spacing = spacing.max(0.05);
    let mut rng = Pcg32::new(seed);
    let mut out = Vec::new();
    let mut y = b.min.y;
    while y <= b.max.y {
        let mut x = b.min.x;
        while x <= b.max.x {
            out.push(v(
                x + rng.range(-0.4, 0.4) * spacing,
                y + rng.range(-0.4, 0.4) * spacing,
            ));
            x += spacing;
        }
        y += spacing;
    }
    out
}

/// Harness render through the real two-pass path: prepare, let `supply`
/// produce ink for each surviving Pending fill job (exactly where the JS
/// runtime runs its fills), finish.
pub fn render_with(input: RenderInput, supply: impl Fn(&FillJob) -> SuppliedFill) -> RenderOutput {
    let n = input.shapes.len();
    let prepared = prepare(input);
    let mut supplied: Vec<Option<SuppliedFill>> = vec![None; n];
    for job in prepared.fill_jobs() {
        supplied[job.shape] = Some(supply(&job));
    }
    prepared.finish(supplied)
}
