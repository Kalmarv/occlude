//! Golden test: a fixed-seed scene rendered to SVG must not drift.
//! Regenerate deliberately with: UPDATE_GOLDEN=1 cargo test golden

use occlude_core::fill::FillKind;
use occlude_core::nativegen::{render_with, HatchPass, NativeFill};
use occlude_core::pipeline::{Pen, RenderInput, ShapeRec};
use occlude_core::primitive::{Arc, Cubic, Line, Primitive};
use occlude_core::region::WindingRule;
use occlude_core::snap::snap_primitive;
use occlude_core::svg::{to_svg, SvgOptions};
use occlude_core::vec2::v;
use std::f64::consts::PI;
use std::path::PathBuf;

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/scene1.svg")
}

fn scene() -> RenderInput {
    let snap_all = |prims: Vec<Primitive>| prims.iter().map(snap_primitive).collect::<Vec<_>>();
    let circle = |x: f64, y: f64, r: f64| {
        snap_all(vec![
            Primitive::Arc(Arc::new(v(x, y), r, 0.0, PI)),
            Primitive::Arc(Arc::new(v(x, y), r, PI, PI)),
        ])
    };

    let shape = |contours: Vec<Vec<Primitive>>,
                 closed: bool,
                 fill: Option<(u32, FillKind)>,
                 z: f64| ShapeRec {
        contours,
        closed,
        convex: closed,
        winding: WindingRule::NonZero,
        stroke: Some(0),
        fill,
        z,
        bridge_mm: 0.0,
        clips: vec![],
        modifiers: Vec::new(),
    };
    RenderInput {
        shapes: vec![
            shape(
                vec![snap_all(vec![Primitive::Line(Line::new(
                    v(0., 74.),
                    v(105., 74.),
                ))])],
                false,
                None,
                -1.0,
            ),
            shape(
                vec![snap_all(vec![Primitive::Cubic(Cubic::new(
                    v(10., 120.),
                    v(35., 60.),
                    v(70., 130.),
                    v(95., 50.),
                ))])],
                false,
                None,
                0.0,
            ),
            shape(
                vec![circle(40., 74., 22.)],
                true,
                Some((0, FillKind::Pending)),
                0.0,
            ),
            shape(
                vec![circle(62., 74., 18.)],
                true,
                Some((0, FillKind::Pending)),
                0.0,
            ),
            shape(
                vec![circle(52., 40., 12.)],
                true,
                Some((0, FillKind::Pending)),
                0.0,
            ),
        ],
        clips: vec![],
        pens: vec![Pen::default()],
        paper: Some(occlude_core::bbox::BBox::new(v(0., 0.), v(105., 148.))),
        seed: 1234,
        coarsen: 1.0,
        debug_ghost: false,
        fields: Vec::new(),
    }
}

#[test]
fn golden_svg_stable() {
    // Fill ink supplied through the real two-pass path (the JS runtime's
    // native analogue): hatch/stipple specs registered per shape index.
    let hatch = |angle: f64| {
        NativeFill::Hatch(vec![HatchPass {
            angle,
            spacing: 2.0,
            offset: 0.0,
            shape_anchor: false,
        }])
    };
    let fills = [
        (2usize, hatch(45.0)),
        (3usize, hatch(-30.0)),
        (
            4usize,
            NativeFill::Stipple {
                density: 0.6,
                min_dist: 1.2,
            },
        ),
    ];
    let out = render_with(scene(), &fills);
    let svg = to_svg(
        &out.frags,
        &[Pen::default()],
        &SvgOptions {
            width: 105.0,
            height: 148.0,
            background: None,
            only_pen: None,
        },
    );
    let path = golden_path();
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &svg).unwrap();
        return;
    }
    let golden = std::fs::read_to_string(&path)
        .expect("golden file missing — run with UPDATE_GOLDEN=1 to create it");
    assert_eq!(svg, golden, "rendered SVG drifted from the golden fixture");
}
