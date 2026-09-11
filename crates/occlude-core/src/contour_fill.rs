//! Native connected contour fill. Boolean normalization is separate from
//! offsetting; the exact scene regions remain the final visibility authority.
use crate::bbox::BBox;
use crate::index::SpatialIndex;
use crate::primitive::{Arc, Line, Primitive};
use crate::region::{Region, WindingRule};
use crate::vec2::{v, Vec2};
use cavalier_contours::polyline::{
    seg_arc_radius_and_center, PlineSource, PlineSourceMut, Polyline,
};
use cavalier_contours::shape_algorithms::{Shape, ShapeOffsetOptions};
use i_overlay::core::{fill_rule::FillRule, overlay_rule::OverlayRule};
use i_overlay::float::overlay::FloatOverlay;

type Polygons = Vec<Vec<Vec<[f64; 2]>>>;
pub const MAX_PRIMITIVES: usize = 250_000;
const MAX_LEVELS: usize = 4096;

#[derive(Debug, Default, Clone)]
pub struct Diagnostics {
    pub components: usize,
    pub levels: usize,
    pub contours: usize,
    pub connectors: usize,
    pub connector_tests: usize,
    pub residual_patches: usize,
    pub fallbacks: usize,
    pub validation_splits: usize,
    pub fallback_thin: usize,
    pub fallback_budget: usize,
    pub fallback_unstable: usize,
}

impl Diagnostics {
    pub fn add(&mut self, other: &Self) {
        self.components += other.components;
        self.levels += other.levels;
        self.contours += other.contours;
        self.connectors += other.connectors;
        self.connector_tests += other.connector_tests;
        self.residual_patches += other.residual_patches;
        self.fallbacks += other.fallbacks;
        self.validation_splits += other.validation_splits;
        self.fallback_thin += other.fallback_thin;
        self.fallback_budget += other.fallback_budget;
        self.fallback_unstable += other.fallback_unstable;
    }
}

pub fn error_budget(width: f64, spacing: f64) -> Result<f64, String> {
    if !width.is_finite() || width <= 0.0 || !spacing.is_finite() || spacing <= 0.0 {
        return Err("contour: pen width and spacing must be finite and positive".into());
    }
    Ok(0.01_f64.min(width / 20.0).min(spacing / 10.0))
}

fn options(eps: f64) -> ShapeOffsetOptions<f64> {
    // Kernel tolerances consume at most an eighth of the aggregate budget.
    ShapeOffsetOptions {
        pos_equal_eps: eps / 64.0,
        offset_dist_eps: eps / 64.0,
        slice_join_eps: eps / 32.0,
    }
}

fn pline(prims: &[Primitive], eps: f64) -> Polyline {
    let mut p = Polyline::new_closed();
    for prim in prims {
        match prim {
            Primitive::Line(l) => p.add(l.p0.x, l.p0.y, 0.0),
            Primitive::Arc(a) => {
                let n = (a.sweep.abs() / std::f64::consts::PI).ceil().max(1.0) as usize;
                for i in 0..n {
                    let q = a.eval(i as f64 / n as f64);
                    p.add(q.x, q.y, (a.sweep / n as f64 / 4.0).tan());
                }
            }
            Primitive::Cubic(_) => {
                let mut pts = Vec::new();
                prim.flatten(eps / 4.0, &mut pts);
                for q in pts.iter().take(pts.len().saturating_sub(1)) {
                    p.add(q.x, q.y, 0.0);
                }
            }
        }
    }
    p
}

fn primitives(p: &Polyline) -> Vec<Primitive> {
    p.iter_segments()
        .map(|(a, b)| {
            if a.bulge == 0.0 {
                Primitive::Line(Line::new(v(a.x, a.y), v(b.x, b.y)))
            } else {
                let (r, c) = seg_arc_radius_and_center(a, b);
                Primitive::Arc(Arc::new(
                    v(c.x, c.y),
                    r,
                    (a.y - c.y).atan2(a.x - c.x),
                    4.0 * a.bulge.atan(),
                ))
            }
        })
        .collect()
}

fn flat(contours: &[Vec<Primitive>], eps: f64) -> Vec<Vec<[f64; 2]>> {
    contours
        .iter()
        .map(|c| {
            let mut out = Vec::new();
            for p in c {
                let mut pts = Vec::new();
                p.flatten(eps / 4.0, &mut pts);
                out.extend(
                    pts.iter()
                        .take(pts.len().saturating_sub(1))
                        .map(|p| [p.x, p.y]),
                );
            }
            out
        })
        .filter(|c| c.len() >= 3)
        .collect()
}

fn normalize(region: &Region, eps: f64) -> Polygons {
    let rule = match region.winding {
        WindingRule::EvenOdd => FillRule::EvenOdd,
        WindingRule::NonZero => FillRule::NonZero,
    };
    FloatOverlay::<[f64; 2], i64>::from_subj(&flat(&region.contours, eps))
        .overlay(OverlayRule::Subject, rule)
}

fn boolean(a: &Polygons, b: &Polygons, op: OverlayRule) -> Polygons {
    FloatOverlay::<[f64; 2], i64>::from_subj_and_clip(a, b).overlay(op, FillRule::NonZero)
}

