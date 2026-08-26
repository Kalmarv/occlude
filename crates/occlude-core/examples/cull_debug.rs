use occlude_core::fill::FillKind;
use occlude_core::pipeline::{render, Pen, RenderInput, ShapeRec};
use occlude_core::primitive::{Arc, Line, Primitive};
use occlude_core::region::WindingRule;
use occlude_core::snap::snap_primitive;
use occlude_core::vec2::v;
use std::f64::consts::FRAC_PI_2;

fn main() {
    // Mirror the TS lowering of rect(-2.5,-10,5,20,1) rotated i°, A4 square.
    let unit = 1.848;
    let (cx0, cy0) = (105.0, 148.5);
    let shapes: Vec<ShapeRec> = (0..200)
        .map(|i| {
            let a = (i as f64).to_radians();
            let rot = |x: f64, y: f64| {
                v(
                    (x * a.cos() - y * a.sin()) * unit + cx0,
                    (x * a.sin() + y * a.cos()) * unit + cy0,
                )
            };
            let r = 1.0 * unit;
            let arc = |acx: f64, acy: f64, start: f64| {
                Primitive::Arc(Arc::new(rot(acx, acy), r, start + a, FRAC_PI_2))
            };
            let line = |x0: f64, y0: f64, x1: f64, y1: f64| {
                Primitive::Line(Line::new(rot(x0, y0), rot(x1, y1)))
            };
            let contour: Vec<Primitive> = vec![
                line(-1.5, -10.0, 1.5, -10.0),
                arc(1.5, -9.0, -FRAC_PI_2),
                line(2.5, -9.0, 2.5, 9.0),
                arc(1.5, 9.0, 0.0),
                line(1.5, 10.0, -1.5, 10.0),
                arc(-1.5, 9.0, FRAC_PI_2),
                line(-2.5, 9.0, -2.5, -9.0),
                arc(-1.5, -9.0, std::f64::consts::PI),
            ]
            .iter()
            .map(snap_primitive)
            .collect();
            ShapeRec {
                contours: vec![contour],
                closed: true,
                convex: true,
                winding: WindingRule::NonZero,
                stroke: Some(0),
                fill: Some((
                    0,
                    FillKind::Stipple {
                        density: 1.0,
                        min_dist: 0.4,
                    },
                )),
                z: 0.0,
                clips: vec![],
                modifiers: Vec::new(),
            }
        })
        .collect();
    let out = render(&RenderInput {
        shapes,
        clips: vec![],
        pens: vec![Pen::default()],
        paper: None,
        seed: 1,
        coarsen: 1.0,
        fields: Vec::new(),
    });
    eprintln!("culled_contained: {}", out.stats.culled_contained);
}
