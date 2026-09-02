use occlude_core::bbox::BBox;
use occlude_core::fill::FillKind;
use occlude_core::nativegen::{hatch_region, render_with, HatchPass, NativeFill};
use occlude_core::gcode::{export_gcode, merge_chains, MachineProfile};
use occlude_core::pipeline::{render, ClipDef, Pen, RenderInput, ShapeRec};
use occlude_core::primitive::{Arc, Line, Primitive};
use occlude_core::region::{Region, WindingRule};
use occlude_core::svg::{to_svg, SvgOptions};
use occlude_core::vec2::v;
use std::f64::consts::PI;

fn circle_contour(cx: f64, cy: f64, r: f64) -> Vec<Vec<Primitive>> {
    vec![vec![
        Primitive::Arc(Arc::new(v(cx, cy), r, 0.0, PI)),
        Primitive::Arc(Arc::new(v(cx, cy), r, PI, PI)),
    ]]
}

fn rect_contour(x: f64, y: f64, w: f64, h: f64) -> Vec<Vec<Primitive>> {
    let p = [v(x, y), v(x + w, y), v(x + w, y + h), v(x, y + h)];
    vec![vec![
        Primitive::Line(Line::new(p[0], p[1])),
        Primitive::Line(Line::new(p[1], p[2])),
        Primitive::Line(Line::new(p[2], p[3])),
        Primitive::Line(Line::new(p[3], p[0])),
    ]]
}

fn stroke_shape(contours: Vec<Vec<Primitive>>, closed: bool) -> ShapeRec {
    ShapeRec {
        contours,
        closed,
        convex: false,
        winding: WindingRule::NonZero,
        stroke: Some(0),
        fill: None,
        z: 0.0,
        bridge_mm: 0.0,
        clips: vec![],
        modifiers: Vec::new(),
    }
}

fn filled_shape(contours: Vec<Vec<Primitive>>, kind: FillKind) -> ShapeRec {
    ShapeRec {
        contours,
        closed: true,
        convex: true,
        winding: WindingRule::NonZero,
        stroke: Some(0),
        fill: Some((0, kind)),
        z: 0.0,
        bridge_mm: 0.0,
        clips: vec![],
        modifiers: Vec::new(),
    }
}

/// Hatch ink precomputed harness-side (the supplied-prims leg): the engine
/// generates no patterns anymore, so tests supply them via Custom.
fn hatched_shape(contours: Vec<Vec<Primitive>>) -> ShapeRec {
    let region = Region::new(contours.clone(), WindingRule::NonZero, true);
    let prims = hatch_region(
        &region,
        &HatchPass {
            angle: 45.0,
            spacing: 1.0,
            offset: 0.0,
            shape_anchor: false,
        },
    );
    filled_shape(contours, FillKind::Custom(prims))
}

fn input(shapes: Vec<ShapeRec>) -> RenderInput {
    RenderInput {
        shapes,
        clips: vec![],
        pens: vec![Pen::default()],
        paper: None,
        seed: 42,
        coarsen: 1.0,
        debug_ghost: false, fields: Vec::new(), field_uses: Vec::new(),
    }
}

/// The core correctness property: no visible fragment midpoint may lie
/// strictly inside any later opaque region.
fn assert_no_midpoint_inside(
    out: &occlude_core::pipeline::RenderOutput,
    occluder: &Region,
    occluder_shape: u32,
) {
    for f in out.frags.iter().filter(|f| f.shape != occluder_shape) {
        let mid = f.geom.eval(0.5);
        if occluder.on_boundary(mid, 1e-7) {
            continue;
        }
        assert!(
            !occluder.inside(mid),
            "fragment midpoint {mid:?} of shape {} is hidden but drawn",
            f.shape
        );
    }
}

#[test]
fn line_under_filled_rect_splits() {
    let shapes = vec![
        stroke_shape(
            vec![vec![Primitive::Line(Line::new(v(-20., 0.), v(20., 0.)))]],
            false,
        ),
        hatched_shape(rect_contour(-5., -5., 10., 10.)),
    ];
    let out = render(&input(shapes));
    let line_frags: Vec<_> = out.frags.iter().filter(|f| f.shape == 0).collect();
    assert_eq!(line_frags.len(), 2, "{line_frags:?}");
    let total: f64 = line_frags.iter().map(|f| f.geom.length()).sum();
    assert!((total - 30.0).abs() < 1e-6, "visible length {total}");
}

