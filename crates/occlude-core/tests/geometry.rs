use occlude_core::cleanup::{dedupe_seams, spans_to_fragments};
use occlude_core::clip::{clip_spans, fully_hidden};
use occlude_core::fragment::{Frag, Span};
use occlude_core::intersect::*;
use occlude_core::pipeline::{Pen, RenderInput, ShapeRec};
use occlude_core::poly::{roots_cubic, roots_in_unit};
use occlude_core::primitive::{Arc, Cubic, Line, Primitive};
use occlude_core::region::{Region, WindingRule};
use occlude_core::vec2::v;
use std::f64::consts::{FRAC_PI_2, PI, TAU};

fn line(x0: f64, y0: f64, x1: f64, y1: f64) -> Line {
    Line::new(v(x0, y0), v(x1, y1))
}

fn circle_region(cx: f64, cy: f64, r: f64) -> Region {
    Region::new(
        vec![vec![
            Primitive::Arc(Arc::new(v(cx, cy), r, 0.0, PI)),
            Primitive::Arc(Arc::new(v(cx, cy), r, PI, PI)),
        ]],
        WindingRule::NonZero,
        true,
    )
}

fn square_region(x: f64, y: f64, w: f64, h: f64) -> Region {
    let p = [v(x, y), v(x + w, y), v(x + w, y + h), v(x, y + h)];
    Region::new(
        vec![vec![
            Primitive::Line(Line::new(p[0], p[1])),
            Primitive::Line(Line::new(p[1], p[2])),
            Primitive::Line(Line::new(p[2], p[3])),
            Primitive::Line(Line::new(p[3], p[0])),
        ]],
        WindingRule::NonZero,
        false,
    )
}

// ---------- polynomial roots ----------

#[test]
fn cubic_roots_match_known() {
    // (t-0.2)(t-0.5)(t-0.9) = t³ -1.6t² +0.73t -0.09
    let r = roots_cubic(1.0, -1.6, 0.73, -0.09);
    assert_eq!(r.len(), 3);
    assert!((r[0] - 0.2).abs() < 1e-9);
    assert!((r[1] - 0.5).abs() < 1e-9);
    assert!((r[2] - 0.9).abs() < 1e-9);
}

#[test]
fn cardano_and_bernstein_agree() {
    let polys = [
        [-0.09, 0.73, -1.6, 1.0],
        [0.001, -3.0, 1.0, 2.0],
        [-0.25, 0.0, 1.0, 0.0], // quadratic disguised
        [0.1, -0.9, 2.3, -1.7],
    ];
    for p in polys {
        let a = roots_in_unit(&p);
        let mut b: Vec<f64> = roots_cubic(p[3], p[2], p[1], p[0])
            .into_iter()
            .filter(|&t| (-1e-9..=1.0 + 1e-9).contains(&t))
            .map(|t| t.clamp(0.0, 1.0))
            .collect();
        b.dedup_by(|x, y| (*x - *y).abs() < 1e-7);
        assert_eq!(a.len(), b.len(), "poly {p:?}: {a:?} vs {b:?}");
        for (x, y) in a.iter().zip(b.iter()) {
            assert!((x - y).abs() < 1e-6, "poly {p:?}: {a:?} vs {b:?}");
        }
    }
}

#[test]
fn double_root_tangency_found() {
    // (t-0.5)² (t²+1): tangency at 0.5 for a quartic.
    // (t²-t+0.25)(t²+1) = t⁴ - t³ + 1.25t² - t + 0.25
    let r = roots_in_unit(&[0.25, -1.0, 1.25, -1.0, 1.0]);
    assert_eq!(r.len(), 1, "{r:?}");
    assert!((r[0] - 0.5).abs() < 1e-4);
}

// ---------- line–line ----------

#[test]
fn line_line_crossing() {
    let r = line_line(&line(0., 0., 10., 10.), &line(0., 10., 10., 0.));
    assert_eq!(r.len(), 1);
    assert!((r[0].0 - 0.5).abs() < 1e-12 && (r[0].1 - 0.5).abs() < 1e-12);
}

#[test]
fn line_line_parallel_and_disjoint_colinear() {
    assert!(line_line(&line(0., 0., 10., 0.), &line(0., 1., 10., 1.)).is_empty());
    assert!(line_line(&line(0., 0., 1., 0.), &line(5., 0., 6., 0.)).is_empty());
}

