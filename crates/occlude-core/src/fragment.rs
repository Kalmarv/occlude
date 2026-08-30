//! Fragments: the output currency of the whole system. One fragment is a
//! sub-range [t0, t1] of an origin primitive, plus pen and shape labels.

use crate::primitive::Primitive;

#[derive(Debug, Clone)]
pub struct Frag {
    /// Index of the origin primitive in the caller's primitive table
    /// (u32::MAX for generated geometry that has no table entry).
    pub origin: u32,
    pub t0: f64,
    pub t1: f64,
    pub pen: u32,
    pub shape: u32,
    /// Stipple dot: zero-length, plotted as pen-down/delay/pen-up.
    pub dot: bool,
    /// Bridge connector inserted by the endpoint-join pass (debug-visible).
    pub bridge: bool,
    /// Exact geometry of this sub-range (not a polyline).
    pub geom: Primitive,
}

impl Frag {
    pub fn whole(origin: u32, geom: Primitive, pen: u32, shape: u32) -> Frag {
        Frag {
            origin,
            t0: 0.0,
            t1: 1.0,
            pen,
            shape,
            dot: false,
            bridge: false,
            geom,
        }
    }

    pub fn len(&self) -> f64 {
        if self.dot {
            0.0
        } else {
            self.geom.length()
        }
    }
}

/// A span of an origin primitive's parameter range with its visibility state.
/// The clip layer maintains a full partition of [0, 1] per primitive so the
/// cleanup neighbour rules can see hidden gaps.
#[derive(Debug, Clone)]
pub struct Span {
    pub t0: f64,
    pub t1: f64,
    pub visible: bool,
}