#[test]
fn overlapping_filled_circles_occlude_in_draw_order() {
    let shapes = vec![
        hatched_shape(circle_contour(0., 0., 10.)),
        hatched_shape(circle_contour(10., 0., 10.)),
    ];
    let out = render(&input(shapes));
    let occ = Region::new(circle_contour(10., 0., 10.), WindingRule::NonZero, true);
    assert_no_midpoint_inside(&out, &occ, 1);
    // Shape 0's outline is partially hidden; shape 1's is complete.
    let len0: f64 = out
        .frags
        .iter()
        .filter(|f| f.shape == 0 && f.origin < 2)
        .map(|f| f.geom.length())
        .sum();
    let len1: f64 = out
        .frags
        .iter()
        .filter(|f| f.shape == 1 && (2..4).contains(&f.origin))
        .map(|f| f.geom.length())
        .sum();
    let circumference = 2.0 * PI * 10.0;
    assert!(
        len0 < circumference - 1.0,
        "shape 0 must lose outline: {len0}"
    );
    assert!(
        (len1 - circumference).abs() < 1e-6,
        "shape 1 complete: {len1}"
    );
}

#[test]
fn z_override_beats_draw_order() {
    let mut top = hatched_shape(circle_contour(0., 0., 10.));
    top.z = 5.0; // drawn first but stacked on top
    let below = hatched_shape(circle_contour(5., 0., 10.));
    let out = render(&input(vec![top, below]));
    let occ0 = Region::new(circle_contour(0., 0., 10.), WindingRule::NonZero, true);
    // Shape 1 (below) must have no midpoints inside shape 0's region.
    for f in out.frags.iter().filter(|f| f.shape == 1) {
        let mid = f.geom.eval(0.5);
        if !occ0.on_boundary(mid, 1e-7) {
            assert!(!occ0.inside(mid), "below shape drawn inside top shape");
        }
    }
    // And shape 0 keeps its full outline.
    let len0: f64 = out
        .frags
        .iter()
        .filter(|f| f.shape == 0 && f.origin < 2)
        .map(|f| f.geom.length())
        .sum();
    assert!((len0 - 2.0 * PI * 10.0).abs() < 1e-6);
}

#[test]
fn contained_shape_is_culled() {
    let shapes = vec![
        stroke_shape(circle_contour(0., 0., 2.), true), // buried
        hatched_shape(circle_contour(0., 0., 10.)),
    ];
    let out = render(&input(shapes));
    assert!(out.frags.iter().all(|f| f.shape != 0), "buried shape drawn");
    assert_eq!(out.stats.culled_contained, 1);
}

#[test]
fn clean_shapes_pass_through_whole() {
    let shapes = vec![
        stroke_shape(circle_contour(0., 0., 5.), true),
        hatched_shape(circle_contour(100., 0., 5.)),
    ];
    let out = render(&input(shapes));
    assert_eq!(out.stats.clean, 2);
    let f0: Vec<_> = out.frags.iter().filter(|f| f.shape == 0).collect();
    assert_eq!(f0.len(), 2);
    assert!(f0.iter().all(|f| f.t0 == 0.0 && f.t1 == 1.0));
}

#[test]
fn hatch_fills_convex_and_is_occluded() {
    let shapes = vec![
        hatched_shape(circle_contour(0., 0., 10.)),
        hatched_shape(rect_contour(0., -12., 14., 24.)),
    ];
    let out = render(&input(shapes));
    assert!(out.stats.fill_prims > 10);
    let occ = Region::new(rect_contour(0., -12., 14., 24.), WindingRule::NonZero, true);
    assert_no_midpoint_inside(&out, &occ, 1);
    // All hatch fragments of shape 0 stay inside its own circle.
    let own = Region::new(circle_contour(0., 0., 10.), WindingRule::NonZero, true);
    for f in out.frags.iter().filter(|f| f.shape == 0 && f.origin >= 4) {
        for t in [0.1, 0.5, 0.9] {
            let p = f.geom.eval(t);
            assert!(
                own.inside(p) || own.on_boundary(p, 1e-6),
                "hatch escaped its region at {p:?}"
            );
        }
    }
}

#[test]
fn stipple_is_deterministic_and_inside() {
    let shape = filled_shape(circle_contour(0., 0., 10.), FillKind::Pending);
    let fills = [(
        0usize,
        NativeFill::Stipple {
            density: 0.5,
            min_dist: 1.0,
        },
    )];
    let out1 = render_with(input(vec![shape.clone()]), &fills);
    let out2 = render_with(input(vec![shape]), &fills);
    let dots1: Vec<_> = out1.frags.iter().filter(|f| f.dot).collect();
    let dots2: Vec<_> = out2.frags.iter().filter(|f| f.dot).collect();
    assert!(
        dots1.len() > 20,
        "expected a field of dots, got {}",
        dots1.len()
    );
    assert_eq!(dots1.len(), dots2.len());
    for (a, b) in dots1.iter().zip(dots2.iter()) {
        assert_eq!(a.geom.start(), b.geom.start());
    }
    let region = Region::new(circle_contour(0., 0., 10.), WindingRule::NonZero, true);
    for d in dots1 {
        assert!(region.inside(d.geom.start()));
    }
}

