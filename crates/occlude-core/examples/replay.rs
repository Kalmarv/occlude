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
use occlude_core::scene::decode_prims;
use occlude_core::scene::{decode_render_input, encode_render_output};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

fn read_f64(dir: &Path, name: &str) -> Vec<f64> {
    let bytes = fs::read(dir.join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"));
    bytes
        .chunks_exact(8)
        .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

fn read_u32(dir: &Path, name: &str) -> Vec<u32> {
    let bytes = fs::read(dir.join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"));
    bytes
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let dir = Path::new(args.get(1).map(String::as_str).unwrap_or("scene"));
    let iters: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);

    let prims = read_f64(dir, "prims.f64");
    let contours = read_u32(dir, "contours.u32");
    let shapes_u32 = read_u32(dir, "shapes_u32.u32");
    let shapes_f64 = read_f64(dir, "shapes_f64.f64");
    let mods = read_f64(dir, "mods.f64");
    let fields = read_f64(dir, "fields.f64");
    let clip_list = read_u32(dir, "clip_list.u32");
    let clips_u32 = read_u32(dir, "clips_u32.u32");
    let pens_json = fs::read_to_string(dir.join("pens.json")).expect("pens.json");
    let meta: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join("meta.json")).expect("meta.json"))
            .expect("meta.json parse");
    let paper: Vec<f64> = meta["paper"]
        .as_array()
        .expect("paper")
        .iter()
        .map(|v| v.as_f64().unwrap())
        .collect();
    let seed = meta["seed"].as_u64().expect("seed") as u32;
    let coarsen = meta["coarsen"].as_f64().unwrap_or(1.0);

    // Field uses + domain refs (absent in dumps that predate them: an
    // empty table is a valid scene with no engine field uses).
    let field_uses: Vec<f64> = fs::read(dir.join("field_uses.f64"))
        .map(|b| b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().unwrap())).collect())
        .unwrap_or_default();
    let domain_list: Vec<u32> = fs::read(dir.join("domain_list.u32"))
        .map(|b| b.chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().unwrap())).collect())
        .unwrap_or_default();
    let input = decode_render_input(
        &prims, &contours, &shapes_u32, &shapes_f64, &mods, &fields, &field_uses, &domain_list,
        &clip_list, &clips_u32, &pens_json, &paper, seed, coarsen, 0,
    )
    .expect("decode scene");

    println!(
        "scene: {} shapes, {} clips, {} prim rows, seed {}",
        input.shapes.len(),
        input.clips.len(),
        prims.len() / occlude_core::scene::PRIM_STRIDE,
        seed
    );

    // Optional fills sidecar (written by dump-scene after running the JS
    // fill modules): supplied ink for Pending-filled shapes.
    let read_opt_f64 = |name: &str| -> Vec<f64> {
        fs::read(dir.join(name))
            .map(|b| {
                b.chunks_exact(8)
                    .map(|c| f64::from_le_bytes(c.try_into().unwrap()))
                    .collect()
            })
            .unwrap_or_default()
    };
    let read_opt_u32 = |name: &str| -> Vec<u32> {
        fs::read(dir.join(name))
            .map(|b| {
                b.chunks_exact(4)
                    .map(|c| u32::from_le_bytes(c.try_into().unwrap()))
                    .collect()
            })
            .unwrap_or_default()
    };
    let fills_index = read_opt_u32("fills_index.u32");
    let fill_chains = read_opt_u32("fill_chains.u32");
    if !fills_index.is_empty() && !dir.join("fill_chains.u32").exists() {
        panic!("fills sidecar predates fill_chains.u32 (prim-range fills_index) — re-run dump-scene");
    }
    let fill_prims_raw = read_opt_f64("fill_prims.f64");
    let fill_dots_raw = read_opt_f64("fill_dots.f64");
    let fill_prim_table = decode_prims(&fill_prims_raw);
    let n_shapes = input.shapes.len();
    let make_supplied = || -> Vec<Option<SuppliedFill>> {
        let mut supplied: Vec<Option<SuppliedFill>> = vec![None; n_shapes];
        for rec in fills_index.chunks_exact(5) {
            let (si, cs, cc, ds, dc) = (
                rec[0] as usize,
                rec[1] as usize,
                rec[2] as usize,
                rec[3] as usize,
                rec[4] as usize,
            );
            supplied[si] = Some(SuppliedFill {
                chains: (cs..cs + cc)
                    .map(|c| {
                        let (ps, pc) = (fill_chains[c * 2] as usize, fill_chains[c * 2 + 1] as usize);
                        fill_prim_table[ps..ps + pc].to_vec()
                    })
                    .collect(),
                dots: (ds..ds + dc)
                    .map(|d| occlude_core::vec2::v(fill_dots_raw[d * 2], fill_dots_raw[d * 2 + 1]))
                    .collect(),
            });
        }
        supplied
    };
    if !fills_index.is_empty() {
        println!("fills sidecar: {} filled shapes supplied", fills_index.len() / 5);
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