#[test]
fn line_line_colinear_overlap_returns_endpoints() {
    let r = line_line(&line(0., 0., 10., 0.), &line(4., 0., 6., 0.));
    assert_eq!(r.len(), 2);
    assert!((r[0].0 - 0.4).abs() < 1e-12);
    assert!((r[1].0 - 0.6).abs() < 1e-12);
}

#[test]
fn line_through_polygon_vertex_dedupes() {
    // Horizontal line through the apex of a triangle: both edges report the
    // same t on the subject; intersect_boundary must dedupe to one.
    let tri = Region::from_contour(vec![
        Primitive::Line(line(0., 10., 10., 10.)),
        Primitive::Line(line(10., 10., 5., 0.)),
        Primitive::Line(line(5., 0., 0., 10.)),
    ]);
    let subject = Primitive::Line(line(-5., 0., 15., 0.));
    let ts = intersect_boundary(&subject, tri.boundary_slice());
    assert_eq!(ts.len(), 1, "{ts:?}");
    assert!((ts[0] - 0.5).abs() < 1e-9);
}

// ---------- line–arc / arc–arc ----------

#[test]
fn line_arc_secant_and_tangent() {
    let a = Arc::new(v(0., 0.), 5., 0., TAU / 2.0);
    // Horizontal secant through y=3 hits upper semicircle twice.
    let r = line_arc(&line(-10., 3., 10., 3.), &a);
    assert_eq!(r.len(), 2);
    // Exact tangent at the top: one hit (double root deduped by boundary code,
    // here the quadratic returns two ~equal roots).
    let t = line_arc(&line(-10., 5., 10., 5.), &a);
    assert!(!t.is_empty());
    for (tl, _) in &t {
        assert!((line(-10., 5., 10., 5.).eval(*tl).x).abs() < 1e-4);
    }
}

#[test]
fn arc_arc_two_points() {
    let a = Arc::new(v(0., 0.), 5., -PI, TAU);
    let b = Arc::new(v(6., 0.), 5., -PI, TAU);
    let r = arc_arc(&a, &b);
    assert_eq!(r.len(), 2);
    for (ta, _) in r {
        let p = a.eval(ta);
        assert!((p.x - 3.0).abs() < 1e-9);
        assert!((p.y.abs() - 4.0).abs() < 1e-9);
    }
}

#[test]
fn arc_arc_coincident_circle_overlap() {
    let a = Arc::new(v(0., 0.), 5., 0.0, PI); // upper half
    let b = Arc::new(v(0., 0.), 5., FRAC_PI_2 * 0.5, FRAC_PI_2); // 45°..135°
    let r = arc_arc(&a, &b);
    assert_eq!(r.len(), 2, "{r:?}");
    assert!((a.eval(r[0].0).dist(b.eval(0.0))) < 1e-9);
}

// ---------- cubics ----------

#[test]
fn line_cubic_s_curve() {
    // S-curve crossing y=0 three times.
    let c = Cubic::new(v(0., -1.), v(3., 4.), v(7., -4.), v(10., 1.));
    let r = line_cubic(&line(-1., 0., 11., 0.), &c);
    assert_eq!(r.len(), 3, "{r:?}");
    for (_, s) in r {
        assert!(c.eval(s).y.abs() < 1e-9);
    }
}

#[test]
fn arc_cubic_hits() {
    let a = Arc::new(v(5., 0.), 2., -PI, TAU);
    let c = Cubic::new(v(0., 0.), v(3., 3.), v(7., -3.), v(10., 0.));
    let r = arc_cubic(&a, &c);
    assert!(!r.is_empty());
    for (_, s) in &r {
        let p = c.eval(*s);
        assert!((p.dist(v(5., 0.)) - 2.0).abs() < 1e-8, "{p:?}");
    }
}

#[test]
fn cubic_cubic_crossing() {
    let a = Cubic::new(v(0., 0.), v(3., 5.), v(7., 5.), v(10., 0.));
    let b = Cubic::new(v(0., 4.), v(3., -1.), v(7., -1.), v(10., 4.));
    let r = cubic_cubic(&a, &b);
    assert_eq!(r.len(), 2, "{r:?}");
    for (s, t) in r {
        assert!(a.eval(s).dist(b.eval(t)) < 1e-8);
    }
}

#[test]
fn cubic_cubic_identical_returns_empty() {
    let a = Cubic::new(v(0., 0.), v(3., 5.), v(7., 5.), v(10., 0.));
    assert!(cubic_cubic(&a, &a).is_empty());
}

