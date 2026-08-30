//! Cleanup: the one place tolerance exists, and it is physical — the pen nib.
//!
//! 1. Coalesce at nib resolution: a hidden gap shorter than the nib cannot
//!    be plotted as a gap (the pen bridges it physically), so it is inked.
//!    This is done by run-merging, not per-piece rules: grazing-incidence
//!    occlusion cuts an edge into alternating sub-nib visible/hidden slivers,
//!    and per-piece "mixed neighbours → delete" would erase a zone that a
//!    real pen renders as a solid line. After bridging, a visible run still
//!    shorter than the nib is a dot, and is dropped.
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
    let n = spans.len();
    // A hidden span is bridgeable when it is too short to plot as a gap.
    let bridgeable = |s: &Span| !s.visible && span_len(s.t0, s.t1) < threshold;

    // Build maximal runs that start and end on a VISIBLE span and cross only
    // visible spans or bridgeable hidden gaps. Order-independent by
    // construction: membership depends only on the original span states.
    let mut i = 0;
    while i < n {
        if !spans[i].visible {
            i += 1;
            continue;
        }
        let start = spans[i].t0;
        let mut end = spans[i].t1;
        let mut j = i;
        // Extend: consume [bridgeable gaps]* followed by a visible span.
        loop {
            let mut k = j + 1;
            while k < n && bridgeable(&spans[k]) {
                k += 1;
            }
            if k < n && spans[k].visible {
                end = spans[k].t1;
                j = k;
            } else {
                break;
            }
        }
        i = j + 1;
        if span_len(start, end) < threshold {
            continue; // whole run below the nib → a dot, drop it
        }
        out.push(Frag {
            origin,
            t0: start,
            t1: end,
            pen,
            shape,
            dot: false,
            bridge: false,
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
    let (a0, a1) = (a.start(), a.end());
    let (b0, b1) = (b.start(), b.end());
    let fwd = a0.dist(b0) <= tol && a1.dist(b1) <= tol;
    let rev = a0.dist(b1) <= tol && a1.dist(b0) <= tol;
    if !fwd && !rev {
        return false;
    }
    // Interior samples under the matching orientation: endpoints plus one
    // midpoint cannot distinguish mirrored S-cubics (identical ends AND
    // midpoint, entirely different curves). Reversal is an exact 1−t
    // reparameterisation for every primitive kind, so u = 1−t is valid.
    let same = |t: f64, u: f64| a.eval(t).dist(b.eval(u)) <= tol;
    (fwd && same(0.25, 0.25) && same(0.5, 0.5) && same(0.75, 0.75))
        || (rev && same(0.25, 0.75) && same(0.5, 0.5) && same(0.75, 0.25))
}