fn polygon_shape(p: &[Vec<[f64; 2]>]) -> Shape<f64> {
    Shape::from_plines(p.iter().enumerate().map(|(i, c)| {
        let mut pl = Polyline::new_closed();
        for q in c {
            pl.add(q[0], q[1], 0.0);
        }
        if (pl.area() > 0.0) != (i == 0) {
            pl.invert_direction_mut();
        }
        pl
    }))
}

fn shape_polygons(shape: &Shape<f64>, eps: f64) -> Polygons {
    let contours: Vec<_> = shape
        .ccw_plines
        .iter()
        .chain(&shape.cw_plines)
        .map(|p| primitives(&p.polyline))
        .collect();
    normalize(&Region::new(contours, WindingRule::NonZero, false), eps)
}

/// Preserve native arcs when the source already satisfies the offset kernel's
/// nonintersecting-input contract. Parentage follows containment, not array order.
fn simple_components(region: &Region, eps: f64) -> Option<Vec<Shape<f64>>> {
    let mut plines: Vec<_> = region.contours.iter().map(|c| pline(c, eps)).collect();
    if plines
        .iter()
        .any(|p| p.vertex_count() < 2 || p.scan_for_self_intersect())
    {
        return None;
    }
    let rings: Vec<_> = region
        .contours
        .iter()
        .map(|c| Region::from_contour(c.clone()))
        .collect();
    let boxes: Vec<_> = rings.iter().map(|r| r.bbox).collect();
    let index = SpatialIndex::build(&boxes);
    let mut hits = Vec::new();
    for i in 0..plines.len() {
        index.query(&boxes[i], &mut hits);
        for &j in &hits {
            if j as usize <= i {
                continue;
            }
            let x = plines[i].find_intersects(&plines[j as usize]);
            if !x.basic_intersects.is_empty() || !x.overlapping_intersects.is_empty() {
                return None;
            }
        }
    }
    let areas: Vec<f64> = plines.iter().map(|p| p.area()).collect();
    let mut order: Vec<_> = (0..plines.len()).collect();
    order.sort_by(|&a, &b| areas[b].abs().total_cmp(&areas[a].abs()).then(a.cmp(&b)));
    let mut winding = vec![0_i32; plines.len()];
    let mut owner = vec![None; plines.len()];
    let mut groups: Vec<Vec<Polyline>> = Vec::new();
    for i in order {
        let q = region.contours[i][0].start();
        index.query(&BBox::new(q, q), &mut hits);
        let parent = hits
            .iter()
            .map(|&j| j as usize)
            .filter(|&j| areas[j].abs() > areas[i].abs() && rings[j].inside(q))
            .min_by(|&a, &b| areas[a].abs().total_cmp(&areas[b].abs()));
        let before = parent.map_or(0, |p| winding[p]);
        let after = before + if areas[i] > 0.0 { 1 } else { -1 };
        winding[i] = after;
        let filled = |w: i32| match region.winding {
            WindingRule::EvenOdd => w.abs() % 2 == 1,
            WindingRule::NonZero => w != 0,
        };
        if !filled(before) && filled(after) {
            if areas[i] < 0.0 {
                plines[i].invert_direction_mut();
            }
            owner[i] = Some(groups.len());
            groups.push(vec![plines[i].clone()]);
        } else {
            owner[i] = parent.and_then(|p| owner[p]);
            if filled(before) && !filled(after) {
                if areas[i] > 0.0 {
                    plines[i].invert_direction_mut();
                }
                groups[owner[i]?].push(plines[i].clone());
            }
        }
    }
    Some(groups.into_iter().map(Shape::from_plines).collect())
}

pub struct Occlusion<'a> {
    pub region: &'a Region,
    pub clips: Vec<(&'a Region, bool)>,
}

#[derive(Default)]
pub struct Generated {
    pub runs: Vec<Vec<Primitive>>,
    pub diagnostics: Diagnostics,
}

fn shape_region(s: &Shape<f64>) -> Region {
    Region::new(
        s.ccw_plines
            .iter()
            .chain(&s.cw_plines)
            .map(|p| primitives(&p.polyline))
            .collect(),
        WindingRule::NonZero,
        false,
    )
}

fn disc(s: &Shape<f64>) -> Option<(Vec2, f64)> {
    if s.ccw_plines.len() != 1 || !s.cw_plines.is_empty() {
        return None;
    }
    let prims = primitives(&s.ccw_plines[0].polyline);
    let Primitive::Arc(first) = *prims.first()? else {
        return None;
    };
    let mut sweep = 0.0;
    for p in prims {
        let Primitive::Arc(a) = p else {
            return None;
        };
        if a.center.dist(first.center) > 1e-10 || (a.r - first.r).abs() > 1e-10 {
            return None;
        }
        sweep += a.sweep;
    }
    ((sweep - std::f64::consts::TAU).abs() < 1e-10).then_some((first.center, first.r))
}

