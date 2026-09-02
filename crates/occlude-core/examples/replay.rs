//! Scene replay: run a REAL dumped scene through the exact serial pipeline
//! with stage timers, instead of the synthetic stress scenes in hotspots.rs.
//! The scene comes from the TS side (`pnpm --filter occlude dump-scene
//! <sketch.ts> <dir>`), so what profiles here is what the studio renders.
//!
//!   cargo run --release --no-default-features --features profile \
//!     --example replay -- <scene-dir> [iterations]
//!
//! Run WITHOUT rayon (`--no-default-features`) so the pipeline is serial —
//! the same code path the wasm build executes. Also writes out-prims.f64 /
//! out-frags.f64 next to the scene for byte-identity diffing against a
//! wasm render of the same dump.

use occlude_core::fill::SuppliedFill;
use occlude_core::pipeline::prepare;
use occlude_core::scene::encode_render_output;
use std::fs;
use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = Path::new(args.get(1).map(String::as_str).unwrap_or("scene"));
    let iters: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);

    let dump = occlude_core::scene::dump::load(dir).unwrap_or_else(|e| panic!("load scene: {e}"));
    let input = dump.input;
    println!(
        "scene: {} shapes, {} clips, {} prim rows, seed {}",
        input.shapes.len(),
        input.clips.len(),
        dump.prim_rows,
        dump.seed
    );
    let supplied_all = dump.supplied;
    let make_supplied = || -> Vec<Option<SuppliedFill>> { supplied_all.clone() };
    let filled = supplied_all.iter().filter(|s| s.is_some()).count();
    if filled > 0 {
        println!("fills sidecar: {filled} filled shapes supplied");
    }

    let mut zones: HashMap<&'static str, Duration> = HashMap::new();
    let mut total = Duration::ZERO;
    let mut last = None;
    for _ in 0..iters {
        occlude_core::profile::take();
        let t0 = Instant::now();
        let out = prepare(input.clone()).finish(make_supplied());
        total += t0.elapsed();
        for (name, d) in occlude_core::profile::take() {
            *zones.entry(name).or_default() += d;
        }
        last = Some(out);
    }
    let out = last.unwrap();

    let mut rows: Vec<(&'static str, Duration)> = zones.into_iter().collect();
    rows.sort_by(|a, b| b.1.cmp(&a.1));
    println!("\n{:<28} {:>10} {:>6}", "zone", "ms/iter", "%");
    let denom = total.as_secs_f64().max(1e-9);
    for (name, d) in &rows {
        println!(
            "{:<28} {:>10.1} {:>5.1}%",
            name,
            d.as_secs_f64() * 1000.0 / iters as f64,
            d.as_secs_f64() / denom * 100.0
        );
    }
    println!(
        "\ntotal render: {:.1}ms/iter ({} iterations)",
        total.as_secs_f64() * 1000.0 / iters as f64,
        iters
    );
    println!(
        "stats: frags {} fill_prims {} clean {} culled {}",
        out.stats.fragments,
        out.stats.fill_prims,
        out.stats.clean,
        out.stats.culled_off_paper + out.stats.culled_contained
    );

    // Byte-identity artifacts (little-endian f64, same layout as wasm).
    let enc = encode_render_output(&out);
    let write_f64 = |name: &str, data: &[f64]| {
        let mut bytes = Vec::with_capacity(data.len() * 8);
        for v in data {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        fs::write(dir.join(name), bytes).unwrap();
    };
    write_f64("native-prims.f64", &enc.prims);
    write_f64("native-frags.f64", &enc.frags);
    println!("wrote native-prims.f64 / native-frags.f64 to {}", dir.display());
}
