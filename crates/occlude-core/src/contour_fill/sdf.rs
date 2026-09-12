//! Experimental distance-field contour fill. Enabled only by `contour-sdf`.
//! The Boolean visible area and the exact pre-modifier visibility check are
//! shared with production. No offset kernel or swept-ink Boolean is used here.
//!
//! Marching squares samples distance to the flattened visible boundary. This
//! first comparison uses a uniform, nib-relative grid, streamed in two rows.
//! It deliberately does NOT claim the production offset error budget: contour
//! interpolation can err by up to the cell diagonal (+ boundary flattening).
//! Coverage cells use Lipschitz distance bounds, not just pixel occupancy.
use super::*;
use std::collections::HashMap;

const MAX_SAMPLES: usize = 32_000_000;
const MAX_COVERAGE_WORK: usize = 32_000_000;

#[derive(Clone, Copy)]
struct Segment {
    a: Vec2,
    b: Vec2,
    owner: usize,
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
    fn primitive(self) -> Primitive {
        Primitive::Line(Line::new(self.a, self.b))
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
    signs: std::cell::RefCell<HashMap<u64, Vec<f64>>>,
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
                let x = bbox.width() >= bbox.height();
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
            signs: Default::default(),
        }
    }
    fn nearest(&self, p: Vec2, limit: f64) -> (f64, Option<Segment>) {
        let mut best = limit * limit;
        let mut found = None;
        if self.nodes.is_empty() {
            return (limit, None);
        }
        let mut stack = [0usize; 64];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let n = &self.nodes[stack[top]];
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
    fn inside(&self, p: Vec2) -> bool {
        if self.nodes.is_empty() {
            return false;
        }
        let mut cache = self.signs.borrow_mut();
        if cache.len() > 8192 {
            cache.clear();
        }
        let row = cache.entry(p.y.to_bits()).or_insert_with(|| {
            let mut xs = Vec::new();
            let mut stack = [0usize; 64];
            let mut top = 1;
            while top > 0 {
                top -= 1;
                let n = &self.nodes[stack[top]];
                if p.y < n.bbox.min.y || p.y >= n.bbox.max.y {
                    continue;
                }
                if let Some((l, r)) = n.children {
                    stack[top] = l;
                    stack[top + 1] = r;
                    top += 2;
                } else {
                    for s in &self.segments[n.begin..n.end] {
                        if (s.a.y > p.y) != (s.b.y > p.y) {
                            xs.push(s.a.x + (p.y - s.a.y) * (s.b.x - s.a.x) / (s.b.y - s.a.y));
                        }
                    }
                }
            }
            xs.sort_unstable_by(f64::total_cmp);
            xs
        });
        row.partition_point(|&x| x <= p.x) % 2 == 1
    }
    fn row(&self, y: f64, x0: f64, step: f64, values: &mut [f64]) {
        let mut crossings: Vec<_> = self
            .segments
            .iter()
            .filter(|s| (s.a.y > y) != (s.b.y > y))
            .map(|s| s.a.x + (y - s.a.y) * (s.b.x - s.a.x) / (s.b.y - s.a.y))
            .collect();
        crossings.sort_unstable_by(f64::total_cmp);
        let mut at = 0;
        for (i, d) in values.iter_mut().enumerate() {
            let x = x0 + i as f64 * step;
            while at < crossings.len() && crossings[at] <= x {
                at += 1;
            }
            let distance = self.nearest(v(x, y), f64::INFINITY).0;
            *d = if at % 2 == 1 { distance } else { -distance };
        }
    }
    fn signed(&self, p: Vec2) -> f64 {
        let d = self.nearest(p, f64::INFINITY).0;
        if self.inside(p) {
            d
        } else {
            -d
        }
    }
    fn intersects(&self, bbox: BBox) -> bool {
        if self.nodes.is_empty() {
            return false;
        }
        let mut stack = [0usize; 64];
        let mut top = 1;
        while top > 0 {
            top -= 1;
            let n = &self.nodes[stack[top]];
            if !bbox.overlaps(&n.bbox) {
                continue;
            }
            if let Some((l, r)) = n.children {
                stack[top] = l;
                stack[top + 1] = r;
                top += 2;
            } else {
                if self.segments[n.begin..n.end]
                    .iter()
                    .any(|s| bbox.intersects_segment(s.a, s.b))
                {
                    return true;
                }
            }
        }
        false
    }
}

