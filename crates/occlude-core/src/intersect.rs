//! Pairwise primitive intersection. Every function returns crossing
//! parameters as (t_on_first, t_on_second), both in [0, 1], unsorted.
//!
//! Dispatch per the spec:
//! - line–line, line–arc, arc–arc: closed form
//! - line–cubic: cubic roots (Cardano + Newton polish)
//! - arc–cubic: degree-6 polynomial (Bernstein subdivision root finder)
//! - cubic–cubic: parameter-interval subdivision + 2D Newton polish, with an
//!   endpoint-projection fallback when the curves are near-coincident (the
//!   subdivision explodes instead of converging)
//!
//! Coincident/overlapping pairs (colinear lines, same-circle arcs) return the
//! projections of the other primitive's endpoints — exactly the split points
//! an occlusion pass needs; midpoint classification then treats "on the
//! boundary" as outside.

use crate::poly::{roots_cubic_in_unit, roots_in_unit, roots_quadratic};
use crate::primitive::{Arc, Cubic, Line, Primitive, EPS};
use crate::vec2::Vec2;

const T_TOL: f64 = 1e-9;

fn unit(t: f64) -> Option<f64> {
    if (-T_TOL..=1.0 + T_TOL).contains(&t) {
        Some(t.clamp(0.0, 1.0))
    } else {
        None
    }
}

pub fn line_line(a: &Line, b: &Line) -> Vec<(f64, f64)> {
    let da = a.dir();
    let db = b.dir();
    let denom = da.cross(db);
    let w = b.p0 - a.p0;
    let scale = da.len() * db.len();
    if denom.abs() <= 1e-12 * scale.max(1e-300) {
        // Parallel. Colinear overlap → project b's endpoints onto a.
        if w.cross(da).abs() > 1e-9 * da.len().max(EPS) {
            return Vec::new();
        }
        let len2 = da.len2();
        if len2 < EPS * EPS {
            return Vec::new();
        }
        let mut out = Vec::new();
        for (bp, tb) in [(b.p0, 0.0), (b.p1, 1.0)] {
            if let Some(t) = unit((bp - a.p0).dot(da) / len2) {
                out.push((t, tb));
            }
        }
        return out;
    }
    let t = w.cross(db) / denom;
    let u = w.cross(da) / denom;
    match (unit(t), unit(u)) {
        (Some(t), Some(u)) => vec![(t, u)],
        _ => Vec::new(),
    }
}

pub fn line_arc(l: &Line, a: &Arc) -> Vec<(f64, f64)> {
    let d = l.dir();
    let m = l.p0 - a.center;
    // |m + t·d|² = r²
    let qa = d.len2();
    if qa < EPS * EPS {
        return Vec::new();
    }
    let qb = 2.0 * m.dot(d);
    let qc = m.len2() - a.r * a.r;
    let mut out = Vec::new();
    for t in roots_quadratic(qa, qb, qc) {
        if let Some(t) = unit(t) {
            let p = l.eval(t);
            if let Some(ta) = a.t_of_angle((p - a.center).angle()) {
                out.push((t, ta));
            }
        }
    }
    out
}

pub fn arc_arc(a: &Arc, b: &Arc) -> Vec<(f64, f64)> {
    let d = b.center - a.center;
    let dist = d.len();
    if dist < 1e-9 && (a.r - b.r).abs() < 1e-9 {
        // Same circle: overlap. Split points are each arc's endpoints seen on
        // the other arc.
        let mut out = Vec::new();
        for (angle, tb) in [(b.start, 0.0), (b.start + b.sweep, 1.0)] {
            if let Some(ta) = a.t_of_angle(angle) {
                out.push((ta, tb));
            }
        }
        return out;
    }
    if dist < EPS {
        return Vec::new(); // concentric, different radii
    }
    // Radical line: distance from a.center along d.
    let along = (dist * dist + a.r * a.r - b.r * b.r) / (2.0 * dist);
    let h2 = a.r * a.r - along * along;
    let tol = 1e-9 * a.r.max(b.r).max(1.0);
    if h2 < -tol {
        return Vec::new();
    }
    let h = h2.max(0.0).sqrt();
    let base = a.center + d * (along / dist);
    let perp = d.perp() * (h / dist);
    let mut pts = vec![base + perp];
    if h > 1e-12 {
        pts.push(base - perp);
    }
    let mut out = Vec::new();
    for p in pts {
        let ta = a.t_of_angle((p - a.center).angle());
        let tb = b.t_of_angle((p - b.center).angle());
        if let (Some(ta), Some(tb)) = (ta, tb) {
            out.push((ta, tb));
        }
    }
    out
}

