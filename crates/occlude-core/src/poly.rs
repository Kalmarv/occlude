//! Polynomial root finding.
//!
//! Two engines, per the spec:
//! - Cardano + Newton polish for cubics (line–cubic intersections).
//! - Bernstein-basis subdivision (variation-diminishing isolation, then
//!   bisection/Newton refinement) for arbitrary degree ≤ 6 — used for
//!   arc–cubic (degree 6) and as the robust fallback everywhere.
//!
//! All `*_in_unit` functions return roots in [0, 1], sorted, deduped.

/// Solve a·t² + b·t + c = 0 numerically stably. Returns 0–2 real roots
/// (unsorted, unfiltered).
pub fn roots_quadratic(a: f64, b: f64, c: f64) -> Vec<f64> {
    if a.abs() < 1e-14 * (b.abs().max(c.abs()).max(1.0)) {
        if b.abs() < 1e-300 {
            return Vec::new();
        }
        return vec![-c / b];
    }
    let disc = b * b - 4.0 * a * c;
    if disc < 0.0 {
        return Vec::new();
    }
    let sq = disc.sqrt();
    // Numerically stable form: avoid cancellation between -b and sqrt.
    let q = -0.5 * (b + b.signum() * sq);
    let mut out = Vec::with_capacity(2);
    out.push(q / a);
    if q.abs() > 1e-300 {
        out.push(c / q);
    } else {
        out.push(0.0);
    }
    out
}

/// Real roots of a·t³ + b·t² + c·t + d = 0 via Cardano, polished with Newton
/// on the original polynomial.
pub fn roots_cubic(a: f64, b: f64, c: f64, d: f64) -> Vec<f64> {
    let scale = a.abs().max(b.abs()).max(c.abs()).max(d.abs());
    if scale == 0.0 {
        return Vec::new();
    }
    if a.abs() < 1e-12 * scale {
        return roots_quadratic(b, c, d);
    }
    // Normalise to t³ + p2 t² + p1 t + p0.
    let p2 = b / a;
    let p1 = c / a;
    let p0 = d / a;
    // Depressed cubic: t = s - p2/3 → s³ + ps + q.
    let off = p2 / 3.0;
    let p = p1 - p2 * p2 / 3.0;
    let q = 2.0 * p2 * p2 * p2 / 27.0 - p2 * p1 / 3.0 + p0;
    let disc = (q / 2.0) * (q / 2.0) + (p / 3.0) * (p / 3.0) * (p / 3.0);
    // Classification tolerance must be scale-invariant: p and q come from
    // the NORMALISED cubic, so measure disc against its own constituents —
    // comparing against the raw coefficient magnitude picked the wrong
    // Cardano branch when all coefficients were scaled by e.g. 1e20.
    let disc_tol =
        1e-14 * ((q / 2.0) * (q / 2.0) + (p / 3.0).abs().powi(3)).max(f64::MIN_POSITIVE);

    let f = |t: f64| ((a * t + b) * t + c) * t + d;
    let df = |t: f64| (3.0 * a * t + 2.0 * b) * t + c;
    let polish = |t0: f64| {
        let mut t = t0;
        for _ in 0..3 {
            let dv = df(t);
            if dv.abs() < 1e-300 {
                break;
            }
            let step = f(t) / dv;
            if !step.is_finite() {
                break;
            }
            t -= step;
        }
        t
    };

    let mut out = Vec::with_capacity(3);
    if disc > disc_tol {
        // One real root.
        let sq = disc.sqrt();
        let u = (-q / 2.0 + sq).cbrt();
        let vv = (-q / 2.0 - sq).cbrt();
        out.push(polish(u + vv - off));
    } else if disc >= -disc_tol && p.abs() < 1e-9 {
        // Triple-ish root.
        out.push(polish(-off + (-q).cbrt()));
    } else {
        // Three real roots (trigonometric form).
        let m = 2.0 * (-p / 3.0).max(0.0).sqrt();
        let arg = (3.0 * q / (p * m)).clamp(-1.0, 1.0);
        let theta = arg.acos() / 3.0;
        for k in 0..3 {
            let s = m * (theta - 2.0 * std::f64::consts::PI * k as f64 / 3.0).cos();
            out.push(polish(s - off));
        }
    }
    out.retain(|t| t.is_finite());
    out.sort_by(|x, y| x.partial_cmp(y).unwrap());
    out.dedup_by(|x, y| (*x - *y).abs() < 1e-9);
    out
}

