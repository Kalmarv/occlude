//! Local vector coverage completion. A short centre stroke is a candidate,
//! never a coverage assumption: subtract its round-nib sweep and finish only
//! what remains. Cleanup is independent ink, not an excursion from a loop.
use super::*;

// A polygon is covered if one line capsule contains all its vertices, or one
// primitive covers its bounding disk. Both are sufficient geometric tests;
// neither uses area thresholds or excludes thin features from the contract.
struct Coverage {
    ink: Vec<Primitive>,
    index: SpatialIndex,
    radius: f64,
}
impl Coverage {
    fn new(ink: Vec<Primitive>, radius: f64) -> Self {
        let boxes = ink
            .iter()
            .map(|p| p.bbox().expanded(radius))
            .collect::<Vec<_>>();
        Self {
            ink,
            index: SpatialIndex::build(&boxes),
            radius,
        }
    }
    fn covers(&self, polygon: &[Vec<[f64; 2]>]) -> bool {
        let pts: Vec<_> = polygon.iter().flatten().map(|p| v(p[0], p[1])).collect();
        if pts.is_empty() {
            return true;
        }
        let bbox = BBox::from_points(&pts);
        let center = (bbox.min + bbox.max) * 0.5;
        let bound = (bbox.max - bbox.min).len() * 0.5;
        let mut hits = Vec::new();
        self.index.query(&BBox::new(center, center), &mut hits);
        hits.iter().any(|&i| {
            let p = &self.ink[i as usize];
            if matches!(p, Primitive::Line(_)) {
                pts.iter().all(|&q| p.dist_to(q) <= self.radius)
            } else if p.dist_to(center) + bound <= self.radius {
                true
            } else if let Primitive::Arc(a) = p {
                // For an arc no longer than a semicircle, its angular sector
                // is convex. Bound the box's radial interval as well: checking
                // vertices alone could falsely cover the annulus's inner hole.
                if a.sweep == 0.0 || a.sweep.abs() > std::f64::consts::PI {
                    return false;
                }
                let start = Vec2::from_angle(a.start);
                let end = Vec2::from_angle(a.start + a.sweep);
                let sign = a.sweep.signum();
                let corners = [
                    bbox.min,
                    v(bbox.min.x, bbox.max.y),
                    bbox.max,
                    v(bbox.max.x, bbox.min.y),
                ];
                let nearest = v(
                    a.center.x.clamp(bbox.min.x, bbox.max.x),
                    a.center.y.clamp(bbox.min.y, bbox.max.y),
                );
                nearest.dist(a.center) >= (a.r - self.radius).max(0.0)
                    && corners.iter().all(|&q| {
                        let d = q - a.center;
                        d.len() <= a.r + self.radius
                            && start.cross(d) * sign >= 0.0
                            && d.cross(end) * sign >= 0.0
                    })
            } else {
                false
            }
        })
    }
}

// Inscribed round caps: the Boolean certificate never overstates nib coverage.
fn footprint(ink: &[Primitive], radius: f64, eps: f64) -> Result<Polygons, String> {
    let n = (std::f64::consts::PI / (1.0 - eps / (8.0 * radius)).clamp(-1.0, 1.0).acos())
        .ceil()
        .max(12.0);
    if !n.is_finite() || n > 4096.0 || (ink.len() + 1) as f64 * (n + 4.0) > 20_000_000.0 {
        return Err("contour: residual footprint exceeds precision/geometry budget".into());
    }
    let n = n as usize;
    let mut rings = Vec::new();
    let mut points = Vec::new();
    for p in ink {
        // Cleanup candidates contain lines only.
        let a = p.start();
        let b = p.end();
        if a != b {
            let normal = (b - a).normalized().perp() * radius;
            rings.push(
                vec![a + normal, a - normal, b - normal, b + normal]
                    .into_iter()
                    .map(|p| [p.x, p.y])
                    .collect::<Vec<_>>(),
            );
        }
        points.push(a);
    }
    if let Some(p) = ink.last() {
        points.push(p.end());
    }
    for p in points {
        rings.push(
            (0..n)
                .map(|i| {
                    let q =
                        p + Vec2::from_angle(std::f64::consts::TAU * i as f64 / n as f64) * radius;
                    [q.x, q.y]
                })
                .collect(),
        );
    }
    Ok(vec![rings])
}