pub fn line_cubic(l: &Line, c: &Cubic) -> Vec<(f64, f64)> {
    let d = l.dir();
    let len2 = d.len2();
    if len2 < EPS * EPS {
        return Vec::new();
    }
    // Implicit form: n·p - n·p0 = 0 with n ⟂ d.
    let n = d.perp();
    let (cx, cy) = c.power_coeffs();
    let k0 = n.x * cx[0] + n.y * cy[0] - n.dot(l.p0);
    let k1 = n.x * cx[1] + n.y * cy[1];
    let k2 = n.x * cx[2] + n.y * cy[2];
    let k3 = n.x * cx[3] + n.y * cy[3];
    let mut out = Vec::new();
    for s in roots_cubic_in_unit(k3, k2, k1, k0) {
        let p = c.eval(s);
        if let Some(t) = unit((p - l.p0).dot(d) / len2) {
            out.push((t, s));
        }
    }
    out
}

fn poly_mul(a: &[f64], b: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; a.len() + b.len() - 1];
    for (i, &ai) in a.iter().enumerate() {
        for (j, &bj) in b.iter().enumerate() {
            out[i + j] += ai * bj;
        }
    }
    out
}

pub fn arc_cubic(a: &Arc, c: &Cubic) -> Vec<(f64, f64)> {
    // |C(s) - center|² - r² = 0 → degree 6 in s.
    let (mut cx, mut cy) = c.power_coeffs();
    cx[0] -= a.center.x;
    cy[0] -= a.center.y;
    let mut g = poly_mul(&cx, &cx);
    let gy = poly_mul(&cy, &cy);
    for (gi, yi) in g.iter_mut().zip(gy.iter()) {
        *gi += yi;
    }
    g[0] -= a.r * a.r;
    let mut out = Vec::new();
    for s in roots_in_unit(&g) {
        let p = c.eval(s);
        if let Some(ta) = a.t_of_angle((p - a.center).angle()) {
            out.push((ta, s));
        }
    }
    out
}

/// Closest-point parameter of `p` on a cubic (global minimum of distance²,
/// found via the degree-5 derivative polynomial).
pub fn project_point_cubic(p: Vec2, c: &Cubic) -> f64 {
    let (mut cx, mut cy) = c.power_coeffs();
    cx[0] -= p.x;
    cy[0] -= p.y;
    // d/ds (X² + Y²) = 2(X·X' + Y·Y') → degree 5.
    let dx = [cx[1], 2.0 * cx[2], 3.0 * cx[3]];
    let dy = [cy[1], 2.0 * cy[2], 3.0 * cy[3]];
    let mut d = poly_mul(&cx, &dx);
    let dyy = poly_mul(&cy, &dy);
    for (di, yi) in d.iter_mut().zip(dyy.iter()) {
        *di += yi;
    }
    let mut best = (0.0f64, c.eval(0.0).dist2(p));
    let e1 = c.eval(1.0).dist2(p);
    if e1 < best.1 {
        best = (1.0, e1);
    }
    for s in roots_in_unit(&d) {
        let dd = c.eval(s).dist2(p);
        if dd < best.1 {
            best = (s, dd);
        }
    }
    best.0
}