/// Roots of a cubic restricted to [0, 1], sorted and deduped.
pub fn roots_cubic_in_unit(a: f64, b: f64, c: f64, d: f64) -> Vec<f64> {
    let mut out: Vec<f64> = roots_cubic(a, b, c, d)
        .into_iter()
        .filter_map(clamp_unit)
        .collect();
    out.sort_by(|x, y| x.partial_cmp(y).unwrap());
    out.dedup_by(|x, y| (*x - *y).abs() < 1e-9);
    out
}

fn clamp_unit(t: f64) -> Option<f64> {
    const TOL: f64 = 1e-9;
    if (-TOL..=1.0 + TOL).contains(&t) {
        Some(t.clamp(0.0, 1.0))
    } else {
        None
    }
}

const MAX_DEGREE: usize = 6;

fn binom(n: usize, k: usize) -> f64 {
    const TABLE: [[f64; 7]; 7] = [
        [1., 0., 0., 0., 0., 0., 0.],
        [1., 1., 0., 0., 0., 0., 0.],
        [1., 2., 1., 0., 0., 0., 0.],
        [1., 3., 3., 1., 0., 0., 0.],
        [1., 4., 6., 4., 1., 0., 0.],
        [1., 5., 10., 10., 5., 1., 0.],
        [1., 6., 15., 20., 15., 6., 1.],
    ];
    TABLE[n][k]
}

/// Convert power-basis coefficients (ascending, p(t) = Σ a_k t^k) to
/// Bernstein coefficients on [0, 1].
fn bernstein_from_power(a: &[f64]) -> Vec<f64> {
    let n = a.len() - 1;
    let mut b = vec![0.0; n + 1];
    for (j, bj) in b.iter_mut().enumerate() {
        let mut s = 0.0;
        for (k, &ak) in a.iter().enumerate().take(j + 1) {
            s += binom(j, k) / binom(n, k) * ak;
        }
        *bj = s;
    }
    b
}

fn sign_variations(b: &[f64], tol: f64) -> usize {
    let mut var = 0;
    let mut last = 0i32;
    for &c in b {
        let s = if c > tol {
            1
        } else if c < -tol {
            -1
        } else {
            0
        };
        if s != 0 {
            if last != 0 && s != last {
                var += 1;
            }
            last = s;
        }
    }
    var
}

/// de Casteljau split of Bernstein coefficients at t = 0.5.
fn split_bernstein(b: &[f64]) -> (Vec<f64>, Vec<f64>) {
    let n = b.len();
    let mut tmp = b.to_vec();
    let mut left = Vec::with_capacity(n);
    let mut right = vec![0.0; n];
    left.push(tmp[0]);
    right[n - 1] = tmp[n - 1];
    for level in 1..n {
        for i in 0..n - level {
            tmp[i] = 0.5 * (tmp[i] + tmp[i + 1]);
        }
        left.push(tmp[0]);
        right[n - 1 - level] = tmp[n - 1 - level];
    }
    (left, right)
}

