use occlude_core::synth::custom_lines;
use occlude_core::pipeline::{render, Pen, RenderInput, ShapeRec};
use occlude_core::primitive::{Arc, Primitive};
use occlude_core::region::WindingRule;
use occlude_core::rng::Pcg32;
use occlude_core::vec2::v;
use std::f64::consts::PI;

fn main() {
    let mut rng = Pcg32::new(99);
    let shapes: Vec<ShapeRec> = (0..5000)
        .map(|_| {
            let (x, y, r) = (
                rng.range(0.0, 280.0),
                rng.range(0.0, 200.0),
                rng.range(3.0, 12.0),
            );
            let contours = vec![vec![
                Primitive::Arc(Arc::new(v(x, y), r, 0.0, PI)),
                Primitive::Arc(Arc::new(v(x, y), r, PI, PI)),
            ]];
            let fill = custom_lines(&contours, 1.0, 45.0);
            ShapeRec {
                contours,
                closed: true,
                convex: true,
                winding: WindingRule::NonZero,
                stroke: Some(0),
                fill: Some((0, fill)),
                z: 0.0,
                bridge_mm: 0.0,
                clips: vec![],
                modifiers: Vec::new(),
            }
        })
        .collect();
    let input = RenderInput {
        shapes,
        clips: vec![],
        pens: vec![Pen::default()],
        paper: None,
        seed: 1,
        coarsen: 1.0,
        debug_ghost: false, fields: Vec::new(), field_uses: Vec::new(),
    };
    for _ in 0..5 {
        let t = std::time::Instant::now();
        let out = render(&input);
        eprintln!(
            "render: {:?} frags={} fills={}",
            t.elapsed(),
            out.stats.fragments,
            out.stats.fill_prims
        );
    }
}
