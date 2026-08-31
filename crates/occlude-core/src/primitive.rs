//! The three primitive curve types. Everything the system draws or clips is a
//! Line, an Arc, or a Cubic — circles are two arcs, ellipses/quads lower to
//! cubics, polygons lower to lines. All primitives are parametrised on
//! t ∈ [0, 1] so a fragment is always "primitive + [t0, t1]".

use crate::bbox::BBox;
use crate::poly::roots_quadratic;
use crate::vec2::{v, Vec2};

pub const EPS: f64 = 1e-9;
/// Parameter-space epsilon used to dedupe intersection roots (vertex hits
/// produce a double root).
pub const T_EPS: f64 = 1e-9;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Line {
    pub p0: Vec2,
    pub p1: Vec2,
}

/// Circular arc: point(t) = center + r · (cos, sin)(start + t · sweep).
/// `sweep` is signed; |sweep| ≤ 2π. A full circle is stored as two π arcs so
/// no arc ever wraps.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Arc {
    pub center: Vec2,
    pub r: f64,
    pub start: f64,
    pub sweep: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Cubic {
    pub p0: Vec2,
    pub c0: Vec2,
    pub c1: Vec2,
    pub p1: Vec2,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Primitive {
    Line(Line),
    Arc(Arc),
    Cubic(Cubic),
}

impl Line {
    pub fn new(p0: Vec2, p1: Vec2) -> Line {
        Line { p0, p1 }
    }

    pub fn eval(&self, t: f64) -> Vec2 {
        self.p0.lerp(self.p1, t)
    }

    pub fn dir(&self) -> Vec2 {
        self.p1 - self.p0
    }

    pub fn length(&self) -> f64 {
        self.dir().len()
    }

    pub fn sub(&self, t0: f64, t1: f64) -> Line {
        Line {
            p0: self.eval(t0),
            p1: self.eval(t1),
        }
    }

    pub fn bbox(&self) -> BBox {
        BBox::from_points(&[self.p0, self.p1])
    }
}

impl Arc {
    pub fn new(center: Vec2, r: f64, start: f64, sweep: f64) -> Arc {
        Arc {
            center,
            r,
            start,
            sweep,
        }
    }

    pub fn angle_at(&self, t: f64) -> f64 {
        self.start + t * self.sweep
    }

    pub fn eval(&self, t: f64) -> Vec2 {
        self.center + Vec2::from_angle(self.angle_at(t)) * self.r
    }

    pub fn deriv(&self, t: f64) -> Vec2 {
        // d/dt [c + r(cos θ, sin θ)], θ = start + t·sweep
        let a = self.angle_at(t);
        v(-a.sin(), a.cos()) * (self.r * self.sweep)
    }

    pub fn length(&self) -> f64 {
        self.r * self.sweep.abs()
    }

    pub fn sub(&self, t0: f64, t1: f64) -> Arc {
        Arc {
            center: self.center,
            r: self.r,
            start: self.angle_at(t0),
            sweep: (t1 - t0) * self.sweep,
        }
    }

    /// Map a world-space angle to the arc parameter, or None if the angle does
    /// not lie within the swept range (with a small tolerance at the ends).
    pub fn t_of_angle(&self, angle: f64) -> Option<f64> {
        if self.sweep.abs() < EPS {
            return None;
        }
        // Normalise the offset from start into the direction of sweep.
        let tau = std::f64::consts::TAU;
        let mut d = (angle - self.start) % tau;
        if self.sweep > 0.0 {
            if d < 0.0 {
                d += tau;
            }
        } else if d > 0.0 {
            d -= tau;
        }
        let t = d / self.sweep;
        // Angular tolerance scaled to parameter space.
        let t_tol = (1e-9 / self.sweep.abs()).max(T_EPS);
        if t >= -t_tol && t <= 1.0 + t_tol {
            Some(t.clamp(0.0, 1.0))
        } else {
            None
        }
    }

    pub fn bbox(&self) -> BBox {
        let mut b = BBox::from_points(&[self.eval(0.0), self.eval(1.0)]);
        // Axis-extreme angles (k·π/2) inside the swept range extend the box.
        let half_pi = std::f64::consts::FRAC_PI_2;
        let (a0, a1) = (self.start, self.start + self.sweep);
        let (lo, hi) = if a0 <= a1 { (a0, a1) } else { (a1, a0) };
        let k0 = (lo / half_pi).ceil() as i64;
        let k1 = (hi / half_pi).floor() as i64;
        for k in k0..=k1 {
            let a = k as f64 * half_pi;
            b.grow_point(self.center + Vec2::from_angle(a) * self.r);
        }
        b
    }

    /// Parameters (exclusive of 0 and 1) where dy/dt = 0, i.e. horizontal
    /// tangents. Used to cut the arc into y-monotone pieces for ray casting.
    pub fn y_extrema(&self) -> Vec<f64> {
        // dy/dt ∝ cos θ = 0 → θ = π/2 + kπ
        if self.sweep.abs() < EPS {
            return Vec::new();
        }
        let half_pi = std::f64::consts::FRAC_PI_2;
        let pi = std::f64::consts::PI;
        let (a0, a1) = (self.start, self.start + self.sweep);
        let (lo, hi) = if a0 <= a1 { (a0, a1) } else { (a1, a0) };
        let k0 = ((lo - half_pi) / pi).ceil() as i64;
        let k1 = ((hi - half_pi) / pi).floor() as i64;
        let mut out = Vec::new();
        for k in k0..=k1 {
            let a = half_pi + k as f64 * pi;
            let t = (a - self.start) / self.sweep;
            if t > T_EPS && t < 1.0 - T_EPS {
                out.push(t);
            }
        }
        out.sort_by(|a, b| a.partial_cmp(b).unwrap());
        out.dedup_by(|a, b| (*a - *b).abs() < T_EPS);
        out
    }
}

impl Cubic {
    pub fn new(p0: Vec2, c0: Vec2, c1: Vec2, p1: Vec2) -> Cubic {
        Cubic { p0, c0, c1, p1 }
    }

    /// Elevate a quadratic bezier to a cubic (exact).
    pub fn from_quad(p0: Vec2, c: Vec2, p1: Vec2) -> Cubic {
        Cubic {
            p0,
            c0: p0 + (c - p0) * (2.0 / 3.0),
            c1: p1 + (c - p1) * (2.0 / 3.0),
            p1,
        }
    }

    pub fn eval(&self, t: f64) -> Vec2 {
        let mt = 1.0 - t;
        let a = mt * mt * mt;
        let b = 3.0 * mt * mt * t;
        let c = 3.0 * mt * t * t;
        let d = t * t * t;
        self.p0 * a + self.c0 * b + self.c1 * c + self.p1 * d
    }

    pub fn deriv(&self, t: f64) -> Vec2 {
        let mt = 1.0 - t;
        (self.c0 - self.p0) * (3.0 * mt * mt)
            + (self.c1 - self.c0) * (6.0 * mt * t)
            + (self.p1 - self.c1) * (3.0 * t * t)
    }

    /// Power-basis coefficients per axis: p(t) = k0 + k1 t + k2 t² + k3 t³.
    pub fn power_coeffs(&self) -> ([f64; 4], [f64; 4]) {
        let x = [self.p0.x, self.c0.x, self.c1.x, self.p1.x];
        let y = [self.p0.y, self.c0.y, self.c1.y, self.p1.y];
        let conv = |p: [f64; 4]| {
            [
                p[0],
                3.0 * (p[1] - p[0]),
                3.0 * (p[0] - 2.0 * p[1] + p[2]),
                p[3] - p[0] + 3.0 * (p[1] - p[2]),
            ]
        };
        (conv(x), conv(y))
    }

    /// Extract the exact sub-cubic on [t0, t1] via two de Casteljau splits.
    pub fn sub(&self, t0: f64, t1: f64) -> Cubic {
        let (_, right) = self.split(t0);
        if (1.0 - t0).abs() < 1e-15 {
            return Cubic {
                p0: self.p1,
                c0: self.p1,
                c1: self.p1,
                p1: self.p1,
            };
        }
        let u = (t1 - t0) / (1.0 - t0);
        let (left, _) = right.split(u);
        left
    }

    /// de Casteljau split at t into (left, right).
    pub fn split(&self, t: f64) -> (Cubic, Cubic) {
        let ab = self.p0.lerp(self.c0, t);
        let bc = self.c0.lerp(self.c1, t);
        let cd = self.c1.lerp(self.p1, t);
        let abbc = ab.lerp(bc, t);
        let bccd = bc.lerp(cd, t);
        let mid = abbc.lerp(bccd, t);
        (
            Cubic {
                p0: self.p0,
                c0: ab,
                c1: abbc,
                p1: mid,
            },
            Cubic {
                p0: mid,
                c0: bccd,
                c1: cd,
                p1: self.p1,
            },
        )
    }

    /// Arc length via 16-point Gauss–Legendre on |B'(t)|. Plenty for cleanup
    /// thresholds (which compare against a pen nib width).
    pub fn length(&self) -> f64 {
        // 8-point Gauss–Legendre nodes/weights on [-1, 1].
        const X: [f64; 8] = [
            -0.9602898564975363,
            -0.7966664774136267,
            -0.525532409916329,
            -0.1834346424956498,
            0.1834346424956498,
            0.525532409916329,
            0.7966664774136267,
            0.9602898564975363,
        ];
        const W: [f64; 8] = [
            0.1012285362903763,
            0.2223810344533745,
            0.3137066458778873,
            0.362_683_783_378_362,
            0.362_683_783_378_362,
            0.3137066458778873,
            0.2223810344533745,
            0.1012285362903763,
        ];
        let mut sum = 0.0;
        for i in 0..8 {
            let t = 0.5 * (X[i] + 1.0);
            sum += W[i] * self.deriv(t).len();
        }
        sum * 0.5
    }

    pub fn bbox(&self) -> BBox {
        let mut b = BBox::from_points(&[self.p0, self.p1]);
        let (cx, cy) = self.power_coeffs();
        // Extrema where the derivative (quadratic) is zero, per axis.
        for coeffs in [cx, cy] {
            let d = [coeffs[1], 2.0 * coeffs[2], 3.0 * coeffs[3]];
            for t in roots_quadratic(d[2], d[1], d[0]) {
                if t > 0.0 && t < 1.0 {
                    b.grow_point(self.eval(t));
                }
            }
        }
        b
    }

    /// Parameters strictly inside (0, 1) where dy/dt = 0.
    pub fn y_extrema(&self) -> Vec<f64> {
        let (_, cy) = self.power_coeffs();
        let mut out: Vec<f64> = roots_quadratic(3.0 * cy[3], 2.0 * cy[2], cy[1])
            .into_iter()
            .filter(|&t| t > T_EPS && t < 1.0 - T_EPS)
            .collect();
        out.sort_by(|a, b| a.partial_cmp(b).unwrap());
        out.dedup_by(|a, b| (*a - *b).abs() < T_EPS);
        out
    }

    /// True when all four control points are colinear (within eps scaled to
    /// the curve size) — the curve then lies on a straight segment.
    pub fn is_colinear(&self) -> bool {
        let d = self.p1 - self.p0;
        let scale = d
            .len()
            .max((self.c0 - self.p0).len())
            .max((self.c1 - self.p0).len());
        if scale < EPS {
            return true; // fully collapsed
        }
        let tol = scale * 1e-9;
        (d.cross(self.c0 - self.p0)).abs() <= tol * d.len().max(EPS)
            && (d.cross(self.c1 - self.p0)).abs() <= tol * d.len().max(EPS)
    }

    /// Parameters inside (0, 1) where the derivative vanishes in both axes —
    /// cusps or collapsed control points. Root finding assumes regular curves,
    /// so callers split here first.
    pub fn singular_params(&self) -> Vec<f64> {
        let (cx, cy) = self.power_coeffs();
        let rx = roots_quadratic(3.0 * cx[3], 2.0 * cx[2], cx[1]);
        let ry = roots_quadratic(3.0 * cy[3], 2.0 * cy[2], cy[1]);
        let mut out = Vec::new();
        for &tx in &rx {
            for &ty in &ry {
                if (tx - ty).abs() < 1e-7 {
                    let t = 0.5 * (tx + ty);
                    if t > T_EPS && t < 1.0 - T_EPS && self.deriv(t).len() < 1e-6 {
                        out.push(t);
                    }
                }
            }
        }
        out.sort_by(|a, b| a.partial_cmp(b).unwrap());
        out.dedup_by(|a, b| (*a - *b).abs() < 1e-7);
        out
    }
}

impl Primitive {
    pub fn eval(&self, t: f64) -> Vec2 {
        match self {
            Primitive::Line(l) => l.eval(t),
            Primitive::Arc(a) => a.eval(t),
            Primitive::Cubic(c) => c.eval(t),
        }
    }

    pub fn deriv(&self, t: f64) -> Vec2 {
        match self {
            Primitive::Line(l) => l.dir(),
            Primitive::Arc(a) => a.deriv(t),
            Primitive::Cubic(c) => c.deriv(t),
        }
    }

    pub fn start(&self) -> Vec2 {
        self.eval(0.0)
    }

    pub fn end(&self) -> Vec2 {
        self.eval(1.0)
    }

    pub fn length(&self) -> f64 {
        match self {
            Primitive::Line(l) => l.length(),
            Primitive::Arc(a) => a.length(),
            Primitive::Cubic(c) => c.length(),
        }
    }

    /// Exact distance from a point to this primitive (endpoint-clamped).
    /// Lines and arcs are closed-form; cubics use coarse parameter seeding
    /// plus Newton refinement of (B(t)−p)·B′(t) = 0 — no flattening.
    pub fn dist_to(&self, p: Vec2) -> f64 {
        match self {
            Primitive::Line(l) => {
                let d = l.dir();
                let len2 = d.dot(d);
                let t = if len2 > 0.0 {
                    ((p - l.p0).dot(d) / len2).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                l.eval(t).dist(p)
            }
            Primitive::Arc(a) => {
                let rel = p - a.center;
                let end_min = p.dist(a.eval(0.0)).min(p.dist(a.eval(1.0)));
                if rel.len() < 1e-12 {
                    return a.r.min(end_min);
                }
                // Nearest point on the full circle; keep it only if its
                // angle falls inside the arc's swept interval.
                let ang = rel.y.atan2(rel.x);
                let tau = std::f64::consts::TAU;
                let (from, sweep) = if a.sweep >= 0.0 {
                    (a.start, a.sweep)
                } else {
                    (a.start + a.sweep, -a.sweep)
                };
                let delta = ((ang - from) % tau + tau) % tau;
                if delta <= sweep {
                    (rel.len() - a.r).abs().min(end_min)
                } else {
                    end_min
                }
            }
            Primitive::Cubic(c) => {
                let mut best_t = 0.0;
                let mut best = f64::INFINITY;
                for k in 0..=16 {
                    let t = k as f64 / 16.0;
                    let d = c.eval(t).dist2(p);
                    if d < best {
                        best = d;
                        best_t = t;
                    }
                }
                // Newton on g(t) = (B(t)−p)·B′(t); g′ ≈ |B′|² dominates.
                let mut t = best_t;
                for _ in 0..8 {
                    let e = c.eval(t) - p;
                    let d1 = c.deriv(t);
                    let denom = d1.dot(d1);
                    if denom < 1e-18 {
                        break;
                    }
                    let step = e.dot(d1) / denom;
                    t = (t - step).clamp(0.0, 1.0);
                    if step.abs() < 1e-10 {
                        break;
                    }
                }
                c.eval(t).dist(p).min(c.eval(best_t).dist(p))
            }
        }
    }

    pub fn bbox(&self) -> BBox {
        match self {
            Primitive::Line(l) => l.bbox(),
            Primitive::Arc(a) => a.bbox(),
            Primitive::Cubic(c) => c.bbox(),
        }
    }

    /// Exact sub-primitive on [t0, t1] of this primitive's parameter range.
    pub fn sub(&self, t0: f64, t1: f64) -> Primitive {
        match self {
            Primitive::Line(l) => Primitive::Line(l.sub(t0, t1)),
            Primitive::Arc(a) => Primitive::Arc(a.sub(t0, t1)),
            Primitive::Cubic(c) => Primitive::Cubic(c.sub(t0, t1)),
        }
    }

    /// Split at a sorted list of parameters into consecutive pieces, returned
    /// with their [t0, t1] ranges in the original parametrisation.
    pub fn split_at(&self, ts: &[f64]) -> Vec<(f64, f64, Primitive)> {
        let mut cuts: Vec<f64> = Vec::with_capacity(ts.len() + 2);
        cuts.push(0.0);
        for &t in ts {
            if t > T_EPS && t < 1.0 - T_EPS {
                cuts.push(t);
            }
        }
        cuts.push(1.0);
        cuts.sort_by(|a, b| a.partial_cmp(b).unwrap());
        cuts.dedup_by(|a, b| (*a - *b).abs() < T_EPS);
        let mut out = Vec::with_capacity(cuts.len() - 1);
        for w in cuts.windows(2) {
            out.push((w[0], w[1], self.sub(w[0], w[1])));
        }
        out
    }

    /// Parameters inside (0,1) where dy/dt = 0; cutting here yields
    /// y-monotone pieces for robust ray casting.
    pub fn y_extrema(&self) -> Vec<f64> {
        match self {
            Primitive::Line(_) => Vec::new(),
            Primitive::Arc(a) => a.y_extrema(),
            Primitive::Cubic(c) => c.y_extrema(),
        }
    }

    /// Normalise a freshly recorded primitive: split cubics at cusps, demote
    /// colinear/degenerate cubics to lines, drop collapsed primitives.
    pub fn normalized(&self) -> Vec<Primitive> {
        match self {
            Primitive::Cubic(c) => {
                if c.is_colinear() {
                    // The curve lies on the segment through its extreme
                    // points along the chord direction (a backtracking
                    // colinear cubic retraces ink over the same segment,
                    // which draws identically).
                    let dir = {
                        let d = c.p1 - c.p0;
                        if d.len() > EPS {
                            d.normalized()
                        } else {
                            let d2 = c.c1 - c.p0;
                            if d2.len() > EPS {
                                d2.normalized()
                            } else {
                                return Vec::new(); // fully collapsed → dot, dropped
                            }
                        }
                    };
                    let mut lo = (0.0f64, c.p0);
                    let mut hi = (0.0f64, c.p0);
                    // Extrema along dir occur at the same params as axis
                    // extrema after rotation; sampling endpoints + derivative
                    // roots is exact for a colinear cubic.
                    let (cx, cy) = c.power_coeffs();
                    let da = [
                        cx[1] * dir.x + cy[1] * dir.y,
                        2.0 * (cx[2] * dir.x + cy[2] * dir.y),
                        3.0 * (cx[3] * dir.x + cy[3] * dir.y),
                    ];
                    let mut cand = vec![0.0, 1.0];
                    cand.extend(
                        roots_quadratic(da[2], da[1], da[0])
                            .into_iter()
                            .filter(|&t| t > 0.0 && t < 1.0),
                    );
                    for t in cand {
                        let p = c.eval(t);
                        let s = (p - c.p0).dot(dir);
                        if s < lo.0 {
                            lo = (s, p);
                        }
                        if s > hi.0 {
                            hi = (s, p);
                        }
                    }
                    if (hi.0 - lo.0).abs() < EPS {
                        return Vec::new();
                    }
                    return vec![Primitive::Line(Line::new(lo.1, hi.1))];
                }
                let cusps = c.singular_params();
                if cusps.is_empty() {
                    vec![*self]
                } else {
                    self.split_at(&cusps)
                        .into_iter()
                        .map(|(_, _, p)| p)
                        .collect()
                }
            }
            Primitive::Line(l) => {
                if l.length() < EPS {
                    Vec::new()
                } else {
                    vec![*self]
                }
            }
            Primitive::Arc(a) => {
                if a.r < EPS || a.sweep.abs() < EPS {
                    Vec::new()
                } else {
                    vec![*self]
                }
            }
        }
    }

    /// Adaptive flatten to a polyline with max deviation `tol`. Emits points
    /// including start and end.
    pub fn flatten(&self, tol: f64, out: &mut Vec<Vec2>) {
        match self {
            Primitive::Line(l) => {
                out.push(l.p0);
                out.push(l.p1);
            }
            Primitive::Arc(a) => {
                // Chord sagitta s = r(1 - cos(dθ/2)) ≤ tol
                let dtheta = if a.r > tol {
                    2.0 * (1.0 - tol / a.r).acos()
                } else {
                    std::f64::consts::FRAC_PI_2
                };
                let n = ((a.sweep.abs() / dtheta).ceil() as usize).max(1);
                for i in 0..=n {
                    out.push(a.eval(i as f64 / n as f64));
                }
            }
            Primitive::Cubic(c) => {
                out.push(c.p0);
                flatten_cubic(c, tol, 0, out);
                out.push(c.p1);
            }
        }
    }
}

fn flatten_cubic(c: &Cubic, tol: f64, depth: usize, out: &mut Vec<Vec2>) {
    // Flatness: max distance of control points from the chord.
    let d = c.p1 - c.p0;
    let dl = d.len();
    let flat = if dl < EPS {
        (c.c0 - c.p0).len().max((c.c1 - c.p0).len())
    } else {
        let n = d / dl;
        (n.cross(c.c0 - c.p0))
            .abs()
            .max((n.cross(c.c1 - c.p0)).abs())
    };
    if flat <= tol || depth > 24 {
        return;
    }
    let (l, r) = c.split(0.5);
    flatten_cubic(&l, tol, depth + 1, out);
    out.push(l.p1);
    flatten_cubic(&r, tol, depth + 1, out);
}

#[cfg(test)]
mod flatten_tests {
    use super::*;

    #[test]
    fn two_mm_circle_respects_plotter_resolution() {
        let circle = Primitive::Arc(Arc::new(Vec2::ZERO, 1.0, 0.0, std::f64::consts::TAU));
        let mut points = Vec::new();
        circle.flatten(0.025, &mut points);

        assert!(points.len() >= 16, "got only {} points", points.len());
        for pair in points.windows(2) {
            let midpoint = (pair[0] + pair[1]) * 0.5;
            assert!(1.0 - midpoint.len() <= 0.025 + 1e-12);
        }
    }
}
