//! Integer-kernel input preparation. Validate AFTER rounding: a valid floating
//! boundary can acquire a crossing, endpoint-on-edge, or collapsed hole there.
use super::{v, BBox, DistanceIndex, Vec2};
use crate::index::SpatialIndex;
use std::collections::BTreeMap;

pub(super) struct Input {
    pub coordinates: Vec<i64>,
    pub scale: f64,
    vertices: BTreeMap<(i64, i64), Vec2>,
}

impl Input {
    pub fn restore_vertex(&self, p: Vec2) -> Vec2 {
        let key = (
            (p.x * self.scale).round() as i64,
            (p.y * self.scale).round() as i64,
        );
        let q = v(key.0 as f64 / self.scale, key.1 as f64 / self.scale);
        if p.dist(q) < (0.01 / self.scale).max(f64::EPSILON * p.len() * 8.) {
            *self.vertices.get(&key).unwrap_or(&p)
        } else {
            p
        }
    }
}

pub(super) fn prepare(field: &DistanceIndex, eps: f64) -> Result<Input, String> {
    // Euclidean endpoint error <= sqrt(2)/(2*scale) <= eps/128.
    // Keep the established micron-millionth grid when it already qualifies.
    let mut scale = 1e6_f64.max((128. / eps).ceil());
    let mut cause = String::new();
    for _ in 0..6 {
        let mut vertices = BTreeMap::new();
        let mut coordinates = Vec::with_capacity(field.segments.len() * 4);
        let mut aliased = false;
        for s in &field.segments {
            for p in [s.a, s.b] {
                let x = (p.x * scale).round();
                let y = (p.y * scale).round();
                // Exact integer-to-f64 conversion for the kernel's output
                // coordinates, and ample headroom for exact i128 predicates.
                if !x.is_finite() || !y.is_finite() || x.abs().max(y.abs()) > (1u64 << 50) as f64 {
                    return Err(
                        "contour: boundary exceeds the integer kernel's precision range".into(),
                    );
                }
                let key = (x as i64, y as i64);
                if vertices.insert(key, p).is_some_and(|old| old != p) {
                    aliased = true;
                }
                coordinates.extend([key.0, key.1]);
            }
        }
        if aliased {
            cause = "distinct boundary vertices share one grid point".into();
        } else {
            match validate(&coordinates) {
                Ok(()) => {
                    return Ok(Input {
                        coordinates: coalesce_collinear(&coordinates),
                        scale,
                        vertices,
                    })
                }
                Err(InputError::Topology(e)) => cause = e.into(),
                Err(InputError::WorkBudget) => {
                    return Err(
                        "contour: boundary intersection validation exceeds work budget".into(),
                    )
                }
            }
        }
        scale *= 10.;
    }
    Err(format!(
        "contour: boundary cannot be represented without changing its topology: {cause}"
    ))
}

// A degree-two vertex on a straight boundary is not a distinct distance site.
// Keeping it can create degenerate/unbounded bisectors between collinear sites,
// splitting an otherwise finite interior contour. Merge only exact integer
// collinearity, forward direction, and unambiguous degree-two junctions. This
// changes neither the quantized area nor any hole or branch relationship.
fn coalesce_collinear(input: &[i64]) -> Vec<i64> {
    type Point = [i64; 2];
    let mut segments: Vec<(Point, Point)> = input
        .chunks_exact(4)
        .map(|s| ([s[0], s[1]], [s[2], s[3]]))
        .collect();
    let mut outgoing = BTreeMap::<Point, Vec<usize>>::new();
    let mut incoming = BTreeMap::<Point, usize>::new();
    for (i, &(a, b)) in segments.iter().enumerate() {
        outgoing.entry(a).or_default().push(i);
        *incoming.entry(b).or_default() += 1;
    }
    let mut live = vec![true; segments.len()];
    for i in 0..segments.len() {
        if !live[i] {
            continue;
        }
        loop {
            let (a, b) = segments[i];
            let Some(next) = outgoing.get(&b) else {
                break;
            };
            if next.len() != 1 || incoming.get(&b) != Some(&1) {
                break;
            }
            let j = next[0];
            if j == i || !live[j] {
                break;
            }
            let c = segments[j].1;
            let u = [b[0] as i128 - a[0] as i128, b[1] as i128 - a[1] as i128];
            let w = [c[0] as i128 - b[0] as i128, c[1] as i128 - b[1] as i128];
            if u[0] * w[1] != u[1] * w[0] || u[0] * w[0] + u[1] * w[1] <= 0 {
                break;
            }
            segments[i].1 = c;
            live[j] = false;
        }
    }
    segments
        .into_iter()
        .zip(live)
        .filter(|(_, live)| *live)
        .flat_map(|((a, b), _)| [a[0], a[1], b[0], b[1]])
        .collect()
}