/// Whole-interval certification, including every hole/boundary crossing.
pub fn inside_segment(p: &Primitive, region: &Region) -> bool {
    let mut spans = vec![crate::fragment::Span {
        t0: 0.0,
        t1: 1.0,
        visible: true,
    }];
    crate::clip::clip_spans(p, &mut spans, region, true, &mut Vec::new());
    spans.iter().all(|s| s.visible)
}

fn closest(p: &Primitive, q: Vec2) -> (f64, Vec2) {
    let t = match p {
        Primitive::Line(l) => {
            let d = l.p1 - l.p0;
            if d.dot(d) == 0.0 {
                0.0
            } else {
                ((q - l.p0).dot(d) / d.dot(d)).clamp(0.0, 1.0)
            }
        }
        Primitive::Arc(a) => {
            let angle = (q.y - a.center.y).atan2(q.x - a.center.x);
            let delta = if a.sweep > 0.0 {
                (angle - a.start).rem_euclid(std::f64::consts::TAU)
            } else {
                -(a.start - angle).rem_euclid(std::f64::consts::TAU)
            };
            let t = delta / a.sweep;
            if t <= 1.0 {
                t
            } else if (q - p.start()).len() <= (q - p.end()).len() {
                0.0
            } else {
                1.0
            }
        }
        Primitive::Cubic(c) => crate::intersect::project_point_cubic(q, c),
    };
    (t, p.eval(t))
}

fn tangent(p: &Primitive, t: f64) -> Vec2 {
    match p {
        Primitive::Line(l) => l.p1 - l.p0,
        Primitive::Arc(a) => a.deriv(t),
        Primitive::Cubic(c) => c.deriv(t),
    }
}

fn enter_loop(prims: &[Primitive], seg: usize, t: f64) -> Vec<Primitive> {
    let mut out = Vec::with_capacity(prims.len() + 1);
    if t < 1.0 {
        out.push(prims[seg].sub(t, 1.0));
    }
    for k in 1..prims.len() {
        out.push(prims[(seg + k) % prims.len()]);
    }
    if t > 0.0 {
        out.push(prims[seg].sub(0.0, t));
    }
    out
}

fn count_prims(runs: &[Vec<Primitive>]) -> usize {
    runs.iter().map(Vec::len).sum()
}

/// Deterministic native hatch for only a residual/failed component. The rows
/// follow the longer bbox axis; a sub-spacing strip gets its central row.
/// Final clipping and the existing nib judge remain responsible for thin ink.
fn hatch(region: &Region, spacing: f64, budget: usize) -> Result<Vec<Vec<Primitive>>, String> {
    let b = region.bbox;
    if b.is_empty() {
        return Ok(Vec::new());
    }
    let horizontal = b.width() >= b.height();
    let span = if horizontal { b.height() } else { b.width() };
    // An odd count retains the axial centerline. Even row counts can miss
    // the long tapered ends of a lens-shaped collapse residual entirely.
    let n = ((span / spacing).ceil().max(1.0) as usize) | 1;
    if n > budget {
        return Err("contour: fallback coverage exceeds geometry budget".into());
    }
    let mut out = Vec::new();
    for row in 0..n {
        let d = (row as f64 + 0.5) * span / n as f64;
        let p = if horizontal {
            Primitive::Line(Line::new(v(b.min.x, b.min.y + d), v(b.max.x, b.min.y + d)))
        } else {
            Primitive::Line(Line::new(v(b.min.x + d, b.min.y), v(b.min.x + d, b.max.y)))
        };
        let mut spans = vec![crate::fragment::Span {
            t0: 0.0,
            t1: 1.0,
            visible: true,
        }];
        crate::clip::clip_spans(&p, &mut spans, region, true, &mut Vec::new());
        for s in spans.into_iter().filter(|s| s.visible) {
            out.push(vec![p.sub(s.t0, s.t1)]);
            if out.len() > budget {
                return Err("contour: fallback coverage exceeds geometry budget".into());
            }
        }
    }
    Ok(out)
}

