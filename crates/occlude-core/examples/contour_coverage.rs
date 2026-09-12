//! Independent vector diagnostic for a single contour-fill scene dump.
//! Removes finishing modifiers/outlines so intentional deleted ink is not
//! counted as a coverage failure. Targets the ORIGINAL source and paper,
//! never an erosion that silently excludes thin features.
//! cargo run --release --no-default-features --features contour-sdf \
//!   --example contour_coverage -- <dump> [pen-width-mm]
use occlude_core::{
    bbox::BBox,
    clip::clip_spans,
    contour_fill::error_budget,
    fill::FillKind,
    fragment::Span,
    index::SpatialIndex,
    modifier::Stage,
    pipeline::prepare,
    plan::plan_chains,
    primitive::{Line, Primitive},
    region::Region,
    scene::dump,
    vec2::Vec2,
};
use std::{path::Path, time::Instant};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    let width: f64 = args.get(2).map(|s| s.parse().unwrap()).unwrap_or(0.45);
    let mut scene = dump::load(Path::new(&args[1])).unwrap();
    let jobs: Vec<_> = scene
        .input
        .shapes
        .iter()
        .enumerate()
        .filter(|(_, s)| s.fill.is_some())
        .map(|(i, _)| i)
        .collect();
    assert_eq!(
        jobs.len(),
        1,
        "this diagnostic targets one fill without other opaque shapes"
    );
    let source = &scene.input.shapes[jobs[0]];
    assert!(
        source.clips.is_empty(),
        "diagnostic currently supports the drawable-paper clip only"
    );
    assert!(
        scene
            .input
            .shapes
            .iter()
            .all(|s| s.modifiers.iter().all(|m| m.stage() == Stage::Post)),
        "source must already include pre-deformation"
    );
    let region = Region::new(source.contours.clone(), source.winding, source.convex);
    let paper = scene.input.paper.unwrap_or(region.bbox);
    let eps = error_budget(width, width * 0.9).unwrap();
    for s in &mut scene.input.shapes {
        s.stroke = None;
        s.modifiers.clear();
        if let Some((_, FillKind::Contour { spacing, .. })) = &mut s.fill {
            *spacing = width * 0.9;
        }
    }
    for p in &mut scene.input.pens {
        p.width = width;
    }
    let start = Instant::now();
    let result = prepare(scene.input.clone())
        .try_finish(scene.supplied)
        .unwrap();
    let chains = plan_chains(&result.frags, &scene.input.pens, 200_000);
    let generated_ms = start.elapsed().as_secs_f64() * 1000.;
    #[cfg(feature = "profile")]
    for (name, duration) in occlude_core::profile::take() {
        eprintln!("{name}: {:.3} ms", duration.as_secs_f64() * 1000.);
    }

    let ink: Vec<_> = chains.iter().flat_map(|c| c.prims.iter()).collect();
    let boxes: Vec<_> = ink.iter().map(|p| p.bbox()).collect();
    let index = SpatialIndex::build(&boxes);
    let mut hits = Vec::new();
    let mut probes = 0usize;
    let mut maximum = 0.0_f64;
    let mut misses = 0usize;
    let mut worst = Vec2 { x: 0., y: 0. };
    let mut check = |p: Vec2| {
        if !paper.contains_point(p) || !region.inside(p) {
            return;
        }
        probes += 1;
        index.query(&BBox::from_points(&[p]).expanded(width + eps), &mut hits);
        let distance = hits
            .iter()
            .map(|&i| ink[i as usize].dist_to(p))
            .fold(f64::INFINITY, f64::min);
        if distance > maximum {
            maximum = distance;
            worst = p;
        }
        if distance > width / 2. + eps {
            misses += 1;
        }
    };
    let mut spans = Vec::new();
    let mut scratch = Vec::new();
    for contour in &region.contours {
        for boundary in contour {
            for t in [0.13, 0.5, 0.87] {
                let p = boundary.eval(t);
                let tangent = boundary.eval((t + 1e-4).min(1.)) - boundary.eval((t - 1e-4).max(0.));
                let n = tangent.normalized().perp();
                let crossing = Primitive::Line(Line::new(p - n * width, p + n * width));
                spans.clear();
                spans.push(Span {
                    t0: 0.,
                    t1: 1.,
                    visible: true,
                });
                clip_spans(&crossing, &mut spans, &region, true, &mut scratch);
                // Sampling each original visible interval catches a narrow
                // finger/channel even when it is much thinner than the nib.
                for span in spans.iter().filter(|s| s.visible) {
                    for f in [0.001, 0.5, 0.999] {
                        check(crossing.eval(span.t0 + (span.t1 - span.t0) * f));
                    }
                }
            }
        }
    }
    let nx = paper.width().ceil() as usize;
    let ny = paper.height().ceil() as usize;
    for y in 0..ny {
        for x in 0..nx {
            check(Vec2 {
                x: paper.min.x + (x as f64 + 0.123) * paper.width() / nx as f64,
                y: paper.min.y + (y as f64 + 0.456) * paper.height() / ny as f64,
            });
        }
    }
    println!(
        "{}",
        serde_json::json!({
            "width":width,"errorBudgetMm":eps,"probes":probes,"missesBeyondBudget":misses,
            "maxCenterlineDistanceMm":maximum,"maxGapBeyondNibMm":(maximum-width/2.).max(0.),
            "worst":[worst.x,worst.y],"runs":chains.len(),"primitives":ink.len(),
            "generationAndPlanningMs":generated_ms,"diagnosticTotalMs":start.elapsed().as_secs_f64()*1000.,
            "fallbacks":result.stats.contour.fallbacks,"validationSplits":result.stats.contour.validation_splits
        })
    );
    assert!(
        maximum.is_finite() && misses == 0,
        "independent original-area probes found missing ink"
    );
}