#[test]
fn cubic_cusp_splits_on_normalize() {
    // True cusp: B'(0.5) = 0 in both axes for this symmetric arrangement.
    let c = Cubic::new(v(-1., 0.), v(1., 1.), v(-1., 1.), v(1., 0.));
    assert!(c.deriv(0.5).len() < 1e-12, "test data must be a real cusp");
    let parts = Primitive::Cubic(c).normalized();
    assert!(parts.len() >= 2, "cusp should split, got {}", parts.len());
}

#[test]
fn colinear_cubic_demotes_to_line() {
    let c = Cubic::new(v(0., 0.), v(2., 2.), v(8., 8.), v(10., 10.));
    let parts = Primitive::Cubic(c).normalized();
    assert_eq!(parts.len(), 1);
    assert!(matches!(parts[0], Primitive::Line(_)));
}

// ---------- region / winding ----------

#[test]
fn inside_circle_square_donut() {
    let c = circle_region(0., 0., 5.);
    assert!(c.inside(v(0., 0.)));
    assert!(c.inside(v(4.9, 0.)));
    assert!(!c.inside(v(5.1, 0.)));

    let s = square_region(0., 0., 10., 10.);
    assert!(s.inside(v(5., 5.)));
    assert!(!s.inside(v(-0.1, 5.)));
    assert!(s.convex);

    // Donut: outer CCW circle + inner CW circle (nonzero).
    let donut = Region::new(
        vec![
            vec![
                Primitive::Arc(Arc::new(v(0., 0.), 5., 0.0, PI)),
                Primitive::Arc(Arc::new(v(0., 0.), 5., PI, PI)),
            ],
            vec![
                Primitive::Arc(Arc::new(v(0., 0.), 2., 0.0, -PI)),
                Primitive::Arc(Arc::new(v(0., 0.), 2., -PI, -PI)),
            ],
        ],
        WindingRule::NonZero,
        false,
    );
    assert!(!donut.inside(v(0., 0.)), "hole must be outside");
    assert!(donut.inside(v(3.5, 0.)));
    assert!(!donut.inside(v(6., 0.)));
}

#[test]
fn ray_through_vertex_is_robust() {
    // Diamond: ray from the centre passes exactly through side vertices.
    let d = Region::from_contour(vec![
        Primitive::Line(line(0., -5., 5., 0.)),
        Primitive::Line(line(5., 0., 0., 5.)),
        Primitive::Line(line(0., 5., -5., 0.)),
        Primitive::Line(line(-5., 0., 0., -5.)),
    ]);
    assert!(d.inside(v(0., 0.))); // ray exits exactly through vertex (5,0)
    assert!(!d.inside(v(10., 0.)));
    assert!(!d.inside(v(-10., 0.)));
}

#[test]
fn evenodd_self_intersecting_star() {
    // Pentagram drawn as 5 crossing lines; even-odd leaves the core empty.
    let mut prims = Vec::new();
    let pt = |k: i32| {
        let a = FRAC_PI_2 + k as f64 * 2.0 * TAU / 5.0;
        v(a.cos() * 5.0, a.sin() * 5.0)
    };
    for i in 0..5 {
        prims.push(Primitive::Line(Line::new(pt(i), pt(i + 1))));
    }
    let star_eo = Region::new(vec![prims.clone()], WindingRule::EvenOdd, false);
    let star_nz = Region::new(vec![prims], WindingRule::NonZero, false);
    assert!(!star_eo.inside(v(0., 0.)), "even-odd core is a hole");
    assert!(star_nz.inside(v(0., 0.)), "nonzero core is filled");
    // A point in one of the star's points is inside under both rules.
    let tip = v(0., 4.2);
    assert!(star_eo.inside(tip));
    assert!(star_nz.inside(tip));
}

#[test]
fn on_boundary_detection() {
    let s = square_region(0., 0., 10., 10.);
    assert!(s.on_boundary(v(5., 0.), 1e-9));
    assert!(s.on_boundary(v(0., 3.), 1e-9));
    assert!(!s.on_boundary(v(5., 5.), 1e-9));
    let c = circle_region(0., 0., 5.);
    assert!(c.on_boundary(v(5., 0.), 1e-9));
    assert!(c.on_boundary(v(0., -5.), 1e-9));
}

