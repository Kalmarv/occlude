//! Reproducible release-native optimization benchmark. No render/timing model.
use occlude_core::{
    gcode::Chain,
    optimize::{optimize, Options},
    primitive::{Line, Primitive},
    vec2::v,
};
use std::time::Instant;
fn main() {
    let source: Vec<_> = (0..120)
        .map(|row| Chain {
            pen: 0,
            dot: false,
            ordered: false,
            prims: (0..299)
                .map(|i| {
                    let point = |j: usize| {
                        let u = j as f64 / 299.0;
                        v(
                            24.0 + 152.0 * u,
                            20.0 + row as f64 * 1.0 + 4.0 * (18.0 * u).sin(),
                        )
                    };
                    Primitive::Line(Line::new(point(i), point(i + 1)))
                })
                .collect(),
        })
        .collect();
    let opts = Options {
        tolerance: 0.02,
        max_segment: 2.0,
        corner_degrees: 30.0,
        gap: 0.0,
        tour_budget: 1_000_000,
    };
    let mut times = Vec::new();
    let mut count = 0;
    for i in 0..12 {
        let start = Instant::now();
        let out = optimize(source.clone(), &[], opts, |_, _| false).unwrap();
        if i >= 2 {
            times.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        count = out.chains.iter().map(|c| c.prims.len()).sum::<usize>();
    }
    times.sort_by(f64::total_cmp);
    println!("{{\"input_primitives\":35880,\"output_primitives\":{count},\"samples\":10,\"median_ms\":{},\"p90_ms\":{}}}",times[5],times[8]);
}
