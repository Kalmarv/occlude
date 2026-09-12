//! Replay the user's recursive contour scene at every hundredth-mm nib width.
//! cargo run --release --no-default-features --example contour_widths -- <dump> [hundredths]
use occlude_core::{fill::FillKind, pipeline::prepare, scene::dump};
use std::{path::Path, time::Instant};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let scene = dump::load(Path::new(&args[1])).unwrap();
    let widths: Vec<u32> = args
        .get(2)
        .map(|s| vec![s.parse().unwrap()])
        .unwrap_or_else(|| (1..=100).collect());
    for n in widths {
        let width = n as f64 / 100.0;
        let mut input = scene.input.clone();
        for pen in &mut input.pens {
            pen.width = width;
        }
        for shape in &mut input.shapes {
            if let Some((_, FillKind::Contour { spacing, .. })) = &mut shape.fill {
                *spacing = width * 0.9;
            }
        }
        let start = Instant::now();
        let result = prepare(input).try_finish(scene.supplied.clone());
        println!(
            "{}",
            match result {
                Ok(r) =>
                    serde_json::json!({"width":width,"ms":start.elapsed().as_secs_f64()*1000.0,"fragments":r.frags.len(),"fillPrimitives":r.stats.fill_prims,"fallbacks":r.stats.contour.fallbacks,"fallbackThin":r.stats.contour.fallback_thin,"fallbackBudget":r.stats.contour.fallback_budget,"fallbackUnstable":r.stats.contour.fallback_unstable,"contours":r.stats.contour.contours,"cleanup":r.stats.contour.residual_patches}),
                Err(e) =>
                    serde_json::json!({"width":width,"ms":start.elapsed().as_secs_f64()*1000.0,"error":e}),
            }
        );
        for (name, elapsed) in occlude_core::profile::take() {
            eprintln!("{name}: {:.3} ms", elapsed.as_secs_f64() * 1000.0);
        }
    }
}
