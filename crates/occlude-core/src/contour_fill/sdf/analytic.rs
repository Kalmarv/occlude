// Analytic distance levels and vector residual candidates on finite Voronoi edges.
use crate::{bbox::BBox, index::SpatialIndex, vec2::Vec2};
use boostvoronoi::prelude::*;
use std::collections::BTreeMap;
#[derive(Clone, Copy)]
enum Site {
    Point(Vec2),
    Segment(Vec2, Vec2),
}
fn v(x: f64, y: f64) -> Vec2 {
    Vec2 { x, y }
}
/// Remove subdivision-only junctions. Lines require exact collinearity;
/// arcs require the same circle and exactly shared angular parameter. Neither
/// case is a shape simplification or a removed contour section.
fn append_piece(run: &mut Vec<crate::primitive::Primitive>, p: crate::primitive::Primitive) {
    use crate::primitive::Primitive;
    if let Some(last) = run.last_mut() {
        match (*last, p) {
            (Primitive::Line(a), Primitive::Line(b)) if a.p1 == b.p0 => {
                let orient = robust::orient2d(
                    robust::Coord {
                        x: a.p0.x,
                        y: a.p0.y,
                    },
                    robust::Coord {
                        x: a.p1.x,
                        y: a.p1.y,
                    },
                    robust::Coord {
                        x: b.p1.x,
                        y: b.p1.y,
                    },
                );
                if orient == 0. && (a.p1 - a.p0).dot(b.p1 - b.p0) > 0. {
                    *last = Primitive::Line(crate::primitive::Line::new(a.p0, b.p1));
                    return;
                }
            }
            (Primitive::Arc(a), Primitive::Arc(b))
                if a.center == b.center
                    && a.r == b.r
                    && a.start + a.sweep == b.start
                    && a.sweep.signum() == b.sweep.signum()
                    && (a.sweep + b.sweep).abs() <= std::f64::consts::PI =>
            {
                *last = Primitive::Arc(crate::primitive::Arc::new(
                    a.center,
                    a.r,
                    a.start,
                    a.sweep + b.sweep,
                ));
                return;
            }
            _ => {}
        }
    }
    run.push(p);
}

