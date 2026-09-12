//! Native counterpart of bench/contour.mts. One warmup, five measured runs.
//! cargo run --release --no-default-features --features profile --example contour_bench -- <scene-dump> ...
use occlude_core::{
    pipeline::prepare,
    plan::{encode_plan, plan_chains},
    profile,
    scene::dump,
};
use std::{path::Path, time::Instant};
fn summary(mut v: Vec<f64>) -> serde_json::Value {
    v.sort_by(f64::total_cmp);
    serde_json::json!({"median":v[v.len()/2],"tail":v.last()})
}
fn main() {
    let samples = std::env::var("SAMPLES")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(5)
        .max(1);
    for path in std::env::args().skip(1) {
        let dump = dump::load(Path::new(&path)).unwrap();
        let mut render_ms = Vec::new();
        let mut plan_ms = Vec::new();
        let mut stages: std::collections::BTreeMap<&str, Vec<f64>> =
            std::collections::BTreeMap::new();
        let mut primitives = 0;
        let mut runs = 0;
        let mut fallback = 0;
        for i in 0..=samples {
            profile::take();
            let t = Instant::now();
            let result = prepare(dump.input.clone())
                .try_finish(dump.supplied.clone())
                .unwrap();
            let render = t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            let chains = plan_chains(&result.frags, &dump.input.pens, 200_000);
            let buffer = encode_plan(&chains);
            let planning = t.elapsed().as_secs_f64() * 1000.0;
            if i > 0 {
                render_ms.push(render);
                plan_ms.push(planning);
                for (name, duration) in profile::take() {
                    stages
                        .entry(name)
                        .or_default()
                        .push(duration.as_secs_f64() * 1000.0);
                }
            }
            primitives = chains.iter().map(|c| c.prims.len()).sum::<usize>();
            runs = chains.len();
            fallback = result.stats.contour.fallbacks;
            if i==samples {
                let bytes:Vec<u8>=buffer.iter().flat_map(|x|x.to_le_bytes()).collect();
                std::fs::write(Path::new(&path).join("native-plan.f64"),bytes).unwrap();
            }
        }
        let stages: std::collections::BTreeMap<_, _> = stages
            .into_iter()
            .map(|(name, v)| (name, summary(v)))
            .collect();
        println!(
            "{}",
            serde_json::json!({"scene":path,"samples":samples,"warmup":1,"primitives":primitives,"runs":runs,"fallbacks":fallback,"renderMs":summary(render_ms),"planningMs":summary(plan_ms),"stages":stages})
        );
    }
}
