//! Closed regions: contour lists with a winding rule. The occluder in every
//! clipping operation.
//!
//! `inside` uses a horizontal ray cast with the half-open edge rule. Curved
//! primitives are pre-cut into y-monotone pieces at construction, which turns
//! every piece into an "edge" spanning [y_start, y_end) — vertex hits and
//! tangent rays then resolve by construction rather than by epsilon fudging.

use crate::bbox::BBox;
use crate::intersect::{intersect_pair, project_point_cubic};
use crate::primitive::{Arc, Primitive, EPS};
use crate::vec2::Vec2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindingRule {
    NonZero,
    EvenOdd,
}

#[derive(Debug, Clone)]
struct MonoPiece {
    prim: Primitive,
    y0: f64,
    y1: f64,
}

#[derive(Debug, Clone)]
pub struct Region {
    pub contours: Vec<Vec<Primitive>>,
    pub winding: WindingRule,
    pub convex: bool,
    pub bbox: BBox,
    mono: Vec<MonoPiece>,
    boundary_flat: Vec<Primitive>,
    boundary_bbox: Vec<BBox>,
    /// Cached single-circle detection: (centre, r). Makes inside/on_boundary
    /// O(1) for the most common occluder in plotter sketches.
    circle: Option<(Vec2, f64)>,
}

impl Region {
    pub fn new(contours: Vec<Vec<Primitive>>, winding: WindingRule, convex_hint: bool) -> Region {
        let mut bbox = BBox::EMPTY;
        let mut mono = Vec::new();
        for contour in &contours {
            let mut chain: Vec<MonoPiece> = Vec::new();
            for prim in contour {
                bbox = bbox.union(&prim.bbox());
                for (_, _, piece) in prim.split_at(&prim.y_extrema()) {
                    let y0 = piece.start().y;
                    let y1 = piece.end().y;
                    chain.push(MonoPiece {
                        prim: piece,
                        y0,
                        y1,
                    });
                }
            }
            // Weld the chain: adjacent pieces meet at the same geometric
            // vertex but may disagree — by float ulps (sin(2π) ≠ sin(0)), or
            // by up to ~2× the snap grid when arc endpoints (recomputed from
            // a snapped centre/radius) meet independently-snapped line
            // endpoints on rotated contours. Either way the half-open edge
            // rule breaks for rays through the seam band. Forcing exact
            // continuity restores "each crossing counted exactly once by
            // construction"; the tolerance is far below the pen nib.
            const WELD_TOL: f64 = 4.0 * crate::snap::GRID;
            let n = chain.len();
            for i in 0..n {
                let next_y0 = chain[(i + 1) % n].y0;
                if (chain[i].y1 - next_y0).abs() < WELD_TOL {
                    chain[i].y1 = next_y0;
                }
            }
            mono.extend(chain);
        }
        let convex = convex_hint || is_convex_polygon(&contours);
        let boundary_flat: Vec<Primitive> = contours.iter().flatten().copied().collect();
        let boundary_bbox = boundary_flat.iter().map(|p| p.bbox()).collect();
        let mut region = Region {
            contours,
            winding,
            convex,
            bbox,
            mono,
            boundary_flat,
            boundary_bbox,
            circle: None,
        };
        region.circle = region.as_circle();
        region
    }

    /// Crossing parameters of `subject` against this boundary, sorted and
    /// deduped, using cached per-primitive bboxes.
    pub fn crossings(&self, subject: &Primitive, subject_bbox: &BBox) -> Vec<f64> {
        let sb = subject_bbox.expanded(1e-9);
        let mut ts: Vec<f64> = Vec::new();
        for (prim, pb) in self.boundary_flat.iter().zip(&self.boundary_bbox) {
            if !sb.overlaps(pb) {
                continue;
            }
            for (t, _) in crate::intersect::intersect_pair(subject, prim) {
                ts.push(t);
            }
        }
        ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
        ts.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
        ts
    }

    pub fn boundary_slice(&self) -> &[Primitive] {
        &self.boundary_flat
    }

    pub fn from_contour(prims: Vec<Primitive>) -> Region {
        Region::new(vec![prims], WindingRule::NonZero, false)
    }