/// All real roots of the power-basis polynomial `a` (ascending coefficients,
/// degree ≤ 6) inside [0, 1]. Robust to tangencies (double roots) via
/// subdivision with a depth cap. Sorted, deduped.
pub fn roots_in_unit(a: &[f64]) -> Vec<f64> {
    assert!(!a.is_empty() && a.len() <= MAX_DEGREE + 1);
    let scale = a.iter().fold(0.0f64, |m, c| m.max(c.abs()));
    if scale == 0.0 {
        return Vec::new(); // identically zero: caller must handle coincidence
    }
    // Trim negligible leading (highest-degree) coefficients.
    let mut coeffs: Vec<f64> = a.to_vec();
    while coeffs.len() > 1 && coeffs.last().unwrap().abs() < 1e-13 * scale {
        coeffs.pop();
    }
    match coeffs.len() {
        1 => return Vec::new(),
        2 => {
            let t = -coeffs[0] / coeffs[1];
            return clamp_unit(t).into_iter().collect();
        }
        3 => {
            let mut out: Vec<f64> = roots_quadratic(coeffs[2], coeffs[1], coeffs[0])
                .into_iter()
                .filter_map(clamp_unit)
                .collect();
            out.sort_by(|x, y| x.partial_cmp(y).unwrap());
            out.dedup_by(|x, y| (*x - *y).abs() < 1e-9);
            return out;
        }
        _ => {}
    }

    let f = |t: f64| coeffs.iter().rev().fold(0.0, |acc, &c| acc * t + c);
    let df = |t: f64| {
        coeffs
            .iter()
            .enumerate()
            .skip(1)
            .rev()
            .fold(0.0, |acc, (k, &c)| acc * t + k as f64 * c)
    };

    let bern = bernstein_from_power(&coeffs);
    let tol = 1e-14 * scale;
    let mut out = Vec::new();
    let mut stack = vec![(bern, 0.0f64, 1.0f64, 0u32)];
    while let Some((b, t0, t1, depth)) = stack.pop() {
        let vars = sign_variations(&b, tol);
        if vars == 0 {
            continue;
        }
        let width = t1 - t0;
        if vars == 1 {
            // Exactly one root in (t0, t1): bracketed bisection + Newton.
            let (f0, f1) = (f(t0), f(t1));
            if f0 == 0.0 {
                out.push(t0);
                continue;
            }
            if f1 == 0.0 {
                out.push(t1);
                continue;
            }
            if f0.signum() != f1.signum() {
                out.push(refine_bracketed(&f, &df, t0, t1));
                continue;
            }
            // Endpoint signs equal despite one variation: numeric noise near
            // a tangency — fall through to subdivision.
        }
        if width < 1e-12 || depth > 60 {
            // Tangency cluster: accept the midpoint if the value is tiny.
            let tm = 0.5 * (t0 + t1);
            if f(tm).abs() <= 1e-7 * scale {
                out.push(tm);
            }
            continue;
        }
        let (l, r) = split_bernstein(&b);
        let tm = 0.5 * (t0 + t1);
        // A root landing exactly on the split point looks like an endpoint
        // touch to both children (sign variations 0) and would be lost.
        if f(tm).abs() <= 1e-12 * scale {
            out.push(tm);
        }
        stack.push((l, t0, tm, depth + 1));
        stack.push((r, tm, t1, depth + 1));
    }
    out.sort_by(|x, y| x.partial_cmp(y).unwrap());
    out.dedup_by(|x, y| (*x - *y).abs() < 1e-9);
    out
}

fn refine_bracketed(
    f: &impl Fn(f64) -> f64,
    df: &impl Fn(f64) -> f64,
    mut lo: f64,
    mut hi: f64,
) -> f64 {
    let mut flo = f(lo);
    let mut t = 0.5 * (lo + hi);
    for _ in 0..80 {
        if hi - lo < 1e-15 {
            break;
        }
        // Newton step, kept only when it stays in the bracket.
        let dv = df(t);
        let tn = if dv.abs() > 1e-300 {
            t - f(t) / dv
        } else {
            f64::NAN
        };
        t = if tn.is_finite() && tn > lo && tn < hi {
            tn
        } else {
            0.5 * (lo + hi)
        };
        let ft = f(t);
        if ft == 0.0 {
            return t;
        }
        if ft.signum() == flo.signum() {
            lo = t;
            flo = ft;
        } else {
            hi = t;
        }
        t = 0.5 * (lo + hi);
    }
    t
}