/// Compute remaining material from the emitted ink, including initial-inset
/// losses. Reserve flattening and construction error inside the real nib.
pub(super) fn uncovered(
    permitted: &Polygons,
    runs: &[Vec<Primitive>],
    width: f64,
    eps: f64,
    certify: &dyn Fn(&Primitive) -> bool,
) -> Result<Polygons, String> {
    use i_overlay::mesh::{
        stroke::offset::StrokeOffset,
        style::{LineCap, LineJoin, StrokeStyle},
    };
    let visibility_zone = crate::profile::zone("contour coverage visibility");
    let mut paths: Vec<Vec<[f64; 2]>> = Vec::new();
    let mut certified = Vec::new();
    let flush = |pts: &mut Vec<Vec2>, paths: &mut Vec<Vec<[f64; 2]>>| {
        pts.dedup();
        if pts.len() > 1 {
            paths.push(pts.drain(..).map(|p| [p.x, p.y]).collect());
        } else {
            pts.clear();
        }
    };
    for run in runs {
        let mut pts = Vec::new();
        for p in run {
            // A primitive later clipped by exact visibility must not certify
            // coverage using its removed part. Conservatively clean that gap;
            // overlapping its surviving ink is intentional and safe.
            if certify(p) {
                certified.push(*p);
                p.flatten(eps / 8.0, &mut pts);
            } else {
                flush(&mut pts, &mut paths);
            }
        }
        flush(&mut pts, &mut paths);
    }
    if paths.is_empty() {
        return Ok(permitted.clone());
    }
    drop(visibility_zone);
    let radius = width / 2.0 - eps / 4.0;
    let angle = 2.0 * (1.0 - eps / (8.0 * radius)).acos();
    let style = StrokeStyle::new(2.0 * radius)
        .start_cap(LineCap::Round(angle))
        .end_cap(LineCap::Round(angle))
        .line_join(LineJoin::Round(angle));
    let sweep_zone = crate::profile::zone("contour coverage stroke union");
    let swept = paths.stroke_as::<i64>(style, false);
    drop(sweep_zone);
    let coverage = Coverage::new(certified, width / 2.0 - eps / 8.0);
    let difference_zone = crate::profile::zone("contour coverage difference");
    let residual = boolean(permitted, &swept, OverlayRule::Difference);
    drop(difference_zone);
    let _zone = crate::profile::zone("contour coverage witnesses");
    Ok(residual.into_iter()
        .filter(|p| !coverage.covers(p))
        .collect())
}

fn lines(points: &[Vec2]) -> Vec<Primitive> {
    points
        .windows(2)
        .filter(|p| p[0].dist(p[1]) > 1e-12)
        .map(|p| Primitive::Line(Line::new(p[0], p[1])))
        .collect()
}

/// Pair the two sides by arclength. This is deliberately just a cheap candidate,
/// not a medial-axis claim; concavities/branches are caught by the certificates.
fn centre_stroke(ring: &[[f64; 2]]) -> Vec<Primitive> {
    let pts: Vec<_> = ring.iter().map(|p| v(p[0], p[1])).collect();
    if pts.len() < 3 {
        return Vec::new();
    }
    let b = BBox::from_points(&pts);
    let axis = |p: Vec2| if b.width() >= b.height() { p.x } else { p.y };
    let lo = (0..pts.len())
        .min_by(|&a, &b| axis(pts[a]).total_cmp(&axis(pts[b])))
        .unwrap();
    let hi = (0..pts.len())
        .max_by(|&a, &b| axis(pts[a]).total_cmp(&axis(pts[b])))
        .unwrap();
    let side = |step: usize| {
        let mut out = vec![pts[lo]];
        let mut i = lo;
        while i != hi {
            i = (i + step) % pts.len();
            out.push(pts[i]);
        }
        let mut distances = vec![0.0];
        for pair in out.windows(2) {
            distances.push(distances.last().unwrap() + pair[0].dist(pair[1]));
        }
        let total = *distances.last().unwrap();
        if total > 0.0 {
            for d in &mut distances {
                *d /= total;
            }
        }
        (out, distances)
    };
    let (a, ta) = side(1);
    let (b, tb) = side(pts.len() - 1);
    let mut knots = ta.clone();
    knots.extend(&tb);
    knots.sort_by(f64::total_cmp);
    knots.dedup();
    let at = |p: &[Vec2], ts: &[f64], t: f64| {
        let i = ts.partition_point(|&s| s < t).max(1).min(p.len() - 1);
        p[i - 1].lerp(
            p[i],
            ((t - ts[i - 1]) / (ts[i] - ts[i - 1]).max(1e-30)).clamp(0.0, 1.0),
        )
    };
    lines(
        &knots
            .into_iter()
            .map(|t| at(&a, &ta, t).lerp(at(&b, &tb, t), 0.5))
            .collect::<Vec<_>>(),
    )
}

pub(super) fn simplify(ink: Vec<Primitive>, eps: f64) -> Vec<Primitive> {
    if ink.len() < 3 {
        return ink;
    }
    let mut pts: Vec<_> = ink.iter().map(Primitive::start).collect();
    pts.push(ink.last().unwrap().end());
    let mut keep = vec![false; pts.len()];
    keep[0] = true;
    keep[pts.len() - 1] = true;
    let mut stack = vec![(0, pts.len() - 1)];
    let mut work = 0;
    while let Some((a, b)) = stack.pop() {
        let line = Primitive::Line(Line::new(pts[a], pts[b]));
        let mut far = eps / 8.0;
        let mut split = None;
        for i in a + 1..b {
            work += 1;
            if work > 20_000_000 {
                return ink;
            }
            let d = line.dist_to(pts[i]);
            if d > far {
                far = d;
                split = Some(i);
            }
        }
        if let Some(i) = split {
            keep[i] = true;
            stack.push((a, i));
            stack.push((i, b));
        }
    }
    lines(
        &pts.into_iter()
            .zip(keep)
            .filter_map(|(p, k)| k.then_some(p))
            .collect::<Vec<_>>(),
    )
}

