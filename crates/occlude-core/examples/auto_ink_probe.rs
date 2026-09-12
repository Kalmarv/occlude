//! Design probe only: vector footprint comparisons, not production certification.
//! cargo run --release -p occlude-core --example auto_ink_probe
use i_overlay::{
    core::{fill_rule::FillRule, overlay_rule::OverlayRule},
    float::overlay::FloatOverlay,
};
use std::time::Instant;
type Polygons = Vec<Vec<Vec<[f64; 2]>>>;
fn boolean(a: &Polygons, b: &Polygons, op: OverlayRule) -> Polygons {
    FloatOverlay::<[f64; 2], i64>::from_subj_and_clip(a, b).overlay(op, FillRule::NonZero)
}
fn rect(x: f64, y: f64, w: f64, h: f64) -> Polygons {
    vec![vec![vec![[x, y], [x + w, y], [x + w, y + h], [x, y + h]]]]
}
fn disk(x: f64, y: f64, r: f64) -> Polygons {
    vec![vec![(0..128)
        .map(|i| {
            let a = i as f64 * std::f64::consts::TAU / 128.0;
            [x + r * a.cos(), y + r * a.sin()]
        })
        .collect()]]
}
fn capsule(a: [f64; 2], b: [f64; 2], r: f64) -> Polygons {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = dx.hypot(dy);
    if len == 0.0 {
        return disk(a[0], a[1], r);
    }
    let (nx, ny) = (-dy / len * r, dx / len * r);
    let mut parts = vec![vec![vec![
        [a[0] + nx, a[1] + ny],
        [a[0] - nx, a[1] - ny],
        [b[0] - nx, b[1] - ny],
        [b[0] + nx, b[1] + ny],
    ]]];
    parts.extend(disk(a[0], a[1], r));
    parts.extend(disk(b[0], b[1], r));
    boolean(&parts, &vec![], OverlayRule::Subject)
}
fn area(p: &Polygons) -> f64 {
    p.iter()
        .map(|shape| {
            shape
                .iter()
                .map(|ring| {
                    (0..ring.len())
                        .map(|i| {
                            let a = ring[i];
                            let b = ring[(i + 1) % ring.len()];
                            a[0] * b[1] - a[1] * b[0]
                        })
                        .sum::<f64>()
                        / 2.0
                })
                .sum::<f64>()
                .abs()
        })
        .sum()
}
fn main() {
    for (name, spacing) in [
        ("connector_over_existing_ink", 0.35),
        ("connector_over_blank_gap", 1.0),
    ] {
        let original = boolean(
            &capsule([0., 0.], [10., 0.], 0.2),
            &capsule([0., spacing], [10., spacing], 0.2),
            OverlayRule::Union,
        );
        let candidate = boolean(
            &original,
            &capsule([5., 0.], [5., spacing], 0.2),
            OverlayRule::Union,
        );
        let start = Instant::now();
        let missing = area(&boolean(&original, &candidate, OverlayRule::Difference));
        let added = area(&boolean(&candidate, &original, OverlayRule::Difference));
        assert!(missing < 1e-8);
        if spacing < 0.4 {
            assert!(added < 1e-8)
        } else {
            assert!((added - 0.24).abs() < 1e-8)
        }
        println!("{{\"fixture\":\"{name}\",\"missing_mm2\":{missing},\"added_mm2\":{added},\"comparison_ms\":{}}}",start.elapsed().as_secs_f64()*1000.0);
    }
    // A dense body footprint with a 0.1 mm wide attached finger. Area alone
    // permits deleting the finger even though the local difference is large.
    let body = rect(0., 0., 100., 100.);
    let original = boolean(
        &body,
        &capsule([99., 50.], [110., 50.], 0.05),
        OverlayRule::Union,
    );
    let missing = area(&boolean(&original, &body, OverlayRule::Difference));
    let fraction = missing / area(&original);
    let mut expanded = body.clone();
    for (a, b) in [
        ([0., 0.], [100., 0.]),
        ([100., 0.], [100., 100.]),
        ([100., 100.], [0., 100.]),
        ([0., 100.], [0., 0.]),
    ] {
        expanded.extend(capsule(a, b, 0.1));
    }
    let expanded = boolean(&expanded, &vec![], OverlayRule::Subject);
    let violation = area(&boolean(&original, &expanded, OverlayRule::Difference));
    assert!(fraction < 0.001);
    assert!(violation > 0.9);
    println!("{{\"fixture\":\"lost_attached_finger\",\"missing_mm2\":{missing},\"missing_fraction\":{fraction},\"area_limit_0_1_percent_passes\":true,\"local_limit_0_1_mm_passes\":false,\"violation_mm2\":{violation}}}");
}
