//! Benchmarks: one synthetic stress sketch per pipeline layer, plus
//! micro-benchmarks per intersection pair and `inside` variant (spec §7).

use criterion::{criterion_group, criterion_main, Criterion};
use occlude_core::fill::{FillKind, HatchPass};
use occlude_core::pipeline::{render, Pen, RenderInput, ShapeRec};
use occlude_core::primitive::{Arc, Cubic, Line, Primitive};
use occlude_core::region::{Region, WindingRule};
use occlude_core::rng::Pcg32;
use occlude_core::vec2::v;
use std::f64::consts::PI;
use std::hint::black_box;

fn circle_contour(cx: f64, cy: f64, r: f64) -> Vec<Vec<Primitive>> {
    vec![vec![
        Primitive::Arc(Arc::new(v(cx, cy), r, 0.0, PI)),
        Primitive::Arc(Arc::new(v(cx, cy), r, PI, PI)),
    ]]
}

fn filled_circle(cx: f64, cy: f64, r: f64) -> ShapeRec {
    ShapeRec {
        contours: circle_contour(cx, cy, r),
        closed: true,
        convex: true,
        winding: WindingRule::NonZero,
        stroke: Some(0),
        fill: Some((
            0,
            FillKind::Hatch(vec![HatchPass {
                angle: 45.0,
                spacing: 1.0,
                offset: 0.0,
                shape_anchor: false,
            }]),
        )),
        z: 0.0,
        bridge_mm: 0.0,
        clips: vec![],
        modifiers: Vec::new(),
    }
}

fn input(shapes: Vec<ShapeRec>) -> RenderInput {
    RenderInput {
        shapes,
        clips: vec![],
        pens: vec![Pen::default()],
        paper: None,
        seed: 1,
        coarsen: 1.0,
        debug_ghost: false, fields: Vec::new(),
    }
}

fn dense_circle_field(n: usize) -> Vec<ShapeRec> {
    let mut rng = Pcg32::new(99);
    (0..n)
        .map(|_| {
            filled_circle(
                rng.range(0.0, 280.0),
                rng.range(0.0, 200.0),
                rng.range(3.0, 12.0),
            )
        })
        .collect()
}

fn bench_render(c: &mut Criterion) {
    let mut g = c.benchmark_group("render");
    g.sample_size(10);

    let field500 = dense_circle_field(500);
    g.bench_function("500_filled_circles_hatch", |b| {
        b.iter(|| black_box(render(&input(field500.clone()))))
    });

    let field5000 = dense_circle_field(5000);
    g.bench_function("5000_filled_circles_hatch", |b| {
        b.iter(|| black_box(render(&input(field5000.clone()))))
    });

    // 200 noisy polylines (2k vertices) over 500 filled shapes.
    let mut shapes = dense_circle_field(500);
    let mut rng = Pcg32::new(7);
    for _ in 0..200 {
        let mut prims = Vec::with_capacity(1999);
        let mut p = v(rng.range(0.0, 280.0), rng.range(0.0, 200.0));
        for _ in 0..1999 {
            let q = p + v(rng.range(-0.4, 0.6), rng.range(-0.5, 0.5));
            prims.push(Primitive::Line(Line::new(p, q)));
            p = q;
        }
        shapes.insert(
            0,
            ShapeRec {
                contours: vec![prims],
                closed: false,
                convex: false,
                winding: WindingRule::NonZero,
                stroke: Some(0),
                fill: None,
                z: -1.0,
                bridge_mm: 0.0,
                clips: vec![],
                modifiers: Vec::new(),
            },
        );
    }
    g.bench_function("200_noisy_polylines_over_500", |b| {
        b.iter(|| black_box(render(&input(shapes.clone()))))
    });
    g.finish();
}

fn bench_micro(c: &mut Criterion) {
    use occlude_core::intersect::*;
    let mut g = c.benchmark_group("intersect");
    let l1 = Line::new(v(0., 0.), v(10., 10.));
    let l2 = Line::new(v(0., 10.), v(10., 0.));
    let a1 = Arc::new(v(0., 0.), 5., -PI, 2.0 * PI);
    let a2 = Arc::new(v(6., 0.), 5., -PI, 2.0 * PI);
    let c1 = Cubic::new(v(0., 0.), v(3., 5.), v(7., 5.), v(10., 0.));
    let c2 = Cubic::new(v(0., 4.), v(3., -1.), v(7., -1.), v(10., 4.));
    g.bench_function("line_line", |b| b.iter(|| black_box(line_line(&l1, &l2))));
    g.bench_function("line_arc", |b| b.iter(|| black_box(line_arc(&l1, &a1))));
    g.bench_function("arc_arc", |b| b.iter(|| black_box(arc_arc(&a1, &a2))));
    g.bench_function("line_cubic", |b| b.iter(|| black_box(line_cubic(&l1, &c1))));
    g.bench_function("arc_cubic", |b| b.iter(|| black_box(arc_cubic(&a1, &c1))));
    g.bench_function("cubic_cubic", |b| {
        b.iter(|| black_box(cubic_cubic(&c1, &c2)))
    });
    g.finish();

    let mut g = c.benchmark_group("inside");
    let circle = Region::new(circle_contour(0., 0., 5.), WindingRule::NonZero, true);
    let poly = {
        let mut prims = Vec::new();
        let n = 64;
        for i in 0..n {
            let a0 = i as f64 / n as f64 * 2.0 * PI;
            let a1 = (i + 1) as f64 / n as f64 * 2.0 * PI;
            prims.push(Primitive::Line(Line::new(
                v(a0.cos() * 5.0, a0.sin() * 5.0),
                v(a1.cos() * 5.0, a1.sin() * 5.0),
            )));
        }
        Region::from_contour(prims)
    };
    g.bench_function("inside_circle_arcs", |b| {
        b.iter(|| black_box(circle.inside(v(1.3, 0.7))))
    });
    g.bench_function("inside_polygon_64", |b| {
        b.iter(|| black_box(poly.inside(v(1.3, 0.7))))
    });
    g.finish();
}

criterion_group!(benches, bench_render, bench_micro);
criterion_main!(benches);