fn middle_ring(polygon: &[Vec<[f64; 2]>], width: f64) -> Vec<Primitive> {
    if polygon.len() != 2 {
        return Vec::new();
    }
    let hole = &polygon[1];
    let edges: Vec<_> = (0..hole.len())
        .map(|i| {
            let a = hole[i];
            let b = hole[(i + 1) % hole.len()];
            Primitive::Line(Line::new(v(a[0], a[1]), v(b[0], b[1])))
        })
        .collect();
    let index = SpatialIndex::build(&edges.iter().map(Primitive::bbox).collect::<Vec<_>>());
    let mut hits = Vec::new();
    let mut pts = Vec::new();
    let mut work = 0;
    for p in &polygon[0] {
        let a = v(p[0], p[1]);
        index.query(&BBox::new(a, a).expanded(width), &mut hits);
        work += hits.len();
        if work > 20_000_000 {
            return Vec::new();
        }
        let Some(b) = hits
            .iter()
            .map(|&i| closest(&edges[i as usize], a).1)
            .min_by(|p, q| a.dist2(*p).total_cmp(&a.dist2(*q)))
        else {
            return Vec::new();
        };
        pts.push(a.lerp(b, 0.5));
    }
    if let Some(&p) = pts.first() {
        pts.push(p);
    }
    lines(&pts)
}

/// A convex capsule containing a triangle's vertices contains the whole
/// triangle. Unlike recursive footprint subtraction, this has a finite mesh
/// worklist; cleanup may overlap existing contour ink inside the visible area.
fn convex_cleanup(
    polygon: &[Vec<[f64; 2]>],
    width: f64,
    eps: f64,
    certify: &dyn Fn(&Primitive) -> bool,
    budget: usize,
) -> Result<Vec<Vec<Primitive>>, String> {
    convex_cleanup_covered(polygon, width, eps, certify, budget, None)
}

fn orientation(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    robust::orient2d(
        robust::Coord { x: a[0], y: a[1] },
        robust::Coord { x: b[0], y: b[1] },
        robust::Coord { x: c[0], y: c[1] },
    )
}

// Remove only EXACTLY collinear intermediate points, without changing the
// region. Earcut can omit these too; canonicalizing first lets the partition
// validator compare directed edges without an approximate point weld.
fn mesh_ring(ring: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut out = Vec::new();
    for &p in ring {
        if out.last() == Some(&p) {
            continue;
        }
        while out.len() >= 2 && orientation(out[out.len() - 2], out[out.len() - 1], p) == 0.0 {
            out.pop();
        }
        out.push(p);
    }
    if out.first() == out.last() {
        out.pop();
    }
    while out.len() >= 3 && orientation(out[out.len() - 2], out[out.len() - 1], out[0]) == 0.0 {
        out.pop();
    }
    let mut first = 0;
    while out.len() - first >= 3
        && orientation(out[out.len() - 1], out[first], out[first + 1]) == 0.0
    {
        first += 1;
    }
    out.drain(..first);
    out
}

/// Every positively oriented triangle contributes its directed boundary.
/// Internal edges must cancel and the remainder must equal the original
/// outer boundary minus its holes. Their winding functions are then equal:
/// since every triangle has positive multiplicity, an overlap or a gap cannot
/// hide behind compensating area. No pairwise triangle intersection pass is
/// needed. Predicates use the original coordinates, not rounded differences.
fn validate_mesh(vertices: &[[f64; 2]], holes: &[usize], indices: &mut [usize]) -> bool {
    use std::collections::BTreeMap;
    if !indices.len().is_multiple_of(3) || vertices.iter().flatten().any(|x| !x.is_finite()) {
        return false;
    }
    let key = |p: [f64; 2]| p.map(|x| if x == 0.0 { 0 } else { x.to_bits() });
    let mut edges = BTreeMap::new();
    let mut add = |a: usize, b: usize, weight: i32| {
        let (a, b) = (key(vertices[a]), key(vertices[b]));
        if a != b {
            let (edge, sign) = if a < b {
                ((a, b), weight)
            } else {
                ((b, a), -weight)
            };
            *edges.entry(edge).or_insert(0i32) += sign;
        }
    };
    for t in indices.chunks_exact_mut(3) {
        if t.iter().any(|&i| i >= vertices.len()) {
            return false;
        }
        let sign = orientation(vertices[t[0]], vertices[t[1]], vertices[t[2]]);
        if sign == 0.0 || !sign.is_finite() {
            return false;
        }
        if sign < 0.0 {
            t.swap(1, 2);
        }
        for i in 0..3 {
            add(t[i], t[(i + 1) % 3], 1);
        }
    }
    let mut start = 0;
    for (ring, end) in holes.iter().copied().chain([vertices.len()]).enumerate() {
        if end < start + 3 || end > vertices.len() {
            return false;
        }
        // An extreme vertex of a normalized simple ring determines winding
        // without cancellation in a sum of floating triangle areas.
        let extreme = (start..end)
            .min_by(|&a, &b| {
                vertices[a][0]
                    .total_cmp(&vertices[b][0])
                    .then(vertices[a][1].total_cmp(&vertices[b][1]))
            })
            .unwrap();
        let prev = if extreme == start {
            end - 1
        } else {
            extreme - 1
        };
        let next = if extreme + 1 == end {
            start
        } else {
            extreme + 1
        };
        let sign = orientation(vertices[prev], vertices[extreme], vertices[next]);
        if sign == 0.0 {
            return false;
        }
        let weight = if (sign > 0.0) == (ring == 0) { -1 } else { 1 };
        for i in start..end {
            add(i, if i + 1 == end { start } else { i + 1 }, weight);
        }
        start = end;
    }
    edges.values().all(|&n| n == 0)
}