fn append_patches(
    polys: Polygons,
    width: f64,
    spacing: f64,
    eps: f64,
    component: &Region,
    certify: &dyn Fn(&Primitive) -> bool,
    runs: &mut Vec<Vec<Primitive>>,
    active: &[(usize, usize)],
    diag: &mut Diagnostics,
) -> Result<(), String> {
    // Only the previous layer participates. Small residual hatches can be
    // visited as closed local excursions at an exact point on that layer;
    // both connectors are short and certified, and no contour edge is repeated.
    let mut segments = Vec::new();
    let mut boxes = Vec::new();
    for &(ri, start) in active {
        for pi in start..runs[ri].len() {
            segments.push((ri, pi));
            boxes.push(runs[ri][pi].bbox());
        }
    }
    let index = SpatialIndex::build(&boxes);
    let mut hits = Vec::new();
    let mut portals: std::collections::BTreeMap<usize, Vec<(usize, f64, Vec<Primitive>)>> =
        std::collections::BTreeMap::new();
    for polygon in polys {
        let patch = shape_region(&polygon_shape(&polygon));
        let ink = hatch(
            &patch,
            spacing.min(width * 0.45),
            MAX_PRIMITIVES.saturating_sub(count_prims(runs)),
        )?;
        if ink.is_empty() {
            continue;
        }
        diag.residual_patches += 1;
        for chain in ink {
            let b = chain[0].start();
            let c = chain.last().unwrap().end();
            let mid = b.lerp(c, 0.5);
            index.query(&BBox::new(mid, mid).expanded(2.0 * spacing), &mut hits);
            let mut candidates: Vec<_> = hits
                .iter()
                .flat_map(|&si| {
                    let (ri, pi) = segments[si as usize];
                    let p = &runs[ri][pi];
                    let (t, _) = closest(p, mid);
                    let dt = (spacing * 0.5 / p.length().max(spacing)).min(0.25);
                    [t, (t - dt).max(0.0), (t + dt).min(1.0)]
                        .into_iter()
                        .filter_map(move |t| {
                            let a = p.eval(t);
                            let d = a.dist(b).max(a.dist(c));
                            let cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
                            // A collinear out-and-back would redraw the same segment.
                            (d <= 2.0 * spacing && cross.abs() > 1e-12).then_some((d, ri, pi, t, a))
                        })
                })
                .collect();
            candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
            let mut selected = None;
            for (_, ri, pi, t, a) in candidates.into_iter().take(32) {
                let enter = Primitive::Line(Line::new(a, b));
                let leave = Primitive::Line(Line::new(c, a));
                diag.connector_tests += 2;
                if inside_segment(&enter, component)
                    && inside_segment(&leave, component)
                    && certify(&enter)
                    && certify(&leave)
                {
                    let mut excursion = vec![enter];
                    excursion.extend(chain.iter().copied());
                    excursion.push(leave);
                    selected = Some((ri, pi, t, excursion));
                    break;
                }
            }
            if let Some((ri, pi, t, excursion)) = selected {
                portals.entry(ri).or_default().push((pi, t, excursion));
                diag.connectors += 2;
            } else {
                runs.push(chain);
            }
        }
    }
    for (ri, mut points) in portals {
        points.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
        let first = points[0].0;
        let old = runs[ri].split_off(first);
        let mut points = points.into_iter().peekable();
        for (offset, p) in old.into_iter().enumerate() {
            let pi = first + offset;
            let mut from = 0.0;
            while points.peek().is_some_and(|q| q.0 == pi) {
                let (_, t, excursion) = points.next().unwrap();
                if t > from {
                    runs[ri].push(p.sub(from, t));
                }
                runs[ri].extend(excursion);
                from = t;
            }
            if from < 1.0 {
                runs[ri].push(p.sub(from, 1.0));
            }
        }
    }
    let _ = eps;
    Ok(())
}