#[derive(Debug)]
enum InputError {
    Topology(&'static str),
    WorkBudget,
}
fn validate(input: &[i64]) -> Result<(), InputError> {
    let segments: Vec<_> = input
        .chunks_exact(4)
        .map(|s| ([s[0], s[1]], [s[2], s[3]]))
        .collect();
    let mut balance = BTreeMap::<[i64; 2], i64>::new();
    for &(a, b) in &segments {
        if a == b {
            return Err(InputError::Topology("collapsed boundary edge"));
        }
        *balance.entry(a).or_default() += 1;
        *balance.entry(b).or_default() -= 1;
    }
    if balance.values().any(|&n| n != 0) {
        return Err(InputError::Topology("open boundary"));
    }
    let boxes: Vec<_> = segments
        .iter()
        .map(|&(a, b)| {
            BBox::from_points(&[v(a[0] as f64, a[1] as f64), v(b[0] as f64, b[1] as f64)])
        })
        .collect();
    let index = SpatialIndex::build(&boxes);
    let orient = |a: [i64; 2], b: [i64; 2], p: [i64; 2]| {
        (b[0] as i128 - a[0] as i128) * (p[1] as i128 - a[1] as i128)
            - (b[1] as i128 - a[1] as i128) * (p[0] as i128 - a[0] as i128)
    };
    let on = |p: [i64; 2], a: [i64; 2], b: [i64; 2]| {
        orient(a, b, p) == 0
            && p[0] >= a[0].min(b[0])
            && p[0] <= a[0].max(b[0])
            && p[1] >= a[1].min(b[1])
            && p[1] <= a[1].max(b[1])
    };
    let mut hits = Vec::new();
    let mut checks = 0usize;
    for (i, &(a, b)) in segments.iter().enumerate() {
        index.query(&boxes[i], &mut hits);
        for &j in &hits {
            if j as usize <= i {
                continue;
            }
            checks += 1;
            if checks > 32_000_000 {
                return Err(InputError::WorkBudget);
            }
            let (c, d) = segments[j as usize];
            if (a == c && b == d) || (a == d && b == c) {
                return Err(InputError::Topology("overlapping boundary edges"));
            }
            for (p, u, w) in [(a, c, d), (b, c, d), (c, a, b), (d, a, b)] {
                if p != u && p != w && on(p, u, w) {
                    return Err(InputError::Topology(
                        "boundary endpoint lies inside another edge",
                    ));
                }
            }
            // Compare signs, never multiply determinants (that can overflow).
            let ac = orient(a, b, c);
            let ad = orient(a, b, d);
            let ca = orient(c, d, a);
            let cb = orient(c, d, b);
            if ac.signum() * ad.signum() < 0 && ca.signum() * cb.signum() < 0 {
                return Err(InputError::Topology("crossing boundary edges"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::Segment;
    use super::*;
    #[test]
    fn collinear_island_has_closed_distance_contours() {
        // Extracted from the live noise-islands example. Its diagonal boundary
        // contains redundant degree-two vertices; separate sites previously
        // left eight degree-one contour junctions at spacing 1.1 mm.
        let input: Vec<i64> = include_str!("fixtures/collinear-island.txt")
            .split_whitespace()
            .map(|s| s.parse().unwrap())
            .collect();
        validate(&input).unwrap();
        let merged = coalesce_collinear(&input);
        assert!(merged.len() < input.len());
        validate(&merged).unwrap();
        // Every original segment still lies on an unchanged merged segment.
        for s in input.chunks_exact(4) {
            assert!(merged.chunks_exact(4).any(|m| {
                s.chunks_exact(2).all(|p| {
                    (m[2] as i128 - m[0] as i128) * (p[1] as i128 - m[1] as i128)
                        == (m[3] as i128 - m[1] as i128) * (p[0] as i128 - m[0] as i128)
                        && p[0] >= m[0].min(m[2])
                        && p[0] <= m[0].max(m[2])
                        && p[1] >= m[1].min(m[3])
                        && p[1] <= m[1].max(m[3])
                })
            }));
        }
        for spacing in [0.18, 1.1, 2.0] {
            let out =
                super::super::analytic::extract(&merged, 1e6, 0.095, spacing, 0.2, 0.01).unwrap();
            assert!(!out.pieces.is_empty());
            let mut degrees = vec![0; out.node_count];
            for p in out.pieces {
                degrees[p.a] += 1;
                degrees[p.b] += 1;
            }
            assert!(degrees.iter().all(|&d| d == 0 || d == 2));
        }
    }
    #[test]
    fn coalescing_keeps_bends_reversals_and_shared_junctions() {
        // One-unit bends are not a simplification opportunity.
        let bent = [0, 0, 1000, 1, 1000, 1, 2000, 0];
        assert_eq!(coalesce_collinear(&bent), bent);
        let reversal = [0, 0, 2, 0, 2, 0, 1, 0];
        assert_eq!(coalesce_collinear(&reversal), reversal);
        let shared = [0, 0, 1, 0, 1, 0, 2, 0, 1, 0, 1, 1, 1, 1, 1, 0];
        assert_eq!(coalesce_collinear(&shared), shared);
    }
    #[test]
    fn refines_collapsed_sliver_without_deleting_it() {
        let points = [v(0., 0.), v(2., 0.), v(2., 0.0000002), v(0., 0.0000002)];
        let field = DistanceIndex::new(
            (0..4)
                .map(|i| Segment {
                    a: points[i],
                    b: points[(i + 1) % 4],
                })
                .collect(),
        );
        let input = prepare(&field, 0.01).unwrap();
        assert!(input.scale > 1e6);
        assert_eq!(input.coordinates.len(), 16);
        for p in points {
            let q = v(
                (p.x * input.scale).round() / input.scale,
                (p.y * input.scale).round() / input.scale,
            );
            assert_eq!(input.restore_vertex(q), p);
        }
    }
    #[test]
    fn rejects_crossings_and_t_junctions_but_allows_shared_endpoints() {
        assert!(validate(&[0, 0, 4, 4, 4, 4, 0, 4, 0, 4, 4, 0, 4, 0, 0, 0]).is_err());
        assert!(validate(&[
            0, 0, 4, 0, 4, 0, 0, 4, 0, 4, 0, 0, 2, 0, 3, 1, 3, 1, 2, 1, 2, 1, 2, 0
        ])
        .is_err());
        assert!(validate(&[
            0, 0, 4, 0, 4, 0, 0, 4, 0, 4, 0, 0, 0, 0, -4, 0, -4, 0, 0, -4, 0, -4, 0, 0
        ])
        .is_ok());
    }
}