/// Cubic–cubic via parameter-interval subdivision with bbox rejection, then
/// 2D Newton polish. Near-coincident curves make subdivision explode; the
/// fallback then returns endpoint projections as split points.
pub fn cubic_cubic(a: &Cubic, b: &Cubic) -> Vec<(f64, f64)> {
    if a == b {
        return Vec::new(); // identical: caller's "on boundary = outside" rule applies
    }
    const PARAM_TOL: f64 = 2e-6;
    const NODE_BUDGET: usize = 6000;
    let mut candidates: Vec<(f64, f64)> = Vec::new();
    let mut nodes = 0usize;
    let mut stack = vec![(0.0f64, 1.0f64, 0.0f64, 1.0f64)];
    let mut exploded = false;
    while let Some((sa0, sa1, sb0, sb1)) = stack.pop() {
        nodes += 1;
        if nodes > NODE_BUDGET {
            exploded = true;
            break;
        }
        let ca = a.sub(sa0, sa1);
        let cb = b.sub(sb0, sb1);
        let pad = 1e-9;
        if !ca.bbox().expanded(pad).overlaps(&cb.bbox().expanded(pad)) {
            continue;
        }
        let wa = sa1 - sa0;
        let wb = sb1 - sb0;
        if wa < PARAM_TOL && wb < PARAM_TOL {
            candidates.push((0.5 * (sa0 + sa1), 0.5 * (sb0 + sb1)));
            continue;
        }
        // Split the wider interval (or both when comparable).
        if wa >= wb {
            let sm = 0.5 * (sa0 + sa1);
            stack.push((sa0, sm, sb0, sb1));
            stack.push((sm, sa1, sb0, sb1));
        } else {
            let sm = 0.5 * (sb0 + sb1);
            stack.push((sa0, sa1, sb0, sm));
            stack.push((sa0, sa1, sm, sb1));
        }
    }

    if exploded {
        // Near-coincident: return the other curve's endpoints projected onto
        // the subject (and vice versa) as split points.
        let mut out = Vec::new();
        for (p, tb) in [(b.p0, 0.0), (b.p1, 1.0)] {
            let ta = project_point_cubic(p, a);
            if a.eval(ta).dist(p) < 1e-6 {
                out.push((ta, tb));
            }
        }
        for (p, ta) in [(a.p0, 0.0), (a.p1, 1.0)] {
            let tb = project_point_cubic(p, b);
            if b.eval(tb).dist(p) < 1e-6 {
                out.push((ta, tb));
            }
        }
        dedupe_pairs(&mut out);
        return out;
    }

    // Newton polish each candidate on F(s, t) = A(s) - B(t).
    let mut out = Vec::new();
    for (mut s, mut t) in candidates {
        let mut ok = false;
        for _ in 0..24 {
            let f = a.eval(s) - b.eval(t);
            if f.len() < 1e-11 {
                ok = true;
                break;
            }
            let js = a.deriv(s);
            let jt = -b.deriv(t);
            let det = js.x * jt.y - js.y * jt.x;
            if det.abs() < 1e-14 {
                // Tangential: accept if already close enough.
                ok = f.len() < 1e-7;
                break;
            }
            let ds = (f.x * jt.y - f.y * jt.x) / det;
            let dt = (js.x * f.y - js.y * f.x) / det;
            s = (s - ds).clamp(-0.01, 1.01);
            t = (t - dt).clamp(-0.01, 1.01);
        }
        if !ok {
            ok = (a.eval(s) - b.eval(t)).len() < 1e-7;
        }
        if ok {
            if let (Some(s), Some(t)) = (unit(s), unit(t)) {
                out.push((s, t));
            }
        }
    }
    dedupe_pairs(&mut out);
    out
}

fn dedupe_pairs(pairs: &mut Vec<(f64, f64)>) {
    pairs.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap());
    pairs.dedup_by(|x, y| (x.0 - y.0).abs() < 1e-6 && (x.1 - y.1).abs() < 1e-6);
}

/// Dispatch over primitive types. Returns (t_on_a, t_on_b) pairs.
pub fn intersect_pair(a: &Primitive, b: &Primitive) -> Vec<(f64, f64)> {
    use Primitive::*;
    let flip = |v: Vec<(f64, f64)>| v.into_iter().map(|(x, y)| (y, x)).collect();
    match (a, b) {
        (Line(x), Line(y)) => line_line(x, y),
        (Line(x), Arc(y)) => line_arc(x, y),
        (Arc(x), Line(y)) => flip(line_arc(y, x)),
        (Arc(x), Arc(y)) => arc_arc(x, y),
        (Line(x), Cubic(y)) => line_cubic(x, y),
        (Cubic(x), Line(y)) => flip(line_cubic(y, x)),
        (Arc(x), Cubic(y)) => arc_cubic(x, y),
        (Cubic(x), Arc(y)) => flip(arc_cubic(y, x)),
        (Cubic(x), Cubic(y)) => cubic_cubic(x, y),
    }
}

/// Crossing parameters on `subject` against every primitive of a boundary,
/// sorted and deduped (a vertex hit on two adjacent edges produces a double
/// root — one survives).
pub fn intersect_boundary(subject: &Primitive, boundary: &[Primitive]) -> Vec<f64> {
    let sb = subject.bbox().expanded(1e-9);
    let mut ts: Vec<f64> = Vec::new();
    for prim in boundary {
        if !sb.overlaps(&prim.bbox()) {
            continue;
        }
        for (t, _) in intersect_pair(subject, prim) {
            ts.push(t);
        }
    }
    ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    ts.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    ts
}