#[test]
fn containment_tests() {
    let big = circle_region(0., 0., 10.);
    let small = circle_region(2., 0., 3.);
    let out = circle_region(9., 0., 3.);
    assert!(big.contains_region(&small));
    assert!(!big.contains_region(&out));
    assert!(!small.contains_region(&big));
    let sq = square_region(-2.0, -2.0, 4.0, 4.0);
    assert!(big.contains_region(&sq));
}

// ---------- clip / classify ----------

#[test]
fn line_clipped_by_circle_keeps_outside() {
    let subject = Primitive::Line(line(-10., 0., 10., 0.));
    let region = circle_region(0., 0., 5.);
    let mut spans = vec![Span {
        t0: 0.0,
        t1: 1.0,
        visible: true,
    }];
    clip_spans(&subject, &mut spans, &region, false);
    let vis: Vec<&Span> = spans.iter().filter(|s| s.visible).collect();
    assert_eq!(vis.len(), 2);
    // Visible: [-10,-5] and [5,10] → t ranges [0, .25] and [.75, 1].
    assert!((vis[0].t1 - 0.25).abs() < 1e-9);
    assert!((vis[1].t0 - 0.75).abs() < 1e-9);
}

#[test]
fn line_inside_clip_region_keeps_inside() {
    let subject = Primitive::Line(line(-10., 0., 10., 0.));
    let region = circle_region(0., 0., 5.);
    let mut spans = vec![Span {
        t0: 0.0,
        t1: 1.0,
        visible: true,
    }];
    clip_spans(&subject, &mut spans, &region, true);
    let vis: Vec<&Span> = spans.iter().filter(|s| s.visible).collect();
    assert_eq!(vis.len(), 1);
    assert!((vis[0].t0 - 0.25).abs() < 1e-9 && (vis[0].t1 - 0.75).abs() < 1e-9);
}

#[test]
fn fully_covered_line_hidden_without_intersections() {
    let subject = Primitive::Line(line(-1., 0., 1., 0.));
    let region = circle_region(0., 0., 5.);
    let mut spans = vec![Span {
        t0: 0.0,
        t1: 1.0,
        visible: true,
    }];
    clip_spans(&subject, &mut spans, &region, false);
    assert!(fully_hidden(&spans));
}

#[test]
fn tangent_line_draws_through() {
    // Tangent to the circle: tiny/zero pieces must not survive as gaps.
    let subject = Primitive::Line(line(-10., 5., 10., 5.));
    let region = circle_region(0., 0., 5.);
    let mut spans = vec![Span {
        t0: 0.0,
        t1: 1.0,
        visible: true,
    }];
    clip_spans(&subject, &mut spans, &region, false);
    let mut frags = Vec::new();
    spans_to_fragments(0, &subject, &spans, 0.2, 0, 0, &mut frags, &mut Vec::new());
    assert_eq!(frags.len(), 1, "{frags:?}");
    assert!((frags[0].t0 - 0.0).abs() < 1e-9 && (frags[0].t1 - 1.0).abs() < 1e-9);
}

#[test]
fn stroke_on_boundary_stays_visible() {
    // A line lying exactly on the square's edge: "on = outside".
    let subject = Primitive::Line(line(0., 0., 10., 0.));
    let region = square_region(0., 0., 10., 10.);
    let mut spans = vec![Span {
        t0: 0.0,
        t1: 1.0,
        visible: true,
    }];
    clip_spans(&subject, &mut spans, &region, false);
    assert!(spans.iter().any(|s| s.visible), "{spans:?}");
    let total: f64 = spans
        .iter()
        .filter(|s| s.visible)
        .map(|s| s.t1 - s.t0)
        .sum();
    assert!((total - 1.0).abs() < 1e-6);
}

// ---------- cleanup ----------

#[test]
fn tiny_hidden_gap_bridges() {
    let prim = Primitive::Line(line(0., 0., 100., 0.));
    let spans = vec![
        Span {
            t0: 0.0,
            t1: 0.499,
            visible: true,
        },
        Span {
            t0: 0.499,
            t1: 0.501,
            visible: false,
        }, // 0.2 long < 0.3 nib
        Span {
            t0: 0.501,
            t1: 1.0,
            visible: true,
        },
    ];
    let mut frags = Vec::new();
    spans_to_fragments(0, &prim, &spans, 0.3, 0, 0, &mut frags, &mut Vec::new());
    assert_eq!(frags.len(), 1);
    assert!((frags[0].t1 - frags[0].t0 - 1.0).abs() < 1e-12);
}