/// Absolute offsets avoid accumulated per-level approximation drift. Routing
/// queries only indexed segments near the previous entry point, with at most
/// 32 candidates certified per predecessor and one successor/predecessor.
pub fn generate(
    components: Vec<Shape<f64>>,
    width: f64,
    spacing: f64,
    certify: &dyn Fn(&Primitive) -> bool,
) -> Result<Generated, String> {
    let eps = error_budget(width, spacing)?;
    let opts = options(eps);
    let radius = width / 2.0;
    let mut result = Generated::default();
    result.diagnostics.components = components.len();
    for source in components {
        let region = shape_region(&source);
        let begin = result.runs.len();
        let source_size: usize = source
            .ccw_plines
            .iter()
            .chain(&source.cw_plines)
            .map(|p| p.polyline.vertex_count())
            .sum();
        if source_size > 12_000 {
            result.diagnostics.fallbacks += 1;
            result.diagnostics.fallback_budget += 1;
            result.runs.extend(hatch(
                &region,
                spacing.min(width * 0.9),
                MAX_PRIMITIVES.saturating_sub(count_prims(&result.runs)),
            )?);
            continue;
        }
        let mut previous: Option<Shape<f64>> = None;
        let mut active: Vec<(usize, bool, usize)> = Vec::new();
        let mut work = 0usize;
        let mut stopped = false;
        let mut unstable = false;
        let mut previous_area = f64::INFINITY;
        let clearance =
            shape_region(&source.parallel_offset((radius - eps / 4.0).max(radius / 2.0), &opts));
        for level in 0..MAX_LEVELS {
            work += source_size;
            if work > 20_000_000 {
                break;
            }
            let distance = radius + eps / 4.0 + level as f64 * spacing;
            let next = {
                let _zone = crate::profile::zone("contour offsets");
                source.parallel_offset(distance, &opts)
            };
            let loops: Vec<_> = next
                .ccw_plines
                .iter()
                .map(|p| (primitives(&p.polyline), false))
                .chain(
                    next.cw_plines
                        .iter()
                        .map(|p| (primitives(&p.polyline), true)),
                )
                .collect();
            let size: usize = loops.iter().map(|p| p.0.len()).sum();
            if count_prims(&result.runs) + size > MAX_PRIMITIVES {
                break;
            }
            let area: f64 = next
                .ccw_plines
                .iter()
                .chain(&next.cw_plines)
                .map(|p| p.polyline.area())
                .sum();
            if !area.is_finite()
                || (!loops.is_empty() && area >= previous_area)
                || loops.iter().flat_map(|p| &p.0).any(|p| {
                    !p.start().x.is_finite() || !p.start().y.is_finite() || !p.length().is_finite()
                })
            {
                unstable = true;
                break;
            }
            previous_area = area;
            // Residuals are vector differences around a collapse or split,
            // never a second hatch over the already-covered component.
            if spacing <= width {
                let _zone = crate::profile::zone("contour residuals");
                if let Some(prev) = &previous {
                    let inner = prev.parallel_offset(radius + eps / 4.0, &opts);
                    if !inner.ccw_plines.is_empty() {
                        let grown = next.parallel_offset(-radius - eps / 4.0, &opts);
                        let covered = disc(&inner)
                            .zip(disc(&grown))
                            .is_some_and(|((a, ra), (b, rb))| a.dist(b) + ra <= rb - 1e-9);
                        let residual = if covered {
                            Vec::new()
                        } else if loops.is_empty() {
                            shape_polygons(&inner, eps)
                        } else {
                            boolean(
                                &shape_polygons(&inner, eps),
                                &shape_polygons(&grown, eps),
                                OverlayRule::Difference,
                            )
                        };
                        let ids: Vec<_> = active.iter().map(|p| (p.0, p.2)).collect();
                        append_patches(
                            residual,
                            width,
                            spacing,
                            eps,
                            &region,
                            certify,
                            &mut result.runs,
                            &ids,
                            &mut result.diagnostics,
                        )?;
                    }
                } else if !loops.is_empty() && !region.convex {
                    let residual = boolean(
                        &shape_polygons(&source, eps),
                        &shape_polygons(&next.parallel_offset(-radius - eps, &opts), eps),
                        OverlayRule::Difference,
                    );
                    append_patches(
                        residual,
                        width,
                        spacing,
                        eps,
                        &region,
                        certify,
                        &mut result.runs,
                        &[],
                        &mut result.diagnostics,
                    )?;
                }
            }
            if level == 0 && loops.is_empty() {
                result.diagnostics.fallbacks += 1;
                result.diagnostics.fallback_thin += 1;
                result.runs.extend(hatch(
                    &region,
                    spacing.min(width * 0.9),
                    MAX_PRIMITIVES.saturating_sub(count_prims(&result.runs)),
                )?);
            }
            if loops.is_empty() {
                stopped = true;
                break;
            }
            result.diagnostics.levels += 1;
            result.diagnostics.contours += loops.len();
            let _zone = crate::profile::zone("contour connectors");
            let mut segments = Vec::new();
            let mut boxes = Vec::new();
            for (li, (prims, _)) in loops.iter().enumerate() {
                for (pi, p) in prims.iter().enumerate() {
                    segments.push((li, pi));
                    boxes.push(p.bbox());
                }
            }
            let index = SpatialIndex::build(&boxes);
            let mut proposals = Vec::new();
            let mut hits = Vec::new();
            for &(ri, hole, _) in &active {
                let a = result.runs[ri].last().unwrap().end();
                index.query(&BBox::new(a, a).expanded(2.0 * spacing), &mut hits);
                let mut candidates: Vec<_> = hits
                    .iter()
                    .filter_map(|&si| {
                        let (li, pi) = segments[si as usize];
                        if loops[li].1 != hole {
                            return None;
                        }
                        let (t, b) = closest(&loops[li].0[pi], a);
                        let d = (b - a).len();
                        (d <= 2.0 * spacing).then_some((d, li, pi, t, b))
                    })
                    .collect();
                candidates
                    .sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
                for (d, li, pi, t, b) in candidates.into_iter().take(32) {
                    let connector = Primitive::Line(Line::new(a, b));
                    result.diagnostics.connector_tests += 1;
                    if inside_segment(&connector, &clearance)
                        && inside_segment(&connector, &region)
                        && certify(&connector)
                    {
                        let direction = b - a;
                        let exit = tangent(result.runs[ri].last().unwrap(), 1.0);
                        let entry = tangent(&loops[li].0[pi], t);
                        let heading = 2.0
                            - exit.dot(direction) / (exit.len() * d).max(1e-30)
                            - entry.dot(direction) / (entry.len() * d).max(1e-30);
                        proposals.push((d, ri, li, pi, t, heading));
                    }
                }
            }
            proposals.sort_by(|a, b| {
                a.0.total_cmp(&b.0)
                    .then(a.5.total_cmp(&b.5))
                    .then(a.1.cmp(&b.1))
                    .then(a.2.cmp(&b.2))
            });
            let mut assigned = vec![None; loops.len()];
            let mut used = std::collections::BTreeSet::new();
            for (_, ri, li, pi, t, _) in proposals {
                if assigned[li].is_some() || !used.insert(ri) {
                    continue;
                }
                assigned[li] = Some((ri, pi, t));
            }
            active.clear();
            for (li, (prims, hole)) in loops.into_iter().enumerate() {
                let (ri, start) = if let Some((ri, pi, t)) = assigned[li] {
                    let entered = enter_loop(&prims, pi, t);
                    let a = result.runs[ri].last().unwrap().end();
                    result.runs[ri].push(Primitive::Line(Line::new(a, entered[0].start())));
                    let start = result.runs[ri].len();
                    result.runs[ri].extend(entered);
                    result.diagnostics.connectors += 1;
                    (ri, start)
                } else {
                    let pi = (0..prims.len())
                        .min_by(|&i, &j| {
                            prims[i]
                                .start()
                                .x
                                .total_cmp(&prims[j].start().x)
                                .then(prims[i].start().y.total_cmp(&prims[j].start().y))
                        })
                        .unwrap();
                    let ri = result.runs.len();
                    result.runs.push(enter_loop(&prims, pi, 0.0));
                    (ri, 0)
                };
                active.push((ri, hole, start));
            }
            previous = Some(next);
        }
        if !stopped {
            // Discard provisional ink, rather than reporting partial coverage.
            result.runs.truncate(begin);
            result.diagnostics.fallbacks += 1;
            if unstable {
                result.diagnostics.fallback_unstable += 1;
            } else {
                result.diagnostics.fallback_budget += 1;
            }
            result.runs.extend(hatch(
                &region,
                spacing.min(width * 0.9),
                MAX_PRIMITIVES.saturating_sub(count_prims(&result.runs)),
            )?);
        }
    }
    if count_prims(&result.runs) > MAX_PRIMITIVES {
        return Err("contour: output exceeds geometry budget".into());
    }
    Ok(result)
}

