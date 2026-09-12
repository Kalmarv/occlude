//! Analytic distance-field contour fill, enabled by `contour-sdf`.
//! The Boolean visible area and the exact pre-modifier visibility check are
//! shared with production. No offset kernel or swept-ink Boolean is used here.
//!
//! Distance levels are extracted analytically from point/segment Voronoi cells.
//! Medial branches supply vector cleanup candidates; original scene geometry
//! certifies every final primitive before finishing modifiers.
//!
//! Construction error allocations (fractions of error_budget in paper mm):
//! boundary flattening 1/4, integer conversion 1/128, independent level shift
//! 1/64, parabola subdivision 1/8, cleanup simplification 1/4, arc fit 1/4,
//! and optional boundary-end trimming 1/32. These sum to 119/128, reserving
//! the rest for normalization/numeric error. No offset-level drift accumulates.
//! Original-curve visibility certification triggers bounded refinement when needed.
use super::*;
mod analytic;
mod circular;
mod input;
mod routing;

#[derive(Debug)]
pub(super) enum GenerationError {
    Invalid(String),
    Visibility(String),
}
impl From<String> for GenerationError {
    fn from(s: String) -> Self {
        Self::Invalid(s)
    }
}
impl From<&str> for GenerationError {
    fn from(s: &str) -> Self {
        Self::Invalid(s.into())
    }
}
impl From<GenerationError> for String {
    fn from(e: GenerationError) -> String {
        match e {
            GenerationError::Invalid(s) | GenerationError::Visibility(s) => s,
        }
    }
}
impl std::fmt::Display for GenerationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(s) | Self::Visibility(s) => f.write_str(s),
        }
    }
}

#[derive(Clone, Copy)]
struct Segment {
    a: Vec2,
    b: Vec2,
}
impl Segment {
    fn closest(self, p: Vec2) -> Vec2 {
        let d = self.b - self.a;
        let t = if d.len2() == 0.0 {
            0.0
        } else {
            ((p - self.a).dot(d) / d.len2()).clamp(0.0, 1.0)
        };
        self.a + d * t
    }
    fn bbox(self) -> BBox {
        BBox::from_points(&[self.a, self.b])
    }
}
struct Node {
    bbox: BBox,
    begin: usize,
    end: usize,
    children: Option<(usize, usize)>,
}
struct DistanceIndex {
    segments: Vec<Segment>,
    nodes: Vec<Node>,
    #[cfg(test)]
    nearest_visits: std::cell::Cell<usize>,
}
fn box_distance2(b: BBox, p: Vec2) -> f64 {
    let dx = (b.min.x - p.x).max(0.0).max(p.x - b.max.x);
    let dy = (b.min.y - p.y).max(0.0).max(p.y - b.max.y);
    dx * dx + dy * dy
}
impl DistanceIndex {
    fn new(mut segments: Vec<Segment>) -> Self {
        fn build(s: &mut [Segment], begin: usize, nodes: &mut Vec<Node>) -> usize {
            let bbox = s.iter().fold(BBox::EMPTY, |b, s| b.union(&s.bbox()));
            let i = nodes.len();
            nodes.push(Node {
                bbox,
                begin,
                end: begin + s.len(),
                children: None,
            });
            if s.len() > 8 {
                // Split by centroid spread, not primitive extent. Parallel
                // long lines have wide boxes but identical x centroids; an
                // extent-based split repeatedly partitions ties and turns a
                // nearest-ink query into a scan of almost every contour.
                let centers = s.iter().fold(BBox::EMPTY, |b, s| {
                    b.union(&BBox::from_points(&[(s.a + s.b) * 0.5]))
                });
                let x = centers.width() >= centers.height();
                let mid = s.len() / 2;
                s.select_nth_unstable_by(mid, |a, b| {
                    let a = if x { a.a.x + a.b.x } else { a.a.y + a.b.y };
                    let b = if x { b.a.x + b.b.x } else { b.a.y + b.b.y };
                    a.total_cmp(&b)
                });
                let (left, right) = s.split_at_mut(mid);
                let l = build(left, begin, nodes);
                let r = build(right, begin + mid, nodes);
                nodes[i].children = Some((l, r));
            }
            i
        }
        let mut nodes = Vec::new();
        if !segments.is_empty() {
            build(&mut segments, 0, &mut nodes);
        }
        Self {
            segments,
            nodes,
            #[cfg(test)]
            nearest_visits: Default::default(),
        }
    }
    fn nearest(&self, p: Vec2, limit: f64) -> (f64, Option<Segment>) {
        self.nearest_seeded(p, limit, None)
    }
    // The hint must be a segment from this index. Its distance is an upper
    // bound, so spatially coherent queries can prune without changing the
    // minimum distance or relying on a guessed search radius.
    fn nearest_seeded(&self, p: Vec2, limit: f64, seed: Option<Segment>) -> (f64, Option<Segment>) {
        #[cfg(test)]
        self.nearest_visits.set(0);
        let mut best = limit * limit;
        let mut found = None;
        if let Some(s) = seed {
            let d = s.closest(p).dist2(p);
            if d < best {
                best = d;
                found = Some(s);
            }
        }
        if self.nodes.is_empty() {
            return (limit, None);
        }
        let mut stack = [0usize; 64];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let n = &self.nodes[stack[top]];
            #[cfg(test)]
            self.nearest_visits.set(self.nearest_visits.get() + 1);
            if box_distance2(n.bbox, p) > best {
                continue;
            }
            if let Some((l, r)) = n.children {
                let (near, far) = if box_distance2(self.nodes[l].bbox, p)
                    <= box_distance2(self.nodes[r].bbox, p)
                {
                    (l, r)
                } else {
                    (r, l)
                };
                stack[top] = far;
                stack[top + 1] = near;
                top += 2;
            } else {
                for &s in &self.segments[n.begin..n.end] {
                    let d = s.closest(p).dist2(p);
                    if d < best {
                        best = d;
                        found = Some(s);
                    }
                }
            }
        }
        (best.sqrt(), found)
    }
    #[cfg(test)]
    fn inside(&self, p: Vec2) -> bool {
        let segments: Vec<_> = self.segments.iter().map(|s| (s.a, s.b)).collect();
        let boxes: Vec<_> = self.segments.iter().map(|s| s.bbox()).collect();
        let index = crate::index::SpatialIndex::build(&boxes);
        let maxx = self.nodes[0].bbox.max.x;
        analytic::inside(p, &segments, &index, maxx, &mut Vec::new())
    }
    #[cfg(test)]
    fn signed(&self, p: Vec2) -> f64 {
        let d = self.nearest(p, f64::INFINITY).0;
        if self.inside(p) {
            d
        } else {
            -d
        }
    }
}