#[test]
fn sub_nib_runs_become_tap_candidates() {
    // Any visible run below the nib is a tap CANDIDATE — never a line frag,
    // never silently gone at this level. Coverage decides its fate.
    let prim = Primitive::Line(line(0., 0., 0.2, 0.));
    let spans = vec![Span {
        t0: 0.0,
        t1: 1.0,
        visible: true,
    }];
    let mut frags = Vec::new();
    let mut taps = Vec::new();
    spans_to_fragments(0, &prim, &spans, 0.38, 0, 0, &mut frags, &mut taps);
    assert!(frags.is_empty(), "{frags:?}");
    assert_eq!(taps.len(), 1, "{taps:?}");
    assert!(taps[0].dot);
    let p = taps[0].geom.start();
    assert!(
        (p.x - 0.1).abs() < 1e-9 && p.y.abs() < 1e-9,
        "dot at midpoint"
    );
}

#[test]
fn tap_coverage_owed_vs_redundant() {
    // The one rule: a candidate whose ink is already laid down by a kept
    // stroke of the same pen is redundant; an uncovered one is owed a dot.
    let cand = |x: f64, y: f64, pen: u32| {
        let prim = Primitive::Line(line(x, y, x, y));
        occlude_core::cleanup::dot_frag(9, &prim, pen, 0)
    };
    let kept = Frag::whole(0, Primitive::Line(line(0., 0., 10., 0.)), 0, 0);
    let widths = [0.3];

    // Candidate ON the kept stroke's centreline: covered, dropped.
    let mut frags = vec![kept.clone()];
    occlude_core::cleanup::resolve_taps(&mut frags, vec![cand(5.0, 0.0, 0)], &widths);
    assert_eq!(frags.len(), 1, "covered tap must drop: {frags:?}");

    // Candidate outside the ink band (0.15 half-width): owed, taps.
    let mut frags = vec![kept.clone()];
    occlude_core::cleanup::resolve_taps(&mut frags, vec![cand(5.0, 0.4, 0)], &widths);
    assert_eq!(frags.len(), 2, "uncovered tap must land: {frags:?}");
    assert!(frags[1].dot);

    // Different pen never covers (different ink).
    let mut frags = vec![kept.clone()];
    occlude_core::cleanup::resolve_taps(&mut frags, vec![cand(5.0, 0.0, 1)], &[0.3, 0.3]);
    assert_eq!(frags.len(), 2, "other-pen ink must not cover: {frags:?}");

    // Accepted taps join the coverage: a cluster collapses to ONE dot
    // (a vanished circle's two arcs tap once, not twice).
    let mut frags = vec![];
    occlude_core::cleanup::resolve_taps(
        &mut frags,
        vec![cand(50.0, 0.0, 0), cand(50.1, 0.0, 0), cand(53.0, 0.0, 0)],
        &widths,
    );
    assert_eq!(
        frags.len(),
        2,
        "cluster collapses, distant tap survives: {frags:?}"
    );
}

#[test]
fn coincident_seam_deduped() {
    let g = Primitive::Line(line(0., 0., 10., 0.));
    let frags = vec![
        Frag::whole(0, g, 0, 0),
        Frag::whole(1, Primitive::Line(line(10., 0., 0., 0.)), 0, 1), // reversed
    ];
    let out = dedupe_seams(frags, 0.05);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].shape, 0, "earlier shape wins");
}