pub(super) fn inside(
    p: Vec2,
    segments: &[(Vec2, Vec2)],
    index: &SpatialIndex,
    maxx: f64,
    near: &mut Vec<u32>,
) -> bool {
    index.query(&BBox::from_points(&[p, v(maxx + 1., p.y)]), near);
    let mut crossings = 0;
    for &i in near.iter() {
        let (a, b) = segments[i as usize];
        if (a.y > p.y) != (b.y > p.y) && a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y) > p.x {
            crossings += 1;
        }
    }
    crossings % 2 == 1
}
fn cross(a: Vec2, b: Vec2) -> f64 {
    a.x * b.y - a.y * b.x
}
impl Site {
    fn distance(self, p: Vec2) -> f64 {
        match self {
            Self::Point(a) => p.dist(a),
            Self::Segment(a, b) => {
                let d = b - a;
                p.dist(a + d * ((p - a).dot(d) / d.len2()).clamp(0., 1.))
            }
        }
    }
}
fn intersections(a: Site, b: Site, r: f64) -> Vec<Vec2> {
    match (a, b) {
        (Site::Point(a), Site::Point(b)) => {
            let d = b - a;
            let len = d.len();
            if len == 0. || len > 2. * r {
                return vec![];
            }
            let q = (a + b) * 0.5;
            let h = (r * r - len * len * 0.25).max(0.).sqrt();
            let n = d.perp() / len;
            if h == 0. {
                vec![q]
            } else {
                vec![q + n * h, q - n * h]
            }
        }
        (Site::Point(p), Site::Segment(a, b)) | (Site::Segment(a, b), Site::Point(p)) => {
            let t = (b - a).normalized();
            let n = t.perp();
            let mut result = Vec::new();
            if p == a || p == b {
                return vec![p + n * r, p - n * r];
            }
            for sign in [-1., 1.] {
                let q = a + n * (sign * r);
                let u = (p - q).dot(t);
                let h2 = r * r - (p - q - t * u).len2();
                if h2 < -1e-10 * r * r {
                    continue;
                }
                let h = h2.max(0.).sqrt();
                result.push(q + t * (u + h));
                if h > 1e-10 {
                    result.push(q + t * (u - h));
                }
            }
            result
        }
        (Site::Segment(a, b), Site::Segment(c, d)) => {
            let t = (b - a).normalized();
            let u = (d - c).normalized();
            let det = cross(t, u);
            if det.abs() < 1e-14 {
                return vec![];
            }
            let mut result = Vec::new();
            for s in [-1., 1.] {
                for z in [-1., 1.] {
                    let p = a + t.perp() * (s * r);
                    let q = c + u.perp() * (z * r);
                    result.push(p + t * (cross(q - p, u) / det));
                }
            }
            result
        }
    }
}
fn minimum_distance(site: Site, other: Site, p0: Vec2, p1: Vec2, curved: bool) -> f64 {
    if curved {
        let (p, a, b) = match (site, other) {
            (Site::Point(p), Site::Segment(a, b)) | (Site::Segment(a, b), Site::Point(p)) => {
                (p, a, b)
            }
            _ => unreachable!(),
        };
        let u = (b - a).normalized();
        let x0 = (p0 - a).dot(u);
        let x1 = (p1 - a).dot(u);
        let x = (p - a).dot(u);
        if x >= x0.min(x1) && x <= x0.max(x1) {
            return cross(u, p - a).abs() / 2.;
        }
        return site.distance(p0).min(site.distance(p1));
    }
    match site {
        Site::Point(p) => {
            let d = p1 - p0;
            if d.len2() == 0. {
                return p.dist(p0);
            }
            p.dist(p0 + d * ((p - p0).dot(d) / d.len2()).clamp(0., 1.))
        }
        Site::Segment(a, b) => {
            let n = (b - a).normalized().perp();
            let d0 = (p0 - a).dot(n);
            let d1 = (p1 - a).dot(n);
            if (d0 > 0.) != (d1 > 0.) {
                0.
            } else {
                d0.abs().min(d1.abs())
            }
        }
    }
}

