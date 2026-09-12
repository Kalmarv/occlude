//! Optional, post-render path work. Never called by ordinary planning.
//! Fits are bounded against the ORIGINAL line spans; existing arcs/cubics,
//! dots and discontinuities are preserved. Joins need explicit provenance
//! and a whole-primitive visibility certificate supplied by the caller.
use crate::{
    fragment::Frag,
    gcode::{reverse_primitive, tour, Chain},
    primitive::{Arc, Line, Primitive},
    vec2::{v, Vec2},
};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub tolerance: f64,
    pub max_segment: f64,
    pub corner_degrees: f64,
    pub gap: f64,
    pub tour_budget: usize,
}
impl Options {
    pub fn validate(&self) -> Result<(), String> {
        if !self.tolerance.is_finite()
            || self.tolerance < 0.0
            || !self.max_segment.is_finite()
            || self.max_segment <= 0.0
            || !self.corner_degrees.is_finite()
            || !(0.0..=180.0).contains(&self.corner_degrees)
            || !self.gap.is_finite()
            || self.gap < 0.0
        {
            return Err(
                "optimization: invalid tolerance, segment length, corner angle or gap".into(),
            );
        }
        Ok(())
    }
}
#[derive(Default)]
pub struct Output {
    pub chains: Vec<Chain>,
    pub before: Vec<Chain>,
    pub after: Vec<Chain>,
    /// fitted spans, removed primitives, joins, connector tests
    pub stats: [usize; 4],
}
fn key(p: &Primitive, pen: u32) -> Vec<u64> {
    let mut data = Vec::new();
    crate::scene::encode_prim(p, &mut data);
    let mut k: Vec<_> = data
        .into_iter()
        .map(|x| if x == 0.0 { 0 } else { x.to_bits() })
        .collect();
    k.push(pen as u64);
    k
}
fn turn(a: Vec2, b: Vec2) -> f64 {
    a.cross(b).atan2(a.dot(b)).abs()
}
fn distance_segment(p: Vec2, a: Vec2, b: Vec2) -> f64 {
    let d = b - a;
    p.dist(a + d * ((p - a).dot(d) / d.len2().max(1e-300)).clamp(0.0, 1.0))
}
/// Monotone projection and bounded perpendicular distance prove both directed
/// distances for a line fit, including interiors of original segments.
fn fit_line(ps: &[Vec2], eps: f64) -> Option<Primitive> {
    let a = ps[0];
    let b = *ps.last()?;
    let d = b - a;
    if d.len2() <= 1e-20 {
        return None;
    }
    let mut prev = 0.0;
    for &p in ps {
        let t = (p - a).dot(d) / d.len2();
        if t < prev - 1e-12 || t > 1.0 + 1e-12 || distance_segment(p, a, b) > eps {
            return None;
        }
        prev = t;
    }
    Some(Primitive::Line(Line::new(a, b)))
}
/// Radial extrema over each complete chord plus monotone angular coverage
/// prove the chord chain and circular arc stay within eps of each other.
fn fit_arc(ps: &[Vec2], eps: f64) -> Option<Primitive> {
    let a = ps[0];
    let b = ps[ps.len() / 2];
    let c = *ps.last()?;
    let u = b - a;
    let w = c - a;
    let det = 2.0 * u.cross(w);
    if det.abs() < 1e-14 * u.len() * w.len() || det == 0.0 {
        return None;
    }
    let center = a + v(
        (u.len2() * w.y - w.len2() * u.y) / det,
        (u.x * w.len2() - w.x * u.len2()) / det,
    );
    let r = a.dist(center);
    if !center.is_finite() || !r.is_finite() || r <= eps {
        return None;
    }
    let sign = det.signum();
    let mut sweep = 0.0;
    for pair in ps.windows(2) {
        let x = pair[0] - center;
        let y = pair[1] - center;
        let angle = x.cross(y).atan2(x.dot(y));
        if angle * sign < 0.0 || angle.abs() >= std::f64::consts::PI {
            return None;
        }
        sweep += angle;
        let near = distance_segment(center, pair[0], pair[1]);
        let far = x.len().max(y.len());
        if r - near > eps || far - r > eps {
            return None;
        }
    }
    if sweep.abs() > std::f64::consts::PI || sweep.abs() < 1e-8 {
        return None;
    }
    let arc = Primitive::Arc(Arc::new(
        center,
        r,
        (a.y - center.y).atan2(a.x - center.x),
        sweep,
    ));
    if arc.start().dist(a) > 1e-8 || arc.end().dist(c) > 1e-8 {
        return None;
    }
    Some(arc)
}
fn fitted(ps: &[Vec2], eps: f64) -> Option<Primitive> {
    fit_line(ps, eps).or_else(|| fit_arc(ps, eps))
}
fn one(prims: Vec<Primitive>, pen: u32) -> Chain {
    Chain {
        prims,
        pen,
        dot: false,
        ordered: true,
    }
}
fn fit_chain(c: &mut Chain, o: Options, out: &mut Output) {
    if c.dot || o.tolerance == 0.0 {
        return;
    }
    let src = std::mem::take(&mut c.prims);
    let mut i = 0;
    while i < src.len() {
        let Primitive::Line(first) = src[i] else {
            c.prims.push(src[i]);
            i += 1;
            continue;
        };
        if first.p0.dist(first.p1) > o.max_segment || first.p0 == first.p1 {
            c.prims.push(src[i]);
            i += 1;
            continue;
        }
        let mut ps = vec![first.p0, first.p1];
        for p in src.iter().skip(i + 1).take(255) {
            let Primitive::Line(l) = p else { break };
            let last = *ps.last().unwrap();
            if l.p0 != last
                || l.p0.dist(l.p1) > o.max_segment
                || l.p0 == l.p1
                || turn(last - ps[ps.len() - 2], l.p1 - l.p0) > o.corner_degrees.to_radians()
            {
                break;
            }
            // A repeated junction closes a lap: never fit into its next lap.
            if l.p1 == ps[0] {
                break;
            }
            ps.push(l.p1);
        }
        let max = ps.len() - 1;
        let mut best = None;
        let mut n = 2;
        while n <= max {
            if let Some(p) = fitted(&ps[..=n], o.tolerance) {
                best = Some((n, p));
            } else {
                break;
            }
            if n == max {
                break;
            }
            n = (n * 2).min(max);
        }
        // Bounded search for an additional valid prefix; failure need not be
        // monotone for arc fits, so this is a local heuristic, not optimality.
        if let Some((low, _)) = best {
            let mut lo = low;
            let mut hi = n.min(max);
            while hi > lo + 1 {
                let mid = (lo + hi) / 2;
                if let Some(p) = fitted(&ps[..=mid], o.tolerance) {
                    best = Some((mid, p));
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
        }
        if let Some((n, p)) = best {
            out.before.push(one(src[i..i + n].to_vec(), c.pen));
            out.after.push(one(vec![p], c.pen));
            out.stats[0] += 1;
            out.stats[1] += n - 1;
            c.prims.push(p);
            i += n;
        } else {
            c.prims.push(src[i]);
            i += 1;
        }
    }
}
fn travel(cs: &[Chain]) -> f64 {
    let mut pos = Vec2::ZERO;
    let mut d = 0.0;
    for c in cs {
        d += pos.dist(c.start());
        pos = c.end();
    }
    d
}

/// Continue from the existing order instead of restarting the same greedy
/// tour. Spread bounded 2-opt proposals across the entire drawing, including
/// its tail; charge reversal work to the budget as well as candidate tests.
fn refine_order(cs: &mut [Chain], budget: usize) {
    let n = cs.len();
    if n < 3 {
        return;
    }
    let mut work = 0;
    let mut round = 0;
    while work < budget {
        let mut improved = false;
        for i in 0..n - 1 {
            if work >= budget {
                break;
            }
            let j = if round < 16 {
                (i + 1 + round).min(n - 1)
            } else {
                (i + 1 + (round * 8191 + i * 131) % n) % n
            };
            work += 1;
            if j <= i {
                continue;
            }
            let before = if i == 0 { Vec2::ZERO } else { cs[i - 1].end() };
            let next = cs.get(j + 1).map(Chain::start);
            let old = before.dist(cs[i].start()) + next.map_or(0.0, |p| cs[j].end().dist(p));
            let new = before.dist(cs[j].end()) + next.map_or(0.0, |p| cs[i].start().dist(p));
            if new + 1e-9 < old {
                work += j - i + 1;
                cs[i..=j].reverse();
                for c in &mut cs[i..=j] {
                    *c = c.reversed();
                }
                improved = true;
            }
        }
        round += 1;
        if !improved && round >= 32 {
            break;
        }
    }
}

/// Move a closed path's seam without removing or duplicating any ink. A
/// deterministic set of projections considers both travel-in and travel-out.
fn relocate_seams(cs: &mut [Chain]) {
    for i in 0..cs.len() {
        if cs[i].dot || cs[i].start().dist(cs[i].end()) > 1e-8 {
            continue;
        }
        let prev = if i == 0 { Vec2::ZERO } else { cs[i - 1].end() };
        let next = cs.get(i + 1).map(Chain::start);
        let cost = |p: Vec2| prev.dist(p) + next.map_or(0.0, |n| n.dist(p));
        let mut best = (cost(cs[i].start()), 0, 0.0);
        let stride = (cs[i].prims.len() / 256).max(1);
        for (j, p) in cs[i].prims.iter().enumerate().step_by(stride) {
            let mut ts = vec![0.0, 1.0];
            for target in [Some(prev), next].into_iter().flatten() {
                match p {
                    Primitive::Line(l) => {
                        let d = l.p1 - l.p0;
                        ts.push(((target - l.p0).dot(d) / d.len2().max(1e-300)).clamp(0.0, 1.0));
                    }
                    Primitive::Arc(a) => {
                        let angle = (target.y - a.center.y).atan2(target.x - a.center.x);
                        let delta = ((angle - a.start) * a.sweep.signum())
                            .rem_euclid(std::f64::consts::TAU);
                        if a.sweep != 0.0 && delta <= a.sweep.abs() {
                            ts.push(delta / a.sweep.abs());
                        }
                    }
                    _ => {}
                }
            }
            for t in ts {
                let d = cost(p.eval(t));
                if d + 1e-9 < best.0 {
                    best = (d, j, t);
                }
            }
        }
        let (_, j, t) = best;
        if j == 0 && t == 0.0 {
            continue;
        }
        if t <= 1e-12 {
            cs[i].prims.rotate_left(j);
        } else if t >= 1.0 - 1e-12 {
            let n = cs[i].prims.len();
            cs[i].prims.rotate_left((j + 1) % n);
        } else {
            let src = std::mem::take(&mut cs[i].prims);
            cs[i].prims.push(src[j].sub(t, 1.0));
            cs[i].prims.extend_from_slice(&src[j + 1..]);
            cs[i].prims.extend_from_slice(&src[..j]);
            cs[i].prims.push(src[j].sub(0.0, t));
        }
    }
}

pub fn optimize(
    chains: Vec<Chain>,
    frags: &[Frag],
    o: Options,
    visible: impl Fn(u32, &Primitive) -> bool,
) -> Result<Output, String> {
    optimize_with(chains, frags, o, visible, |_| false)
}

pub fn optimize_with(
    mut chains: Vec<Chain>,
    frags: &[Frag],
    o: Options,
    visible: impl Fn(u32, &Primitive) -> bool,
    allow_ordered: impl Fn(u32) -> bool,
) -> Result<Output, String> {
    o.validate()?;
    // Build provenance only when joining is requested. Ambiguous/shared ink,
    // generated generic bridges and ordered runs without permission stay protected.
    let mut lookup: HashMap<Vec<u64>, Option<u32>> = HashMap::new();
    if o.gap > 0.0 {
        for f in frags
            .iter()
            .filter(|f| (f.run.is_none() || allow_ordered(f.shape)) && !f.bridge && !f.dot)
        {
            let owner = Some(f.shape);
            for p in [f.geom, reverse_primitive(&f.geom)] {
                lookup
                    .entry(key(&p, f.pen))
                    .and_modify(|old| {
                        if *old != owner {
                            *old = None;
                        }
                    })
                    .or_insert(owner);
            }
        }
        // Protected contour fills can contain millions of primitives. Do not
        // allocate a second provenance map for ink that can never be joined.
        if !lookup.is_empty() {
            for f in frags
                .iter()
                .filter(|f| (f.run.is_some() && !allow_ordered(f.shape)) || f.bridge || f.dot)
            {
                for p in [f.geom, reverse_primitive(&f.geom)] {
                    if let Some(owner) = lookup.get_mut(&key(&p, f.pen)) {
                        *owner = None;
                    }
                }
            }
        }
    }
    let mut owners = Vec::new();
    for c in &chains {
        let owner = if c.dot || o.gap == 0.0 {
            None
        } else {
            let first = lookup.get(&key(&c.prims[0], c.pen)).copied().flatten();
            first.filter(|s| {
                c.prims
                    .iter()
                    .all(|p| lookup.get(&key(p, c.pen)) == Some(&Some(*s)))
            })
        };
        owners.push(owner);
    }
    drop(lookup);
    let mut out = Output::default();
    for c in &mut chains {
        fit_chain(c, o, &mut out);
    }
    if o.gap > 0.0 {
        let cell = |p: Vec2| ((p.x / o.gap).floor() as i64, (p.y / o.gap).floor() as i64);
        let mut grid: HashMap<(i64, i64, u32, u32), Vec<(usize, bool)>> = HashMap::new();
        for (i, c) in chains.iter().enumerate() {
            if let Some(owner) = owners[i] {
                for (p, rev) in [(c.start(), false), (c.end(), true)] {
                    let (x, y) = cell(p);
                    grid.entry((x, y, c.pen, owner)).or_default().push((i, rev));
                }
            }
        }
        let mut slots: Vec<_> = chains.into_iter().map(Some).collect();
        let mut joined = Vec::new();
        for i in 0..slots.len() {
            let Some(mut c) = slots[i].take() else {
                continue;
            };
            if let Some(owner) = owners[i] {
                loop {
                    let end = c.end();
                    let (x, y) = cell(end);
                    let mut candidates = Vec::new();
                    let mut inspected = 0;
                    'near: for dx in -1..=1 {
                        for dy in -1..=1 {
                            if let Some(ids) = grid.get_mut(&(
                                x.saturating_add(dx),
                                y.saturating_add(dy),
                                c.pen,
                                owner,
                            )) {
                                let mut k = 0;
                                while k < ids.len() {
                                    let (j, rev) = ids[k];
                                    if slots[j].is_none() {
                                        ids.swap_remove(k);
                                        continue;
                                    }
                                    k += 1;
                                    // Bounded even in a dense/coincident bucket.
                                    inspected += 1;
                                    if inspected > 256 {
                                        break 'near;
                                    }
                                    let Some(other) = &slots[j] else { continue };
                                    let p = if rev { other.end() } else { other.start() };
                                    let d = end.dist(p);
                                    if d > 1e-8 && d <= o.gap {
                                        candidates.push((d, j, rev, p));
                                    }
                                }
                            }
                        }
                    }
                    candidates.sort_by(|a, b| {
                        a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2))
                    });
                    let mut chosen = None;
                    for (_, j, rev, p) in candidates.into_iter().take(32) {
                        let bridge = Primitive::Line(Line::new(end, p));
                        out.stats[3] += 1;
                        if visible(owner, &bridge) {
                            chosen = Some((j, rev, bridge));
                            break;
                        }
                    }
                    let Some((j, rev, bridge)) = chosen else {
                        break;
                    };
                    let other = slots[j].take().unwrap();
                    let other = if rev { other.reversed() } else { other };
                    out.after.push(one(vec![bridge], c.pen));
                    out.stats[2] += 1;
                    c.prims.push(bridge);
                    c.prims.extend(other.prims);
                }
            }
            joined.push(c);
        }
        chains = joined;
    }
    if o.tour_budget > 0 {
        let mut pens: BTreeMap<u32, Vec<Chain>> = BTreeMap::new();
        for c in chains {
            pens.entry(c.pen).or_default().push(c);
        }
        chains = Vec::new();
        for (_, cs) in pens {
            let candidate = tour(cs.clone(), o.tour_budget / 4);
            let mut best = if travel(&candidate) <= travel(&cs) {
                candidate
            } else {
                cs
            };
            refine_order(&mut best, o.tour_budget * 3 / 4);
            relocate_seams(&mut best);
            chains.extend(best);
        }
    }
    out.chains = chains;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn opts() -> Options {
        Options {
            tolerance: 0.01,
            max_segment: 2.0,
            corner_degrees: 30.0,
            gap: 0.0,
            tour_budget: 0,
        }
    }
    fn lines(ps: &[Vec2]) -> Chain {
        one(
            ps.windows(2)
                .map(|p| Primitive::Line(Line::new(p[0], p[1])))
                .collect(),
            0,
        )
    }
    #[test]
    fn fits_circle_with_bounded_chords_and_retains_cusp() {
        let ps: Vec<_> = (0..=100)
            .map(|i| Vec2::from_angle(i as f64 * 0.015) * 10.0)
            .collect();
        let out = optimize(vec![lines(&ps)], &[], opts(), |_, _| false).unwrap();
        assert!(out.chains[0].prims.len() < 5);
        assert!(out.chains[0]
            .prims
            .iter()
            .any(|p| matches!(p, Primitive::Arc(_))));
        for p in &out.chains[0].prims {
            for k in 0..=100 {
                let q = p.eval(k as f64 / 100.0);
                assert!(
                    ps.windows(2)
                        .map(|s| distance_segment(q, s[0], s[1]))
                        .fold(f64::INFINITY, f64::min)
                        <= 0.01000001
                );
            }
        }
        let c = lines(&[v(0.0, 0.0), v(1.0, 0.0), v(1.0, 1.0)]);
        assert_eq!(
            optimize(vec![c], &[], opts(), |_, _| false).unwrap().chains[0]
                .prims
                .len(),
            2
        );
    }
    #[test]
    fn no_fitting_across_discontinuity_or_repeated_lap() {
        let mut c = lines(&[v(0.0, 0.0), v(1.0, 0.0)]);
        c.prims
            .push(Primitive::Line(Line::new(v(1.1, 0.0), v(2.0, 0.0))));
        assert_eq!(
            optimize(vec![c], &[], opts(), |_, _| false).unwrap().chains[0]
                .prims
                .len(),
            2
        );
    }
    #[test]
    fn joins_require_same_owner_unprotected_and_certificate() {
        let ps = [
            Primitive::Line(Line::new(v(0.0, 0.0), v(1.0, 0.0))),
            Primitive::Line(Line::new(v(1.2, 0.0), v(2.0, 0.0))),
        ];
        let frags: Vec<_> = ps
            .iter()
            .enumerate()
            .map(|(i, p)| Frag::whole(i as u32, *p, 0, 3))
            .collect();
        let cs: Vec<_> = ps
            .iter()
            .map(|p| Chain {
                prims: vec![*p],
                pen: 0,
                dot: false,
                ordered: false,
            })
            .collect();
        let o = Options { gap: 0.3, ..opts() };
        assert_eq!(
            optimize(cs.clone(), &frags, o, |_, _| false)
                .unwrap()
                .chains
                .len(),
            2
        );
        assert_eq!(
            optimize(cs.clone(), &frags, o, |s, _| s == 3)
                .unwrap()
                .chains
                .len(),
            1
        );
        let mut f = frags.clone();
        f[1].shape = 4;
        assert_eq!(
            optimize(cs.clone(), &f, o, |_, _| true)
                .unwrap()
                .chains
                .len(),
            2
        );
        f = frags;
        f[1].run = Some(crate::fragment::RunSpan {
            id: 1,
            start: 0.0,
            end: 1.0,
        });
        assert_eq!(
            optimize(cs.clone(), &f, o, |_, _| true)
                .unwrap()
                .chains
                .len(),
            2
        );
        assert_eq!(
            optimize_with(cs, &f, o, |_, _| true, |s| s == 3)
                .unwrap()
                .chains
                .len(),
            1
        );
    }
    #[test]
    fn moving_a_closed_seam_preserves_ink_and_continuity() {
        let c = lines(&[
            v(10.0, 10.0),
            v(0.0, 10.0),
            v(0.0, 0.0),
            v(10.0, 0.0),
            v(10.0, 10.0),
        ]);
        let mut cs = vec![c];
        let before = travel(&cs);
        relocate_seams(&mut cs);
        assert!(travel(&cs) < before);
        let length: f64 = cs[0].prims.iter().map(|p| p.end().dist(p.start())).sum();
        assert!((length - 40.0).abs() < 1e-9);
        for pair in cs[0].prims.windows(2) {
            assert!(pair[0].end().dist(pair[1].start()) < 1e-9);
        }
        assert!(cs[0].start().dist(cs[0].end()) < 1e-9);
    }
}
