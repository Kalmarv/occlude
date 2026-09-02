use occlude_core::synth::custom_lines;
use occlude_core::gcode::{export_gcode, MachineProfile};
use occlude_core::pipeline::{render, Pen, RenderInput, ShapeRec};
use occlude_core::primitive::{Arc, Primitive};
use occlude_core::region::WindingRule;
use occlude_core::rng::Pcg32;
use occlude_core::vec2::v;
use std::f64::consts::PI;

fn main() {
    // Dense field tuned to produce ≥50k fragments.
    let mut rng = Pcg32::new(5);
    let shapes: Vec<ShapeRec> = (0..4500)
        .map(|_| {
            let (x, y, r) = (
                rng.range(0.0, 400.0),
                rng.range(0.0, 300.0),
                rng.range(4.0, 10.0),
            );
            let contours = vec![vec![
                Primitive::Arc(Arc::new(v(x, y), r, 0.0, PI)),
                Primitive::Arc(Arc::new(v(x, y), r, PI, PI)),
            ]];
            let fill = custom_lines(&contours, 0.4, 45.0);
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
    let out = render(&input);
    println!("fragments: {}", out.frags.len());
    let t = std::time::Instant::now();
    let jobs = export_gcode(
        &out.frags,
        &[Pen::default()],
        &MachineProfile::default(),
        200_000,
    );
    println!(
        "export: {:?}  ink={:.0}mm travel={:.0}mm",
        t.elapsed(),
        jobs[0].ink_mm,
        jobs[0].travel_mm
    );
}