#[derive(Clone)]
struct Hit {
    id: usize,
    p: Vec2,
    k: usize,
}
#[derive(Clone)]
pub struct Piece {
    pub a: usize,
    pub b: usize,
    pub center: Option<Vec2>,
    pub points: [Vec2; 2],
    pub sweep: f64,
    pub radius: f64,
    pub requested: f64,
    pub level: usize,
}
pub struct Output {
    pub pieces: Vec<Piece>,
    pub node_count: usize,
    pub levels: usize,
    pub cleanup: Vec<Vec<Vec2>>,
    pub thin_hulls: Vec<Option<Vec<Vec2>>>,
    pub portals: Vec<[Vec2; 2]>,
}
pub fn extract(
    input: &[i64],
    scale: f64,
    first: f64,
    spacing: f64,
    width: f64,
    eps: f64,
) -> Result<Output, String> {
    if !first.is_finite() || first <= 0. || !spacing.is_finite() || spacing <= 0. {
        return Err("invalid levels".into());
    }
    let lines: Vec<Line<i64>> = input
        .chunks_exact(4)
        .map(|p| Line::new(Point { x: p[0], y: p[1] }, Point { x: p[2], y: p[3] }))
        .collect();
    let diagram = Builder::<i64>::default()
        .with_segments(lines.iter())
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let segments: Vec<_> = input
        .chunks_exact(4)
        .map(|p| {
            (
                v(p[0] as f64 / scale, p[1] as f64 / scale),
                v(p[2] as f64 / scale, p[3] as f64 / scale),
            )
        })
        .collect();
    let boxes: Vec<_> = segments
        .iter()
        .map(|&(a, b)| BBox::from_points(&[a, b]))
        .collect();
    let index = SpatialIndex::build(&boxes);
    let site = |cell: &Cell| {
        let (a, b) = segments[cell.source_index().usize()];
        if cell.contains_segment() {
            Site::Segment(a, b)
        } else if cell.contains_segment_startpoint() {
            Site::Point(a)
        } else {
            Site::Point(b)
        }
    };
    let vertex = |id: VertexIndex| {
        let p = diagram.vertex(id).unwrap();
        v(p.x() / scale, p.y() / scale)
    };
    let maxx = segments
        .iter()
        .flat_map(|(a, b)| [a.x, b.x])
        .fold(f64::NEG_INFINITY, f64::max);
    let mut near = Vec::new();
    // Avoid singular isolevels within a bounded absolute distance error. Each
    // requested level is adjusted independently; shifts never accumulate.
    let mut critical = Vec::new();
    let mut max_inside = 0.0_f64;
    for e in diagram.edges() {
        let twin = diagram.edge(e.twin().unwrap()).unwrap();
        if e.id().usize() > twin.id().usize() {
            continue;
        }
        let (Some(v0), Some(v1)) = (e.vertex0(), twin.vertex0()) else {
            continue;
        };
        let (s0, s1) = (
            site(&diagram.cells()[e.cell().unwrap().usize()]),
            site(&diagram.cells()[twin.cell().unwrap().usize()]),
        );
        let (p0, p1) = (vertex(v0), vertex(v1));
        let (d0, d1) = (s0.distance(p0), s0.distance(p1));
        critical.extend([d0, d1]);
        if inside(
            if d0 > d1 { p0 } else { p1 },
            &segments,
            &index,
            maxx,
            &mut near,
        ) {
            max_inside = max_inside.max(d0.max(d1));
        }
        match (s0, s1) {
            (Site::Point(a), Site::Point(b)) => critical.push(a.dist(b) / 2.),
            (Site::Point(p), Site::Segment(a, b)) | (Site::Segment(a, b), Site::Point(p)) => {
                critical.push(cross((b - a).normalized(), p - a).abs() / 2.)
            }
            _ => (),
        }
    }
    critical.retain(|v| v.is_finite());
    critical.sort_by(f64::total_cmp);
    critical.dedup();
    let separation = |x: f64| {
        let at = critical.partition_point(|&v| v < x);
        let a = at
            .checked_sub(1)
            .map(|i| (x - critical[i]).abs())
            .unwrap_or(f64::INFINITY);
        let b = critical
            .get(at)
            .map(|v| (x - v).abs())
            .unwrap_or(f64::INFINITY);
        a.min(b)
    };
    let max_level = if max_inside < first {
        0
    } else {
        let last_level = ((max_inside - first) / spacing).floor();
        // Check BEFORE conversion/addition: usize is only 32 bits in WASM,
        // where a saturating float cast followed by +1 could wrap to zero.
        if !last_level.is_finite() || last_level >= 100_000. {
            return Err("contour: spacing requires more than 100000 contour levels".into());
        }
        last_level as usize + 1
    };
    let shift = (first.min(spacing) * 1e-4).min(eps / 64.);
    let radii: Vec<_> = (0..max_level)
        .map(|k| {
            let target = first + k as f64 * spacing;
            if separation(target) > shift / 4. {
                return target;
            }
            let low = target - shift;
            let high = target + shift;
            let a = critical.partition_point(|&v| v < low);
            let b = critical.partition_point(|&v| v <= high);
            let mut best = target;
            let mut score = separation(target);
            for q in [low, high]
                .into_iter()
                .chain(critical[a..b].windows(2).map(|p| (p[0] + p[1]) / 2.))
            {
                let distance = separation(q);
                if distance > score {
                    best = q;
                    score = distance;
                }
            }
            best
        })
        .collect();
    let mut cellhits: Vec<Vec<Hit>> = vec![Vec::new(); diagram.cells().len()];
    let mut nodes = Vec::new();
    let mut vertexids = BTreeMap::new();
    let mut levels = 0;
    let mut event_count = 0usize;
    for e in diagram.edges() {
        let twin = diagram.edge(e.twin().map_err(|e| e.to_string())?).unwrap();
        if e.id().usize() > twin.id().usize() {
            continue;
        }
        let (Some(v0), Some(v1)) = (e.vertex0(), twin.vertex0()) else {
            continue;
        };
        let (p0, p1) = (vertex(v0), vertex(v1));
        let (c0, c1) = (e.cell().unwrap().usize(), twin.cell().unwrap().usize());
        let (s0, s1) = (site(&diagram.cells()[c0]), site(&diagram.cells()[c1]));
        let d0 = s0.distance(p0);
        let d1 = s0.distance(p1);
        let max = d0.max(d1);
        if radii.first().is_none_or(|&r| max < r) {
            continue;
        }
        if !inside(
            if d0 > d1 { p0 } else { p1 },
            &segments,
            &index,
            maxx,
            &mut near,
        ) {
            continue;
        }
        let count = radii.partition_point(|&r| r <= max);
        levels = levels.max(count);
        let minimum = minimum_distance(s0, s1, p0, p1, e.is_curved());
        let first_level = radii.partition_point(|&r| r < minimum - 1e-7).min(count);
        for k in first_level..count {
            let r = radii[k];
            let mut roots = intersections(s0, s1, r);
            roots.retain(|&q| {
                if !q.is_finite()
                    || (s0.distance(q) - r).abs() > 1e-7
                    || (s1.distance(q) - r).abs() > 1e-7
                {
                    return false;
                }
                let axis = if e.is_curved() {
                    match (s0, s1) {
                        (Site::Segment(a, b), _) | (_, Site::Segment(a, b)) => (b - a).normalized(),
                        _ => unreachable!(),
                    }
                } else {
                    (p1 - p0).normalized()
                };
                let t = (q - p0).dot(axis);
                let end = (p1 - p0).dot(axis);
                t >= end.min(0.) - 1e-8 && t <= end.max(0.) + 1e-8
            });
            roots.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
            roots.dedup_by(|a, b| a.dist(*b) < 1e-9);
            for q in roots {
                // Bound provisional storage as well as final ink. Each event
                // creates at most one node and two cell-hit records.
                if event_count >= 2 * super::super::MAX_PRIMITIVES {
                    return Err("contour: distance-event work budget exceeded".into());
                }
                event_count += 1;
                let vertex = if q.dist(p0) < 1e-8 {
                    Some(v0)
                } else if q.dist(p1) < 1e-8 {
                    Some(v1)
                } else {
                    None
                };
                let id = if let Some(vi) = vertex {
                    *vertexids.entry((vi.usize(), k)).or_insert_with(|| {
                        nodes.push(q);
                        nodes.len() - 1
                    })
                } else {
                    nodes.push(q);
                    nodes.len() - 1
                };
                for c in [c0, c1] {
                    cellhits[c].push(Hit {
                        id,
                        p: nodes[id],
                        k,
                    });
                }
            }
        }
    }
    let mut pieces = Vec::new();
    let mut near = Vec::new();
    let maxx = segments
        .iter()
        .flat_map(|(a, b)| [a.x, b.x])
        .fold(f64::NEG_INFINITY, f64::max);
    for (ci, hits) in cellhits.iter_mut().enumerate() {
        let cell = &diagram.cells()[ci];
        let s = site(cell);
        let param = |p: Vec2| match s {
            Site::Point(a) => (p - a).y.atan2((p - a).x),
            Site::Segment(a, b) => (p - a).dot((b - a).normalized()),
        };
        if let Site::Segment(a, b) = s {
            hits.retain(|h| cross(b - a, h.p - a) > 0.);
        }
        hits.sort_by(|a, b| {
            a.k.cmp(&b.k)
                .then(param(a.p).total_cmp(&param(b.p)))
                .then(a.id.cmp(&b.id))
        });
        hits.dedup_by_key(|h| (h.k, h.id));
        let mut begin = 0;
        while begin < hits.len() {
            let end = begin + hits[begin..].partition_point(|h| h.k == hits[begin].k);
            let slice = &hits[begin..end];
            let r = radii[slice[0].k];
            let count = if matches!(s, Site::Point(_)) {
                slice.len()
            } else {
                slice.len().saturating_sub(1)
            };
            for j in 0..count {
                let a = &slice[j];
                let b = &slice[(j + 1) % slice.len()];
                if a.id == b.id {
                    continue;
                }
                let (middle, center, sweep) = match s {
                    Site::Point(c) => {
                        let angle = param(a.p);
                        let sweep = (param(b.p) - angle).rem_euclid(std::f64::consts::TAU);
                        (
                            c + v((angle + sweep / 2.).cos(), (angle + sweep / 2.).sin()) * r,
                            Some(c),
                            sweep,
                        )
                    }
                    Site::Segment(_, _) => ((a.p + b.p) * 0.5, None, 0.),
                };
                if center.is_some() {
                    index.query(
                        &BBox::from_points(&[middle, v(maxx + 1., middle.y)]),
                        &mut near,
                    );
                    let mut crossings = 0;
                    for &i in &near {
                        let (a, b) = segments[i as usize];
                        if (a.y > middle.y) != (b.y > middle.y)
                            && a.x + (middle.y - a.y) * (b.x - a.x) / (b.y - a.y) > middle.x
                        {
                            crossings += 1;
                        }
                    }
                    if crossings % 2 == 0 {
                        continue;
                    }
                }
                index.query(&BBox::from_points(&[middle]).expanded(r + 1e-7), &mut near);
                if near.iter().any(|&i| {
                    let (a, b) = segments[i as usize];
                    Site::Segment(a, b).distance(middle) < r - 1e-7
                }) {
                    continue;
                }
                if pieces.len() == super::super::MAX_PRIMITIVES {
                    return Err("contour: regular contour geometry budget exceeded".into());
                }
                pieces.push(Piece {
                    a: a.id,
                    b: b.id,
                    center,
                    points: [a.p, b.p],
                    sweep,
                    radius: r,
                    requested: first + slice[0].k as f64 * spacing,
                    level: slice[0].k,
                });
            }
            begin = end;
        }
    }
    let mut drawn_nodes = vec![false; nodes.len()];
    for p in &pieces {
        drawn_nodes[p.a] = true;
        drawn_nodes[p.b] = true;
    }
    let mut cleanup = Vec::new();
    let mut cleanup_points = 0usize;
    let mut thin_hulls = Vec::new();
    let mut portals = Vec::new();
    let nib = width / 2.;
    let tolerance = eps / 8.;
    for e in diagram.edges() {
        if spacing > width {
            break;
        }
        let twin = diagram.edge(e.twin().unwrap()).unwrap();
        if !e.is_primary() || e.id().usize() > twin.id().usize() {
            continue;
        }
        let (Some(v0), Some(v1)) = (e.vertex0(), twin.vertex0()) else {
            continue;
        };
        let (p0, p1) = (vertex(v0), vertex(v1));
        let (s0, s1) = (
            site(&diagram.cells()[e.cell().unwrap().usize()]),
            site(&diagram.cells()[twin.cell().unwrap().usize()]),
        );
        let (d0, d1) = (s0.distance(p0), s0.distance(p1));
        if !inside(
            if d0 > d1 { p0 } else { p1 },
            &segments,
            &index,
            maxx,
            &mut near,
        ) {
            continue;
        }
        let axis = if e.is_curved() {
            match (s0, s1) {
                (Site::Segment(a, b), _) | (_, Site::Segment(a, b)) => (b - a).normalized(),
                _ => unreachable!(),
            }
        } else {
            (p1 - p0).normalized()
        };
        let extent = (p1 - p0).dot(axis);
        if extent == 0. {
            continue;
        }
        let at = |t: f64| {
            if e.is_linear() {
                p0 + (p1 - p0) * t
            } else {
                let (p, a, b) = match (s0, s1) {
                    (Site::Point(p), Site::Segment(a, b))
                    | (Site::Segment(a, b), Site::Point(p)) => (p, a, b),
                    _ => unreachable!(),
                };
                let u = (b - a).normalized();
                let n = u.perp();
                let x = (p0 - a).dot(u) + extent * t;
                let f = (p - a).dot(u);
                let height = (p - a).dot(n);
                a + u * x + n * (((x - f) * (x - f) + height * height) / (2. * height))
            }
        };
        let max = d0.max(d1);
        let mut stops = vec![0., 1.];
        let minimum = minimum_distance(s0, s1, p0, p1, e.is_curved());
        let begin = radii.partition_point(|&r| r + nib - tolerance < minimum - 1e-7);
        for r in radii[begin..]
            .iter()
            .flat_map(|&r| [r, r + nib - tolerance])
            .filter(|&r| r <= max && r >= minimum - 1e-7 && r > 0.)
        {
            for q in intersections(s0, s1, r) {
                let t = (q - p0).dot(axis) / extent;
                if t > 0.
                    && t < 1.
                    && (s0.distance(q) - r).abs() < 1e-7
                    && (s1.distance(q) - r).abs() < 1e-7
                {
                    stops.push(t);
                }
            }
        }
        stops.sort_by(f64::total_cmp);
        stops.dedup();
        let mut intervals: Vec<(f64, f64, Option<Vec<Vec2>>)> = Vec::new();
        for pair in stops.windows(2) {
            let d = s0.distance(at((pair[0] + pair[1]) / 2.));
            let below = radii.partition_point(|&r| r <= d);
            if below > 0 && d - radii[below - 1] <= nib - tolerance {
                continue;
            }
            // The lower available contour already covers each site's normal
            // ray up to this depth. Bound only the remaining wedge, over the
            // WHOLE interval, by a convex hull of its quadratic controls and
            // projected feet. A point-site uses its full focus wedge, a
            // deliberately conservative bound.
            let a = at(pair[0]);
            let b = at(pair[1]);
            let control = at((pair[0] + pair[1]) / 2.) * 2. - (a + b) * 0.5;
            let depth = if below == 0 {
                0.
            } else {
                radii[below - 1] + nib - tolerance
            };
            let mut hull = vec![a, control, b];
            for site in [s0, s1] {
                match site {
                    Site::Point(p) => hull.push(p),
                    Site::Segment(u, w) => {
                        let d = w - u;
                        let n = d.normalized().perp();
                        let sign = ((a + b) * 0.5 - u).dot(n).signum();
                        for q in [a, control, b] {
                            hull.push(
                                u + d * ((q - u).dot(d) / d.len2()).clamp(0., 1.)
                                    + n * (depth * sign),
                            );
                        }
                    }
                }
            }
            // Test actual drawn nodes on the next contour in the two adjacent
            // cells. Its round endpoint capsule can cover this entire wedge.
            // This avoids a global index or all-pairs contour search.
            let covered = [e.cell().unwrap().usize(), twin.cell().unwrap().usize()]
                .into_iter()
                .any(|ci| {
                    let hits = &cellhits[ci];
                    let begin = hits.partition_point(|h| h.k < below);
                    hits[begin..]
                        .iter()
                        .take_while(|h| h.k == below)
                        .take(32)
                        .any(|h| {
                            drawn_nodes[h.id] && hull.iter().all(|p| p.dist(h.p) <= nib - eps / 4.)
                        })
                });
            if covered {
                continue;
            }
            if let Some(last) = intervals.last_mut() {
                let a = at(last.1);
                let b = at(pair[0]);
                let control = at((last.1 + pair[0]) / 2.) * 2. - (a + b) * 0.5;
                // A quadratic Bezier lies within its control polygon; its control-polygon
                // length bounds the transition length. Join only a short gap on this same
                // certified medial branch, before allocating any intermediate geometry.
                if a.dist(control) + control.dist(b) <= 2. * spacing {
                    last.1 = pair[1];
                    if let Some(existing) = &mut last.2 {
                        if existing.len() + hull.len() <= 64 {
                            existing.extend(hull);
                        } else {
                            last.2 = None;
                        }
                    }
                    continue;
                }
            }
            intervals.push((pair[0], pair[1], Some(hull)));
        }
        for (a, b, hull) in intervals {
            let mut run = vec![at(a)];
            let mut work = vec![(a, b)];
            while let Some((a, b)) = work.pop() {
                let mid = (a + b) / 2.;
                let q = at(mid);
                if q.dist((at(a) + at(b)) * 0.5) > tolerance {
                    work.push((mid, b));
                    work.push((a, mid));
                } else {
                    run.push(at(b));
                }
                if run.len() + work.len() > 100000 {
                    return Err("probe parabola budget".into());
                }
            }
            thin_hulls.push(hull);
            portals.push(if d0 > d1 { [p0, p1] } else { [p1, p0] });
            if run.len() > (2 * super::super::MAX_PRIMITIVES).saturating_sub(cleanup_points) {
                return Err("contour: residual construction work budget exceeded".into());
            }
            cleanup_points += run.len();
            cleanup.push(run);
        }
    }
    Ok(Output {
        pieces,
        // Endpoints already live in Piece; release the temporary node positions
        // before allocating adjacency and assembled contour geometry.
        node_count: nodes.len(),
        levels,
        cleanup,
        thin_hulls,
        portals,
    })
}