struct Vertex {
    p: Vec2,
    edges: [usize; 2],
    degree: usize,
}
#[derive(Default)]
struct Graph {
    keys: HashMap<(usize, usize), usize>,
    vertices: Vec<Vertex>,
    edges: Vec<(usize, usize)>,
}
impl Graph {
    fn vertex(&mut self, key: (usize, usize), p: Vec2) -> usize {
        *self.keys.entry(key).or_insert_with(|| {
            let i = self.vertices.len();
            self.vertices.push(Vertex {
                p,
                edges: [0; 2],
                degree: 0,
            });
            i
        })
    }
    fn edge(&mut self, a: usize, b: usize) -> Result<(), String> {
        if self.edges.len() >= MAX_PRIMITIVES {
            return Err("contour SDF prototype: contour primitive budget exceeded".into());
        }
        let id = self.edges.len();
        for i in [a, b] {
            let n = &mut self.vertices[i];
            if n.degree == 2 {
                return Err("contour SDF prototype: nonmanifold marching graph".into());
            }
            n.edges[n.degree] = id;
            n.degree += 1;
        }
        self.edges.push((a, b));
        Ok(())
    }
    fn runs(self) -> Vec<Vec<Primitive>> {
        let mut used = vec![false; self.edges.len()];
        let mut runs = Vec::new();
        // Endpoints first, then closed loops. Hash iteration never sets order.
        for open in [true, false] {
            for start in 0..self.vertices.len() {
                if open && self.vertices[start].degree != 1 {
                    continue;
                }
                let mut at = start;
                let mut run = Vec::new();
                loop {
                    let n = &self.vertices[at];
                    let edge = n.edges[..n.degree].iter().copied().find(|&i| !used[i]);
                    let Some(e) = edge else { break };
                    used[e] = true;
                    let (a, b) = self.edges[e];
                    let next = if a == at { b } else { a };
                    let p = self.vertices[at].p;
                    let q = self.vertices[next].p;
                    if p != q {
                        run.push(Primitive::Line(Line::new(p, q)));
                    }
                    at = next;
                }
                if !run.is_empty() {
                    runs.push(run);
                }
            }
        }
        runs
    }
}