#[test]
fn clip_region_restricts() {
    let mut line = stroke_shape(
        vec![vec![Primitive::Line(Line::new(v(-20., 0.), v(20., 0.)))]],
        false,
    );
    line.clips = vec![0];
    let mut inp = input(vec![line]);
    inp.clips = vec![ClipDef {
        contours: circle_contour(0., 0., 5.),
        winding: WindingRule::NonZero,
        convex: true,
        invert: false,
    }];
    let out = render(&inp);
    assert_eq!(out.frags.len(), 1);
    let total: f64 = out.frags.iter().map(|f| f.geom.length()).sum();
    assert!(
        (total - 10.0).abs() < 1e-6,
        "clipped to diameter, got {total}"
    );
}

#[test]
fn inverted_clip_keeps_outside() {
    // Same line, same circle, polarity flipped: the two outer pieces
    // survive and the diameter inside the circle is gone — clip(invert()).
    let mut line = stroke_shape(
        vec![vec![Primitive::Line(Line::new(v(-20., 0.), v(20., 0.)))]],
        false,
    );
    line.clips = vec![0];
    let mut inp = input(vec![line]);
    inp.clips = vec![ClipDef {
        contours: circle_contour(0., 0., 5.),
        winding: WindingRule::NonZero,
        convex: true,
        invert: true,
    }];
    let out = render(&inp);
    assert_eq!(out.frags.len(), 2);
    let total: f64 = out.frags.iter().map(|f| f.geom.length()).sum();
    assert!(
        (total - 30.0).abs() < 1e-6,
        "kept the outside pieces, got {total}"
    );
    // Complement completeness: normal + inverted spans = the whole line.
}

#[test]
fn paper_clips_and_culls() {
    let shapes = vec![
        stroke_shape(
            vec![vec![Primitive::Line(Line::new(v(-50., 10.), v(150., 10.)))]],
            false,
        ),
        stroke_shape(circle_contour(500., 500., 5.), true), // fully off paper
    ];
    let mut inp = input(shapes);
    inp.paper = Some(BBox::new(v(0., 0.), v(100., 100.)));
    let out = render(&inp);
    assert_eq!(out.stats.culled_off_paper, 1);
    let total: f64 = out.frags.iter().map(|f| f.geom.length()).sum();
    assert!(
        (total - 100.0).abs() < 1e-6,
        "clipped to paper, got {total}"
    );
}

#[test]
fn shared_edge_squares_no_double_seam() {
    // Two adjacent filled squares sharing edge x=10 exactly (snapped input).
    let shapes = vec![
        hatched_shape(rect_contour(0., 0., 10., 10.)),
        hatched_shape(rect_contour(10., 0., 10., 10.)),
    ];
    let out = render(&input(shapes));
    // The shared edge must be drawn exactly once.
    let seam_frags: Vec<_> = out
        .frags
        .iter()
        .filter(|f| {
            let (s, e) = (f.geom.start(), f.geom.end());
            (s.x - 10.0).abs() < 1e-9 && (e.x - 10.0).abs() < 1e-9 && f.geom.length() > 9.0
        })
        .collect();
    assert_eq!(
        seam_frags.len(),
        1,
        "shared edge drawn {} times",
        seam_frags.len()
    );
}

#[test]
fn export_gcode_and_svg_smoke() {
    let shapes = vec![
        hatched_shape(circle_contour(50., 50., 20.)),
        hatched_shape(rect_contour(60., 30., 30., 40.)),
    ];
    let out = render(&input(shapes));
    let pens = vec![Pen::default()];
    let svg = to_svg(
        &out.frags,
        &pens,
        &SvgOptions {
            width: 100.0,
            height: 100.0,
            background: Some("#f8f5ee".into()),
            only_pen: None,
        },
    );
    assert!(svg.contains("<path"), "svg has geometry");
    let jobs = export_gcode(&out.frags, &pens, &MachineProfile::default(), 20_000);
    assert_eq!(jobs.len(), 1);
    let g = &jobs[0].gcode;
    assert!(g.contains("G21"));
    assert!(g.contains("G1 X"));
    assert!(jobs[0].ink_mm > 100.0);
    // Chain merging must not lose ink: total chained length == fragment length.
    let frag_len: f64 = out.frags.iter().map(|f| f.geom.length()).sum();
    let chain_len: f64 = merge_chains(&out.frags, 0)
        .iter()
        .map(|c| c.ink_length())
        .sum();
    assert!((frag_len - chain_len).abs() < 1e-6);
}