pub(super) fn contours(
    field: &super::DistanceIndex,
    width: f64,
    spacing: f64,
    eps: f64,
    certify: &dyn Fn(&super::Primitive) -> bool,
) -> Result<
    (
        Vec<Vec<super::Primitive>>,
        Vec<Vec<super::Primitive>>,
        usize,
        Vec<usize>,
    ),
    super::GenerationError,
> {
    use super::{Arc, Line, Primitive};
    let input = super::input::prepare(field, eps)?;
    let first = (width / 2. - eps / 2.).max(width / 4.);
    let out = extract(&input.coordinates, input.scale, first, spacing, width, eps)?;
    // A regular contour vertex has exactly two incident pieces. Fixed slots
    // preserve insertion order without allocating a tiny Vec for every one of
    // potentially millions of vertices. Still count/reject nonregular degree;
    // never silently discard an extra incident edge.
    let mut adjacent = vec![[usize::MAX; 2]; out.node_count];
    let mut degrees = vec![0u8; out.node_count];
    for (i, p) in out.pieces.iter().enumerate() {
        for node in [p.a, p.b] {
            let degree = &mut degrees[node];
            if *degree < 2 {
                adjacent[node][*degree as usize] = i;
            }
            *degree = (*degree + 1).min(3);
        }
    }
    let bad = degrees
        .iter()
        .filter(|&&degree| degree != 0 && degree != 2)
        .count();
    drop(degrees);
    if bad > 0 {
        return Err(format!("analytic probe: {bad} nonregular contour vertices").into());
    }
    let mut used = vec![false; out.pieces.len()];
    let mut runs = Vec::new();
    let mut regular_levels = Vec::new();
    let mut first_runs = Vec::new();
    for i in 0..out.pieces.len() {
        if used[i] {
            continue;
        }
        let start = out.pieces[i].a;
        let mut at = start;
        let mut run = Vec::new();
        loop {
            let Some(&id) = adjacent[at].iter().find(|&&i| !used[i]) else {
                return Err("analytic probe: open contour".into());
            };
            used[id] = true;
            let p = &out.pieces[id];
            let (a, b, sweep, next) = if p.a == at {
                (p.points[0], p.points[1], p.sweep, p.b)
            } else {
                (p.points[1], p.points[0], -p.sweep, p.a)
            };
            let primitive = if let Some(c) = p.center {
                Primitive::Arc(Arc::new(c, p.radius, (a - c).angle(), sweep))
            } else {
                Primitive::Line(Line::new(a, b))
            };
            if !primitive.start().is_finite() || !primitive.end().is_finite() {
                return Err("analytic probe: nonfinite primitive".into());
            }
            append_piece(&mut run, primitive);
            at = next;
            if at == start {
                break;
            }
        }
        // A circular source flattened for the segment kernel need not remain
        // hundreds of line segments in the final plan. This single-lap fit
        // bounds the WHOLE polyline by eps/4 and is certified against the exact
        // visible area. Existing analytic arcs are left intact.
        if run.len() >= 6 && run.iter().all(|p| matches!(p, Primitive::Line(_))) {
            let mut points: Vec<_> = run.iter().map(Primitive::start).collect();
            points.push(run.last().unwrap().end());
            if let Some(circle) = super::closed_circle(&points, eps / 4.) {
                if circle.iter().all(certify) {
                    run = circle;
                }
            }
        }
        if out.pieces[i].requested == first {
            first_runs.push(run.clone());
        }
        runs.push(run);
        regular_levels.push(out.pieces[i].level);
    }
    if !first_runs.iter().flatten().all(certify) {
        return Err(super::GenerationError::Visibility(
            "contour: regular contour failed exact visibility validation before culling".into(),
        ));
    }
    let ink = super::Ink::new(&first_runs, width / 2., eps);
    let radius = ink.radius - 2e-6;
    let mut patches = Vec::new();
    let mut _culled = 0;
    let mut taps = std::collections::BTreeSet::new();
    'patch: for ((run, hull), portals) in
        out.cleanup.into_iter().zip(out.thin_hulls).zip(out.portals)
    {
        if let Some(hull) = hull {
            let middle = hull.iter().copied().fold(v(0., 0.), |a, b| a + b) / hull.len() as f64;
            let covered = std::iter::once(middle)
                .chain(hull.iter().copied())
                .take(8)
                .any(|p| {
                    let (_, Some(segment)) = ink.initial.nearest(p, radius) else {
                        return false;
                    };
                    hull.iter().all(|&p| segment.closest(p).dist(p) <= radius)
                });
            if covered {
                _culled += 1;
                continue;
            }
            for q in portals {
                let tap = Primitive::Line(Line::new(q, q));
                if hull.iter().all(|p| p.dist(q) <= width / 2. - eps / 4.) && certify(&tap) {
                    if taps.insert((q.x.to_bits(), q.y.to_bits())) {
                        patches.push(vec![tap]);
                    }
                    continue 'patch;
                }
            }
        }
        patches.push(
            run.windows(2)
                .filter(|p| p[0] != p[1])
                .map(|p| {
                    Primitive::Line(Line::new(
                        input.restore_vertex(p[0]),
                        input.restore_vertex(p[1]),
                    ))
                })
                .collect(),
        );
    }
    #[cfg(feature = "profile")]
    eprintln!("analytic thin patches culled: {_culled}");
    Ok((runs, patches, out.levels, regular_levels))
}

