//! Local vector coverage completion. A short centre stroke is a candidate,
//! never a coverage assumption: subtract its round-nib sweep and finish only
//! what remains. Cleanup is independent ink, not an excursion from a loop.
use super::*;

// Inscribed round caps: the Boolean certificate never overstates nib coverage.
fn footprint(ink: &[Primitive], radius: f64, eps: f64) -> Result<Polygons, String> {
    let n = (std::f64::consts::PI / (1.0 - eps / (8.0 * radius)).clamp(-1.0, 1.0).acos())
        .ceil()
        .max(12.0);
    if !n.is_finite() || n > 4096.0 || (ink.len() + 1) as f64 * (n + 4.0) > 2_000_000.0 {
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

fn simplify(ink: Vec<Primitive>, eps: f64) -> Vec<Primitive> {
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
            if work > 100_000 {
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
        if work > 100_000 {
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

pub(super) fn complete(
    polygon: Vec<Vec<[f64; 2]>>,
    width: f64,
    eps: f64,
    certify: &dyn Fn(&Primitive) -> bool,
    budget: usize,
) -> Result<Vec<Vec<Primitive>>, String> {
    let radius = width / 2.0;
    let mut queue = vec![(polygon, 0)];
    let mut out = Vec::new();
    let mut count = 0;
    let mut work = 0;
    while let Some((polygon, depth)) = queue.pop() {
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
            count += 1;
            if count > budget {
                return Err("contour: residual coverage exceeds geometry budget".into());
            }
            out.push(candidate);
            continue;
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
        if candidate.is_empty() || depth >= 8 {
            return Err(format!(
                "contour: could not certify residual coverage near ({:.3}, {:.3}) mm",
                center.x, center.y
            ));
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
        count += flat.len();
        work += flat.len() + polygon.iter().map(Vec::len).sum::<usize>();
        if count > budget || work > 100_000 {
            return Err("contour: residual coverage exceeds geometry budget".into());
        }
        let remaining = boolean(
            &vec![polygon],
            &footprint(&flat, radius - eps / 8.0, eps)?,
            OverlayRule::Difference,
        );
        out.push(flat);
        for p in remaining.into_iter().rev() {
            queue.push((p, depth + 1));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

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
/// or obligation to join. The index is fixed; consumed marks are tombstones.
pub(super) fn join(
    result: &mut Generated,
    begin: usize,
    spacing: f64,
    certify: &dyn Fn(&Primitive) -> bool,
) {
    let ids: Vec<_> = result.cleanup_runs.range(begin..).copied().collect();
    let mut ends = Vec::new();
    let mut boxes = Vec::new();
    for &ri in &ids {
        for (reverse, p) in [
            (false, result.runs[ri][0].start()),
            (true, result.runs[ri].last().unwrap().end()),
        ] {
            ends.push((ri, reverse, p));
            boxes.push(BBox::new(p, p));
        }
    }
    let index = SpatialIndex::build(&boxes);
    let mut hits = Vec::new();
    let mut started = std::collections::BTreeSet::new();
    for ri in ids {
        started.insert(ri);
        if result.runs[ri].is_empty() {
            continue;
        }
        loop {
            let a = result.runs[ri].last().unwrap().end();
            index.query(&BBox::new(a, a).expanded(2.0 * spacing), &mut hits);
            let mut candidates: Vec<_> = hits
                .iter()
                .filter_map(|&i| {
                    let (other, rev, b) = ends[i as usize];
                    let d = a.dist(b);
                    (!started.contains(&other)
                        && !result.runs[other].is_empty()
                        && d <= 2.0 * spacing)
                        .then_some((d, other, rev, b))
                })
                .collect();
            candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
            let mut picked = None;
            for (_, other, rev, b) in candidates.into_iter().take(32) {
                result.diagnostics.connector_tests += 1;
                if certify(&Primitive::Line(Line::new(a, b))) {
                    picked = Some((other, rev, b));
                    break;
                }
            }
            let Some((other, rev, b)) = picked else {
                break;
            };
            let ink = std::mem::take(&mut result.runs[other]);
            result.cleanup_runs.remove(&other);
            result.runs[ri].retain(|p| p.length() > 0.0);
            if a != b {
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
            if result.runs[ri].len() > 1 {
                result.runs[ri].retain(|p| p.length() > 0.0);
            }
            result.diagnostics.connectors += 1;
        }
    }
}

#[cfg(test)]
mod join_tests {
    use super::*;
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