fn contours(
    field: &DistanceIndex,
    width: f64,
    spacing: f64,
    eps: f64,
) -> Result<(Vec<Vec<Primitive>>, usize), String> {
    let _zone = crate::profile::zone("SDF sample and march");
    let b = field.nodes[0].bbox.expanded(width / 4.0);
    let step = width.min(spacing) / 2.0;
    let nx = (b.width() / step).ceil().max(1.0) as usize;
    let ny = (b.height() / step).ceil().max(1.0) as usize;
    if nx
        .checked_add(1)
        .and_then(|n| ny.checked_add(1).and_then(|m| n.checked_mul(m)))
        .is_none_or(|n| n > MAX_SAMPLES)
    {
        return Err(format!("contour SDF prototype: uniform sampling exceeds {MAX_SAMPLES} samples at step {step:.6} mm; adaptive sampling required"));
    }
    let sx = b.width() / nx as f64;
    let sy = b.height() / ny as f64;
    let point = |x: usize, y: usize| v(b.min.x + x as f64 * sx, b.min.y + y as f64 * sy);
    let mut top = vec![0.0; nx + 1];
    field.row(b.min.y, b.min.x, sx, &mut top);
    let mut bottom = vec![0.0; nx + 1];
    let mut graph = Graph::default();
    let mut levels = 0;
    let first = (width / 2.0 - eps / 2.0).max(width / 4.0);
    for y in 0..ny {
        field.row(point(0, y + 1).y, b.min.x, sx, &mut bottom);
        for x in 0..nx {
            let vals = [top[x], top[x + 1], bottom[x + 1], bottom[x]];
            let lo = vals.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = vals.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            if hi < first {
                continue;
            }
            let k0 = ((lo - first) / spacing).ceil().max(0.0) as usize;
            let k1 = ((hi - first) / spacing).floor() as usize;
            if k1 >= MAX_LEVELS {
                return Err("contour SDF prototype: level budget exceeded".into());
            }
            let corners = [
                point(x, y),
                point(x + 1, y),
                point(x + 1, y + 1),
                point(x, y + 1),
            ];
            // Horizontal and vertical edge keys are global, including the
            // level. Both cells evaluate each crossing in the same direction.
            let keys = [
                2 * (y * (nx + 1) + x),
                2 * (y * (nx + 1) + x + 1) + 1,
                2 * ((y + 1) * (nx + 1) + x),
                2 * (y * (nx + 1) + x) + 1,
            ];
            let endpoints = [(0, 1), (1, 2), (3, 2), (0, 3)];
            for k in k0..=k1 {
                let level = first + k as f64 * spacing;
                let mut hits = Vec::with_capacity(4);
                for e in 0..4 {
                    let (a, b) = endpoints[e];
                    if (vals[a] >= level) == (vals[b] >= level) {
                        continue;
                    }
                    let t = ((level - vals[a]) / (vals[b] - vals[a])).clamp(0.0, 1.0);
                    hits.push((
                        e,
                        graph.vertex((keys[e], k), corners[a].lerp(corners[b], t)),
                    ));
                }
                if hits.len() == 2 {
                    graph.edge(hits[0].1, hits[1].1)?;
                } else if hits.len() == 4 {
                    // Resolve saddle ambiguity against the actual field.
                    let center = field.signed((corners[0] + corners[2]) * 0.5) >= level;
                    for c in 0..4 {
                        if (vals[c] >= level) != center {
                            graph.edge(hits[(c + 3) % 4].1, hits[c].1)?;
                        }
                    }
                }
                if !hits.is_empty() {
                    levels = levels.max(k + 1);
                }
            }
        }
        std::mem::swap(&mut top, &mut bottom);
    }
    Ok((graph.runs(), levels))
}

// Fit only bounded local windows. Each chord's radial extrema and the
// monotone angular order are checked, so vertices alone cannot hide a bulge
// between samples. Arcs are at most a semicircle and still pass exact scene
// visibility. This representation matters to decimate and the plot estimator.
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
            owner: usize::MAX,
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
fn reconstruct_arcs(lines: Vec<Primitive>, tolerance: f64) -> Vec<Primitive> {
    let _zone = crate::profile::zone("SDF arc reconstruction");
    if lines.len() < 4 {
        return lines;
    }
    let mut points: Vec<_> = lines.iter().map(Primitive::start).collect();
    points.push(lines.last().unwrap().end());
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
    originals: Vec<Primitive>,
    actual_radius: f64,
    extra: Vec<Segment>,
    buckets: HashMap<(i64, i64), Vec<usize>>,
    radius: f64,
}
impl Ink {
    fn new(runs: &[Vec<Primitive>], radius: f64, eps: f64) -> Self {
        let mut segments = Vec::new();
        let mut points = Vec::new();
        let originals: Vec<_> = runs.iter().flatten().copied().collect();
        for (owner, p) in originals.iter().enumerate() {
            points.clear();
            p.flatten(eps / 4.0, &mut points);
            segments.extend(points.windows(2).map(|p| Segment {
                a: p[0],
                b: p[1],
                owner,
            }));
        }
        Self {
            initial: DistanceIndex::new(segments),
            originals,
            actual_radius: radius,
            extra: Vec::new(),
            buckets: HashMap::new(),
            // Distance to the chord approximation can understate distance to
            // the actual arc by eps/4. Reserve that error in every certificate.
            radius: radius - eps / 4.0,
        }
    }
    fn cell(&self, p: Vec2) -> (i64, i64) {
        (
            (p.x / (2.0 * self.radius)).floor() as i64,
            (p.y / (2.0 * self.radius)).floor() as i64,
        )
    }
    fn distance(&self, p: Vec2) -> f64 {
        let mut d = self.initial.nearest(p, self.radius).0;
        if let Some(ids) = self.buckets.get(&self.cell(p)) {
            for &i in ids {
                d = d.min(self.extra[i].closest(p).dist(p));
            }
        }
        d
    }
    fn covers(&self, b: BBox, tolerance: f64) -> bool {
        let p = b.center();
        let corners = [b.min, v(b.max.x, b.min.y), b.max, v(b.min.x, b.max.y)];
        let fits = |s: Segment| {
            corners
                .iter()
                .all(|&q| s.closest(q).dist(q) <= self.radius - tolerance)
        };
        if let Some(s) = self.initial.nearest(p, self.actual_radius).1 {
            if fits(s) {
                return true;
            }
            if let Primitive::Arc(a) = self.originals[s.owner] {
                // A <= PI angular sector is convex. Its radial interval over
                // the entire box is bounded by the nearest point and corners.
                // This certifies the actual arc capsule, not merely its chords.
                let near = v(
                    a.center.x.clamp(b.min.x, b.max.x),
                    a.center.y.clamp(b.min.y, b.max.y),
                );
                let start = Vec2::from_angle(a.start);
                let end = Vec2::from_angle(a.start + a.sweep);
                let radius = self.actual_radius - tolerance;
                if a.sweep.abs() <= std::f64::consts::PI
                    && a.sweep != 0.0
                    && near.dist(a.center) >= (a.r - radius).max(0.0)
                    && corners.iter().all(|&q| {
                        let d = q - a.center;
                        d.len() <= a.r + radius
                            && start.cross(d) * a.sweep.signum() >= 0.0
                            && d.cross(end) * a.sweep.signum() >= 0.0
                    })
                {
                    return true;
                }
            }
        }
        self.buckets
            .get(&self.cell(p))
            .is_some_and(|ids| ids.iter().any(|&i| fits(self.extra[i])))
    }
    fn add(&mut self, s: Segment) {
        let b = s.bbox().expanded(self.radius);
        let lo = self.cell(b.min);
        let hi = self.cell(b.max);
        let id = self.extra.len();
        self.extra.push(s);
        for y in lo.1..=hi.1 {
            for x in lo.0..=hi.0 {
                self.buckets.entry((x, y)).or_default().push(id);
            }
        }
    }
}