fn convex_cleanup_covered(
    polygon: &[Vec<[f64; 2]>],
    width: f64,
    eps: f64,
    certify: &dyn Fn(&Primitive) -> bool,
    budget: usize,
    covered: Option<&Coverage>,
) -> Result<Vec<Vec<Primitive>>, String> {
    let _zone = crate::profile::zone("contour triangle completion");
    let mut vertices = Vec::new();
    let mut holes: Vec<usize> = Vec::new();
    for (i, ring) in polygon.iter().enumerate() {
        let ring = mesh_ring(ring);
        if ring.len() < 3 {
            return Err("contour: residual has a degenerate boundary".into());
        }
        if i > 0 {
            holes.push(vertices.len());
        }
        vertices.extend(ring.iter().copied());
    }
    let origin = vertices[0];
    let local: Vec<_> = vertices
        .iter()
        .map(|p| [p[0] - origin[0], p[1] - origin[1]])
        .collect();
    let mut indices: Vec<usize> = Vec::new();
    earcut::Earcut::new().earcut(local.iter().copied(), &holes, &mut indices);
    if !validate_mesh(&vertices, &holes, &mut indices) {
        // Translation itself can round two distinct input coordinates onto
        // one value. Retry the proposal in the original frame, then apply the
        // SAME boundary proof. Neither frame is trusted without validation.
        indices.clear();
        earcut::Earcut::new().earcut(vertices.iter().copied(), &holes, &mut indices);
        if !validate_mesh(&vertices, &holes, &mut indices) {
            return Err("contour: residual triangulation failed partition validation".into());
        }
    }
    let queue: Vec<[Vec2; 3]> = indices
        .chunks_exact(3)
        .map(|t| {
            [
                v(vertices[t[0]][0], vertices[t[0]][1]),
                v(vertices[t[1]][0], vertices[t[1]][1]),
                v(vertices[t[2]][0], vertices[t[2]][1]),
            ]
        })
        .collect();
    let radius = width / 2.0 - eps / 8.0;
    let mut out = Vec::new();
    let mut work = 0;
    for mut t in queue.into_iter().rev() {
        if covered.is_some_and(|ink| ink.covers(&[t.iter().map(|p| [p.x, p.y]).collect()])) {
            continue;
        }
        work += 1;
        if work > 20_000_000 || out.len() >= budget {
            return Err(format!("contour: residual coverage exceeds geometry budget (marks {}, work {}, allowance {}, triangle {:?})",out.len(),work,budget,t));
        }
        let longest = (0..3)
            .max_by(|&a, &b| {
                t[a].dist2(t[(a + 1) % 3])
                    .total_cmp(&t[b].dist2(t[(b + 1) % 3]))
            })
            .unwrap();
        t.rotate_left(longest);
        let [a, b, c] = t;
        let fits = |p: &Primitive| t.iter().all(|&q| p.dist_to(q) <= radius);
        let center = (a + b + c) / 3.0;
        let mut picked = None;
        // Small remnants can place their tap in adjacent already-inked space.
        if t.iter().all(|&q| q.dist(center) <= radius) {
            for step in [0.0, eps / 4.0, width / 16.0, width / 4.0] {
                for angle in 0..16 {
                    let q = center
                        + Vec2::from_angle(std::f64::consts::TAU * angle as f64 / 16.0) * step;
                    let p = Primitive::Line(Line::new(q, q));
                    if fits(&p) && certify(&p) {
                        picked = Some(p);
                        break;
                    }
                }
                if picked.is_some() {
                    break;
                }
            }
        }
        if picked.is_none() {
            let normal = (b - a).normalized().perp();
            let alpha = (radius / 8.0 / a.dist(c).max(b.dist(c)).max(radius)).min(0.25);
            let start = a.lerp(c, alpha);
            let end = b.lerp(c, alpha);
            for offset in [0.0, eps / 4.0, -eps / 4.0, width / 16.0, -width / 16.0] {
                let p = Primitive::Line(Line::new(start + normal * offset, end + normal * offset));
                if fits(&p) && certify(&p) {
                    picked = Some(p);
                    break;
                }
            }
        }
        if let Some(p) = picked {
            out.push(vec![p]);
            continue;
        }
        // Cover a large triangle in parallel bands, rather than subdividing
        // its whole area into nib-sized triangles. Every band's four corners
        // lie in one round stroke, hence so does the complete convex band.
        {
            // First try bands spaced by their perpendicular height. Their
            // endpoints may extend outside this triangle into already inked
            // material, but exact visibility must certify every whole stroke.
            // If that is forbidden, use the conservative in-triangle bands.
            let axis = (b - a).normalized();
            let normal = axis.perp();
            let coarse_n = (((c - a).dot(normal).abs() / (1.8 * radius)).ceil() as usize).max(1);
            let mut coarse = Vec::new();
            if coarse_n <= budget.saturating_sub(out.len()) {
                for i in 0..coarse_n {
                    let t0 = i as f64 / coarse_n as f64;
                    let t1 = (i + 1) as f64 / coarse_n as f64;
                    let corners = [a.lerp(c, t0), b.lerp(c, t0), b.lerp(c, t1), a.lerp(c, t1)];
                    let lo = corners
                        .iter()
                        .map(|q| (*q - a).dot(axis))
                        .fold(f64::INFINITY, f64::min);
                    let hi = corners
                        .iter()
                        .map(|q| (*q - a).dot(axis))
                        .fold(f64::NEG_INFINITY, f64::max);
                    let y = ((corners[0] - a).dot(normal) + (corners[3] - a).dot(normal)) * 0.5;
                    let p = Primitive::Line(Line::new(
                        a + axis * lo + normal * y,
                        a + axis * hi + normal * y,
                    ));
                    if !corners.iter().all(|&q| p.dist_to(q) <= radius) || !certify(&p) {
                        break;
                    }
                    coarse.push(p);
                }
                if coarse.len() == coarse_n {
                    out.extend(coarse.into_iter().map(|p| vec![p]));
                    continue;
                }
            }
            // Along the longest edge the triangle's horizontal sections
            // nest. Each band's LOWER (wider) section covers its orthogonal
            // projection, including the apex. Contract toward the barycenter
            // to keep the entire stroke inside, reserving the displacement in
            // the capsule radius. Work depends on altitude, never slant length
            // or recursive area subdivision.
            let height = (c - a).dot(normal).abs();
            let n_float = (height / (radius * 0.75)).ceil().max(1.0);
            if !n_float.is_finite() || n_float > budget.saturating_sub(out.len()) as f64 {
                return Err(format!(
                    "contour: residual bands exceed geometry budget ({} bands, {} remaining)",
                    n_float,
                    budget.saturating_sub(out.len())
                ));
            }
            let n = n_float as usize;
            let contraction = (radius / (8.0 * a.dist(b).max(radius))).min(0.25);
            for i in 0..n {
                let t0 = i as f64 / n as f64;
                let t1 = (i + 1) as f64 / n as f64;
                let corners = [a.lerp(c, t0), b.lerp(c, t0), b.lerp(c, t1), a.lerp(c, t1)];
                let p = Primitive::Line(Line::new(
                    corners[0].lerp(center, contraction),
                    corners[1].lerp(center, contraction),
                ));
                if !corners.iter().all(|&q| p.dist_to(q) <= radius) || !certify(&p) {
                    return Err(format!(
                        "contour: no visible cleanup band near ({:.3}, {:.3}) mm",
                        center.x, center.y
                    ));
                }
                out.push(vec![p]);
            }
        }
    }
    Ok(out)
}

