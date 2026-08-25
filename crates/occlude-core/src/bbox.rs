use crate::vec2::Vec2;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BBox {
    pub min: Vec2,
    pub max: Vec2,
}

impl BBox {
    pub const EMPTY: BBox = BBox {
        min: Vec2 {
            x: f64::INFINITY,
            y: f64::INFINITY,
        },
        max: Vec2 {
            x: f64::NEG_INFINITY,
            y: f64::NEG_INFINITY,
        },
    };

    pub fn new(min: Vec2, max: Vec2) -> BBox {
        BBox { min, max }
    }

    pub fn from_points(pts: &[Vec2]) -> BBox {
        let mut b = BBox::EMPTY;
        for &p in pts {
            b.grow_point(p);
        }
        b
    }

    pub fn is_empty(&self) -> bool {
        self.min.x > self.max.x || self.min.y > self.max.y
    }

    pub fn grow_point(&mut self, p: Vec2) {
        self.min.x = self.min.x.min(p.x);
        self.min.y = self.min.y.min(p.y);
        self.max.x = self.max.x.max(p.x);
        self.max.y = self.max.y.max(p.y);
    }

    pub fn union(&self, o: &BBox) -> BBox {
        BBox {
            min: Vec2 {
                x: self.min.x.min(o.min.x),
                y: self.min.y.min(o.min.y),
            },
            max: Vec2 {
                x: self.max.x.max(o.max.x),
                y: self.max.y.max(o.max.y),
            },
        }
    }

    pub fn overlaps(&self, o: &BBox) -> bool {
        self.min.x <= o.max.x
            && o.min.x <= self.max.x
            && self.min.y <= o.max.y
            && o.min.y <= self.max.y
    }

    pub fn contains_box(&self, o: &BBox) -> bool {
        self.min.x <= o.min.x
            && self.min.y <= o.min.y
            && self.max.x >= o.max.x
            && self.max.y >= o.max.y
    }

    pub fn contains_point(&self, p: Vec2) -> bool {
        p.x >= self.min.x && p.x <= self.max.x && p.y >= self.min.y && p.y <= self.max.y
    }

    pub fn width(&self) -> f64 {
        (self.max.x - self.min.x).max(0.0)
    }

    pub fn height(&self) -> f64 {
        (self.max.y - self.min.y).max(0.0)
    }

    pub fn area(&self) -> f64 {
        self.width() * self.height()
    }

    pub fn center(&self) -> Vec2 {
        Vec2 {
            x: (self.min.x + self.max.x) * 0.5,
            y: (self.min.y + self.max.y) * 0.5,
        }
    }

    /// Exact segment-vs-box overlap (separating axis). Much tighter than
    /// bbox-vs-bbox for diagonal segments, whose own bbox is a large square.
    pub fn intersects_segment(&self, p0: Vec2, p1: Vec2) -> bool {
        // Axis tests (segment bbox vs box).
        if p0.x.max(p1.x) < self.min.x
            || p0.x.min(p1.x) > self.max.x
            || p0.y.max(p1.y) < self.min.y
            || p0.y.min(p1.y) > self.max.y
        {
            return false;
        }
        // Separating axis along the segment normal: all four corners on one
        // side means no intersection.
        let d = p1 - p0;
        let c = |x: f64, y: f64| d.cross(Vec2 { x, y } - p0);
        let s1 = c(self.min.x, self.min.y);
        let s2 = c(self.max.x, self.min.y);
        let s3 = c(self.max.x, self.max.y);
        let s4 = c(self.min.x, self.max.y);
        let all_pos = s1 > 0.0 && s2 > 0.0 && s3 > 0.0 && s4 > 0.0;
        let all_neg = s1 < 0.0 && s2 < 0.0 && s3 < 0.0 && s4 < 0.0;
        !(all_pos || all_neg)
    }

    pub fn expanded(&self, pad: f64) -> BBox {
        BBox {
            min: Vec2 {
                x: self.min.x - pad,
                y: self.min.y - pad,
            },
            max: Vec2 {
                x: self.max.x + pad,
                y: self.max.y + pad,
            },
        }
    }
}
