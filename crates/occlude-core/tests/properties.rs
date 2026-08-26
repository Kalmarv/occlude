//! Property tests (spec §8): random shapes and occluders.

use occlude_core::fill::{FillKind, HatchPass};
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
    let hatch = FillKind::Hatch(vec![HatchPass {
        angle: 45.0,
        spacing: 2.0,
        offset: 0.0,
    }]);
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
    ShapeRec {
        contours,
        closed,
        convex,
        winding: WindingRule::NonZero,
        stroke: Some(0),
        fill: if filled && closed {
            Some((0, hatch))
        } else {
            None
        },
        z: 0.0,
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
        fields: Vec::new(),
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

    #[test]
    fn no_fragment_shorter_than_threshold(gens in prop::collection::vec(shape_strategy(), 2..8)) {
        let shapes: Vec<ShapeRec> = gens.iter().map(to_rec).collect();
        let out = run(shapes);
        let nib = 0.3;
        for f in &out.frags {
            if f.dot {
                continue;
            }
            prop_assert!(
                f.geom.length() >= nib - 1e-9,
                "fragment of length {} below nib {}",
                f.geom.length(), nib
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
