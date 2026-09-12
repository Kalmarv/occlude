use occlude_core::bbox::BBox;
use occlude_core::fill::{FillKind, SuppliedFill};
use occlude_core::synth::{bbox_of, custom_lines, lattice_dots, render_with};
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

/// Line ink precomputed harness-side (the supplied-prims leg): the engine
/// generates no patterns, so tests supply synthetic lines via Custom.
fn hatched_shape(contours: Vec<Vec<Primitive>>) -> ShapeRec {
    let fill = custom_lines(&contours, 1.0, 45.0);
    filled_shape(contours, fill)
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
fn supplied_dots_are_deterministic_and_strictly_inside() {
    // Dots supplied over the whole bbox (many outside the circle): the
    // engine keeps only strictly-inside ones, deterministically.
    let shape = filled_shape(circle_contour(0., 0., 10.), FillKind::Pending);
    let supply = |job: &occlude_core::pipeline::FillJob| SuppliedFill {
        chains: Vec::new(),
        dots: lattice_dots(&bbox_of(job.contours), 1.0, 7),
    };
    let out1 = render_with(input(vec![shape.clone()]), supply);
    let out2 = render_with(input(vec![shape]), supply);
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
fn duplicate_outlines_are_deduped_after_decimation() {
    use occlude_core::modifier::{Modifier, Param};
    for fraction in [0.0, 0.3, 1.0] {
        for reverse in [false, true] {
            let outline = stroke_shape(rect_contour(10.0, 10.0, 20.0, 20.0), true);
            let mut distressed = outline.clone();
            distressed.modifiers.push(Modifier::Decimate {
                stroke: Param::Lit(fraction), fill: Param::Lit(fraction),
            });
            let mut shapes = vec![distressed, outline];
            if reverse { shapes.reverse(); }
            let out = render(&input(shapes));
            assert_eq!(out.frags.len(), 4, "fraction={fraction}, reverse={reverse}");
            let length: f64 = out.frags.iter().map(|f| f.geom.length()).sum();
            assert!((length - 80.0).abs() < 1e-9);
        }
    }
}

#[test]
fn duplicate_outlines_survive_dashing_and_displacement() {
    use occlude_core::modifier::{Modifier, Param};
    for modifier in [
        Modifier::Dash { len: 1.0, gap: 1.0, offset: 0.0 },
        Modifier::Wobble { amp: Param::Lit(2.0), wavelength: 3.0 },
    ] {
        let outline = stroke_shape(rect_contour(10.0, 10.0, 20.0, 20.0), true);
        let mut modified = outline.clone();
        modified.modifiers.push(modifier);
        let out = render(&input(vec![modified, outline]));
        assert_eq!(out.frags.iter().filter(|f| f.shape == 1).count(), 4);
        assert!(out.frags.iter().any(|f| f.shape == 0));
    }
}

#[test]
fn export_gcode_and_svg_smoke() {
    let shapes = vec![
        hatched_shape(circle_contour(50., 50., 20.)),
        hatched_shape(rect_contour(60., 30., 30., 40.)),
    ];
    let out = render(&input(shapes));
    let pens = vec![Pen::default()];
    let plotted = occlude_core::plan::plan_chains(&out.frags, &pens, 20_000);
    let svg = to_svg(
        &plotted,
        &pens,
        &SvgOptions {
            width: 100.0,
            height: 100.0,
            background: Some("#f8f5ee".into()),
            only_pen: None,
        },
    );
    assert!(svg.contains("<path"), "svg has geometry");
    let jobs = export_gcode(&plotted, &pens, &MachineProfile::default());
    // Law 5: the SVG is the plotted drawing — one <path> per chain the G-code
    // plots, in the same order, bridging included (so its ink ≥ the raw
    // fragments' ink by exactly the bridged gaps, never less).
    let svg_paths = svg.matches("<path").count();
    assert_eq!(svg_paths, plotted.iter().filter(|c| !c.dot).count());
    let chained_ink: f64 = plotted.iter().map(|c| c.ink_length()).sum();
    let frag_ink: f64 = out.frags.iter().filter(|f| !f.dot).map(|f| f.geom.length()).sum();
    assert!(chained_ink >= frag_ink - 1e-6, "svg chains must carry all the ink");
    assert!(chained_ink - frag_ink < pens[0].width * plotted.len() as f64, "bridges are sub-nib");
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

#[test]
fn the_occluder_span_path_judges_runs_whole() {
    // A 38 mm squiggle of 0.19 mm segments, stroked, with a later opaque
    // shape whose BBOX overlaps every segment but whose region touches none:
    // each segment takes the occluder-span path. Judged per piece, every
    // segment is sub-nib (0.19 < 0.3) and the stroke dissolves into taps;
    // judged as a run, it is 38 mm of drawable ink.
    let n = 200;
    let pt = |i: usize| v(-19.0 + i as f64 * 0.19, (i as f64 * 0.3).sin() * 0.02);
    let chain: Vec<Primitive> = (0..n)
        .map(|i| Primitive::Line(Line::new(pt(i), pt(i + 1))))
        .collect();
    let squiggle = stroke_shape(vec![chain], false);
    // A wide, thin filled bar just below the squiggle: its bbox spans the
    // squiggle's x-range, its region never reaches y ≈ 0.
    let bar = filled_shape(rect_contour(-25., 2., 50., 1.), FillKind::Custom(Vec::new()));
    let out = render(&input(vec![squiggle, bar]));
    let ink: f64 = out
        .frags
        .iter()
        .filter(|f| f.shape == 0 && !f.dot)
        .map(|f| f.geom.length())
        .sum();
    let dots = out.frags.iter().filter(|f| f.shape == 0 && f.dot).count();
    assert!(ink > 37.0, "run judged whole should keep the stroke: {ink} mm");
    assert_eq!(dots, 0, "no crumbs along a drawable stroke");
}

#[test]
fn clipped_occluder_hides_only_its_effective_region() {
    // A full-cover mask exercises containment culling as well as clipping.
    for invert in [false, true] {
        let line = stroke_shape(vec![vec![Primitive::Line(Line::new(v(0., 0.), v(100., 0.)))]], false);
        let mut mask = filled_shape(rect_contour(-10., -10., 120., 20.), FillKind::Mask);
        mask.stroke = None;
        mask.clips = vec![0, 1];
        let mut inp = input(vec![line, mask]);
        let mut loops = rect_contour(20., -5., 60., 10.);
        loops.extend(rect_contour(40., -2., 20., 4.));
        inp.clips = vec![
            ClipDef { contours: loops, winding: WindingRule::EvenOdd, convex: false, invert },
            ClipDef { contours: rect_contour(0., -8., 70., 16.), winding: WindingRule::NonZero, convex: true, invert: false },
        ];
        let out = render(&inp);
        let ink: f64 = out.frags.iter().filter(|f| f.shape == 0).map(|f| f.geom.length()).sum();
        // Normal: hides [20,40] + [60,70]; inverted: [0,20] + [40,60].
        let expected = if invert { 60. } else { 70. };
        assert!((ink - expected).abs() < 1e-6, "invert={invert}: {ink}, expected {expected}");
    }
}

#[test]
fn native_contour_disc_is_an_atomic_plan_run() {
    let mut shape = filled_shape(circle_contour(40.0,40.0,30.0),FillKind::Contour { spacing: 0.27, connectors: true });
    shape.stroke = None;
    let out = render(&input(vec![shape]));
    let chains = merge_chains(&out.frags,0);
    assert!(chains.len() <= 2,"{} chains",chains.len());
    assert!(chains.iter().all(|c|c.ordered));
    for c in chains {
        for pair in c.prims.windows(2) { assert!(pair[0].end().dist(pair[1].start()) < 1e-8); }
        let back = c.reversed().reversed();
        assert!((back.ink_length()-c.ink_length()).abs()<1e-8);
    }
}

#[test]
fn native_contour_occluder_creates_separate_islands() {
    let mut shape = filled_shape(rect_contour(0.0,0.0,20.0,10.0),FillKind::Contour { spacing: 0.27, connectors: true });
    shape.stroke = None;
    let mut mask = filled_shape(rect_contour(9.0,-1.0,2.0,12.0),FillKind::Mask);
    mask.stroke = None;
    let out = render(&input(vec![shape,mask]));
    let chains = merge_chains(&out.frags,0);
    assert!(chains.len() >= 2);
    for c in chains {
        // A valid run may start exactly on the left island's boundary.
        let left = c.start().x <= 9.0;
        for p in c.prims {
            for i in 0..=20 {
                let q = p.eval(i as f64/20.0);
                assert!(if left { q.x <= 9.0 } else { q.x >= 11.0 }, "left={left}, point={q:?}, primitive={p:?}");
            }
        }
    }
}

#[test]
fn native_contour_annulus_retains_hole() {
    let mut contours = circle_contour(40.0,40.0,12.0);
    contours.extend(circle_contour(40.0,40.0,4.0));
    let mut shape = filled_shape(contours,FillKind::Contour { spacing: 0.27, connectors: true });
    shape.winding = WindingRule::EvenOdd; shape.convex = false; shape.stroke = None;
    let out = render(&input(vec![shape]));
    assert!(!out.frags.is_empty());
    for f in &out.frags {
        for i in 0..=20 { assert!(f.geom.eval(i as f64/20.0).dist(v(40.0,40.0)) >= 4.0-1e-8); }
    }
}

#[test]
fn native_rounded_rectangle_has_one_main_run() {
    let mut ring = Vec::new();
    let r = 10.0;
    let corners = [(v(70.0,10.0),-PI/2.0),(v(70.0,60.0),0.0),(v(10.0,60.0),PI/2.0),(v(10.0,10.0),PI)];
    for i in 0..4 {
        let arc = Primitive::Arc(Arc::new(corners[i].0,r,corners[i].1,PI/2.0));
        let next = Arc::new(corners[(i+1)%4].0,r,corners[(i+1)%4].1,PI/2.0);
        ring.push(arc); ring.push(Primitive::Line(Line::new(arc.end(),next.eval(0.0))));
    }
    let mut shape = filled_shape(vec![ring],FillKind::Contour { spacing: 0.27, connectors: true }); shape.stroke = None;
    let out = render(&input(vec![shape]));
    let chains = merge_chains(&out.frags,0);
    // Keep one main inset run; allow separate cleanup instead of retracing.
    assert!(chains.len()<=4,"{} chains, {:?}",chains.len(),out.stats.contour);
    assert!(chains.iter().any(|c| c.prims.len() >= out.stats.contour.contours * 4));
}

#[test]
fn ordered_run_gaps_survive_shared_junctions_and_bridging() {
    use occlude_core::fragment::{Frag,RunSpan};
    use occlude_core::plan::{plan_chains_with,PlanOptions,encode_plan,decode_plan};
    let a=v(0.0,0.0); let b=v(1.0,0.0);
    let prims=[Primitive::Arc(Arc::new(v(-1.0,0.0),1.0,0.0,PI*2.0)),Primitive::Line(Line::new(a,b)),Primitive::Arc(Arc::new(v(2.0,0.0),1.0,PI,PI*2.0))];
    let mut frags:Vec<_>=prims.iter().enumerate().map(|(i,p)|{
        let mut f=Frag::whole(i as u32,*p,0,0); f.run=Some(RunSpan{id:1,start:i as f64,end:i as f64+1.0});f
    }).collect();
    let intact=plan_chains_with(&frags,&[Pen::default()],PlanOptions::default());
    assert_eq!(intact.len(),1); assert_eq!(intact[0].prims.len(),3);
    assert_eq!(decode_plan(&encode_plan(&intact)).unwrap()[0].prims.len(),3);
    frags.remove(1);
    let broken=plan_chains_with(&frags,&[Pen::default()],PlanOptions { bridge:Some(10.0),..PlanOptions::default() });
    assert_eq!(broken.len(),2);
}