#[cfg(test)]
mod coalescing_tests {
    use super::*;
    use crate::primitive::{Arc, Line, Primitive};
    #[test]
    fn excessive_level_count_errors_before_integer_conversion() {
        let square = [
            0, 0, 1000, 0, 1000, 0, 1000, 1000, 1000, 1000, 0, 1000, 0, 1000, 0, 0,
        ];
        for spacing in [1e-9, f64::MIN_POSITIVE] {
            let error = extract(&square, 1., 0.5, spacing, 1., 0.01)
                .err()
                .expect("must reject excessive levels");
            assert!(error.contains("contour levels"), "{error}");
        }
    }

    #[test]
    fn subdivision_removal_preserves_lines_arcs_and_reversals() {
        let mut run = Vec::new();
        append_piece(&mut run, Primitive::Line(Line::new(v(0., 0.), v(1., 0.))));
        append_piece(&mut run, Primitive::Line(Line::new(v(1., 0.), v(2., 0.))));
        assert_eq!(run.len(), 1);
        assert_eq!(run[0].start(), v(0., 0.));
        assert_eq!(run[0].end(), v(2., 0.));
        append_piece(&mut run, Primitive::Line(Line::new(v(2., 0.), v(1., 0.))));
        assert_eq!(run.len(), 2, "a reversed lap is not a redundant vertex");
        let quarter = std::f64::consts::FRAC_PI_2;
        let a = Primitive::Arc(Arc::new(v(0., 0.), 2., 0., quarter));
        let b = Primitive::Arc(Arc::new(v(0., 0.), 2., quarter, quarter));
        let mut arcs = vec![a];
        append_piece(&mut arcs, b);
        assert_eq!(arcs.len(), 1);
        for i in 0..101 {
            let t = i as f64 / 100.;
            assert!(arcs[0].dist_to(a.eval(t)) < 1e-12);
            assert!(arcs[0].dist_to(b.eval(t)) < 1e-12);
        }
        assert!((arcs[0].length() - a.length() - b.length()).abs() < 1e-12);
        append_piece(
            &mut arcs,
            Primitive::Arc(Arc::new(v(0., 0.), 2., 2. * quarter, quarter)),
        );
        assert_eq!(arcs.len(), 2, "retain the half-circle sweep bound");
    }
}
