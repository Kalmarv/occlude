// The plan a studio render pays for, at the scale a dense sketch reaches.
use occlude_core::pipeline::{render, Pen, RenderInput, ShapeRec};
use occlude_core::primitive::{Line, Primitive};
use occlude_core::region::WindingRule;
use occlude_core::rng::Pcg32;
use occlude_core::vec2::v;

fn main() {
    let mut rng = Pcg32::new(11);
    // many short open strokes: the fragment count a flow field reaches
    let shapes: Vec<ShapeRec> = (0..60000)
        .map(|_| {
            let (x, y) = (rng.range(0.0, 400.0), rng.range(0.0, 300.0));
            let mut contour = Vec::new();
            let mut p = v(x, y);
            for _ in 0..8 {
                let q = v(p.x + rng.range(-2.0, 2.0), p.y + rng.range(-2.0, 2.0));
                contour.push(Primitive::Line(Line::new(p, q)));
                p = q;
            }
            ShapeRec {
                contours: vec![contour],
                closed: false,
                convex: false,
                winding: WindingRule::NonZero,
                stroke: Some(0),
                fill: None,
                z: 0.0,
                bridge_mm: 0.0,
                clips: vec![],
                modifiers: Vec::new(),
            }
        })
        .collect();
    let input = RenderInput {
        shapes, clips: vec![], pens: vec![Pen::default()], paper: None,
        seed: 1, coarsen: 1.0, debug_ghost: false, fields: Vec::new(), field_uses: Vec::new(),
    };
    let out = render(&input);
    let _ = occlude_core::profile::take();
    println!("fragments: {}", out.frags.len());
    let pens = [Pen::default()];
    let t = std::time::Instant::now();
    let chains = occlude_core::plan::plan_chains(&out.frags, &pens, 200_000);
    let buf = occlude_core::plan::encode_plan(&chains);
    println!("plan: {:?}  chains {}  buffer {} KB", t.elapsed(), chains.len(), buf.len() * 8 / 1024);
    let mut zs = occlude_core::profile::take();
    zs.sort_by(|a, b| b.1.cmp(&a.1));
    for (name, d) in zs { println!("  {:>12}  {:?}", name, d); }
}