/// Resolve the complete area before offsetting. Occluders are themselves
/// clipped, matching the exact primitive-visibility semantics in the pipeline.
pub fn visible_components(
    source: &Region,
    clips: &[(&Region, bool)],
    occluders: &[Occlusion<'_>],
    eps: f64,
) -> Result<Vec<Shape<f64>>, String> {
    let _zone = crate::profile::zone("contour visible area");
    if !eps.is_finite() || eps <= 0.0 {
        return Err("contour: invalid geometry tolerance".into());
    }
    // Bound conversion before asking either kernel to allocate flattened input.
    let mut conversion_work = 0.0;
    for region in std::iter::once(source)
        .chain(clips.iter().map(|p| p.0))
        .chain(occluders.iter().map(|o| o.region))
    {
        if region.contours.iter().map(Vec::len).sum::<usize>() > 12_000 {
            return Err("contour: visible-area input exceeds normalization budget".into());
        }
        for p in region.contours.iter().flatten() {
            let b = p.bbox();
            let magnitude = b
                .min
                .x
                .abs()
                .max(b.min.y.abs())
                .max(b.max.x.abs())
                .max(b.max.y.abs());
            if !magnitude.is_finite() || magnitude * 2_f64.powi(-50) > eps / 16.0 {
                return Err("contour: coordinates exceed the geometry error budget".into());
            }
            if !matches!(p, Primitive::Line(_)) {
                conversion_work += p.length() / (eps / 4.0);
            }
        }
    }
    if !conversion_work.is_finite() || conversion_work > 20_000_000.0 {
        return Err("contour: curve conversion exceeds geometry work budget".into());
    }
    let b = source.bbox;
    if b.is_empty() {
        return Ok(Vec::new());
    }
    let span = (b.max.x - b.min.x).max(b.max.y - b.min.y);
    if !span.is_finite() || span * 2_f64.powi(-50) > eps / 16.0 {
        return Err("contour: coordinates exceed the quantization error budget".into());
    }
    let corners = [b.min, b.max, v(b.min.x, b.max.y), v(b.max.x, b.min.y)];
    let active_clips: Vec<_> = clips
        .iter()
        .copied()
        .filter(|(r, keep)| {
            if *keep {
                !(r.convex
                    && corners
                        .iter()
                        .all(|&p| r.inside(p) || r.on_boundary(p, 1e-9)))
            } else {
                r.bbox.overlaps(&b)
            }
        })
        .collect();
    let blockers: Vec<_> = occluders
        .iter()
        .filter(|o| o.region.bbox.overlaps(&b))
        .collect();
    if active_clips.is_empty() && blockers.is_empty() {
        if let Some(c) = simple_components(source, eps) {
            return Ok(c);
        }
    }
    // Interior, mutually disjoint masks are already a valid hole hierarchy.
    // Retain their circular arcs without a polygon Boolean round trip.
    if active_clips.is_empty() && source.contours.len() == 1 && !blockers.is_empty() {
        let mut rings = source.contours.clone();
        let mut disjoint = true;
        for (i, o) in blockers.iter().enumerate() {
            if !o.clips.is_empty()
                || o.region.contours.len() != 1
                || o.region.contours[0].is_empty()
                || !source.inside(o.region.contours[0][0].start())
                || blockers[..i]
                    .iter()
                    .any(|p| p.region.bbox.overlaps(&o.region.bbox))
            {
                disjoint = false;
                break;
            }
            rings.extend(o.region.contours.clone());
        }
        if disjoint {
            let combined = Region::new(rings, WindingRule::EvenOdd, false);
            if let Some(c) = simple_components(&combined, eps) {
                return Ok(c);
            }
        }
    }
    let mut area = normalize(source, eps);
    for (r, keep) in active_clips {
        area = boolean(
            &area,
            &normalize(r, eps),
            if keep {
                OverlayRule::Intersect
            } else {
                OverlayRule::Difference
            },
        );
    }
    for o in blockers {
        let mut opaque = normalize(o.region, eps);
        for &(clip, keep) in &o.clips {
            opaque = boolean(
                &opaque,
                &normalize(clip, eps),
                if keep {
                    OverlayRule::Intersect
                } else {
                    OverlayRule::Difference
                },
            );
        }
        area = boolean(&area, &opaque, OverlayRule::Difference);
    }
    let n: usize = area.iter().flatten().map(Vec::len).sum();
    if n > MAX_PRIMITIVES {
        return Err("contour: normalized area exceeds geometry budget".into());
    }
    Ok(area.iter().map(|p| polygon_shape(p)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn circle(r: f64) -> Vec<Primitive> {
        vec![Primitive::Arc(Arc::new(
            v(0.0, 0.0),
            r,
            0.0,
            std::f64::consts::TAU,
        ))]
    }
    #[test]
    fn disc_joins_regular_loops_and_covers_center() {
        let region = Region::new(vec![circle(30.0)], WindingRule::NonZero, true);
        let shapes = visible_components(&region, &[], &[], 0.01).unwrap();
        let ink = generate(shapes, 0.5, 0.45, &|p| inside_segment(p, &region)).unwrap();
        assert!(
            ink.runs.len() <= 2,
            "{} runs: {:?}",
            ink.runs.len(),
            ink.diagnostics
        );
        assert!(ink.diagnostics.contours > 60);
        for run in &ink.runs {
            for pair in run.windows(2) {
                assert!((pair[0].end() - pair[1].start()).len() < 1e-8);
            }
        }
        for i in 0..=300 {
            let q = v(i as f64 * 0.1, 0.0);
            let distance = ink
                .runs
                .iter()
                .flatten()
                .map(|p| (closest(p, q).1 - q).len())
                .fold(f64::INFINITY, f64::min);
            assert!(distance <= 0.26, "uncovered radius {}: {}", q.x, distance);
        }
    }
    fn polygon(points: &[(f64, f64)]) -> Vec<Primitive> {
        points
            .iter()
            .enumerate()
            .map(|(i, &(x, y))| {
                let (nx, ny) = points[(i + 1) % points.len()];
                Primitive::Line(Line::new(v(x, y), v(nx, ny)))
            })
            .collect()
    }

    #[test]
    fn interior_coverage_distance_corpus() {
        let cases = vec![
            ("disc", vec![circle(8.0)]),
            ("annulus", vec![circle(8.0), circle(3.0)]),
            (
                "rectangle",
                vec![polygon(&[(0., 0.), (16., 0.), (16., 10.), (0., 10.)])],
            ),
            ("acute", vec![polygon(&[(0., 0.), (16., 0.), (0.5, 5.)])]),
            (
                "U",
                vec![polygon(&[
                    (0., 0.),
                    (4., 0.),
                    (4., 10.),
                    (12., 10.),
                    (12., 0.),
                    (16., 0.),
                    (16., 15.),
                    (0., 15.),
                ])],
            ),
            (
                "dumbbell",
                vec![polygon(&[
                    (0., 0.),
                    (6., 0.),
                    (6., 6.),
                    (10., 6.),
                    (10., 0.),
                    (16., 0.),
                    (16., 14.),
                    (10., 14.),
                    (10., 8.),
                    (6., 8.),
                    (6., 14.),
                    (0., 14.),
                ])],
            ),
            (
                "sliver",
                vec![polygon(&[(0., 0.), (12., 0.), (12., 0.15), (0., 0.15)])],
            ),
            ("tiny", vec![circle(0.1)]),
        ];
        let width = 0.6;
        let spacing = 0.54;
        let eps = error_budget(width, spacing).unwrap();
        for (name, rings) in cases {
            let region = Region::new(rings, WindingRule::EvenOdd, false);
            let components = visible_components(&region, &[], &[], eps).unwrap();
            let ink =
                generate(components, width, spacing, &|p| inside_segment(p, &region)).unwrap();
            assert!(!ink.runs.is_empty(), "{name} silently lost");
            // Independent diagnostic: flatten once, then measure point-to-line
            // distances on a 0.04 mm grid. Production uses no raster decisions.
            let mut segments = Vec::new();
            let mut boxes = Vec::new();
            for p in ink.runs.iter().flatten() {
                let mut pts = Vec::new();
                p.flatten(0.0005, &mut pts);
                for ab in pts.windows(2) {
                    segments.push((ab[0], ab[1]));
                    boxes.push(BBox::from_points(ab));
                }
            }
            let index = SpatialIndex::build(&boxes);
            let mut hits = Vec::new();
            let b = region.bbox;
            let mut max_distance = 0.0_f64;
            let mut samples = 0;
            let nx = ((b.max.x - b.min.x) / 0.04).ceil() as usize;
            let ny = ((b.max.y - b.min.y) / 0.04).ceil() as usize;
            for ix in 0..=nx {
                for iy in 0..=ny {
                    let q = v(b.min.x + ix as f64 * 0.04, b.min.y + iy as f64 * 0.04);
                    if !region.inside(q) {
                        continue;
                    }
                    let boundary = region
                        .contours
                        .iter()
                        .flatten()
                        .map(|p| q.dist(closest(p, q).1))
                        .fold(f64::INFINITY, f64::min);
                    if boundary < width / 2.0 {
                        continue;
                    }
                    index.query(
                        &BBox::new(q, q).expanded(width / 2.0 + eps + 0.001),
                        &mut hits,
                    );
                    let mut distance = f64::INFINITY;
                    for &i in &hits {
                        let (a, b) = segments[i as usize];
                        let d = b - a;
                        let t = ((q - a).dot(d) / d.dot(d)).clamp(0.0, 1.0);
                        distance = distance.min(q.dist(a + d * t));
                    }
                    max_distance = max_distance.max(distance);
                    samples += 1;
                    assert!(
                        distance <= width / 2.0 + eps + 0.001,
                        "{name}: uncovered {q:?}, nearest ink {distance}"
                    );
                }
            }
            eprintln!("coverage {name}: {samples} samples, max centerline distance {max_distance:.6} mm, {} runs, {:?}",ink.runs.len(),ink.diagnostics);
        }
    }

    #[test]
    fn hole_front_collision_covers_saddle() {
        let mut rings=vec![polygon(&[(16.8,60.3),(193.2,60.3),(193.2,236.7),(16.8,236.7)])];
        for j in 0..16 {rings.push(vec![Primitive::Arc(Arc::new(v(42.0+(j%4) as f64*42.0,85.5+(j/4) as f64*42.0),10.5,0.0,std::f64::consts::TAU))]);}
        let region=Region::new(rings,WindingRule::EvenOdd,false);
        let components=visible_components(&region,&[],&[],0.01).unwrap();
        let ink=generate(components,0.45,0.405,&|p|inside_segment(p,&region)).unwrap();
        let q=v(39.7,148.5);
        let closest=ink.runs.iter().flatten().map(|p|(q.dist(closest(p,q).1),p)).min_by(|a,b|a.0.total_cmp(&b.0)).unwrap();
        assert!(closest.0<=0.236,"nearest {:?}",closest);
    }

    #[test]
    fn tiny_hole_survives_boolean_normalization() {
        let region = Region::new(
            vec![circle(10.0), circle(0.0001)],
            WindingRule::EvenOdd,
            false,
        );
        let clip = Region::new(
            vec![polygon(&[(-9., -12.), (12., -12.), (12., 12.), (-9., 12.)])],
            WindingRule::NonZero,
            true,
        );
        let components = visible_components(&region, &[(&clip, true)], &[], 0.01).unwrap();
        assert_eq!(components.len(), 1);
        assert_eq!(components[0].cw_plines.len(), 1);
        assert!(components[0].cw_plines[0].polyline.area().abs() > 0.0);
    }

    #[test]
    fn deterministic_component_budget_falls_back_without_partial_ink() {
        let mut poly = Polyline::new_closed();
        for i in 0..12_001 {
            let a = i as f64 / 12_001.0 * std::f64::consts::TAU;
            poly.add(a.cos(), a.sin(), 0.0);
        }
        let region = Region::new(vec![circle(1.0)], WindingRule::NonZero, true);
        let result = generate(vec![Shape::from_plines([poly])], 0.3, 0.27, &|p| {
            inside_segment(p, &region)
        })
        .unwrap();
        assert_eq!(result.diagnostics.fallback_budget, 1);
        assert_eq!(result.diagnostics.contours, 0);
        assert!(!result.runs.is_empty());
        assert!(result
            .runs
            .iter()
            .flatten()
            .all(|p| matches!(p, Primitive::Line(_))));
        assert!(visible_components(&region, &[], &[], f64::NAN).is_err());
    }

    #[test]
    fn kernel_preserves_arcs_and_expands_holes() {
        let region = Region::new(vec![circle(10.0), circle(3.0)], WindingRule::EvenOdd, false);
        let components = visible_components(&region, &[], &[], 0.005).unwrap();
        assert_eq!(components.len(), 1);
        let offset = components[0].parallel_offset(1.0, &options(0.005));
        assert_eq!((offset.ccw_plines.len(), offset.cw_plines.len()), (1, 1));
        assert!((offset.ccw_plines[0].polyline.area() - std::f64::consts::PI * 81.0).abs() < 1e-8);
        assert!((offset.cw_plines[0].polyline.area() + std::f64::consts::PI * 16.0).abs() < 1e-8);
    }
    #[test]
    fn kernel_normalizes_self_crossing_even_odd_input() {
        let pts = [v(-2.0, -2.0), v(2.0, 2.0), v(-2.0, 2.0), v(2.0, -2.0)];
        let ring = (0..4)
            .map(|i| Primitive::Line(Line::new(pts[i], pts[(i + 1) % 4])))
            .collect();
        let region = Region::new(vec![ring], WindingRule::EvenOdd, false);
        let shapes = visible_components(&region, &[], &[], 0.005).unwrap();
        assert_eq!(shapes.len(), 2);
        for s in shapes {
            assert!(!s
                .parallel_offset(0.1, &options(0.005))
                .ccw_plines
                .is_empty());
        }
    }
}