fn complete(
    field: &DistanceIndex,
    width: f64,
    eps: f64,
    certify: &dyn Fn(&Primitive) -> bool,
    result: &mut Generated,
    begin: usize,
) -> Result<(), String> {
    let _zone = crate::profile::zone("SDF distance coverage");
    let radius = width / 2.0;
    let mut ink = Ink::new(&result.runs[begin..], radius, eps);
    let mut stack = vec![(field.nodes[0].bbox, false)];
    let mut work = 0;
    let mut primitive_count = count_prims(&result.runs);
    while let Some((cell, known_inside)) = stack.pop() {
        work += 1;
        #[cfg(feature = "profile")]
        if work % 1_000_000 == 0 {
            eprintln!("SDF coverage cells {work}, marks {}", ink.extra.len());
        }
        if work > MAX_COVERAGE_WORK {
            return Err("contour SDF prototype: coverage cell budget exceeded".into());
        }
        let p = cell.center();
        let half = (cell.max - cell.min).len() / 2.0;
        // Unsigned distance to a union of strokes is 1-Lipschitz: this
        // certifies ALL points in the cell, including any narrow finger.
        if half < width && ink.covers(cell, eps / 1024.0) {
            continue;
        }
        let (distance, nearest) = if known_inside {
            (f64::INFINITY, None)
        } else {
            field.nearest(p, f64::INFINITY)
        };
        let inside = known_inside || field.inside(p);
        if !inside && (distance > half + eps / 4.0 || !field.intersects(cell)) {
            continue;
        }
        let children_inside = inside && distance > half + eps / 4.0;
        if half <= width / 8.0 && ink.distance(p) > ink.radius - eps / 8.0 {
            let nearest = nearest
                .or_else(|| field.nearest(p, f64::INFINITY).1)
                .unwrap();
            let q = if inside || certify(&Primitive::Line(Line::new(p, p))) {
                Some(p)
            } else {
                let edge = nearest.closest(p);
                let normal = (nearest.b - nearest.a).normalized().perp();
                [2.0, 0.25, 0.03125]
                    .into_iter()
                    .flat_map(|scale| {
                        [edge + normal * (eps * scale), edge - normal * (eps * scale)]
                    })
                    .find(|&q| field.inside(q) && certify(&Primitive::Line(Line::new(q, q))))
            };
            if let Some(q) = q {
                let tangent = (nearest.b - nearest.a).normalized();
                // Marks overlap earlier ink and follow the local boundary.
                // Try a short stroke, halve if it crosses a forbidden area,
                // then a tap. Every retained mark passes exact visibility.
                let mut chosen = None;
                for scale in [1.0, 0.5, 0.25, 0.0] {
                    let d = tangent * (width * scale);
                    let s = Segment {
                        a: q - d,
                        b: q + d,
                        owner: usize::MAX,
                    };
                    if certify(&s.primitive()) {
                        chosen = Some(s);
                        break;
                    }
                }
                if let Some(s) = chosen {
                    if primitive_count >= MAX_PRIMITIVES {
                        return Err(
                            "contour SDF prototype: cleanup primitive budget exceeded".into()
                        );
                    }
                    primitive_count += 1;
                    ink.add(s);
                    result.cleanup_runs.insert(result.runs.len());
                    result.runs.push(vec![s.primitive()]);
                    result.diagnostics.residual_patches += 1;
                    if ink.covers(cell, eps / 1024.0) {
                        continue;
                    }
                }
            }
        }
        if half < eps / 128.0 {
            // Normalization flattened curves within eps/4. A cell on that
            // approximate boundary can lie outside the exact permitted area.
            // Permit this discrepancy only within the boundary error band;
            // an interior failure remains an error, never a coverage claim.
            if distance <= eps && !certify(&Primitive::Line(Line::new(p, p))) {
                continue;
            }
            return Err(format!("contour SDF prototype: unresolved boundary cell near ({:.6}, {:.6}) mm, side {:.9} mm, field distance {}, ink distance {}, inside {}",p.x,p.y,cell.width().max(cell.height()),distance,ink.distance(p),inside));
        }
        let c = cell.center();
        for (a, b) in [
            (c, cell.max),
            (v(cell.min.x, c.y), v(c.x, cell.max.y)),
            (v(c.x, cell.min.y), v(cell.max.x, c.y)),
            (cell.min, c),
        ] {
            stack.push((BBox::new(a, b), children_inside));
        }
    }
    Ok(())
}