#[test]
fn rotated_stadium_inside_matches_sdf() {
    // Regression: rotated rounded-rects (stadium: r = h/2) misclassified
    // points because snapped arc/line seam endpoints disagreed by more than
    // the old weld tolerance. Compare inside() against the exact SDF on a
    // dense grid for many rotations.
    use occlude_core::snap::snap_primitive;
    let (hw, hh, r) = (17.6, 7.04, 7.04); // mm-ish stadium like the repro
    for rot_deg in [0.0f64, 13.0, 29.5, 47.0, 61.0, 88.0, 173.0] {
        let a = rot_deg.to_radians();
        let (cos, sin) = (a.cos(), a.sin());
        let rot = |x: f64, y: f64| v(x * cos - y * sin + 100.0, x * sin + y * cos + 100.0);
        // Contour: top edge, right cap (2 arcs + degenerate side), bottom
        // edge, left cap — mirroring the TS rect lowering with radius = h/2.
        let quarter = std::f64::consts::FRAC_PI_2;
        let arc = |cx: f64, cy: f64, start: f64| {
            let c = rot(cx, cy);
            Primitive::Arc(Arc::new(c, r, start + a, quarter))
        };
        let lineseg = |x0: f64, y0: f64, x1: f64, y1: f64| {
            Primitive::Line(Line::new(rot(x0, y0), rot(x1, y1)))
        };
        let contour: Vec<Primitive> = vec![
            lineseg(-hw + r, -hh, hw - r, -hh),
            arc(hw - r, -hh + r, -quarter),
            lineseg(hw, -hh + r, hw, hh - r), // zero length: r == hh
            arc(hw - r, hh - r, 0.0),
            lineseg(hw - r, hh, -hw + r, hh),
            arc(-hw + r, hh - r, quarter),
            lineseg(-hw, hh - r, -hw, -hh + r), // zero length
            arc(-hw + r, -hh + r, std::f64::consts::PI),
        ]
        .iter()
        .map(snap_primitive)
        .collect();
        let region = Region::from_contour(contour);
        let sdf = |px: f64, py: f64| -> f64 {
            // Un-rotate into local space, rounded-box SDF.
            let (dx, dy) = (px - 100.0, py - 100.0);
            let lx = dx * cos + dy * sin;
            let ly = -dx * sin + dy * cos;
            let qx = lx.abs() - (hw - r);
            let qy = ly.abs() - (hh - r);
            (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt() + qx.max(qy).min(0.0) - r
        };
        let mut checked = 0;
        for iy in 0..80 {
            for ix in 0..80 {
                let px = 100.0 - 25.0 + 50.0 * ix as f64 / 79.0;
                let py = 100.0 - 25.0 + 50.0 * iy as f64 / 79.0;
                let d = sdf(px, py);
                if d.abs() < 0.1 {
                    continue; // snap/weld ambiguity band
                }
                checked += 1;
                assert_eq!(
                    region.inside(v(px, py)),
                    d < 0.0,
                    "rot {rot_deg}°: point ({px:.3},{py:.3}) sdf {d:.4} misclassified"
                );
            }
        }
        assert!(checked > 4000);
    }
}

#[test]
fn containment_rejects_near_covers_and_accepts_twins() {
    // Regression: contains_region degenerated to a one-point sample because
    // crossing points always lie on the outer boundary. A rect is NOT
    // contained by its 1°-rotated copy, but IS contained by its exact
    // 180°-rotated twin (identical region).
    use occlude_core::snap::snap_primitive;
    let stadium = |deg: f64| -> Region {
        let a = deg.to_radians();
        let rot = |x: f64, y: f64| v(x * a.cos() - y * a.sin(), x * a.sin() + y * a.cos());
        let quarter = std::f64::consts::FRAC_PI_2;
        let contour: Vec<Primitive> = vec![
            Primitive::Line(Line::new(rot(-1.5, -10.0), rot(1.5, -10.0))),
            Primitive::Arc(Arc::new(rot(1.5, -9.0), 1.0, -quarter + a, quarter)),
            Primitive::Line(Line::new(rot(2.5, -9.0), rot(2.5, 9.0))),
            Primitive::Arc(Arc::new(rot(1.5, 9.0), 1.0, a, quarter)),
            Primitive::Line(Line::new(rot(1.5, 10.0), rot(-1.5, 10.0))),
            Primitive::Arc(Arc::new(rot(-1.5, 9.0), 1.0, quarter + a, quarter)),
            Primitive::Line(Line::new(rot(-2.5, 9.0), rot(-2.5, -9.0))),
            Primitive::Arc(Arc::new(
                rot(-1.5, -9.0),
                1.0,
                std::f64::consts::PI + a,
                quarter,
            )),
        ]
        .iter()
        .map(snap_primitive)
        .collect();
        Region::from_contour(contour)
    };
    let base = stadium(0.0);
    let bbox_rect = Region::from_contour(vec![
        Primitive::Line(line(-2.5, -10., 2.5, -10.)),
        Primitive::Line(line(2.5, -10., 2.5, 10.)),
        Primitive::Line(line(2.5, 10., -2.5, 10.)),
        Primitive::Line(line(-2.5, 10., -2.5, -10.)),
    ]);
    // Near covers must NOT claim containment of the bbox rect or the shape.
    for deg in [1.0, 2.0, 5.0, 17.0, 91.0] {
        let cover = stadium(deg);
        assert!(
            !cover.contains_region(&bbox_rect),
            "{deg}° cover wrongly contains the bbox rect"
        );
        assert!(
            !cover.contains_region(&base),
            "{deg}° cover wrongly contains the base stadium"
        );
    }
    // The exact 180° twin IS the same region: containment holds.
    assert!(stadium(180.0).contains_region(&base));
}

// ---- review regressions (2026-08-26) ----

#[test]
fn roots_cubic_scale_invariant() {
    // Root exactly t = 0.9 for t³ + t − 1.629; scaling every coefficient
    // must not change the answer (the old discriminant tolerance used the
    // raw coefficient magnitude and picked the wrong Cardano branch).
    for k in [1e-18, 1e-9, 1.0, 1e9, 1e20] {
        let r = roots_cubic(k, 0.0, k, -1.629 * k);
        assert_eq!(r.len(), 1, "k={k}: expected one real root, got {r:?}");
        assert!((r[0] - 0.9).abs() < 1e-9, "k={k}: root {} != 0.9", r[0]);
    }
    // Property: random cubics agree with their scaled versions.
    let mut s = 0x9e3779b97f4a7c15u64;
    let mut rnd = || {
        s = s.wrapping_mul(6364136223846793005).wrapping_add(1);
        ((s >> 33) as f64 / (1u64 << 31) as f64) - 1.0
    };
    for _ in 0..500 {
        let (a, b, c, d) = (rnd() + 1.5, rnd(), rnd(), rnd());
        for k in [1e-12, 1e12] {
            let base = roots_cubic(a, b, c, d);
            let scaled = roots_cubic(k * a, k * b, k * c, k * d);
            assert_eq!(base.len(), scaled.len(), "count differs at k={k}");
            for (x, y) in base.iter().zip(scaled.iter()) {
                assert!((x - y).abs() < 1e-6, "root {x} vs {y} at k={k}");
            }
        }
    }
}

#[test]
fn mirrored_s_cubics_are_not_deduped() {
    use occlude_core::primitive::Cubic;
    // Identical endpoints AND identical midpoint, entirely different curves:
    // both must survive as ink.
    let up = Primitive::Cubic(Cubic::new(v(0., 0.), v(0., 20.), v(20., -20.), v(20., 0.)));
    let dn = Primitive::Cubic(Cubic::new(v(0., 0.), v(0., -20.), v(20., 20.), v(20., 0.)));
    let input = RenderInput {
        shapes: vec![
            ShapeRec {
                contours: vec![vec![up]],
                closed: false,
                convex: false,
                winding: WindingRule::NonZero,
                stroke: Some(0),
                fill: None,
                z: 0.0,
                bridge_mm: 0.0,
                clips: vec![],
                modifiers: Vec::new(),
            },
            ShapeRec {
                contours: vec![vec![dn]],
                closed: false,
                convex: false,
                winding: WindingRule::NonZero,
                stroke: Some(0),
                fill: None,
                z: 1.0,
                bridge_mm: 0.0,
                clips: vec![],
                modifiers: Vec::new(),
            },
        ],
        clips: vec![],
        pens: vec![Pen::default()],
        paper: None,
        seed: 1,
        coarsen: 1.0,
        debug_ghost: false,
        fields: Vec::new(),
    };
    let out = occlude_core::pipeline::render(&input);
    assert_eq!(out.frags.len(), 2, "both S-curves must draw");
}

#[test]
fn stipple_zero_min_dist_is_bounded() {
    use occlude_core::fill::stipple_region;
    use occlude_core::primitive::Line;
    use occlude_core::region::Region;
    // A 100×100mm square with min_dist = 0 must complete quickly on a
    // budgeted grid rather than attempting a gigabyte allocation.
    let sq = Region::new(
        vec![vec![
            Primitive::Line(Line::new(v(0., 0.), v(100., 0.))),
            Primitive::Line(Line::new(v(100., 0.), v(100., 100.))),
            Primitive::Line(Line::new(v(100., 100.), v(0., 100.))),
            Primitive::Line(Line::new(v(0., 100.), v(0., 0.))),
        ]],
        WindingRule::NonZero,
        true,
    );
    let pts = stipple_region(&sq, 1.0, 0.0, 7);
    assert!(!pts.is_empty());
    assert!(pts.len() < 5_000_000);
}