fn fit_arc(points: &[Vec2], tolerance: f64) -> Option<Primitive> {
    if points.len() < 4 {
        return None;
    }
    let a = points[0];
    let b = points[points.len() / 2];
    let c = *points.last()?;
    let u = b - a;
    let w = c - a;
    let det = 2.0 * u.cross(w);
    if det.abs() < 1e-12 * u.len() * w.len() || det == 0.0 {
        return None;
    }
    let center = a + v(
        (u.len2() * w.y - w.len2() * u.y) / det,
        (u.x * w.len2() - w.x * u.len2()) / det,
    );
    let r = a.dist(center);
    if !center.is_finite() || !r.is_finite() || r > 1e6 || r < tolerance {
        return None;
    }
    let sign = det.signum();
    let start = (a - center).angle();
    let mut previous = 0.0;
    for (i, &p) in points.iter().enumerate().skip(1) {
        let mut angle = ((p - center).angle() - start) * sign;
        if angle < -1e-10 {
            angle += std::f64::consts::TAU;
        }
        if angle < previous - 1e-10 || angle > std::f64::consts::PI + 1e-10 {
            return None;
        }
        if (p.dist(center) - r).abs() > tolerance {
            return None;
        }
        let chord = Segment {
            a: points[i - 1],
            b: p,
        };
        if chord.closest(center).dist(center) < r - tolerance {
            return None;
        }
        previous = angle;
    }
    if previous < 1e-5 {
        return None;
    }
    Some(Primitive::Arc(Arc::new(center, r, start, sign * previous)))
}
fn closed_circle(points: &[Vec2], tolerance: f64) -> Option<Vec<Primitive>> {
    if points.len() < 7 || points[0].dist(*points.last()?) > 1e-10 {
        return None;
    }
    let a = points[0];
    let u = points[points.len() / 3] - a;
    let w = points[2 * points.len() / 3] - a;
    let det = 2.0 * u.cross(w);
    if det.abs() < 1e-12 * u.len() * w.len() || det == 0.0 {
        return None;
    }
    let center = a + v(
        (u.len2() * w.y - w.len2() * u.y) / det,
        (u.x * w.len2() - w.x * u.len2()) / det,
    );
    let radius = a.dist(center);
    if !center.is_finite() || radius < tolerance || radius > 1e6 {
        return None;
    }
    let sign = det.signum();
    let mut angle = 0.0;
    for pair in points.windows(2) {
        let d = pair[1] - center;
        let previous = pair[0] - center;
        let step = previous.cross(d).atan2(previous.dot(d)) * sign;
        if step < -1e-10 || (d.len() - radius).abs() > tolerance {
            return None;
        }
        if (Segment {
            a: pair[0],
            b: pair[1],
        })
        .closest(center)
        .dist(center)
            < radius - tolerance
        {
            return None;
        }
        angle += step;
    }
    if (angle - std::f64::consts::TAU).abs() > 1e-8 {
        return None;
    }
    let start = (a - center).angle();
    let sweep = sign * std::f64::consts::PI;
    Some(vec![
        Primitive::Arc(Arc::new(center, radius, start, sweep)),
        Primitive::Arc(Arc::new(center, radius, start + sweep, sweep)),
    ])
}
fn reconstruct_arcs(lines: Vec<Primitive>, tolerance: f64) -> Vec<Primitive> {
    let _zone = crate::profile::zone("SDF arc reconstruction");
    if lines.len() < 4 {
        return lines;
    }
    let mut points: Vec<_> = lines.iter().map(Primitive::start).collect();
    points.push(lines.last().unwrap().end());
    if let Some(circle) = closed_circle(&points, tolerance) {
        return circle;
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < points.len() {
        let mut best = None;
        for span in [3usize, 6, 12, 24, 48, 96, 192] {
            let end = (i + span).min(points.len() - 1);
            if end - i < 3 {
                break;
            }
            if let Some(arc) = fit_arc(&points[i..=end], tolerance) {
                best = Some((end, arc));
            } else {
                break;
            }
            if end == points.len() - 1 {
                break;
            }
        }
        if let Some((end, arc)) = best {
            out.push(arc);
            i = end;
        } else {
            out.push(lines[i]);
            i += 1;
        }
    }
    out
}

/// Static contour BVH plus local, incrementally added cleanup segments.
/// A query visits one bucket; no all-pairs or repeated swept-area unions.
struct Ink {
    initial: DistanceIndex,
    radius: f64,
}
impl Ink {
    fn new(runs: &[Vec<Primitive>], radius: f64, eps: f64) -> Self {
        let mut segments = Vec::new();
        let mut points = Vec::new();
        for p in runs.iter().flatten() {
            points.clear();
            p.flatten(eps / 4., &mut points);
            segments.extend(points.windows(2).map(|p| Segment { a: p[0], b: p[1] }));
        }
        Self {
            initial: DistanceIndex::new(segments),
            // A chord can understate distance to its arc by eps/4.
            radius: radius - eps / 4.,
        }
    }
}

/// Medial branches may end exactly on a boundary, which keep-inside clipping
/// excludes. Reserve eps/32 for moving each end inward along its own segment.
/// A shorter-than-eps/16 segment becomes a certified tap. The Hausdorff change
/// is bounded by eps/32, including for the round-nib footprint. Any introduced
/// discontinuity starts a new run; it is never an implicit pen-down jump.
fn validated_cleanup(
    patch: Vec<Primitive>,
    eps: f64,
    certify: &dyn Fn(&Primitive) -> bool,
) -> Result<Vec<Vec<Primitive>>, GenerationError> {
    let mut runs = Vec::new();
    let mut current: Vec<Primitive> = Vec::new();
    for p in patch {
        let q = if certify(&p) {
            p
        } else if matches!(p, Primitive::Line(_)) && p.length() > 0. {
            let trim = (eps / (32. * p.length())).min(0.5);
            let q = p.sub(trim, 1. - trim);
            if !certify(&q) {
                return Err(GenerationError::Visibility(format!(
                    "contour: medial cleanup failed exact visibility validation: {p:?}"
                )));
            }
            q
        } else {
            return Err(GenerationError::Visibility(format!(
                "contour: medial cleanup failed exact visibility validation: {p:?}"
            )));
        };
        if current
            .last()
            .is_some_and(|previous| previous.end() != q.start())
        {
            runs.push(std::mem::take(&mut current));
        }
        current.push(q);
    }
    if !current.is_empty() {
        runs.push(current);
    }
    Ok(runs)
}

pub(super) fn generate(
    components: Vec<Shape<f64>>,
    width: f64,
    spacing: f64,
    certify: &dyn Fn(&Primitive) -> bool,
) -> Result<Generated, GenerationError> {
    generate_at_tolerance(
        components,
        width,
        spacing,
        error_budget(width, spacing)?,
        certify,
    )
}

pub(super) fn generate_at_tolerance(
    components: Vec<Shape<f64>>,
    width: f64,
    spacing: f64,
    eps: f64,
    certify: &dyn Fn(&Primitive) -> bool,
) -> Result<Generated, GenerationError> {
    let mut result = Generated::default();
    result.diagnostics.components = components.len();
    for component in components {
        if let Some(ink) = circular::generate(
            &component,
            width,
            spacing,
            eps,
            MAX_PRIMITIVES.saturating_sub(count_prims(&result.runs)),
        )? {
            let base = result.runs.len();
            result
                .cleanup_runs
                .extend(ink.cleanup_runs.into_iter().map(|i| base + i));
            result.diagnostics.add(&ink.diagnostics);
            result.runs.extend(ink.runs);
            continue;
        }
        let polygons = shape_polygons(&component, eps);
        let segments = polygons
            .iter()
            .flatten()
            .flat_map(|ring| {
                ring.iter()
                    .zip(ring.iter().cycle().skip(1))
                    .take(ring.len())
                    .map(|(a, b)| Segment {
                        a: v(a[0], a[1]),
                        b: v(b[0], b[1]),
                    })
            })
            .collect();
        let field = DistanceIndex::new(segments);
        if field.nodes.is_empty() {
            continue;
        }
        let begin = result.runs.len();
        let (rings, patches, levels, regular_levels) = {
            let _zone = crate::profile::zone("SDF analytic extraction");
            analytic::contours(&field, width, spacing, eps, certify)?
        };
        #[cfg(feature = "profile")]
        eprintln!(
            "SDF marched: {} rings, {} segments",
            rings.len(),
            count_prims(&rings)
        );
        result.diagnostics.levels += levels;
        result.diagnostics.contours += rings.len();
        // Final exact validation happens once after all construction and
        // simplification, before the resulting ink reaches finishing modifiers.
        let routing_zone = crate::profile::zone("SDF contour routing");
        result.runs.extend(routing::join(
            rings,
            &regular_levels,
            spacing,
            certify,
            &mut result.diagnostics,
        ));
        drop(routing_zone);
        #[cfg(feature = "profile")]
        eprintln!("SDF validated: {} segments", count_prims(&result.runs));
        // Sparse contours intentionally leave gaps. Never densify them.
        if spacing <= width {
            let _zone = crate::profile::zone("SDF residual finishing");
            for patch in patches {
                for run in validated_cleanup(patch, eps, certify)? {
                    result.cleanup_runs.insert(result.runs.len());
                    result.diagnostics.residual_patches += 1;
                    result.runs.push(run);
                }
            }
            // Reuse the existing bounded, whole-interval-certified local join
            // for cleanup marks only. Regular contour loops stay independent.
            cleanup::join(&mut result, begin, spacing, certify);
            for &index in result.cleanup_runs.range(begin..) {
                let original = &result.runs[index];
                if original.len() < 3 {
                    continue;
                }
                // Completion has eps/2 of coverage slack. Reserve the other
                // half for one simplification/arc fit, and validate any new
                // geometry before accepting it. Failed fits keep the ink.
                let simplified =
                    reconstruct_arcs(cleanup::simplify(original.clone(), eps * 2.0), eps / 4.0);
                if simplified.len() < original.len() && simplified.iter().all(certify) {
                    result.runs[index] = simplified;
                }
            }
        } else if result.runs.len() == begin {
            let fallback = hatch(
                &shape_region(&component),
                spacing,
                true,
                MAX_PRIMITIVES.saturating_sub(count_prims(&result.runs)),
            )?;
            result.diagnostics.fallbacks += 1;
            result.diagnostics.fallback_thin += 1;
            for run in fallback {
                result.fallback_runs.insert(result.runs.len());
                result.runs.push(run);
            }
        }
        #[cfg(feature = "profile")]
        eprintln!("SDF complete: {} segments", count_prims(&result.runs));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn polygon(points: &[[f64; 2]]) -> Shape<f64> {
        polygon_shape(&[points.to_vec()])
    }
    fn square() -> Shape<f64> {
        polygon(&[[0., 0.], [10., 0.], [10., 10.], [0., 10.]])
    }
    fn valid(p: &Primitive, r: &Region) -> bool {
        let mut spans = vec![crate::fragment::Span {
            t0: 0.,
            t1: 1.,
            visible: true,
        }];
        let mut scratch = Vec::new();
        crate::clip::clip_spans(p, &mut spans, r, true, &mut scratch);
        spans.len() == 1 && spans[0].visible && spans[0].t0 == 0. && spans[0].t1 == 1.
    }
    #[test]
    fn adjacent_float_event_rows_keep_the_half_open_sign_rule() {
        let low = f64::from_bits(1.0_f64.to_bits() + 1);
        let high = f64::from_bits(low.to_bits() + 1);
        let points = [v(0., low), v(2., low), v(2., high), v(0., high)];
        let field = DistanceIndex::new(
            (0..4)
                .map(|i| Segment {
                    a: points[i],
                    b: points[(i + 1) % 4],
                })
                .collect(),
        );
        assert!(field.inside(v(1., low)));
        assert!(!field.inside(v(1., high)));
    }
    #[test]
    fn coherent_nearest_queries_keep_exact_distances_and_reduce_tree_visits() {
        let field = DistanceIndex::new(
            (0..1000)
                .map(|i| {
                    let a = v((i % 37) as f64 * 0.7, (i / 37) as f64 * 0.8);
                    Segment {
                        a,
                        b: a + Vec2::from_angle(i as f64 * 0.73) * 0.6,
                    }
                })
                .collect(),
        );
        let mut seed = None;
        let mut ordinary_visits = 0;
        let mut seeded_visits = 0;
        for i in 0..4000 {
            let p = v((i % 100) as f64 * 0.27, (i / 100) as f64 * 0.58);
            let expected = field.nearest(p, f64::INFINITY).0;
            ordinary_visits += field.nearest_visits.get();
            let (actual, next) = field.nearest_seeded(p, f64::INFINITY, seed);
            seeded_visits += field.nearest_visits.get();
            assert_eq!(actual.to_bits(), expected.to_bits());
            seed = next;
        }
        assert!(seeded_visits < ordinary_visits);
    }
    #[test]
    fn nearest_parallel_contours_does_not_scan_the_whole_index() {
        let segments = (0..10_000)
            .map(|i| Segment {
                a: v(-10000., i as f64),
                b: v(10000., i as f64),
            })
            .collect();
        let index = DistanceIndex::new(segments);
        assert_eq!(index.nearest(v(0., 5000.25), f64::INFINITY).0, 0.25);
        assert!(
            index.nearest_visits.get() < 128,
            "visited {} nodes",
            index.nearest_visits.get()
        );
    }
    #[test]
    fn distance_sign_matches_direct_crossings_at_vertices_and_between_them() {
        let rings = vec![
            vec![v(0., 0.), v(9., 0.3), v(10., 8.), v(5., 10.), v(0., 8.)],
            vec![v(3., 2.), v(5., 2.1), v(6., 6.), v(2., 6.2)],
        ];
        let segments: Vec<_> = rings
            .iter()
            .flat_map(|r| {
                r.iter()
                    .zip(r.iter().cycle().skip(1))
                    .take(r.len())
                    .map(|(&a, &b)| Segment { a, b })
            })
            .collect();
        let field = DistanceIndex::new(segments.clone());
        let mut ys: Vec<_> = (-10..110).map(|i| i as f64 / 10.).collect();
        for s in &segments {
            ys.extend([s.a.y - 1e-12, s.a.y, s.a.y + 1e-12]);
        }
        for y in ys {
            for i in -10..110 {
                let p = v(i as f64 * 0.1 + 0.037, y);
                let count = segments
                    .iter()
                    .filter(|s| (s.a.y > y) != (s.b.y > y))
                    .filter(|s| s.a.x + (y - s.a.y) * (s.b.x - s.a.x) / (s.b.y - s.a.y) <= p.x)
                    .count();
                assert_eq!(field.inside(p), count % 2 == 1, "{p:?}");
            }
        }
    }
    #[test]
    fn complete_circle_fit_rejects_a_second_lap() {
        let points: Vec<_> = (0..=128)
            .map(|i| Vec2::from_angle(i as f64 * std::f64::consts::TAU / 128.) * 4.)
            .collect();
        assert_eq!(closed_circle(&points, 0.01).unwrap().len(), 2);
        let twice: Vec<_> = points[..128].iter().chain(points.iter()).copied().collect();
        assert!(closed_circle(&twice, 0.01).is_none());
    }
    #[test]
    fn reconstructed_arcs_bound_the_whole_polyline() {
        let points: Vec<_> = (0..=64)
            .map(|i| Vec2::from_angle(i as f64 * std::f64::consts::PI / 64.0) * 10.0)
            .collect();
        let arc = fit_arc(&points, 0.01).unwrap();
        assert!(matches!(arc, Primitive::Arc(_)));
        for pair in points.windows(2) {
            for i in 0..=10 {
                assert!(arc.dist_to(pair[0].lerp(pair[1], i as f64 / 10.0)) <= 0.010001);
            }
        }
        let reversal = vec![points[0], points[8], points[4], points[12]];
        assert!(fit_arc(&reversal, 0.01).is_none());
    }
    #[test]
    fn field_distance_and_hole_sign() {
        let polygons = vec![
            vec![[0., 0.], [10., 0.], [10., 10.], [0., 10.]],
            vec![[4., 4.], [6., 4.], [6., 6.], [4., 6.]],
        ];
        let segments = polygons
            .iter()
            .flat_map(|r| {
                r.iter()
                    .zip(r.iter().cycle().skip(1))
                    .take(r.len())
                    .map(|(a, b)| Segment {
                        a: v(a[0], a[1]),
                        b: v(b[0], b[1]),
                    })
            })
            .collect();
        let f = DistanceIndex::new(segments);
        assert_eq!(f.signed(v(5., 5.)), -1.);
        assert_eq!(f.signed(v(2., 5.)), 2.);
        assert_eq!(f.signed(v(-2., 5.)), -2.);
    }
    #[test]
    fn square_and_attached_thin_finger_are_actually_covered() {
        for source in [
            square(),
            polygon(&[
                [0., 0.],
                [10., 0.],
                [10., 4.9],
                [17., 4.9],
                [17., 5.1],
                [10., 5.1],
                [10., 10.],
                [0., 10.],
            ]),
        ] {
            let r = shape_region(&source);
            let certify = |p: &Primitive| valid(p, &r);
            let ink = generate(vec![source], 0.5, 0.45, &certify).unwrap();
            assert!(ink.diagnostics.levels > 5);
            let segments: Vec<_> = ink.runs.iter().flatten().collect();
            // Includes the actual 0.2 mm finger, which a half-nib erosion loses.
            for y in 0..200 {
                for x in 0..340 {
                    let p = v((x as f64 + 0.37) * 0.05, (y as f64 + 0.61) * 0.05);
                    if r.inside(p) {
                        assert!(
                            segments
                                .iter()
                                .map(|s| s.dist_to(p))
                                .fold(f64::INFINITY, f64::min)
                                <= 0.25 + 0.01,
                            "uncovered {p:?}"
                        );
                    }
                }
            }
        }
    }
    #[test]
    fn annulus_u_and_thin_sliver_keep_visible_ink_and_continuity() {
        let annulus = Region::new(
            vec![
                vec![Primitive::Arc(Arc::new(
                    v(0., 0.),
                    5.,
                    0.,
                    std::f64::consts::TAU,
                ))],
                vec![Primitive::Arc(Arc::new(
                    v(0., 0.),
                    2.,
                    0.,
                    std::f64::consts::TAU,
                ))],
            ],
            WindingRule::EvenOdd,
            false,
        );
        let u = shape_region(&polygon(&[
            [0., 0.],
            [3., 0.],
            [3., 6.],
            [7., 6.],
            [7., 0.],
            [10., 0.],
            [10., 10.],
            [0., 10.],
        ]));
        let sliver = shape_region(&polygon(&[[0., 0.], [10., 0.], [10., 0.03], [0., 0.03]]));
        for region in [annulus, u, sliver] {
            let source = visible_components(&region, &[], &[], 0.01).unwrap();
            let ink = generate(source, 0.5, 0.45, &|p| valid(p, &region)).unwrap();
            assert!(!ink.runs.is_empty());
            for run in &ink.runs {
                for p in run {
                    assert!(valid(p, &region));
                    assert!(p.start().is_finite() && p.end().is_finite());
                }
                for pair in run.windows(2) {
                    assert!(pair[0].end().dist(pair[1].start()) < 1e-12);
                }
            }
            // Shifted diagnostic lattice independent of the marching grid.
            let mut maximum = 0.0_f64;
            for j in 0..100 {
                for i in 0..100 {
                    let b = region.bbox;
                    let p = v(
                        b.min.x + (i as f64 + 0.319) * b.width() / 100.,
                        b.min.y + (j as f64 + 0.713) * b.height() / 100.,
                    );
                    if region.inside(p) {
                        let d = ink
                            .runs
                            .iter()
                            .flatten()
                            .map(|s| s.dist_to(p))
                            .fold(f64::INFINITY, f64::min);
                        maximum = maximum.max(d);
                    }
                }
            }
            eprintln!(
                "SDF independent coverage: max distance {maximum:.6} mm at nib radius 0.25 mm"
            );
            assert!(maximum <= 0.26);
        }
    }
    #[test]
    fn sparse_does_not_add_dense_cleanup_and_is_deterministic() {
        let a = generate(vec![square()], 0.5, 2., &|_| true).unwrap();
        let b = generate(vec![square()], 0.5, 2., &|_| true).unwrap();
        assert_eq!(a.diagnostics.residual_patches, 0);
        assert_eq!(format!("{:?}", a.runs), format!("{:?}", b.runs));
        assert!(generate(vec![square()], 0., 1., &|_| true).is_err());
    }

    #[test]
    fn analytic_transformed_thin_features_keep_actual_coverage() {
        let outlines = [
            // Thin attached features must be sampled directly, not erased from
            // the test target by a half-nib inset.
            vec![
                [0., 0.],
                [3., 0.],
                [3., 1.49],
                [5., 1.49],
                [5., 1.51],
                [3., 1.51],
                [3., 3.],
                [0., 3.],
            ],
            vec![[0., 0.], [5., 0.], [5., 0.007], [0., 0.007]],
            vec![[0., 0.], [5., 0.], [0.02, 0.015]],
        ];
        for (fixture, points) in outlines.iter().enumerate() {
            for (angle, sx, sy) in [(0.0_f64, 1., 1.), (0.371_f64, -1.3, 0.7)] {
                let transform = |p: Vec2| {
                    let p = v(p.x * sx, p.y * sy);
                    v(
                        p.x * angle.cos() - p.y * angle.sin() + 17.321,
                        p.x * angle.sin() + p.y * angle.cos() + 9.123,
                    )
                };
                let transformed: Vec<_> = points
                    .iter()
                    .map(|p| {
                        let p = transform(v(p[0], p[1]));
                        [p.x, p.y]
                    })
                    .collect();
                let region = shape_region(&polygon(&transformed));
                for width in [0.01, 0.02, 0.1, 0.32, 0.49, 0.66, 1.] {
                    let eps = error_budget(width, width * 0.9).unwrap();
                    let components = visible_components(&region, &[], &[], eps).unwrap();
                    let ink = crate::contour_fill::generate(components, width, width * 0.9, &|p| {
                        valid(p, &region)
                    })
                    .unwrap_or_else(|e| {
                        panic!("fixture={fixture}, angle={angle}, width={width}: {e}")
                    });
                    assert!(!ink.runs.is_empty());
                    // Shifted points along every boundary edge, a small distance
                    // inward, explicitly include both sides of the thin finger.
                    for (a, b) in points
                        .iter()
                        .zip(points.iter().cycle().skip(1))
                        .take(points.len())
                    {
                        let a = v(a[0], a[1]);
                        let b = v(b[0], b[1]);
                        for j in 0..31 {
                            let p = a.lerp(b, (j as f64 + 0.37) / 31.);
                            let p = transform(p + (b - a).normalized().perp() * 0.0001);
                            if !region.inside(p) {
                                continue;
                            }
                            let distance = ink
                                .runs
                                .iter()
                                .flatten()
                                .map(|s| s.dist_to(p))
                                .fold(f64::INFINITY, f64::min);
                            assert!(distance <= width / 2. + eps,
                                "fixture={fixture}, angle={angle}, width={width}: uncovered {p:?}, distance={distance}");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn analytic_nearly_touching_hole_keeps_the_narrow_channel() {
        for gap in [0.0000002, 0.000002, 0.005, 0.1] {
            for angle in [0.0_f64, 0.371_f64] {
                let transform = |p: Vec2| {
                    v(
                        p.x * angle.cos() - p.y * angle.sin() + 17.321,
                        p.x * angle.sin() + p.y * angle.cos() + 9.123,
                    )
                };
                let rings = [
                    vec![[0., 0.], [5., 0.], [5., 5.], [0., 5.]],
                    vec![[gap, gap], [4., gap], [4., 4.], [gap, 4.]],
                ];
                let contours = rings
                    .iter()
                    .map(|ring| {
                        ring.iter()
                            .zip(ring.iter().cycle().skip(1))
                            .take(ring.len())
                            .map(|(a, b)| {
                                Primitive::Line(Line::new(
                                    transform(v(a[0], a[1])),
                                    transform(v(b[0], b[1])),
                                ))
                            })
                            .collect()
                    })
                    .collect();
                let region = Region::new(contours, WindingRule::EvenOdd, false);
                for width in [0.01, 0.1, 0.2, 0.45, 1.] {
                    let eps = error_budget(width, width * 0.9).unwrap();
                    let components = visible_components(&region, &[], &[], eps).unwrap();
                    let ink = crate::contour_fill::generate(components, width, width * 0.9, &|p| {
                        valid(p, &region)
                    })
                    .unwrap_or_else(|e| panic!("gap={gap}, angle={angle}, width={width}: {e}"));
                    for j in 0..51 {
                        let t = 0.01 + 3.98 * (j as f64 + 0.31) / 51.;
                        for q in [v(gap / 2., t), v(t, gap / 2.)] {
                            let p = transform(q);
                            assert!(region.inside(p));
                            let distance = ink
                                .runs
                                .iter()
                                .flatten()
                                .map(|s| s.dist_to(p))
                                .fold(f64::INFINITY, f64::min);
                            assert!(distance <= width / 2. + eps,
                                "gap={gap}, angle={angle}, width={width}: uncovered {p:?}, distance={distance}");
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn cubic_strip_keeps_its_actual_centerline_covered() {
        use crate::primitive::Cubic;
        for thickness in [0.03, 0.0002] {
            for scale in [1., 10.] {
                let top = Cubic::new(
                    v(0., 0.),
                    v(3. * scale, 4.),
                    v(7. * scale, 4.),
                    v(10. * scale, 0.),
                );
                let bottom = Cubic::new(
                    v(10. * scale, -thickness),
                    v(7. * scale, 4. - thickness),
                    v(3. * scale, 4. - thickness),
                    v(0., -thickness),
                );
                let region = Region::new(
                    vec![vec![
                        Primitive::Cubic(top),
                        Primitive::Line(Line::new(top.p1, bottom.p0)),
                        Primitive::Cubic(bottom),
                        Primitive::Line(Line::new(bottom.p1, top.p0)),
                    ]],
                    WindingRule::NonZero,
                    false,
                );
                let ink =
                    crate::contour_fill::generate_visible(&region, &[], &[], 0.5, 0.45, &|p| {
                        valid(p, &region)
                    })
                    .unwrap_or_else(|e| panic!("thickness={thickness}, scale={scale}: {e}"));
                if thickness == 0.0002 && scale == 10. {
                    assert!(
                        ink.diagnostics.geometry_refinements > 0,
                        "the stretched thin strip must exercise refinement from original curves"
                    );
                }
                assert!(ink.runs.iter().flatten().all(|p| valid(p, &region)));
                for i in 0..101 {
                    let t = (i as f64 + 0.37) / 101.;
                    let p = (top.eval(t) + bottom.eval(1. - t)) * 0.5;
                    assert!(region.inside(p));
                    let distance = ink
                        .runs
                        .iter()
                        .flatten()
                        .map(|s| s.dist_to(p))
                        .fold(f64::INFINITY, f64::min);
                    assert!(
                        distance <= 0.26,
                        "thickness={thickness}, scale={scale}, t={t}: distance={distance}"
                    );
                }
            }
        }
    }
}
