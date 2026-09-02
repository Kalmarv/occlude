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
    /// Post: chop final strokes into dashes by physical length (mm),
    /// phase-continuous along the outline (period snapped to closed
    /// contours so the pattern meets itself). `offset` shifts the pattern.
    /// The cuts are exact sub-ranges — curves stay curves.
    Dash { len: f64, gap: f64, offset: f64 },
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
    /// Index into `RenderInput::field_uses`.
    Field(u32),
}

/// One engine field USE (spec rule 12): the grid it samples, the per-use
/// sampling transform — paper mm → field space, "the transform outside the
/// grid", so a thousand shape-anchored uses share ONE raster — the linear
/// part field→paper (vector directions turn with the motif; rule 10's
/// iron-filings law), the magnitude scale (field units → mm), and the
/// domain refs: clip-region indices the sample point must lie in (nested
/// `within()` bounds are a conjunction). Outside its domain a field is
/// ABSENT, and absence is the do-nothing value: modifiers touch nothing.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldUse {
    pub grid: u32,
    /// Affine [a, b, c, d, e, f]: (x', y') = (a x + c y + e, b x + d y + f).
    pub m: [f64; 6],
    /// Linear part of the inverse map (field → paper), for directions.
    pub linv: [f64; 4],
    pub mag: f64,
    pub domains: Vec<u32>,
}

impl FieldUse {
    /// A use that samples a paper-mm grid directly (harness scenes).
    pub fn direct(grid: u32) -> FieldUse {
        FieldUse {
            grid,
            m: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            linv: [1.0, 0.0, 0.0, 1.0],
            mag: 1.0,
            domains: Vec::new(),
        }
    }
}

/// Everything a field sample needs: grids, uses, and the domain regions
/// (the scene's clip regions — domains ride the same table).
#[derive(Clone, Copy)]
pub struct FieldCtx<'a> {
    pub grids: &'a [FieldGrid],
    pub uses: &'a [FieldUse],
    pub domains: &'a [(crate::region::Region, bool)],
}

impl FieldCtx<'_> {
    fn absent(&self, u: &FieldUse, p: crate::vec2::Vec2) -> bool {
        u.domains.iter().any(|&d| {
            self.domains
                .get(d as usize)
                .is_some_and(|(r, keep)| r.inside(p) != *keep)
        })
    }

    fn raw(&self, u: &FieldUse, p: crate::vec2::Vec2) -> f64 {
        let [a, b, c, d, e, f] = u.m;
        let x = a * p.x + c * p.y + e;
        let y = b * p.x + d * p.y + f;
        self.grids.get(u.grid as usize).map_or(0.0, |g| g.sample(x, y))
    }

    /// A scalar use at a paper point: absent outside its domain (0), else
    /// the grid sampled through the use's transform.
    pub fn scalar(&self, use_idx: u32, p: crate::vec2::Vec2) -> f64 {
        let Some(u) = self.uses.get(use_idx as usize) else {
            return 0.0;
        };
        if self.absent(u, p) {
            return 0.0;
        }
        self.raw(u, p)
    }

    /// A vector (dx, dy) use pair at a paper point, in paper mm: sampled
    /// through the transform, direction carried through the linear part
    /// and renormalised, magnitude preserved (scaled to mm) — transforms
    /// act on coordinates and directions, never on magnitudes.
    pub fn vector(&self, dx: &Param, dy: &Param, p: crate::vec2::Vec2) -> crate::vec2::Vec2 {
        let (Param::Field(ix), Param::Field(iy)) = (dx, dy) else {
            return crate::vec2::v(dx.at(self, p), dy.at(self, p));
        };
        let (Some(ux), Some(uy)) = (self.uses.get(*ix as usize), self.uses.get(*iy as usize))
        else {
            return crate::vec2::v(0.0, 0.0);
        };
        if self.absent(ux, p) {
            return crate::vec2::v(0.0, 0.0);
        }
        let sx = self.raw(ux, p);
        let sy = self.raw(uy, p);
        let mag = sx.hypot(sy);
        if !(mag > 0.0) || !mag.is_finite() {
            return crate::vec2::v(0.0, 0.0);
        }
        let [a, b, c, d] = ux.linv;
        let tx = a * sx + c * sy;
        let ty = b * sx + d * sy;
        let tm = tx.hypot(ty);
        if !(tm > 0.0) {
            return crate::vec2::v(0.0, 0.0);
        }
        crate::vec2::v(tx / tm * mag * ux.mag, ty / tm * mag * ux.mag)
    }
}

impl Param {
    /// Resolve at a paper point. Out-of-range use indices resolve to 0 — a
    /// malformed scene degrades to "modifier off", not a panic.
    pub fn at(&self, fields: &FieldCtx, p: crate::vec2::Vec2) -> f64 {
        match *self {
            Param::Lit(v) => v,
            Param::Field(i) => fields.scalar(i, p),
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

/// A scalar field rasterised over FIELD space (the coordinates a `FieldUse`
/// transform maps paper points into), sampled with clamped interpolation.
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
    /// Catmull-Rom bicubic (clamped edges). C1 continuity matters: deform
    /// geometry follows this raster directly, and bilinear's derivative
    /// jumps at cell boundaries draw as visible facets wherever the
    /// displacement is large.
    pub fn sample(&self, x: f64, y: f64) -> f64 {
        if self.w == 0 || self.h == 0 || self.samples.len() < self.w * self.h {
            return 0.0;
        }
        let gx = ((x - self.x0) / self.dx).clamp(0.0, (self.w - 1) as f64);
        let gy = ((y - self.y0) / self.dy).clamp(0.0, (self.h - 1) as f64);
        let ix = (gx.floor() as isize).min(self.w as isize - 2).max(0);
        let iy = (gy.floor() as isize).min(self.h as isize - 2).max(0);
        let (tx, ty) = (gx - ix as f64, gy - iy as f64);
        let at = |xx: isize, yy: isize| {
            let cx = xx.clamp(0, self.w as isize - 1) as usize;
            let cy = yy.clamp(0, self.h as isize - 1) as usize;
            self.samples[cy * self.w + cx]
        };
        if self.w < 4 || self.h < 4 {
            // Tiny grids: bilinear.
            let a = at(ix, iy);
            let b = at(ix + 1, iy);
            let c = at(ix, iy + 1);
            let d = at(ix + 1, iy + 1);
            let top = a + (b - a) * tx;
            let bot = c + (d - c) * tx;
            return top + (bot - top) * ty;
        }
        let cr = |p0: f64, p1: f64, p2: f64, p3: f64, t: f64| {
            let t2 = t * t;
            let t3 = t2 * t;
            0.5 * ((2.0 * p1)
                + (p2 - p0) * t
                + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
                + (3.0 * p1 - 3.0 * p2 + p3 - p0) * t3)
        };
        let mut rows = [0.0; 4];
        for (k, o) in (-1..=2).enumerate() {
            rows[k] = cr(
                at(ix - 1, iy + o),
                at(ix, iy + o),
                at(ix + 1, iy + o),
                at(ix + 2, iy + o),
                tx,
            );
        }
        cr(rows[0], rows[1], rows[2], rows[3], ty)
    }
}
