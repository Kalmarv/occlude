//! Cleanup: the one place tolerance exists, and it is physical — the pen nib.
//!
//! 1. Pieces shorter than the nib: both neighbours visible → bridge (merge
//!    across), both hidden → delete, mixed → delete. The ends of a primitive
//!    count as hidden neighbours.
//! 2. Merge consecutive visible spans of the same origin primitive.
//! 3. Drop coincident duplicate fragments from different shapes (seams drawn
//!    twice because "on boundary = outside" keeps both).

use crate::fragment::{Frag, Span};
use crate::primitive::Primitive;
use std::collections::HashMap;

/// Apply rules 1–2 to one origin primitive's final span partition and emit
/// fragments. `threshold` is the nib width of the pen drawing this primitive.
pub fn spans_to_fragments(
    origin: u32,
    prim: &Primitive,
    spans: &[Span],
    threshold: f64,
    pen: u32,
    shape: u32,
    out: &mut Vec<Frag>,
) {
    if spans.is_empty() {
        return;
    }
    // Parameter-fraction length is exact for lines and arcs (constant-speed
    // parametrisations); cubics need the real sub-curve length.
    let total_len = prim.length();
    let span_len = |t0: f64, t1: f64| -> f64 {
        match prim {
            Primitive::Cubic(c) => Primitive::Cubic(c.sub(t0, t1)).length(),
            _ => (t1 - t0) * total_len,
        }
    };
    // Resolve tiny pieces by the neighbour rule.
    let mut visible: Vec<bool> = spans.iter().map(|s| s.visible).collect();
    let n = spans.len();
    for i in 0..n {
        let len = span_len(spans[i].t0, spans[i].t1);
        if len >= threshold {
            continue;
        }
        let prev = if i > 0 { visible[i - 1] } else { false };
        let next = if i + 1 < n {
            spans[i + 1].visible
        } else {
            false
        };
        visible[i] = prev && next; // bridge iff both neighbours visible
    }
    // Merge consecutive visible spans.
    let mut i = 0;
    while i < n {
        if !visible[i] {
            i += 1;
            continue;
        }
        let start = spans[i].t0;
        let mut end = spans[i].t1;
        while i + 1 < n && visible[i + 1] {
            i += 1;
            end = spans[i].t1;
        }
        i += 1;
        if span_len(start, end) < threshold {
            continue; // merged run still below the nib → a dot, drop it
        }
        out.push(Frag {
            origin,
            t0: start,
            t1: end,
            pen,
            shape,
            dot: false,
            geom: prim.sub(start, end),
        });
    }
}

/// Rule 3: drop later fragments whose geometry coincides with an earlier one
/// (within `threshold`, unordered endpoints). Snapped input makes true shared
/// edges exactly coincident, so quantised endpoint hashing finds them.
pub fn dedupe_seams(frags: Vec<Frag>, threshold: f64) -> Vec<Frag> {
    let q = threshold.max(1e-9);
    let key_of = |f: &Frag| -> (i64, i64, i64, i64) {
        let a = f.geom.start();
        let b = f.geom.end();
        let quant = |v: f64| (v / q).round() as i64;
        let ka = (quant(a.x), quant(a.y));
        let kb = (quant(b.x), quant(b.y));
        if ka <= kb {
            (ka.0, ka.1, kb.0, kb.1)
        } else {
            (kb.0, kb.1, ka.0, ka.1)
        }
    };
    let mut seen: HashMap<(i64, i64, i64, i64), Vec<usize>> = HashMap::new();
    let mut keep = vec![true; frags.len()];
    for (idx, f) in frags.iter().enumerate() {
        if f.dot {
            continue;
        }
        let key = key_of(f);
        let bucket = seen.entry(key).or_default();
        let dup = bucket.iter().any(|&j| {
            let g = &frags[j];
            g.shape != f.shape && coincident(&g.geom, &f.geom, threshold)
        });
        if dup {
            keep[idx] = false;
        } else {
            bucket.push(idx);
        }
    }
    frags
        .into_iter()
        .zip(keep)
        .filter_map(|(f, k)| if k { Some(f) } else { None })
        .collect()
}

/// Same endpoints (either orientation) and same midpoint within tol.
fn coincident(a: &Primitive, b: &Primitive, tol: f64) -> bool {
    let (a0, a1, am) = (a.start(), a.end(), a.eval(0.5));
    let (b0, b1, bm) = (b.start(), b.end(), b.eval(0.5));
    let fwd = a0.dist(b0) <= tol && a1.dist(b1) <= tol;
    let rev = a0.dist(b1) <= tol && a1.dist(b0) <= tol;
    (fwd || rev) && am.dist(bm) <= tol
}