pub(super) fn generate(
    components: Vec<Shape<f64>>,
    width: f64,
    spacing: f64,
    certify: &dyn Fn(&Primitive) -> bool,
) -> Result<Generated, String> {
    let eps = error_budget(width, spacing)?;
    let mut result = Generated::default();
    result.diagnostics.components = components.len();
    for component in components {
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
                        owner: usize::MAX,
                    })
            })
            .collect();
        let field = DistanceIndex::new(segments);
        if field.nodes.is_empty() {
            continue;
        }
        let begin = result.runs.len();
        let (rings, levels) = contours(&field, width, spacing, eps)?;
        #[cfg(feature = "profile")]
        eprintln!(
            "SDF marched: {} rings, {} segments",
            rings.len(),
            count_prims(&rings)
        );
        result.diagnostics.levels += levels;
        result.diagnostics.contours += rings.len();
        for ring in rings {
            let simplified = reconstruct_arcs(cleanup::simplify(ring, eps * 4.0), eps);
            let mut run = Vec::new();
            for p in simplified {
                if certify(&p) {
                    run.push(p);
                } else {
                    result.diagnostics.validation_splits += 1;
                    if !run.is_empty() {
                        result.runs.push(std::mem::take(&mut run));
                    }
                }
            }
            if !run.is_empty() {
                result.runs.push(run);
            }
        }
        #[cfg(feature = "profile")]
        eprintln!("SDF validated: {} segments", count_prims(&result.runs));
        // Sparse contours intentionally leave gaps. Never densify them.
        if spacing <= width {
            complete(&field, width, eps, certify, &mut result, begin)?;
            // Reuse the existing bounded, whole-interval-certified local join
            // for cleanup marks only. Regular contour loops stay independent.
            cleanup::join(&mut result, begin, spacing, certify);
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
                        owner: usize::MAX,
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
}