#[test]
fn mask_occludes_without_ink() {
    let mut mask = filled_shape(circle_contour(0., 0., 5.), FillKind::Mask);
    mask.stroke = None; // fully invisible occluder
    let shapes = vec![
        stroke_shape(
            vec![vec![Primitive::Line(Line::new(v(-20., 0.), v(20., 0.)))]],
            false,
        ),
        mask,
    ];
    let out = render(&input(shapes));
    // The mask contributes no fragments at all…
    assert!(out.frags.iter().all(|f| f.shape == 0));
    assert_eq!(out.stats.fill_prims, 0);
    // …but the line is still cut by it.
    let total: f64 = out.frags.iter().map(|f| f.geom.length()).sum();
    assert!(
        (total - 30.0).abs() < 1e-6,
        "hidden-line cut missing: {total}"
    );
}

#[test]
fn fill_polyline_chain_is_judged_whole() {
    use occlude_core::fill::SuppliedFill;
    use occlude_core::pipeline::{prepare, RenderOutput};
    let shape = filled_shape(rect_contour(-20., -20., 40., 40.), FillKind::Pending);
    // A 30 mm squiggle in 0.02 mm steps: every segment is far below the
    // 0.3 mm nib, but the chain is one pen stroke — drawable ink.
    let n = 1500;
    let pt = |i: usize| v(-15.0 + i as f64 * 0.02, (i as f64 * 0.04).sin() * 3.0);
    let chain: Vec<Primitive> = (0..n)
        .map(|i| Primitive::Line(Line::new(pt(i), pt(i + 1))))
        .collect();
    let fill_ink = |out: &RenderOutput| -> f64 {
        out.frags
            .iter()
            .filter(|f| f.origin >= 4 && !f.dot)
            .map(|f| f.geom.length())
            .sum()
    };
    let whole = prepare(input(vec![shape.clone()])).finish(vec![Some(SuppliedFill {
        chains: vec![chain.clone()],
        dots: vec![],
    })]);
    let as_chain = fill_ink(&whole);
    assert!(as_chain > 25.0, "chain judged whole should survive: {as_chain} mm");
    // The same segments as 1500 separate strokes: each sub-nib alone —
    // that is the contract (chain = stroke), not a regression.
    let split = prepare(input(vec![shape])).finish(vec![Some(SuppliedFill {
        chains: chain.iter().map(|p| vec![*p]).collect(),
        dots: vec![],
    })]);
    assert_eq!(fill_ink(&split), 0.0);
}

#[test]
fn fill_chain_pieces_split_by_the_region_are_separate_strokes() {
    use occlude_core::fill::SuppliedFill;
    use occlude_core::pipeline::prepare;
    // A U-shaped region with a hair-thin left arm (0.1 mm) and a wide right
    // arm. One ruling crosses both: a 5 mm piece and a 0.1 mm sliver with a
    // pen lift between them — two strokes, judged apart. Summing them would
    // emit the sliver as a line: an ink change to the ink-immutable hatch.
    let pts = [
        v(-20., -20.), v(20., -20.), v(20., 20.), v(15., 20.),
        v(15., -15.), v(-19.9, -15.), v(-19.9, 20.), v(-20., 20.),
    ];
    let contour: Vec<Primitive> = (0..pts.len())
        .map(|i| Primitive::Line(Line::new(pts[i], pts[(i + 1) % pts.len()])))
        .collect();
    let mut shape = filled_shape(vec![contour], FillKind::Pending);
    shape.convex = false;
    let ruling = Primitive::Line(Line::new(v(-30., 0.), v(30., 0.)));
    let out = prepare(input(vec![shape])).finish(vec![Some(SuppliedFill {
        chains: vec![vec![ruling]],
        dots: vec![],
    })]);
    let lines: Vec<f64> = out
        .frags
        .iter()
        .filter(|f| f.origin >= 8 && !f.dot)
        .map(|f| f.geom.length())
        .collect();
    assert!(lines.iter().any(|&l| (l - 5.0).abs() < 1e-6), "wide arm piece: {lines:?}");
    assert!(lines.iter().all(|&l| l >= 0.3), "sub-nib sliver emitted as a line: {lines:?}");
}
