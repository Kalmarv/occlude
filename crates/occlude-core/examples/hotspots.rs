//! Hotspot profiler: renders stress scenes (mirroring the QA corpus) many
//! times with the stage timers enabled and reports where the time goes.
//!
//!   cargo run --release --no-default-features --features profile \
//!     --example hotspots -- [iterations]
//!
//! Run WITHOUT rayon (`--no-default-features`) so the pipeline is serial —
//! the same code path the wasm build executes.

use occlude_core::bbox::BBox;
use occlude_core::fill::FillKind;
use occlude_core::synth::{bbox_of, custom_lines, lattice_dots, render_with};
use occlude_core::fill::SuppliedFill;
use occlude_core::modifier::FieldUse;
use occlude_core::modifier::{FieldGrid, Modifier, Param};
use occlude_core::pipeline::{Pen, RenderInput, ShapeRec};
use occlude_core::primitive::{Arc, Line, Primitive};
use occlude_core::region::WindingRule;
use occlude_core::vec2::v;
use std::collections::HashMap;
use std::f64::consts::PI;
use std::time::{Duration, Instant};

fn lcg(seed: &mut u64) -> f64 {
    *seed = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    ((*seed >> 33) as f64) / (1u64 << 31) as f64
}

fn circle(cx: f64, cy: f64, r: f64) -> Vec<Vec<Primitive>> {
    vec![vec![
        Primitive::Arc(Arc::new(v(cx, cy), r, 0.0, PI)),
        Primitive::Arc(Arc::new(v(cx, cy), r, PI, PI)),
    ]]
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Vec<Vec<Primitive>> {
    vec![vec![
        Primitive::Line(Line::new(v(x, y), v(x + w, y))),
        Primitive::Line(Line::new(v(x + w, y), v(x + w, y + h))),
        Primitive::Line(Line::new(v(x + w, y + h), v(x, y + h))),
        Primitive::Line(Line::new(v(x, y + h), v(x, y + h - h))),
    ]]
}

fn shape(contours: Vec<Vec<Primitive>>, closed: bool, convex: bool) -> ShapeRec {
    ShapeRec {
        contours,
        closed,
        convex,
        winding: WindingRule::NonZero,
        stroke: Some(0),
        fill: None,
        z: 0.0,
        bridge_mm: 0.0,
        clips: vec![],
        modifiers: Vec::new(),
    }
}

fn input(shapes: Vec<ShapeRec>, fields: Vec<FieldGrid>) -> RenderInput {
    let nfields = fields.len();
    let mut shapes = shapes;
    for (i, s) in shapes.iter_mut().enumerate() {
        s.z = i as f64;
    }
    RenderInput {
        shapes,
        clips: vec![],
        pens: vec![Pen::default()],
        paper: Some(BBox::new(v(0.0, 0.0), v(200.0, 200.0))),
        seed: 7,
        coarsen: 1.0,
        debug_ghost: false,
        fields,
        field_uses: (0..nfields).map(|i| FieldUse::direct(i as u32)).collect(),
    }
}

fn hatch_for(sh: &occlude_core::pipeline::ShapeRec, spacing: f64) -> FillKind {
    custom_lines(&sh.contours, spacing, 45.0)
}

/// scale-cull mirror: 1500 concentric opaque circles + 1200 disjoint hatch
/// squares + 100 large overlapping hatch rects.
fn scene_cull() -> RenderInput {
    let mut s = 11u64;
    let mut shapes = Vec::new();
    for k in 0..1500 {
        let mut sh = shape(circle(100.0, 100.0, 60.0 - k as f64 * 0.02), true, true);
        sh.fill = Some((0, FillKind::Mask));
        shapes.push(sh);
    }
    for k in 0..1200 {
        let (i, j) = ((k % 40) as f64, (k / 40) as f64);
        let mut sh = shape(rect(i * 5.0, j * 5.0, 4.0, 4.0), true, true);
        sh.fill = Some((0, hatch_for(&sh, 0.8)));
        shapes.push(sh);
    }
    for _ in 0..100 {
        let (x, y) = (lcg(&mut s) * 160.0, lcg(&mut s) * 160.0);
        let mut sh = shape(rect(x, y, 40.0, 40.0), true, true);
        sh.fill = Some((0, hatch_for(&sh, 1.2)));
        shapes.push(sh);
    }
    input(shapes, vec![])
}

/// comb mirror: 60 long lines chopped by 60 opaque circles + stipple discs.
fn scene_comb() -> (RenderInput, Vec<usize>) {
    let mut s = 23u64;
    let mut shapes = Vec::new();
    for k in 0..60 {
        let y = 2.0 + k as f64 * 3.3;
        shapes.push(shape(
            vec![vec![Primitive::Line(Line::new(v(0.0, y), v(200.0, y)))]],
            false,
            false,
        ));
    }
    for _ in 0..60 {
        let (x, y, r) = (
            20.0 + lcg(&mut s) * 160.0,
            20.0 + lcg(&mut s) * 160.0,
            2.0 + lcg(&mut s) * 6.0,
        );
        let mut sh = shape(circle(x, y, r), true, true);
        sh.fill = Some((0, FillKind::Mask));
        shapes.push(sh);
    }
    let mut fills: Vec<usize> = Vec::new();
    for k in 0..4 {
        let mut sh = shape(circle(50.0 + k as f64 * 30.0, 170.0, 14.0), true, true);
        sh.fill = Some((0, FillKind::Pending));
        fills.push(shapes.len());
        shapes.push(sh);
    }
    (input(shapes, vec![]), fills)
}

/// Ring stack: 120 concentric circles with dash+wobble programs, plus a
/// deform field (rasterised swirl) on a third of them.
fn scene_rings() -> RenderInput {
    // Rasterise a swirl into a FieldGrid pair the way the TS side would.
    let grid = |f: &dyn Fn(f64, f64) -> f64| -> FieldGrid {
        let (w, h, step) = (128usize, 128usize, 200.0 / 127.0);
        let mut samples = Vec::with_capacity(w * h);
        for j in 0..h {
            for i in 0..w {
                samples.push(f(i as f64 * step, j as f64 * step));
            }
        }
        FieldGrid {
            x0: 0.0,
            y0: 0.0,
            dx: step,
            dy: step,
            w,
            h,
            samples,
        }
    };
    let swirl = |x: f64, y: f64| -> (f64, f64) {
        let (dx, dy) = (x - 100.0, y - 100.0);
        let d = dx.hypot(dy).max(1e-9);
        let k = 20.0 * (-d / 50.0).exp() / d;
        (-dy * k, dx * k)
    };
    let fields = vec![grid(&|x, y| swirl(x, y).0), grid(&|x, y| swirl(x, y).1)];

    let mut shapes = Vec::new();
    for k in 0..120 {
        let t = k as f64 / 119.0;
        let mut sh = shape(circle(100.0, 100.0, 30.0 + t * 65.0), true, true);
        sh.modifiers = vec![
            Modifier::Dash {
                len: 1.0 + t * 8.0,
                gap: 0.5 + t * 2.0,
                offset: k as f64,
            },
            Modifier::Wobble {
                amp: Param::Lit(1.5),
                wavelength: 12.0,
            },
        ];
        if k % 3 == 0 {
            sh.modifiers.insert(
                0,
                Modifier::Deform {
                    dx: Param::Field(0),
                    dy: Param::Field(1),
                    detail: 2.0,
                },
            );
        }
        shapes.push(sh);
    }
    input(shapes, fields)
}

/// streams-z mirror: 250 overlapping hatched circles.
fn scene_hatch() -> RenderInput {
    let mut s = 31u64;
    let mut shapes = Vec::new();
    for _ in 0..250 {
        let (x, y, r) = (
            lcg(&mut s) * 200.0,
            lcg(&mut s) * 200.0,
            4.0 + lcg(&mut s) * 14.0,
        );
        let mut sh = shape(circle(x, y, r), true, true);
        sh.fill = Some((0, hatch_for(&sh, 1.4)));
        shapes.push(sh);
    }
    input(shapes, vec![])
}

fn main() {
    let iters: usize = std::env::args()
        .nth(1)
        .and_then(|a| a.parse().ok())
        .unwrap_or(50);
    let scenes: Vec<(&str, RenderInput, Vec<usize>)> = vec![
        ("cull-2800", scene_cull(), Vec::new()),
        {
            let (inp, fills) = scene_comb();
            ("comb", inp, fills)
        },
        ("rings-modifiers", scene_rings(), Vec::new()),
        ("hatch-250", scene_hatch(), Vec::new()),
    ];

    for (name, inp, fills) in &scenes {
        // Synthetic dots for the stippled shapes: benchmark input, not a fill.
        let supply = |job: &occlude_core::pipeline::FillJob| SuppliedFill {
            chains: Vec::new(),
            dots: if fills.contains(&job.shape) {
                lattice_dots(&bbox_of(job.contours), 0.9, job.shape as u64)
            } else {
                Vec::new()
            },
        };
        // Warmup + drain any stale zones.
        for _ in 0..3 {
            let _ = render_with(inp.clone(), supply);
        }
        let _ = occlude_core::profile::take();

        let t0 = Instant::now();
        let mut frags = 0usize;
        for _ in 0..iters {
            frags = render_with(inp.clone(), supply).frags.len();
        }
        let wall = t0.elapsed();

        let mut zones: HashMap<&'static str, Duration> = HashMap::new();
        for (n, d) in occlude_core::profile::take() {
            *zones.entry(n).or_default() += d;
        }
        let mut rows: Vec<_> = zones.into_iter().collect();
        rows.sort_by_key(|r| r.0);
        let total: Duration = rows.iter().map(|r| r.1).sum();

        println!(
            "\n== {name}: {iters} iters, {:.1}ms/render, {frags} frags ==",
            wall.as_secs_f64() * 1000.0 / iters as f64
        );
        for (zone, d) in rows {
            let pct = 100.0 * d.as_secs_f64() / total.as_secs_f64();
            println!(
                "  {zone:<22} {:>8.1}ms {pct:>5.1}%",
                d.as_secs_f64() * 1000.0 / iters as f64
            );
        }
    }
}
