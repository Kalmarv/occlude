// Heavy occlusion: a deep stack of opaque discs that all overlap. The shape
// the JS obench harness found superlinear — this one says which stage.
use occlude_core::pipeline::{render, Pen, RenderInput, ShapeRec};
use occlude_core::primitive::{Arc, Primitive};
use occlude_core::region::WindingRule;
use occlude_core::rng::Pcg32;
use occlude_core::synth::custom_lines;
use occlude_core::vec2::v;
use std::f64::consts::PI;

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(400);
    let mut rng = Pcg32::new(4);
    let shapes: Vec<ShapeRec> = (0..n)
        .map(|_| {
            let (x, y) = (rng.range(40.0, 160.0), rng.range(40.0, 160.0));
            let contours = vec![vec![
                Primitive::Arc(Arc::new(v(x, y), 60.0, 0.0, PI)),
                Primitive::Arc(Arc::new(v(x, y), 60.0, PI, PI)),
            ]];
            let fill = custom_lines(&contours, 0.5, 45.0);
            ShapeRec {
                contours, closed: true, convex: true,
                winding: WindingRule::NonZero,
                stroke: Some(0), fill: Some((0, fill)), z: 0.0, bridge_mm: 0.0,
                clips: vec![], modifiers: Vec::new(),
            }
        })
        .collect();
    let input = RenderInput {
        shapes, clips: vec![], pens: vec![Pen::default()], paper: None,
        seed: 1, coarsen: 1.0, debug_ghost: false, fields: Vec::new(), field_uses: Vec::new(),
    };
    let t = std::time::Instant::now();
    let out = render(&input);
    println!("{n} discs: {:?}  fragments: {}", t.elapsed(), out.frags.len());
    let mut zs = occlude_core::profile::take();
    zs.sort_by(|a, b| b.1.cmp(&a.1));
    for (name, d) in zs.iter().take(8) { println!("  {:>20}  {:?}", name, d); }
}
