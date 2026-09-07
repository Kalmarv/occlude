//! SVG output: exact primitives (no flattening — SVG draws arcs and cubics
//! natively). One <g> per pen, one <path> per PLOTTED CHAIN — the same
//! merge → tour → bridge the G-code and the machine driver run, so the SVG
//! is the drawing the pen lays down (law 5): bridged sub-nib gaps are inked,
//! and path order is plot order. Dots become filled circles at nib radius.

use crate::gcode::Chain;
use crate::pipeline::Pen;
use crate::primitive::Primitive;
use std::fmt::Write;

pub struct SvgOptions {
    /// Paper size in mm (width, height). Fragments are already in paper mm.
    pub width: f64,
    pub height: f64,
    pub background: Option<String>,
    /// Restrict output to one pen index (an execution filter over the plan).
    pub only_pen: Option<u32>,
}

/// Escape arbitrary text for use inside an XML attribute value.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// Encode PLANNED chains (`plan::plan_chains` or a range of it): one <g> per
/// pen, one <path> per chain in plan order. Never plans.
pub fn to_svg(chains: &[Chain], pens: &[Pen], opts: &SvgOptions) -> String {
    let mut s = String::new();
    let _ = write!(
        s,
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{w}mm" height="{h}mm" viewBox="0 0 {w} {h}">"#,
        w = opts.width,
        h = opts.height
    );
    if let Some(bg) = &opts.background {
        let _ = write!(
            s,
            r#"<rect width="{}" height="{}" fill="{}"/>"#,
            opts.width,
            opts.height,
            xml_escape(bg)
        );
    }
    for (pi, pen) in pens.iter().enumerate() {
        if let Some(only) = opts.only_pen {
            if only != pi as u32 {
                continue;
            }
        }
        let chains: Vec<&Chain> = chains.iter().filter(|c| c.pen == pi as u32).collect();
        if chains.is_empty() {
            continue;
        }
        let _ = write!(
            s,
            r#"<g fill="none" stroke="{}" stroke-width="{}" stroke-linecap="round" stroke-linejoin="round" data-pen="{}">"#,
            xml_escape(&pen.color),
            pen.width,
            xml_escape(&pen.name)
        );
        for chain in &chains {
            if chain.dot {
                let p = chain.start();
                let _ = write!(
                    s,
                    r#"<circle cx="{:.4}" cy="{:.4}" r="{:.4}" fill="{}" stroke="none"/>"#,
                    p.x,
                    p.y,
                    pen.width * 0.5,
                    xml_escape(&pen.color)
                );
                continue;
            }
            let mut d = String::new();
            let start = chain.start();
            let _ = write!(d, "M{:.4} {:.4}", start.x, start.y);
            for p in &chain.prims {
                append_segment(&mut d, p);
            }
            let _ = write!(s, r#"<path d="{}"/>"#, d);
        }
        s.push_str("</g>");
    }
    s.push_str("</svg>");
    s
}

/// One primitive's drawing command, continuing from the current point (the
/// chain's previous end — chains are contiguous by construction).
fn append_segment(d: &mut String, p: &Primitive) {
    match p {
        Primitive::Line(l) => {
            let _ = write!(d, "L{:.4} {:.4}", l.p1.x, l.p1.y);
        }
        Primitive::Arc(a) => {
            // Post-split arcs can still be a half circle or more; SVG needs
            // |sweep| < 2π per segment, so emit two segments beyond π.
            let mut emit = |t0: f64, t1: f64| {
                let sw = (t1 - t0) * a.sweep;
                let e = a.eval(t1);
                let large = if sw.abs() > std::f64::consts::PI {
                    1
                } else {
                    0
                };
                // Paper space is y-down; positive angle sweep renders clockwise,
                // which is SVG sweep-flag 1.
                let sf = if sw > 0.0 { 1 } else { 0 };
                let _ = write!(
                    d,
                    "A{r:.4} {r:.4} 0 {large} {sf} {x:.4} {y:.4}",
                    r = a.r,
                    x = e.x,
                    y = e.y
                );
            };
            if a.sweep.abs() > std::f64::consts::PI * 1.5 {
                emit(0.0, 0.5);
                emit(0.5, 1.0);
            } else {
                emit(0.0, 1.0);
            }
        }
        Primitive::Cubic(c) => {
            let _ = write!(
                d,
                "C{:.4} {:.4} {:.4} {:.4} {:.4} {:.4}",
                c.c0.x, c.c0.y, c.c1.x, c.c1.y, c.p1.x, c.p1.y
            );
        }
    }
}
