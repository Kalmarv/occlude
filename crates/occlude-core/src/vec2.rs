//! Minimal 2D vector math. Everything is f64; paper space is millimetres.

use std::ops::{Add, Div, Mul, Neg, Sub};

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

pub const fn v(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}

impl Vec2 {
    pub const ZERO: Vec2 = v(0.0, 0.0);

    pub fn dot(self, o: Vec2) -> f64 {
        self.x * o.x + self.y * o.y
    }

    /// z-component of the 3D cross product; positive when `o` is
    /// counter-clockwise of `self` in a y-down system it is clockwise, but the
    /// sign convention is consistent throughout so winding still works.
    pub fn cross(self, o: Vec2) -> f64 {
        self.x * o.y - self.y * o.x
    }

    pub fn len2(self) -> f64 {
        self.dot(self)
    }

    pub fn len(self) -> f64 {
        self.len2().sqrt()
    }

    pub fn dist(self, o: Vec2) -> f64 {
        (self - o).len()
    }

    pub fn dist2(self, o: Vec2) -> f64 {
        (self - o).len2()
    }

    pub fn lerp(self, o: Vec2, t: f64) -> Vec2 {
        v(self.x + (o.x - self.x) * t, self.y + (o.y - self.y) * t)
    }

    pub fn normalized(self) -> Vec2 {
        let l = self.len();
        if l == 0.0 {
            Vec2::ZERO
        } else {
            self / l
        }
    }

    /// Rotate 90° counter-clockwise (in math orientation).
    pub fn perp(self) -> Vec2 {
        v(-self.y, self.x)
    }

    pub fn angle(self) -> f64 {
        self.y.atan2(self.x)
    }

    pub fn from_angle(a: f64) -> Vec2 {
        v(a.cos(), a.sin())
    }

    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

impl Add for Vec2 {
    type Output = Vec2;
    fn add(self, o: Vec2) -> Vec2 {
        v(self.x + o.x, self.y + o.y)
    }
}

impl Sub for Vec2 {
    type Output = Vec2;
    fn sub(self, o: Vec2) -> Vec2 {
        v(self.x - o.x, self.y - o.y)
    }
}

impl Mul<f64> for Vec2 {
    type Output = Vec2;
    fn mul(self, s: f64) -> Vec2 {
        v(self.x * s, self.y * s)
    }
}

impl Div<f64> for Vec2 {
    type Output = Vec2;
    fn div(self, s: f64) -> Vec2 {
        v(self.x / s, self.y / s)
    }
}

impl Neg for Vec2 {
    type Output = Vec2;
    fn neg(self) -> Vec2 {
        v(-self.x, -self.y)
    }
}