pub(super) fn complete(
    polygon: Vec<Vec<[f64; 2]>>,
    width: f64,
    eps: f64,
    certify: &dyn Fn(&Primitive) -> bool,
    budget: usize,
) -> Result<Vec<Vec<Primitive>>, String> {
    let _zone = crate::profile::zone("contour cleanup candidates");
    let radius = width / 2.0;
    let mut out = Vec::new();
    let patch = polygon_shape(&polygon);
    let region = shape_region(&patch);
    let b = region.bbox;
    let center = (b.min + b.max) * 0.5;
    let mut centers = vec![center];
    let mean =
        polygon[0].iter().fold(Vec2::ZERO, |a, p| a + v(p[0], p[1])) / polygon[0].len() as f64;
    centers.push(mean);
    // Near a clipped/approximated boundary the bbox centre may be outside
    // the permitted ink. Try a bounded ring of alternate tap centres, each
    // checked against BOTH the full remnant and exact visibility.
    for i in 0..16 {
        centers.push(
            center + Vec2::from_angle(std::f64::consts::TAU * i as f64 / 16.0) * radius * 0.5,
        );
    }
    let tap = centers.into_iter().find_map(|q| {
        let p = Primitive::Line(Line::new(q, q));
        (polygon
            .iter()
            .flatten()
            .all(|vtx| q.dist(v(vtx[0], vtx[1])) <= radius - eps / 4.0)
            && certify(&p))
        .then_some(p)
    });
    let mut candidate = if let Some(tap) = tap {
        vec![tap]
    } else if polygon.len() == 1 {
        centre_stroke(&polygon[0])
    } else {
        middle_ring(&polygon, width)
    };
    candidate = simplify(candidate, eps);
    if candidate.len() == 1 && candidate[0].length() == 0.0 {
        // A disk is convex: containing every polygon vertex proves it
        // contains the whole polygon, including every edge and interior.
        // No tessellated Boolean is needed for an already certified tap.
        if budget == 0 {
            return Err("contour: residual coverage exceeds geometry budget".into());
        }
        return Ok(vec![candidate]);
    }
    // A centre candidate may start on the exact visible boundary. Trim its
    // tips slightly; its round caps still cover them within the error budget.
    if let Some(first) = candidate.first_mut() {
        let t = (eps / 4.0 / first.length().max(eps)).min(0.25);
        *first = first.sub(t, 1.0);
    }
    if let Some(last) = candidate.last_mut() {
        let t = (eps / 4.0 / last.length().max(eps)).min(0.25);
        *last = last.sub(0.0, 1.0 - t);
    }
    if candidate.is_empty() || !candidate.iter().all(certify) {
        // Residual borders themselves are useful cleanup curves (including
        // closed remnants around holes). Keep only certified continuous
        // pieces; never slide a border through a forbidden region.
        candidate = Vec::new();
        let mut borders: Vec<Vec<Primitive>> = Vec::new();
        for border in &region.contours {
            let mut chain = Vec::new();
            for p in border {
                if certify(p) {
                    chain.push(*p);
                } else if !chain.is_empty() {
                    borders.push(std::mem::take(&mut chain));
                }
            }
            if !chain.is_empty() {
                borders.push(chain);
            }
        }
        borders.sort_by(|a, b| {
            b.iter()
                .map(Primitive::length)
                .sum::<f64>()
                .total_cmp(&a.iter().map(Primitive::length).sum::<f64>())
        });
        // Select one continuous boundary, then re-evaluate the actual gap.
        if let Some(border) = borders.into_iter().find(|p| p.iter().all(certify)) {
            candidate = border;
        }
    }
    if candidate.is_empty() {
        return convex_cleanup(&polygon, width, eps, certify, budget);
    }
    // The kernel can put arcs in inset borders; flatten within the shared
    // budget before constructing the polygonal nib sweep.
    let mut flat = Vec::new();
    for p in &candidate {
        let mut pts = Vec::new();
        p.flatten(eps / 8.0, &mut pts);
        flat.extend(lines(&pts));
    }
    if candidate.len() == 1 && candidate[0].length() == 0.0 {
        flat = candidate;
    }
    if !flat.iter().all(certify) {
        return Err("contour: residual approximation failed visibility".into());
    }
    let mut count = flat.len();
    let work = flat.len() + polygon.iter().map(Vec::len).sum::<usize>();
    if count > budget || work > 20_000_000 {
        return Err("contour: residual coverage exceeds geometry budget".into());
    }
    let remaining = boolean(
        &vec![polygon],
        &footprint(&flat, radius - eps / 8.0, eps)?,
        OverlayRule::Difference,
    );
    let coverage = Coverage::new(flat.clone(), radius);
    out.push(flat);
    for p in remaining.into_iter().rev() {
        if !coverage.covers(&p) {
            let extra = convex_cleanup_covered(
                &p,
                width,
                eps,
                certify,
                budget.saturating_sub(count),
                Some(&coverage),
            )?;
            count += extra.len();
            out.extend(extra);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triangulation_does_not_lose_a_vertex_when_translation_rounds_it() {
        let vertices = [[-1., 0.], [1., 0.], [1., 1.], [0.9999999999999999, 1.]];
        let local: Vec<_> = vertices.iter().map(|p| [p[0] + 1.0, p[1]]).collect();
        assert_eq!(local[2], local[3]);
        let mut indices = Vec::new();
        earcut::Earcut::new().earcut(local.iter().copied(), &[], &mut indices);
        assert!(!validate_mesh(&vertices, &[], &mut indices));
        let ink = convex_cleanup(&[vertices.to_vec()], 0.2, 0.01, &|_| true, 100).unwrap();
        for p in vertices {
            assert!(ink.iter().flatten().any(|line| line.dist_to(v(p[0], p[1])) <= 0.1));
        }
    }

    #[test]
    fn partition_validation_rejects_compensating_gap_and_overlap() {
        let square = [[0., 0.], [1., 0.], [1., 1.], [0., 1.]];
        // Both have total triangle area 1. Only the first covers the square.
        assert!(validate_mesh(&square, &[], &mut [0, 1, 2, 0, 2, 3]));
        assert!(!validate_mesh(&square, &[], &mut [0, 1, 2, 0, 1, 2]));
        assert!(!validate_mesh(&square, &[], &mut [0, 1, 2]));
        assert!(!validate_mesh(&square, &[], &mut [0, 1, 99]));
        let rings = [
            [0., 0.],
            [4., 0.],
            [4., 4.],
            [0., 4.],
            [1., 1.],
            [1., 3.],
            [3., 3.],
            [3., 1.],
        ];
        assert!(!validate_mesh(&rings, &[4], &mut [0, 1, 2, 0, 2, 3]));
    }

    #[test]
    fn coverage_cannot_assign_different_vertices_to_different_capsules() {
        let pts = [v(0., 0.), v(3., 0.), v(0., 3.)];
        let cover = Coverage::new(pts.map(|p| Primitive::Line(Line::new(p, p))).to_vec(), 0.5);
        assert!(!cover.covers(&[pts.map(|p| [p.x, p.y]).to_vec()]));
    }

    #[test]
    fn residual_does_not_credit_space_beyond_the_actual_nib() {
        let region = vec![vec![vec![[0., 0.], [4., 0.], [4., 1.], [0., 1.]]]];
        let ink = vec![vec![Primitive::Line(Line::new(v(0., 0.), v(4., 0.)))]];
        let remainder = uncovered(&region, &ink, 1.0, 0.01, &|_| true).unwrap();
        assert!(remainder
            .iter()
            .any(|p| { shape_region(&polygon_shape(p)).inside(v(2., 0.501)) }));
    }

    #[test]
    fn arc_coverage_never_fills_the_inner_hole_or_opposite_direction() {
        let arc = Primitive::Arc(Arc::new(v(0., 0.), 10., 0., std::f64::consts::PI));
        let cover = Coverage::new(vec![arc], 0.5);
        assert!(!cover.covers(&[vec![[-10., 0.], [10., 0.], [0., 10.]]]));
        assert!(cover.covers(&[vec![[-0.01, 9.99], [0.01, 9.99], [0., 10.01]]]));
        let point = Coverage::new(vec![Primitive::Arc(Arc::new(v(0., 0.), 10., 0., 0.))], 0.5);
        assert!(!point.covers(&[vec![[-10., 0.], [-10.01, 0.], [-9.99, 0.]]]));
    }

    #[test]
    fn cleanup_can_overlap_existing_material_beyond_its_triangle() {
        let polygon = vec![vec![[0., 0.], [20., 0.], [10., 0.4]]];
        let ink = convex_cleanup(
            &polygon,
            0.2,
            0.01,
            &|p| p.start().y >= 0.0 && p.end().y >= 0.0,
            1000,
        )
        .unwrap();
        assert!(ink.len() <= 3, "{} marks", ink.len());
        for i in 0..=100 {
            for j in 0..=100 - i {
                let q = v(
                    20.0 * i as f64 / 100.0 + 10.0 * j as f64 / 100.0,
                    0.4 * j as f64 / 100.0,
                );
                assert!(ink.iter().flatten().any(|p| p.dist_to(q) <= 0.1));
            }
        }
    }

    #[test]
    fn convex_bands_cover_area_without_nib_sized_mesh_explosion() {
        let polygon = vec![vec![[0., 0.], [20., 0.], [10., 12.]]];
        let region = shape_region(&polygon_shape(&polygon));
        let ink = convex_cleanup(
            &polygon,
            0.01,
            0.0005,
            &|p| inside_segment(p, &region),
            10_000,
        )
        .unwrap();
        assert!(ink.len() < 4000, "{} marks", ink.len());
        let index_boxes: Vec<_> = ink.iter().map(|r| r[0].bbox().expanded(0.005)).collect();
        let index = SpatialIndex::build(&index_boxes);
        let mut hits = Vec::new();
        for i in 0..=150 {
            for j in 0..=150 - i {
                let q = v(
                    20.0 * i as f64 / 150.0 + 10.0 * j as f64 / 150.0,
                    12.0 * j as f64 / 150.0,
                );
                index.query(&BBox::new(q, q), &mut hits);
                assert!(
                    hits.iter().any(|&k| ink[k as usize][0].dist_to(q) <= 0.005),
                    "uncovered {q:?}"
                );
            }
        }
        assert!(convex_cleanup(&polygon, 0.01, 0.0005, &|_| true, 3).is_err());
    }

    #[test]
    fn mesh_cleanup_covers_thin_finger_and_keeps_hole_forbidden() {
        let polygon = vec![
            vec![
                [0., 0.],
                [10., 0.],
                [10., 4.96],
                [25., 4.96],
                [25., 5.04],
                [10., 5.04],
                [10., 10.],
                [0., 10.],
            ],
            vec![[3., 3.], [3., 7.], [7., 7.], [7., 3.]],
        ];
        let region = shape_region(&polygon_shape(&polygon));
        let ink =
            convex_cleanup(&polygon, 0.4, 0.01, &|p| inside_segment(p, &region), 20_000).unwrap();
        assert!(ink.iter().flatten().all(|p| inside_segment(p, &region)));
        for i in 0..=1000 {
            for y in [4.96, 5.0, 5.04] {
                let q = v(10.0 + 15.0 * i as f64 / 1000.0, y);
                assert!(
                    ink.iter().flatten().any(|p| p.dist_to(q) <= 0.2),
                    "uncovered finger {q:?}"
                );
            }
        }
    }

    #[test]
    fn curved_strip_coverage_includes_tapered_tips() {
        // A 0.12 mm crescent: fixed-axis hatch rows can miss long curved tips.
        let mut ring = Vec::new();
        for i in 0..=200 {
            let t = 0.2 + 2.5 * i as f64 / 200.0;
            ring.push([20.06 * t.cos(), 20.06 * t.sin()]);
        }
        for i in (0..=200).rev() {
            let t = 0.2 + 2.5 * i as f64 / 200.0;
            ring.push([19.94 * t.cos(), 19.94 * t.sin()]);
        }
        let polygon = vec![ring];
        let ink = complete(polygon.clone(), 0.8, 0.01, &|_| true, 10_000).unwrap();
        for i in 0..=2000 {
            let t = 0.2 + 2.5 * i as f64 / 2000.0;
            for r in [19.94, 20.0, 20.06] {
                let q = Vec2::from_angle(t) * r;
                let distance = ink
                    .iter()
                    .flatten()
                    .map(|p| q.dist(closest(p, q).1))
                    .fold(f64::INFINITY, f64::min);
                assert!(distance <= 0.401, "uncovered {q:?}: {distance}");
            }
        }
        assert!(ink.len() <= 3, "{} cleanup runs", ink.len());
        assert!(boolean(
            &vec![polygon],
            &footprint(&ink.concat(), 0.4, 0.01).unwrap(),
            OverlayRule::Difference
        )
        .is_empty());
    }

    #[test]
    fn tap_requires_whole_remnant_to_fit_and_budget_is_enforced() {
        let p = vec![vec![[0., 0.], [0.2, 0.], [0.2, 0.2], [0., 0.2]]];
        let ink = complete(p.clone(), 0.8, 0.01, &|_| true, 10).unwrap();
        assert_eq!(ink.len(), 1);
        assert_eq!(ink[0][0].length(), 0.0);
        assert!(complete(p, 0.8, 0.01, &|_| true, 0).is_err());
    }
}

/// Join only endpoints of nearby cleanup marks. No return trip, loop splitting,
/// or obligation to join. Mutable spatial buckets remove consumed endpoints;
/// at most 64 candidates per neighboring cell enter the local search.
pub(super) fn join(
    result: &mut Generated,
    begin: usize,
    spacing: f64,
    certify: &dyn Fn(&Primitive) -> bool,
) {
    let ids: Vec<_> = result.cleanup_runs.range(begin..).copied().collect();
    let mut ends = Vec::new();
    use std::collections::{BTreeMap, BTreeSet};
    let cell = |p: Vec2| {
        (
            (p.x / (2.0 * spacing)).floor() as i64,
            (p.y / (2.0 * spacing)).floor() as i64,
        )
    };
    let mut cells: BTreeMap<(i64, i64), BTreeSet<usize>> = BTreeMap::new();
    let mut slots = vec![[0usize; 2]; result.runs.len()];
    for &ri in &ids {
        for (side, p) in [
            result.runs[ri][0].start(),
            result.runs[ri].last().unwrap().end(),
        ]
        .into_iter()
        .enumerate()
        {
            let id = ends.len();
            slots[ri][side] = id;
            ends.push((ri, side == 1, p));
            cells.entry(cell(p)).or_default().insert(id);
        }
    }
    let erase = |ri: usize, cells: &mut BTreeMap<(i64, i64), BTreeSet<usize>>| {
        for &id in &slots[ri] {
            if let Some(bucket) = cells.get_mut(&cell(ends[id].2)) {
                bucket.remove(&id);
            }
        }
    };
    let mut hits = Vec::new();
    let mut primitive_count = count_prims(&result.runs);
    for ri in ids {
        erase(ri, &mut cells);
        if result.runs[ri].is_empty() {
            continue;
        }
        loop {
            let a = result.runs[ri].last().unwrap().end();
            hits.clear();
            let (cx, cy) = cell(a);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    if let Some(bucket) = cells.get(&(cx.saturating_add(dx), cy.saturating_add(dy)))
                    {
                        hits.extend(bucket.iter().take(64).copied());
                    }
                }
            }
            let mut candidates: Vec<_> = hits
                .iter()
                .filter_map(|&i| {
                    let (other, rev, b) = ends[i as usize];
                    let d = a.dist(b);
                    (d <= 2.0 * spacing).then_some((d, other, rev, b))
                })
                .collect();
            candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
            let mut picked = None;
            for (_, other, rev, b) in candidates.into_iter().take(32) {
                result.diagnostics.connector_tests += 1;
                if (a == b || primitive_count < MAX_PRIMITIVES)
                    && certify(&Primitive::Line(Line::new(a, b)))
                {
                    picked = Some((other, rev, b));
                    break;
                }
            }
            let Some((other, rev, b)) = picked else {
                break;
            };
            erase(other, &mut cells);
            let mut ink = std::mem::take(&mut result.runs[other]);
            result.cleanup_runs.remove(&other);
            // Do not rescan the growing run at every join (quadratic work).
            if result.runs[ri].len() == 1 && result.runs[ri][0].length() == 0.0 {
                result.runs[ri].clear();
            }
            ink.retain(|p| p.length() > 0.0);
            if a != b {
                primitive_count += 1;
                result.runs[ri].push(Primitive::Line(Line::new(a, b)));
            }
            result.runs[ri].extend(if rev {
                ink.iter()
                    .rev()
                    .map(crate::gcode::reverse_primitive)
                    .collect()
            } else {
                ink
            });
            if result.runs[ri].is_empty() {
                result.runs[ri].push(Primitive::Line(Line::new(b, b)));
            }
            result.diagnostics.connectors += 1;
        }
    }
}

