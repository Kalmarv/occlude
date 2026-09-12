//! Coherent exact visibility certificates for unchanged nearby primitives.
use crate::{index::SpatialIndex, primitive::Primitive, region::Region, vec2::Vec2};

pub(crate) struct ContinuationCertifier {
    boundaries: SpatialIndex,
    closed: bool,
    hits: Vec<u32>,
    last_end: Option<Vec2>,
    #[cfg(test)]
    fast_hits: usize,
}
impl ContinuationCertifier {
    /// Include every boundary involved in the visibility predicate: source,
    /// clips, occluders, and the occluders' own clips.
    pub(crate) fn new<'a>(regions: impl IntoIterator<Item = &'a Region>) -> Self {
        let regions: Vec<_> = regions.into_iter().collect();
        // Arbitrary native callers can supply open contour records. Their ray
        // predicate need not describe components bounded by these primitives.
        // Preserve the original predicate for those inputs instead of caching.
        let closed = regions.iter().all(|region| {
            region.contours.iter().all(|ring| {
                ring.iter()
                    .zip(ring.iter().cycle().skip(1))
                    .take(ring.len())
                    .all(|(a, b)| a.end().dist(b.start()) <= 4. * crate::snap::GRID)
            })
        });
        let boxes: Vec<_> = regions
            .into_iter()
            .flat_map(Region::boundary)
            .map(Primitive::bbox)
            .collect();
        Self {
            boundaries: SpatialIndex::build(&boxes),
            closed,
            hits: Vec::new(),
            last_end: None,
            #[cfg(test)]
            fast_hits: 0,
        }
    }
    pub(crate) fn certify(&mut self, p: &Primitive, slow: impl FnOnce() -> bool) -> bool {
        // This rectangle contains the WHOLE primitive, not just sample points.
        // Expanding covers both clipping's boundary band and endpoint welding.
        let bounds = p
            .bbox()
            .expanded((4. * crate::snap::GRID).max(crate::clip::ON_BOUNDARY_EPS));
        if self.closed
            && p.start().is_finite()
            && p.end().is_finite()
            && self
                .last_end
                .is_some_and(|known| bounds.contains_point(known))
        {
            self.boundaries.query(&bounds, &mut self.hits);
            if self.hits.is_empty() {
                // A whole-primitive bbox clear of ALL boundaries proves that
                // the connected rectangle has one visibility class. It contains
                // both a certified point and the entire new primitive. This also
                // handles floating junction differences without changing any ink.
                // Debug builds independently cross-check the original predicate.
                debug_assert!(
                    slow(),
                    "continuation certificate disagrees with exact clipping"
                );
                self.last_end = Some(p.end());
                #[cfg(test)]
                {
                    self.fast_hits += 1;
                }
                return true;
            }
        }
        let valid = slow();
        self.last_end = valid.then(|| p.end());
        valid
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{primitive::Line, region::WindingRule, vec2::v};
    fn ring(a: f64, b: f64) -> Vec<Primitive> {
        let points = [v(a, a), v(b, a), v(b, b), v(a, b)];
        points
            .iter()
            .zip(points.iter().cycle().skip(1))
            .take(4)
            .map(|(&a, &b)| Primitive::Line(Line::new(a, b)))
            .collect()
    }
    #[test]
    fn open_region_records_keep_the_original_predicate() {
        let region = Region::new(
            vec![vec![Primitive::Line(Line::new(v(0., 0.), v(0., 10.)))]],
            WindingRule::NonZero,
            false,
        );
        let mut cache = ContinuationCertifier::new([&region]);
        assert!(!cache.closed);
        for (a, b) in [(v(1., 1.), v(2., 1.)), (v(2., 1.), v(3., 1.))] {
            let p = Primitive::Line(Line::new(a, b));
            cache.certify(&p, || super::super::inside_segment(&p, &region));
        }
        assert_eq!(cache.fast_hits, 0);
    }

    #[test]
    fn continuation_reuses_only_boundary_clear_connected_ink() {
        let region = Region::new(
            vec![ring(0., 10.), ring(4., 6.)],
            WindingRule::EvenOdd,
            false,
        );
        let mut cache = ContinuationCertifier::new([&region]);
        for (a, b, expected) in [
            (v(1., 1.), v(2., 1.), true),
            (v(2., 1.), v(3., 1.), true),
            (v(3. + 1e-12, 1.), v(3.5, 1.), true), // geometric proof, not a snapped junction
            (v(3., 1.), v(8., 8.), false),         // crosses the hole, despite visible endpoints
            (v(8., 8.), v(9., 8.), true),          // failed predecessor cannot seed reuse
            (v(1., 8.), v(2., 8.), true),          // intentional gap requires a fresh certificate
            (v(2., 8.), v(2., 10.), true),
            (v(2., 10.), v(3., 10.), false), // on-boundary span must not be inherited
        ] {
            let p = Primitive::Line(Line::new(a, b));
            let exact = || super::super::inside_segment(&p, &region);
            assert_eq!(exact(), expected);
            assert_eq!(cache.certify(&p, exact), expected);
        }
        assert_eq!(cache.fast_hits, 2);
    }
}
