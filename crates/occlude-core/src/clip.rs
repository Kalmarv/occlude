//! Split/classify: cut a primitive's visible spans against a region and mark
//! what falls inside (occlusion hides it; clip() keeps it).

use crate::fragment::Span;
use crate::primitive::Primitive;
use crate::region::Region;

/// Distance below which a classification midpoint counts as "on" the
/// boundary. On-boundary points classify as OUTSIDE the region (spec rule):
/// a stroke lying exactly on an occluder's edge stays visible, and the
/// double-draw is handled by cleanup's seam dedupe.
pub const ON_BOUNDARY_EPS: f64 = 1e-9;

/// Refine the visible spans of `prim` against one region.
/// `keep_inside = false`: occlusion — spans inside the region become hidden.
/// `keep_inside = true`:  clip — spans outside the region become hidden.
pub fn clip_spans(prim: &Primitive, spans: &mut Vec<Span>, region: &Region, keep_inside: bool) {
    let mut out: Vec<Span> = Vec::with_capacity(spans.len() + 4);
    for span in spans.iter() {
        if !span.visible {
            out.push(span.clone());
            continue;
        }
        let piece = prim.sub(span.t0, span.t1);
        let piece_bbox = piece.bbox();
        // Diagonal lines get the exact segment-vs-box test — their own bbox
        // is a large mostly-empty square.
        let clear = match &piece {
            Primitive::Line(l) => !region.bbox.intersects_segment(l.p0, l.p1),
            _ => !piece_bbox.overlaps(&region.bbox),
        };
        if clear {
            // Entirely clear of the region: occlusion keeps it, clip hides it.
            out.push(Span {
                visible: !keep_inside,
                ..span.clone()
            });
            continue;
        }
        let ts = region.crossings(&piece, &piece_bbox);
        let width = span.t1 - span.t0;
        // Even with no intersections we still run the midpoint test —
        // the span may be fully inside, fully outside, or enclose the region.
        for (u0, u1, sub) in piece.split_at(&ts) {
            out.push(Span {
                t0: span.t0 + u0 * width,
                t1: span.t0 + u1 * width,
                visible: classify_sub(region, &sub) == keep_inside,
            });
        }
    }
    *spans = out;
}

/// Inside-ness of one crossing-free sub-span. The midpoint decides — except
/// when it lies ON the boundary, which means one of two things: the span runs
/// along the boundary (classify outside — the spec rule, so an edge-riding
/// stroke stays visible), or a point-tangency the root finder missed (an
/// epsilon-negative discriminant yields no crossing, and the untouched span's
/// midpoint IS the grazing point — found in the wild as grid dots tangent to
/// an isolines border run losing a whole half-circle under clip()). Probing
/// off-centre distinguishes them: the first off-boundary sample decides; all
/// samples on the boundary means the span genuinely rides it.
fn classify_sub(region: &Region, sub: &Primitive) -> bool {
    let mid = sub.eval(0.5);
    if !region.on_boundary(mid, ON_BOUNDARY_EPS) {
        return region.inside(mid);
    }
    for t in [0.25, 0.75, 0.125, 0.875] {
        let p = sub.eval(t);
        if !region.on_boundary(p, ON_BOUNDARY_EPS) {
            return region.inside(p);
        }
    }
    false // on = outside
}

/// True once nothing is left visible — the early-out in the clip loop.
pub fn fully_hidden(spans: &[Span]) -> bool {
    spans.iter().all(|s| !s.visible)
}
