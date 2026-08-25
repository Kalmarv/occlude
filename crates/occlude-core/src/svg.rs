//! SVG output: exact primitives (no flattening — SVG draws arcs and cubics
//! natively). One <g> per pen; dots become filled circles at nib radius.

use crate::fragment::Frag;
use crate::pipeline::Pen;
use crate::primitive::Primitive;
use std::fmt::Write;

pub struct SvgOptions {
    /// Paper size in mm (width, height). Fragments are already in paper mm.
    pub width: f64,
    pub height: f64,
    pub background: Option<String>,
    /// Restrict output to one pen index.
    pub only_pen: Option<u32>,
}

pub fn to_svg(frags: &[Frag], pens: &[Pen], opts: &SvgOptions) -> String {
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
            opts.width, opts.height, bg
        );
    }
    for (pi, pen) in pens.iter().enumerate() {
        if let Some(only) = opts.only_pen {
            if only != pi as u32 {
                continue;
            }
        }
        let mine: Vec<&Frag> = frags.iter().filter(|f| f.pen == pi as u32).collect();
        if mine.is_empty() {
            continue;
        }
        let _ = write!(
            s,
            r#"<g fill="none" stroke="{}" stroke-width="{}" stroke-linecap="round" data-pen="{}">"#,
            pen.color, pen.width, pen.name
        );
        let mut path = String::new();
        for f in mine {
            if f.dot {
                let p = f.geom.start();
                let _ = write!(
                    s,
                    r#"<circle cx="{:.4}" cy="{:.4}" r="{:.4}" fill="{}" stroke="none"/>"#,
                    p.x,
                    p.y,
                    pen.width * 0.5,
                    pen.color
                );
                continue;
            }
            append_path(&mut path, &f.geom);
        }
        if !path.is_empty() {
            let _ = write!(s, r#"<path d="{}"/>"#, path);
        }
        s.push_str("</g>");
    }
    s.push_str("</svg>");
    s
}

fn append_path(d: &mut String, p: &Primitive) {
    let s = p.start();
    let _ = write!(d, "M{:.4} {:.4}", s.x, s.y);
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
