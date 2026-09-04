//! Property tests (spec §8): random shapes and occluders.

use occlude_core::synth::custom_lines;
use occlude_core::pipeline::{render, Pen, RenderInput, ShapeRec};
use occlude_core::primitive::{Arc, Cubic, Line, Primitive};
use occlude_core::region::{Region, WindingRule};
use occlude_core::snap::snap_primitive;
use occlude_core::vec2::v;
use proptest::prelude::*;
use std::f64::consts::PI;

fn circle_contour(cx: f64, cy: f64, r: f64) -> Vec<Vec<Primitive>> {
    vec![vec![
        Primitive::Arc(Arc::new(v(cx, cy), r, 0.0, PI)),
        Primitive::Arc(Arc::new(v(cx, cy), r, PI, PI)),
    ]]
    .into_iter()
    .map(|c| c.iter().map(snap_primitive).collect())
    .collect()
}

fn rect_contour(x: f64, y: f64, w: f64, h: f64) -> Vec<Vec<Primitive>> {
    let p = [v(x, y), v(x + w, y), v(x + w, y + h), v(x, y + h)];
    vec![vec![
        Primitive::Line(Line::new(p[0], p[1])),
        Primitive::Line(Line::new(p[1], p[2])),
        Primitive::Line(Line::new(p[2], p[3])),
        Primitive::Line(Line::new(p[3], p[0])),
    ]
    .iter()
    .map(snap_primitive)
    .collect()]
}

#[derive(Debug, Clone)]
enum GenShape {
    Circle {
        x: f64,
        y: f64,
        r: f64,
        filled: bool,
    },
    Rect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        filled: bool,
    },
    Stroke {
        x0: f64,
        y0: f64,
        x1: f64,
        y1: f64,
    },
    Curve {
        pts: [(f64, f64); 4],
    },
}

fn shape_strategy() -> impl Strategy<Value = GenShape> {
    let coord = -50.0..50.0f64;
    let size = 2.0..25.0f64;
    prop_oneof![
        (coord.clone(), coord.clone(), size.clone(), any::<bool>())
            .prop_map(|(x, y, r, filled)| GenShape::Circle { x, y, r, filled }),
        (
            coord.clone(),
            coord.clone(),
            size.clone(),
            size.clone(),
            any::<bool>()
        )
            .prop_map(|(x, y, w, h, filled)| GenShape::Rect { x, y, w, h, filled }),
        (coord.clone(), coord.clone(), coord.clone(), coord.clone())
            .prop_map(|(x0, y0, x1, y1)| GenShape::Stroke { x0, y0, x1, y1 }),
        (
            (coord.clone(), coord.clone()),
            (coord.clone(), coord.clone()),
            (coord.clone(), coord.clone()),
            (coord.clone(), coord.clone()),
        )
            .prop_map(|(a, b, c, d)| GenShape::Curve { pts: [a, b, c, d] }),
    ]
}

fn to_rec(g: &GenShape) -> ShapeRec {
    let (contours, closed, convex, filled) = match g {
        GenShape::Circle { x, y, r, filled } => (circle_contour(*x, *y, *r), true, true, *filled),
        GenShape::Rect { x, y, w, h, filled } => {
            (rect_contour(*x, *y, *w, *h), true, true, *filled)
        }
        GenShape::Stroke { x0, y0, x1, y1 } => (
            vec![vec![snap_primitive(&Primitive::Line(Line::new(
                v(*x0, *y0),
                v(*x1, *y1),
            )))]],
            false,
            false,
            false,
        ),
        GenShape::Curve { pts } => (
            vec![vec![snap_primitive(&Primitive::Cubic(Cubic::new(
                v(pts[0].0, pts[0].1),
                v(pts[1].0, pts[1].1),
                v(pts[2].0, pts[2].1),
                v(pts[3].0, pts[3].1),
            )))]],
            false,
            false,
            false,
        ),
    };
    let fill = if filled && closed {
        Some((
            0,
            custom_lines(&contours, 2.0, 45.0),
        ))
    } else {
        None
    };
    ShapeRec {
        contours,
        closed,
        convex,
        winding: WindingRule::NonZero,
        stroke: Some(0),
        fill,
        z: 0.0,
        bridge_mm: 0.0,
        clips: vec![],
        modifiers: Vec::new(),
    }
}

