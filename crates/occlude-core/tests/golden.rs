//! Golden test: the committed JS-generated scene — the encoder's buffers
//! plus the fills sidecar produced by the PRODUCT fill modules
//! (packages/occlude/src/fills) — rendered to SVG must not drift. Cargo
//! consumes pure data: hermetic, node-free, and still product ink. The
//! fixture's freshness against the JS fills is guarded on the JS side
//! (packages/occlude/test/golden-fixture.test.ts), where node already
//! lives. Regenerate deliberately, in this order:
//!
//!   UPDATE_GOLDEN=1 pnpm --filter occlude test -- golden-fixture   # fixture
//!   UPDATE_GOLDEN=1 cargo test golden                              # SVG

use occlude_core::pipeline::prepare;
use occlude_core::scene::dump;
use occlude_core::svg::{to_svg, SvgOptions};
use std::path::PathBuf;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/golden")
}

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/scene1.svg")
}

#[test]
fn golden_svg_stable() {
    let d = dump::load(&fixture_dir()).expect("golden fixture (regenerate on the JS side)");
    let pens = d.input.pens.clone();
    let (w, h) = match d.paper.as_slice() {
        [x0, y0, x1, y1] => (x1 - x0, y1 - y0),
        _ => (105.0, 148.0),
    };
    let out = prepare(d.input).finish(d.supplied);
    let svg = to_svg(
        &out.frags,
        &pens,
        &SvgOptions {
            width: w,
            height: h,
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