#[cfg(test)]
mod join_tests {
    use super::*;
    #[test]
    fn dense_cleanup_keeps_search_bounded_and_preserves_coincident_taps() {
        let mut ink = Generated::default();
        for i in 0..10_000 {
            let p = v((i / 2) as f64 * 0.001, 0.0);
            ink.cleanup_runs.insert(ink.runs.len());
            ink.runs.push(vec![Primitive::Line(Line::new(p, p))]);
        }
        join(&mut ink, 0, 0.18, &|_| true);
        let runs: Vec<_> = ink.runs.iter().filter(|r| !r.is_empty()).collect();
        assert_eq!(runs.len(), 1);
        assert!(ink.diagnostics.connector_tests <= 32 * 10_000);
        assert_eq!(runs[0][0].start(), v(0.0, 0.0));
        assert!(runs[0].last().unwrap().end().dist(v(4.999, 0.0)) < 1e-10);
        for pair in runs[0].windows(2) {
            assert_eq!(pair[0].end(), pair[1].start());
        }
    }

    #[test]
    fn joins_taps_without_retracing_and_keeps_forbidden_breaks() {
        let mut ink = Generated::default();
        for x in [0.0, 0.6, 1.2, 1.8] {
            ink.cleanup_runs.insert(ink.runs.len());
            ink.runs
                .push(vec![Primitive::Line(Line::new(v(x, 0.), v(x, 0.)))]);
        }
        join(&mut ink, 0, 0.72, &|p| {
            !(p.start().x < 1.0 && p.end().x > 1.0)
        });
        let live: Vec<_> = ink.runs.iter().filter(|r| !r.is_empty()).collect();
        assert_eq!(live.len(), 2);
        for run in live {
            assert_eq!(run.len(), 1);
            assert!((run[0].length() - 0.6).abs() < 1e-9);
        }
    }
}
