//! Fill kinds. The engine generates NO patterns (spec: it decides what
//! survives to paper, never what gets drawn) — fill primitives are produced
//! by sketch-space code between the two render passes and supplied to
//! `finish`, or carried pre-generated (`Custom`) by native consumers
//! (goldens, replay, benches). Hatch and stipple live as JS fill modules in
//! the occlude package now; their generators left this crate with the
//! fills-fields redesign.

use crate::primitive::Primitive;
use crate::vec2::Vec2;

#[derive(Debug, Clone)]
pub enum FillKind {
    /// Ink arrives at `finish` as supplied primitives + dots for this shape
    /// (the two-pass path: pass 1 exposes the post-deform outline, sketch
    /// code generates, pass 2 clips and occludes).
    Pending,
    /// Pre-generated primitives (native consumers, scene-dump sidecars).
    /// They go through the normal occlusion path like everything else.
    Custom(Vec<Primitive>),
    /// Opaque with zero ink: occludes everything beneath it, draws nothing.
    /// The primitive of hidden-line rendering.
    Mask,
}

/// One shape's between-pass fill output, as handed to `finish`.
#[derive(Debug, Clone, Default)]
pub struct SuppliedFill {
    /// Pattern primitives; clipped to the shape's own region by the engine
    /// (overshooting the boundary is fine and expected — paper-aligned
    /// rulings are generated across the bbox and cut here).
    pub prims: Vec<Primitive>,
    /// Intentional taps. Engine-filtered to strictly-inside points (a dot on
    /// the region edge drops), occludable, never routed through tap
    /// resolution — engine-stipple dot semantics exactly.
    pub dots: Vec<Vec2>,
}
