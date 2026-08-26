//! The modifier stack: each shape carries an ordered program of modifiers,
//! applied around the occlusion solve. Pre-stage modifiers deform the
//! shape's geometry before hidden-line removal (they change what is
//! hidden); post-stage modifiers distress the surviving ink afterwards
//! (the scene is unchanged, only the drawing trembles or erodes).
//!
//! Scalar parameters can instead reference a [`FieldGrid`] — a raster
//! sampled from a user field function at encode time — so any parameter
//! can vary over the page.

/// One modifier instruction. Scalar params hold either a literal or, when
/// the matching [`Param::Field`] variant is used, an index into
/// `RenderInput::fields`.
#[derive(Debug, Clone, PartialEq)]
pub enum Modifier {
    /// Post: drop final fragments with these probabilities (outline ink /
    /// fill ink), seeded per fragment.
    Decimate { stroke: Param, fill: Param },
    /// Post: flatten final strokes and displace vertices with seeded
    /// smooth noise. `amp` in mm; `wavelength` = noise lattice spacing.
    Wobble { amp: Param, wavelength: f64 },
    /// Post: chop final strokes into dashes by physical length (mm). The
    /// cuts are exact sub-ranges of the original primitives — curves stay
    /// curves.
    Dash { len: f64, gap: f64 },
    /// Pre: Chaikin corner-cutting on the shape's contours — each pass
    /// rounds every corner; the result converges to a quadratic B-spline.
    Smooth { passes: u32 },
    /// Pre: midpoint-displacement fracture — resample contours at `detail`
    /// spacing (mm) and jitter vertices by up to `amp` (mm), seeded.
    Roughen { amp: Param, detail: f64 },
    /// Pre: displace contour geometry by a vector field (two scalar field
    /// rasters, mm), resampled at `detail` spacing. Changes what is hidden.
    Deform { dx: Param, dy: Param, detail: f64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Runs on shape contours before the solve.
    Pre,
    /// Runs on final fragments after the solve.
    Post,
}

impl Modifier {
    pub fn stage(&self) -> Stage {
        match self {
            Modifier::Decimate { .. } | Modifier::Wobble { .. } | Modifier::Dash { .. } => {
                Stage::Post
            }
            Modifier::Smooth { .. } | Modifier::Roughen { .. } | Modifier::Deform { .. } => {
                Stage::Pre
            }
        }
    }
}

/// A scalar modifier parameter: a literal, or a field sampled by position.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Param {
    Lit(f64),
    /// Index into `RenderInput::fields`.
    Field(u32),
}

impl Param {
    /// Resolve at a position (paper mm). Out-of-range field indices resolve
    /// to 0 — a malformed scene degrades to "modifier off", not a panic.
    pub fn at(&self, fields: &[FieldGrid], x: f64, y: f64) -> f64 {
        match *self {
            Param::Lit(v) => v,
            Param::Field(i) => fields.get(i as usize).map_or(0.0, |f| f.sample(x, y)),
        }
    }

    pub fn literal(&self) -> Option<f64> {
        match *self {
            Param::Lit(v) => Some(v),
            Param::Field(_) => None,
        }
    }

    /// Could this parameter ever be positive? (Cheap "is the modifier on at
    /// all" test: fields are conservatively assumed active.)
    pub fn maybe_positive(&self) -> bool {
        match *self {
            Param::Lit(v) => v > 0.0,
            Param::Field(_) => true,
        }
    }
}

/// A scalar field rasterised over the paper (mm coordinates), sampled with
/// clamped bilinear interpolation.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldGrid {
    pub x0: f64,
    pub y0: f64,
    /// Cell size in mm (per axis).
    pub dx: f64,
    pub dy: f64,
    /// Sample counts (>= 2 per axis for bilinear).
    pub w: usize,
    pub h: usize,
    /// Row-major, `w * h` values.
    pub samples: Vec<f64>,
}

impl FieldGrid {
    pub fn sample(&self, x: f64, y: f64) -> f64 {
        if self.w == 0 || self.h == 0 || self.samples.len() < self.w * self.h {
            return 0.0;
        }
        let gx = ((x - self.x0) / self.dx).clamp(0.0, (self.w - 1) as f64);
        let gy = ((y - self.y0) / self.dy).clamp(0.0, (self.h - 1) as f64);
        let ix = (gx.floor() as usize).min(self.w.saturating_sub(2));
        let iy = (gy.floor() as usize).min(self.h.saturating_sub(2));
        let (tx, ty) = (gx - ix as f64, gy - iy as f64);
        let at = |xx: usize, yy: usize| self.samples[yy * self.w + xx];
        if self.w == 1 || self.h == 1 {
            return at(ix.min(self.w - 1), iy.min(self.h - 1));
        }
        let a = at(ix, iy);
        let b = at(ix + 1, iy);
        let c = at(ix, iy + 1);
        let d = at(ix + 1, iy + 1);
        let top = a + (b - a) * tx;
        let bot = c + (d - c) * tx;
        top + (bot - top) * ty
    }
}
