//! Input snapping: 0.005 mm grid in paper space, applied at record time.
//! Shared edges between shapes then compare with `==`, not epsilon.
//! Intersection results are never snapped — they stay exact floats.

use crate::primitive::{Arc, Cubic, Line, Primitive};
use crate::vec2::Vec2;

pub const GRID: f64 = 0.005;

pub fn snap(v: f64) -> f64 {
    (v / GRID).round() * GRID
}

pub fn snap_point(p: Vec2) -> Vec2 {
    Vec2 {
        x: snap(p.x),
        y: snap(p.y),
    }
}

pub fn snap_primitive(p: &Primitive) -> Primitive {
    match p {
        Primitive::Line(l) => Primitive::Line(Line::new(snap_point(l.p0), snap_point(l.p1))),
        // Snapping centre and radius makes coincident circles exactly
        // coincident; angles stay exact.
        Primitive::Arc(a) => {
            Primitive::Arc(Arc::new(snap_point(a.center), snap(a.r), a.start, a.sweep))
        }
        Primitive::Cubic(c) => Primitive::Cubic(Cubic::new(
            snap_point(c.p0),
            snap_point(c.c0),
            snap_point(c.c1),
            snap_point(c.p1),
        )),
    }
}