    pub fn boundary(&self) -> impl Iterator<Item = &Primitive> {
        self.contours.iter().flatten()
    }

    /// If the region is exactly one circle (two arcs sharing centre/radius or
    /// one full-sweep arc), return (centre, r). Enables exact containment
    /// fast paths in the cull layer.
    pub fn as_circle(&self) -> Option<(Vec2, f64)> {
        if self.contours.len() != 1 {
            return None;
        }
        let c = &self.contours[0];
        let arcs: Vec<&Arc> = c
            .iter()
            .map(|p| match p {
                Primitive::Arc(a) => Some(a),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()?;
        if arcs.is_empty() {
            return None;
        }
        let (center, r) = (arcs[0].center, arcs[0].r);
        let mut total = 0.0;
        for a in &arcs {
            if a.center.dist(center) > EPS || (a.r - r).abs() > EPS {
                return None;
            }
            total += a.sweep;
        }
        if (total.abs() - std::f64::consts::TAU).abs() < 1e-9 {
            Some((center, r))
        } else {
            None
        }
    }

    /// Winding-number containment. Boundary points are NOT special-cased here;
    /// use `classify`-level `on_boundary` when the "on = outside" rule matters.
    pub fn inside(&self, p: Vec2) -> bool {
        if !self.bbox.contains_point(p) {
            return false;
        }
        if let Some((c, r)) = self.circle {
            return p.dist2(c) < r * r;
        }
        match self.winding {
            WindingRule::NonZero => self.winding_number(p) != 0,
            WindingRule::EvenOdd => self.crossing_count(p) % 2 == 1,
        }
    }

    fn winding_number(&self, p: Vec2) -> i32 {
        let mut w = 0;
        for piece in &self.mono {
            w += piece.crossing(p);
        }
        w
    }

    fn crossing_count(&self, p: Vec2) -> u32 {
        let mut n = 0;
        for piece in &self.mono {
            if piece.crossing(p) != 0 {
                n += 1;
            }
        }
        n
    }

    /// True when `p` lies within `eps` of the region boundary.
    pub fn on_boundary(&self, p: Vec2, eps: f64) -> bool {
        if let Some((c, r)) = self.circle {
            return (p.dist(c) - r).abs() <= eps;
        }
        for (prim, pb) in self.boundary_flat.iter().zip(&self.boundary_bbox) {
            if !pb.expanded(eps).contains_point(p) {
                continue;
            }
            let d = match prim {
                Primitive::Line(l) => {
                    let dir = l.dir();
                    let len2 = dir.len2();
                    if len2 < EPS * EPS {
                        l.p0.dist(p)
                    } else {
                        let t = ((p - l.p0).dot(dir) / len2).clamp(0.0, 1.0);
                        l.eval(t).dist(p)
                    }
                }
                Primitive::Arc(a) => {
                    let to = p - a.center;
                    match a.t_of_angle(to.angle()) {
                        Some(_) => (to.len() - a.r).abs(),
                        None => a.eval(0.0).dist(p).min(a.eval(1.0).dist(p)),
                    }
                }
                Primitive::Cubic(c) => {
                    let t = project_point_cubic(p, c);
                    c.eval(t).dist(p)
                }
            };
            if d <= eps {
                return true;
            }
        }
        false
    }

    /// Exact containment of another region: bbox check, then no boundary
    /// crossings, then a sample point inside. (Cull-layer helper.)
    pub fn contains_region(&self, other: &Region) -> bool {
        if !self.bbox.contains_box(&other.bbox) {
            return false;
        }
        // Circle-in-circle fast path.
        if let (Some((c1, r1)), Some((c2, r2))) = (self.as_circle(), other.as_circle()) {
            return c1.dist(c2) + r2 <= r1 + EPS;
        }
        for op in other.boundary() {
            for sp in self.boundary() {
                if !op.bbox().expanded(1e-9).overlaps(&sp.bbox()) {
                    continue;
                }
                for (to, _) in intersect_pair(op, sp) {
                    // A genuine crossing strictly inside the primitive means
                    // the boundary pokes out; endpoint grazing does not.
                    if to > 1e-7 && to < 1.0 - 1e-7 {
                        let pt = op.eval(to);
                        if !self.on_boundary(pt, 1e-9) {
                            return false;
                        }
                        // Coincident-boundary hit: keep checking others.
                        let _ = pt;
                    }
                }
            }
        }
        // No crossings: containment decided by any sample point.
        let sample = other
            .boundary()
            .next()
            .map(|p| p.eval(0.5))
            .unwrap_or(other.bbox.center());
        self.inside(sample) || self.on_boundary(sample, 1e-9)
    }
}

impl MonoPiece {
    /// Signed crossing of the leftward-open horizontal ray from p going +x.
    /// Half-open span [y0, y1): +1 upward, −1 downward, 0 otherwise.
    fn crossing(&self, p: Vec2) -> i32 {
        let (y0, y1) = (self.y0, self.y1);
        let up = y1 > y0;
        let spans = if up {
            p.y >= y0 && p.y < y1
        } else {
            p.y >= y1 && p.y < y0
        };
        if !spans || y0 == y1 {
            return 0;
        }
        let x = match self.x_at(p.y) {
            Some(x) => x,
            None => return 0,
        };
        if x > p.x {
            if up {
                1
            } else {
                -1
            }
        } else {
            0
        }
    }

    /// x on this y-monotone piece at height y (y is within the span).
    fn x_at(&self, y: f64) -> Option<f64> {
        match &self.prim {
            Primitive::Line(l) => {
                // Interpolate on the WELDED span, not the geometric one:
                // seam-adjusted (and near-horizontal) edges stay finite and
                // exactly continuous with their neighbours.
                let t = (y - self.y0) / (self.y1 - self.y0);
                Some(l.p0.x + (l.p1.x - l.p0.x) * t)
            }
            Primitive::Arc(a) => {
                let s = ((y - a.center.y) / a.r).clamp(-1.0, 1.0);
                let base = s.asin();
                for cand in [base, std::f64::consts::PI - base] {
                    if a.t_of_angle(cand).is_some() {
                        return Some(a.center.x + a.r * cand.cos());
                    }
                }
                // Welding can put y a hair past the arc's geometric range —
                // and near a horizontal tangent a tiny y overshoot is a LARGE
                // angle overshoot, so the candidates miss. The crossing is at
                // the endpoint whose height is nearest.
                let e0 = a.eval(0.0);
                let e1 = a.eval(1.0);
                Some(if (e0.y - y).abs() <= (e1.y - y).abs() {
                    e0.x
                } else {
                    e1.x
                })
            }
            Primitive::Cubic(c) => {
                // Monotone in y: bisect.
                let (mut lo, mut hi) = (0.0f64, 1.0f64);
                let ylo = c.eval(0.0).y;
                let increasing = c.eval(1.0).y > ylo;
                for _ in 0..60 {
                    let mid = 0.5 * (lo + hi);
                    let ym = c.eval(mid).y;
                    if (ym < y) == increasing {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                Some(c.eval(0.5 * (lo + hi)).x)
            }
        }
    }
}

/// Convexity for single-contour all-line regions: consistent turn direction.
fn is_convex_polygon(contours: &[Vec<Primitive>]) -> bool {
    if contours.len() != 1 {
        return false;
    }
    let pts: Option<Vec<Vec2>> = contours[0]
        .iter()
        .map(|p| match p {
            Primitive::Line(l) => Some(l.p0),
            _ => None,
        })
        .collect();
    let Some(pts) = pts else { return false };
    if pts.len() < 3 {
        return false;
    }
    let n = pts.len();
    let mut sign = 0i32;
    for i in 0..n {
        let a = pts[(i + 1) % n] - pts[i];
        let b = pts[(i + 2) % n] - pts[(i + 1) % n];
        let c = a.cross(b);
        if c.abs() < EPS {
            continue;
        }
        let s = if c > 0.0 { 1 } else { -1 };
        if sign == 0 {
            sign = s;
        } else if s != sign {
            return false;
        }
    }
    true
}