fn run(shapes: Vec<ShapeRec>) -> occlude_core::pipeline::RenderOutput {
    render(&RenderInput {
        shapes,
        clips: vec![],
        pens: vec![Pen::default()],
        paper: None,
        seed: 7,
        coarsen: 1.0,
        debug_ghost: false, fields: Vec::new(), field_uses: Vec::new(),
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn no_fragment_midpoint_inside_later_opaque(gens in prop::collection::vec(shape_strategy(), 2..8)) {
        let shapes: Vec<ShapeRec> = gens.iter().map(to_rec).collect();
        let out = run(shapes.clone());
        // Rebuild occluder regions with their draw order.
        let occluders: Vec<(usize, Region)> = shapes
            .iter()
            .enumerate()
            .filter(|(_, s)| s.fill.is_some())
            .map(|(i, s)| (i, Region::new(s.contours.clone(), s.winding, s.convex)))
            .collect();
        for f in &out.frags {
            let mid = f.geom.eval(0.5);
            prop_assert!(mid.is_finite(), "NaN midpoint");
            for (oi, region) in &occluders {
                if *oi <= f.shape as usize {
                    continue; // only later shapes occlude
                }
                if region.on_boundary(mid, 1e-6) {
                    continue;
                }
                prop_assert!(
                    !region.inside(mid),
                    "shape {} fragment midpoint {:?} inside later opaque shape {}",
                    f.shape, mid, oi
                );
            }
        }
    }

    /// The nib rule is a property of connected RUNS, not of individual
    /// fragments. Clipping splits a contour into pieces at every crossing, so
    /// a piece can legitimately be microscopic — a rect clipped near its
    /// corner leaves a 0.006 mm sliver contiguous with a 19.4 mm edge, and
    /// the two are one pen stroke. Judging pieces individually is what
    /// `judge_runs` deliberately does NOT do: it made fine-stepped polylines
    /// vanish, every segment sub-nib and demoted to a tap.
    ///
    /// So: rebuild the runs from the output by endpoint adjacency and assert
    /// no RUN is sub-nib. That is what the engine guarantees, and it still
    /// catches the thing worth catching — isolated sub-nib ink surviving
    /// instead of degrading to a tap.
    #[test]
    fn no_run_shorter_than_threshold(gens in prop::collection::vec(shape_strategy(), 2..8)) {
        let shapes: Vec<ShapeRec> = gens.iter().map(to_rec).collect();
        let out = run(shapes);
        let nib = 0.3;
        let live: Vec<usize> = (0..out.frags.len()).filter(|&i| !out.frags[i].dot).collect();
        // Union-find over fragments joined at an endpoint (same shape).
        let mut parent: Vec<usize> = (0..out.frags.len()).collect();
        fn find(parent: &mut Vec<usize>, a: usize) -> usize {
            let mut a = a;
            while parent[a] != a {
                parent[a] = parent[parent[a]];
                a = parent[a];
            }
            a
        }
        // Bucket endpoints so this stays linear-ish; 1e-7 is far below the
        // nib and far above the 1e-9 join tolerance.
        let key = |p: occlude_core::vec2::Vec2| -> (i64, i64) {
            ((p.x * 1e7).round() as i64, (p.y * 1e7).round() as i64)
        };
        let mut buckets: std::collections::HashMap<(i64, i64), Vec<usize>> =
            std::collections::HashMap::new();
        for &i in &live {
            for p in [out.frags[i].geom.start(), out.frags[i].geom.end()] {
                let (kx, ky) = key(p);
                for dx in -1..=1 {
                    for dy in -1..=1 {
                        buckets.entry((kx + dx, ky + dy)).or_default().push(i);
                    }
                }
            }
        }
        for &i in &live {
            for p in [out.frags[i].geom.start(), out.frags[i].geom.end()] {
                for &j in buckets.get(&key(p)).map(|v| v.as_slice()).unwrap_or(&[]) {
                    if j == i || out.frags[j].shape != out.frags[i].shape {
                        continue;
                    }
                    let q = &out.frags[j].geom;
                    if p.dist(q.start()) <= 1e-9 || p.dist(q.end()) <= 1e-9 {
                        let (ra, rb) = (find(&mut parent, i), find(&mut parent, j));
                        if ra != rb {
                            parent[ra] = rb;
                        }
                    }
                }
            }
        }
        let mut total: std::collections::HashMap<usize, f64> = std::collections::HashMap::new();
        for &i in &live {
            let r = find(&mut parent, i);
            *total.entry(r).or_insert(0.0) += out.frags[i].geom.length();
        }
        for (r, len) in &total {
            prop_assert!(
                *len >= nib - 1e-9,
                "connected run (root {}) totals {}, below nib {} — should have degraded to a tap",
                r, len, nib
            );
        }
    }

    #[test]
    fn visible_length_non_increasing_with_occluders(gens in prop::collection::vec(shape_strategy(), 1..5)) {
        // Base scene, then add one occluder on top: total visible length of
        // the base shapes must not grow.
        let base: Vec<ShapeRec> = gens.iter().map(to_rec).collect();
        let n = base.len();
        let out_before = run(base.clone());
        let mut with_occ = base;
        with_occ.push(to_rec(&GenShape::Circle { x: 0.0, y: 0.0, r: 20.0, filled: true }));
        let out_after = run(with_occ);
        let len = |out: &occlude_core::pipeline::RenderOutput| -> f64 {
            out.frags
                .iter()
                .filter(|f| (f.shape as usize) < n && !f.dot)
                .map(|f| f.geom.length())
                .sum()
        };
        let before = len(&out_before);
        let after = len(&out_after);
        prop_assert!(
            after <= before + 1e-6,
            "visible length grew: {before} -> {after}"
        );
    }

    #[test]
    fn order_invariant_when_z_fixed(gens in prop::collection::vec(shape_strategy(), 2..6)) {
        // Distinct z pins the stacking; permuting the input list must not
        // change the drawing.
        let mut shapes: Vec<ShapeRec> = gens.iter().map(to_rec).collect();
        for (i, s) in shapes.iter_mut().enumerate() {
            s.z = i as f64;
        }
        let out1 = run(shapes.clone());
        let mut reversed = shapes;
        reversed.reverse();
        let out2 = run(reversed);
        let signature = |out: &occlude_core::pipeline::RenderOutput| -> Vec<i64> {
            let mut sig: Vec<i64> = out
                .frags
                .iter()
                .filter(|f| !f.dot)
                .map(|f| (f.geom.length() * 1e6).round() as i64)
                .collect();
            sig.sort_unstable();
            sig
        };
        prop_assert_eq!(signature(&out1), signature(&out2));
    }

    #[test]
    fn near_degenerate_never_panics_or_nans(
        x in -1.0..1.0f64,
        eps in 0.0..1e-6f64,
        r in 1e-9..1e-3f64,
    ) {
        // Fuzz-flavoured: collapsed cubics, zero-radius circles, tangent
        // configurations at tiny scale must not panic and must stay finite.
        let shapes = vec![
            ShapeRec {
                contours: vec![vec![Primitive::Cubic(Cubic::new(
                    v(x, 0.0), v(x + eps, eps), v(x - eps, eps), v(x, 0.0),
                ))]],
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
            to_rec(&GenShape::Circle { x, y: 0.0, r, filled: true }),
            to_rec(&GenShape::Circle { x, y: r, r: r * 2.0, filled: true }),
        ];
        let out = run(shapes);
        for f in &out.frags {
            prop_assert!(f.geom.eval(0.0).is_finite());
            prop_assert!(f.geom.eval(0.5).is_finite());
            prop_assert!(f.t0.is_finite() && f.t1.is_finite());
        }
    }
}
