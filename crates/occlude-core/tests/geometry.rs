use occlude_core::cleanup::{dedupe_seams, spans_to_fragments};
use occlude_core::clip::{clip_spans, fully_hidden};
use occlude_core::fragment::{Frag, Span};
use occlude_core::intersect::*;
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
    spans_to_fragments(0, &subject, &spans, 0.2, 0, 0, &mut frags);
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
    spans_to_fragments(0, &prim, &spans, 0.3, 0, 0, &mut frags);
    assert_eq!(frags.len(), 1);
    assert!((frags[0].t1 - frags[0].t0 - 1.0).abs() < 1e-12);
}

#[test]
fn tiny_visible_tick_deleted() {
    let prim = Primitive::Line(line(0., 0., 100., 0.));
    let spans = vec![
        Span {
            t0: 0.0,
            t1: 0.001,
            visible: true,
        }, // 0.1 mm tick at the end
        Span {
            t0: 0.001,
            t1: 1.0,
            visible: false,
        },
    ];
    let mut frags = Vec::new();
    spans_to_fragments(0, &prim, &spans, 0.3, 0, 0, &mut frags);
    assert!(frags.is_empty(), "{frags:?}");
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
