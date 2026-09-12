//! Vector round-nib comparisons for optional Auto search. The reference is the
//! same machine polyline used by plan::toolpath. Cells partition Boolean work,
//! never sample ink. Unchanged segments are removed from the difference inputs.
use crate::{gcode::Chain, plan};
use i_overlay::{
    core::{fill_rule::FillRule, overlay::ShapeType, overlay_rule::OverlayRule},
    float::overlay::FloatOverlay,
    i_float::{adapter::FloatPointAdapter, float::rect::FloatRect},
    mesh::{
        stroke::offset::StrokeOffset,
        style::{LineCap, LineJoin, StrokeStyle},
    },
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
type Polygons = Vec<Vec<Vec<[f64; 2]>>>;
type Key = [u64; 4];
type CellKey = (usize, i64, i64);
const TILE: f64 = 8.;
const SCALE: f64 = 100_000_000.;
const ROUNDING: f64 = 64. / SCALE;
#[derive(Clone, Copy)]
struct Segment {
    a: [f64; 2],
    b: [f64; 2],
}
impl Segment {
    fn key(&self) -> Key {
        let bits = |p: [f64; 2]| p.map(|x| (x * SCALE).round() as i64 as u64);
        let a = bits(self.a);
        let b = bits(self.b);
        if a <= b {
            [a[0], a[1], b[0], b[1]]
        } else {
            [b[0], b[1], a[0], a[1]]
        }
    }
}
fn boolean(a: &Polygons, b: &Polygons, op: OverlayRule) -> Polygons {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    for p in a.iter().chain(b.iter()).flatten().flatten() {
        for j in 0..2 {
            min[j] = min[j].min(p[j]);
            max[j] = max[j].max(p[j]);
        }
    }
    if !min[0].is_finite() {
        return vec![];
    }
    let center = [
        ((min[0] + max[0]) / 2. / TILE).round() * TILE,
        ((min[1] + max[1]) / 2. / TILE).round() * TILE,
    ];
    let span = (max[0] - center[0])
        .abs()
        .max((min[0] - center[0]).abs())
        .max((max[1] - center[1]).abs())
        .max((min[1] - center[1]).abs())
        .max(1.);
    let rect = FloatRect::new(
        center[0] - span,
        center[0] + span,
        center[1] - span,
        center[1] + span,
    );
    if span * SCALE < 800_000_000. {
        let adapter = FloatPointAdapter::<[f64; 2], i32>::with_scale(rect, SCALE);
        FloatOverlay::with_adapter(adapter, 0)
            .unsafe_add_source(a, ShapeType::Subject)
            .unsafe_add_source(b, ShapeType::Clip)
            .overlay(op, FillRule::NonZero)
    } else {
        let adapter = FloatPointAdapter::<[f64; 2], i64>::with_scale(rect, SCALE);
        FloatOverlay::with_adapter(adapter, 0)
            .unsafe_add_source(a, ShapeType::Subject)
            .unsafe_add_source(b, ShapeType::Clip)
            .overlay(op, FillRule::NonZero)
    }
}
fn area(p: &Polygons) -> f64 {
    p.iter()
        .map(|s| {
            s.iter()
                .map(|r| {
                    let o = r[0];
                    (0..r.len())
                        .map(|i| {
                            let a = r[i];
                            let b = r[(i + 1) % r.len()];
                            (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
                        })
                        .sum::<f64>()
                        / 2.
                })
                .sum::<f64>()
                .abs()
        })
        .sum()
}
fn square(k: CellKey) -> Polygons {
    let x = k.1 as f64 * TILE;
    let y = k.2 as f64 * TILE;
    vec![vec![vec![
        [x, y],
        [x + TILE, y],
        [x + TILE, y + TILE],
        [x, y + TILE],
    ]]]
}
fn clip(p: &Polygons, k: CellKey) -> Polygons {
    boolean(p, &square(k), OverlayRule::Intersect)
}
fn sweep(ss: &[Segment], r: f64, eps: f64, outer: bool, k: CellKey) -> Result<Polygons, String> {
    if ss.is_empty() {
        return Ok(vec![]);
    }
    // Round joins/caps are inscribed. Allow their chord error and integer
    // intersection rounding on the appropriate side of the physical radius.
    let radius = if outer {
        r + 2. * eps + ROUNDING
    } else {
        r - eps - ROUNDING
    };
    if radius <= 0. {
        return Err("Ink measurement precision exceeds the nib radius".into());
    }
    let angle = (2. * (1. - eps / radius).clamp(-1., 1.).acos()).min(std::f64::consts::FRAC_PI_8);
    let mut paths: Vec<Vec<[f64; 2]>> = vec![];
    let mut dots = vec![];
    let offset = [(k.1 as f64 + 0.5) * TILE, (k.2 as f64 + 0.5) * TILE];
    let halo = TILE / 2. + radius + eps * 4. + 0.001;
    for source in ss {
        let mut a = [source.a[0] - offset[0], source.a[1] - offset[1]];
        let mut b = [source.b[0] - offset[0], source.b[1] - offset[1]];
        let d = [b[0] - a[0], b[1] - a[1]];
        let mut lo: f64 = 0.;
        let mut hi: f64 = 1.;
        let mut outside = false;
        for j in 0..2 {
            if d[j] == 0. {
                if a[j].abs() > halo {
                    outside = true
                }
            } else {
                let t0 = (-halo - a[j]) / d[j];
                let t1 = (halo - a[j]) / d[j];
                lo = lo.max(t0.min(t1));
                hi = hi.min(t0.max(t1));
            }
        }
        if outside || lo > hi {
            continue;
        }
        b = [a[0] + hi * d[0], a[1] + hi * d[1]];
        a = [a[0] + lo * d[0], a[1] + lo * d[1]];
        let s = Segment { a, b };
        if s.a == s.b {
            dots.push(s.a);
            continue;
        }
        if paths.last().is_some_and(|p| p.last() == Some(&s.a)) {
            paths.last_mut().unwrap().push(s.b)
        } else {
            paths.push(vec![s.a, s.b])
        }
    }
    let style = StrokeStyle::new(radius * 2.)
        .start_cap(LineCap::Round(angle))
        .end_cap(LineCap::Round(angle))
        .line_join(LineJoin::Round(angle));
    let mut out = if paths.is_empty() {
        vec![]
    } else {
        if halo * SCALE < 800_000_000. {
            paths.stroke_fixed_scale_as::<i32>(style, false, SCALE)
        } else {
            paths.stroke_fixed_scale_as::<i64>(style, false, SCALE)
        }
        .map_err(|e| format!("Ink sweep: {e:?}"))?
    };
    let n = (std::f64::consts::TAU / angle).ceil() as usize;
    for p in dots {
        out.push(vec![(0..n)
            .map(|i| {
                let a = i as f64 * std::f64::consts::TAU / n as f64;
                [p[0] + radius * a.cos(), p[1] + radius * a.sin()]
            })
            .collect()])
    }
    for p in out.iter_mut().flatten().flatten() {
        p[0] += offset[0];
        p[1] += offset[1];
    }
    Ok(boolean(&out, &vec![], OverlayRule::Subject))
}
fn cells(
    chains: &[Chain],
    widths: &[f64],
    tolerance: f64,
    local: f64,
) -> Result<BTreeMap<CellKey, Vec<Segment>>, String> {
    let flat = plan::toolpath(chains, tolerance);
    let mut i = 0;
    let mut out: BTreeMap<CellKey, Vec<Segment>> = BTreeMap::new();
    while i < flat.len() {
        let pen = flat[i] as usize;
        let n = flat[i + 2] as usize;
        i += 3;
        let width = *widths.get(pen).ok_or("Unknown pen in ink comparison")?;
        let margin = width * (0.5 + local) + 0.01;
        let ps: Vec<_> = (0..n)
            .map(|j| [flat[i + j * 2], flat[i + j * 2 + 1]])
            .collect();
        i += n * 2;
        let segs: Vec<_> = if n == 1 {
            vec![Segment { a: ps[0], b: ps[0] }]
        } else {
            ps.windows(2)
                .map(|p| Segment { a: p[0], b: p[1] })
                .collect()
        };
        for s in segs {
            if s.a
                .iter()
                .chain(s.b.iter())
                .any(|v| !v.is_finite() || v.abs() > 100_000.)
            {
                return Err("Ink comparison coordinates exceed the fixed-grid range".into());
            }
            let x0 = ((s.a[0].min(s.b[0]) - margin) / TILE).floor() as i64;
            let x1 = ((s.a[0].max(s.b[0]) + margin) / TILE).floor() as i64;
            let y0 = ((s.a[1].min(s.b[1]) - margin) / TILE).floor() as i64;
            let y1 = ((s.a[1].max(s.b[1]) + margin) / TILE).floor() as i64;
            for x in x0..=x1 {
                for y in y0..=y1 {
                    out.entry((pen, x, y)).or_default().push(s)
                }
            }
        }
    }
    Ok(out)
}
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PenDifference {
    pub pen: usize,
    pub original_lower: f64,
    pub original_upper: f64,
    pub missing_lower: f64,
    pub missing_upper: f64,
    pub added_lower: f64,
    pub added_upper: f64,
    pub local_limit_mm: f64,
    pub local_pass: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    pub status: String,
    pub complete: bool,
    pub pens: Vec<PenDifference>,
    pub changed_cells: usize,
    pub model: &'static str,
}
struct Cached {
    lo: Polygons,
    hi: Polygons,
    expanded: Option<Polygons>,
    area_lo: f64,
    area_hi: f64,
}
pub struct InkSession {
    source: BTreeMap<CellKey, Vec<Segment>>,
    cache: BTreeMap<CellKey, Cached>,
    widths: Vec<f64>,
    tolerance: f64,
    local: f64,
    missing: f64,
    added: f64,
}
impl InkSession {
    pub fn new(
        chains: &[Chain],
        widths: Vec<f64>,
        tolerance: f64,
        local: f64,
        missing: f64,
        added: f64,
    ) -> Result<Self, String> {
        if widths.iter().any(|w| !w.is_finite() || *w <= 0.)
            || [local, missing, added]
                .iter()
                .any(|v| !v.is_finite() || *v < 0.)
            || !tolerance.is_finite()
            || tolerance <= 0.
        {
            return Err(
                "Auto requires finite positive pen widths and non-negative fidelity allowances"
                    .into(),
            );
        }
        Ok(Self {
            source: cells(chains, &widths, tolerance, local)?,
            cache: BTreeMap::new(),
            widths,
            tolerance,
            local,
            missing,
            added,
        })
    }
    pub fn compare(&mut self, chains: &[Chain]) -> Result<Difference, String> {
        let candidate = cells(chains, &self.widths, self.tolerance, self.local)?;
        let keys: BTreeSet<_> = self
            .source
            .keys()
            .chain(candidate.keys())
            .copied()
            .collect();
        let mut pens: Vec<_> = self
            .widths
            .iter()
            .enumerate()
            .map(|(pen, w)| PenDifference {
                pen,
                local_limit_mm: w * self.local,
                local_pass: true,
                ..Default::default()
            })
            .collect();
        let mut changed_cells = 0;
        let mut keys: Vec<_> = keys.into_iter().collect();
        keys.sort_by_key(|k| {
            (
                self.source.get(k).map_or(0, Vec::len) == candidate.get(k).map_or(0, Vec::len),
                *k,
            )
        });
        for k in keys {
            let empty = vec![];
            let original = self.source.get(&k).unwrap_or(&empty);
            let cand = candidate.get(&k).unwrap_or(&empty);
            let ok: BTreeSet<_> = original.iter().map(Segment::key).collect();
            let ck: BTreeSet<_> = cand.iter().map(Segment::key).collect();
            // Grid keys recognize numerically reversed samples. Their actual
            // endpoint displacement still contributes a conservative capsule
            // area bound; zero allowances never silently become an epsilon.
            let matches: BTreeMap<_, _> = cand.iter().map(|s| (s.key(), s)).collect();
            let originals: BTreeMap<_, _> = original.iter().map(|s| (s.key(), s)).collect();
            for (segments, partners, missing) in
                [(original, &matches, true), (cand, &originals, false)]
            {
                for s in segments {
                    if let Some(c) = partners.get(&s.key()) {
                        let dist = |a: [f64; 2], b: [f64; 2]| (a[0] - b[0]).hypot(a[1] - b[1]);
                        let d = dist(s.a, c.a)
                            .max(dist(s.b, c.b))
                            .min(dist(s.a, c.b).max(dist(s.b, c.a)));
                        if d > 0. {
                            let p = &mut pens[k.0];
                            let bound = d
                                * (2. * dist(s.a, s.b) + std::f64::consts::TAU * self.widths[k.0])
                                + std::f64::consts::PI * d * d;
                            if missing {
                                p.missing_upper += bound
                            } else {
                                p.added_upper += bound
                            }
                            if d > p.local_limit_mm {
                                p.local_pass = false
                            }
                        }
                    }
                }
            }
            let removed: Vec<_> = original
                .iter()
                .filter(|s| !ck.contains(&s.key()))
                .copied()
                .collect();
            let added: Vec<_> = cand
                .iter()
                .filter(|s| !ok.contains(&s.key()))
                .copied()
                .collect();
            let width = self.widths[k.0];
            let radius = width / 2.;
            let eps = (width / 4000.)
                .min(0.0001)
                .min((width * self.local / 32.).max(width / 16000.));
            if eps <= ROUNDING {
                return Err(
                    "Auto needs finer measurement precision for this pen; the original is retained"
                        .into(),
                );
            }
            if !self.cache.contains_key(&k) {
                let lo = sweep(original, radius, eps, false, k)?;
                let hi = sweep(original, radius, eps, true, k)?;
                let area_lo = area(&clip(&lo, k));
                let area_hi = area(&clip(&hi, k));
                self.cache.insert(
                    k,
                    Cached {
                        lo,
                        hi,
                        area_lo,
                        area_hi,
                        expanded: None,
                    },
                );
            }
            let old = self.cache.get_mut(&k).unwrap();
            let p = &mut pens[k.0];
            p.original_lower += old.area_lo;
            p.original_upper += old.area_hi;
            if removed.is_empty() && added.is_empty() {
                continue;
            }
            changed_cells += 1;
            if !removed.is_empty() {
                let lo = sweep(&removed, radius, eps, false, k)?;
                let hi = sweep(&removed, radius, eps, true, k)?;
                let cl = sweep(cand, radius, eps, false, k)?;
                let ch = sweep(cand, radius, eps, true, k)?;
                p.missing_lower += area(&clip(&boolean(&lo, &ch, OverlayRule::Difference), k));
                p.missing_upper += area(&clip(&boolean(&hi, &cl, OverlayRule::Difference), k));
                let expanded = sweep(cand, radius + p.local_limit_mm, eps, false, k)?;
                if !clip(&boolean(&hi, &expanded, OverlayRule::Difference), k).is_empty() {
                    p.local_pass = false;
                    return Ok(Difference {
                        status: "inconclusive".into(),
                        complete: false,
                        pens,
                        changed_cells,
                        model: "round-nib-machine-polyline-v1",
                    });
                }
            }
            if !added.is_empty() {
                let lo = sweep(&added, radius, eps, false, k)?;
                let hi = sweep(&added, radius, eps, true, k)?;
                p.added_lower += area(&clip(&boolean(&lo, &old.hi, OverlayRule::Difference), k));
                p.added_upper += area(&clip(&boolean(&hi, &old.lo, OverlayRule::Difference), k));
                if old.expanded.is_none() {
                    old.expanded = Some(sweep(original, radius + p.local_limit_mm, eps, false, k)?)
                }
                if !clip(
                    &boolean(&hi, old.expanded.as_ref().unwrap(), OverlayRule::Difference),
                    k,
                )
                .is_empty()
                {
                    p.local_pass = false;
                    return Ok(Difference {
                        status: "inconclusive".into(),
                        complete: false,
                        pens,
                        changed_cells,
                        model: "round-nib-machine-polyline-v1",
                    });
                }
            }
        }
        let passed = pens.iter().all(|p| {
            p.local_pass
                && p.missing_upper <= self.missing * p.original_lower
                && p.added_upper <= self.added * p.original_lower
        });
        let violated = pens.iter().any(|p| {
            p.missing_lower > self.missing * p.original_upper
                || p.added_lower > self.added * p.original_upper
        });
        Ok(Difference {
            complete: true,
            status: if passed {
                "passed"
            } else if violated {
                "rejected"
            } else {
                "inconclusive"
            }
            .into(),
            pens,
            changed_cells,
            model: "round-nib-machine-polyline-v1",
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        primitive::{Line, Primitive},
        vec2::v,
    };
    fn line(x: f64, y: f64, x1: f64, y1: f64) -> Chain {
        Chain {
            prims: vec![Primitive::Line(Line::new(v(x, y), v(x1, y1)))],
            pen: 0,
            dot: false,
            ordered: true,
        }
    }
    #[test]
    fn overlaps_gaps_and_reversal() {
        let src = vec![line(0., 0., 10., 0.), line(0., 0.35, 10., 0.35)];
        let mut s = InkSession::new(&src, vec![0.4], 0.025, 0.1, 0.001, 0.005).unwrap();
        let mut c = src.clone();
        c.push(line(5., 0., 5., 0.35));
        let d = s.compare(&c).unwrap();
        assert_eq!(d.status, "passed");
        assert!(d.pens[0].added_lower < 1e-6);
        assert!(d.pens[0].added_upper < 0.001);
        assert_eq!(
            s.compare(&src.iter().map(Chain::reversed).collect::<Vec<_>>())
                .unwrap()
                .status,
            "passed"
        );
        let mut c = src;
        c.push(line(5., 0., 5., 1.));
        assert_ne!(s.compare(&c).unwrap().status, "passed");
    }
    #[test]
    fn isolated_mark_is_not_hidden_by_area() {
        let mut src = vec![];
        for y in 0..20 {
            src.push(line(0., y as f64, 100., y as f64))
        }
        src.push(line(110., 0., 110.1, 0.));
        let mut s = InkSession::new(&src, vec![0.1], 0.025, 0.1, 0.1, 0.1).unwrap();
        let d = s.compare(&src[..20]).unwrap();
        assert!(!d.pens[0].local_pass);
        assert_ne!(d.status, "passed");
    }
    #[test]
    fn pens_cannot_replace_each_other() {
        let src = vec![line(0., 0., 10., 0.)];
        let mut c = src.clone();
        c[0].pen = 1;
        let mut s = InkSession::new(&src, vec![0.4, 0.4], 0.025, 0.1, 0.001, 0.005).unwrap();
        assert_ne!(s.compare(&c).unwrap().status, "passed");
    }
    #[test]
    fn cell_boundaries_and_nib_sizes_do_not_change_the_decision() {
        for width in [0.01, 0.1, 0.4, 1.0] {
            for x in [7.99999999, 8.00000001, 123.125] {
                let src = vec![
                    line(x, 0., x + 2., 0.),
                    line(x, width * 0.875, x + 2., width * 0.875),
                ];
                let mut candidate = src.clone();
                candidate.push(line(x + 1., 0., x + 1., width * 0.875));
                let mut session =
                    InkSession::new(&src, vec![width], 0.025, 0.1, 0.001, 0.005).unwrap();
                let result = session.compare(&candidate).unwrap();
                assert_eq!(result.status, "passed", "width={width}, x={x}");
            }
        }
    }
    #[test]
    fn interior_loss_is_checked_even_when_outer_boundaries_match() {
        let mut src = vec![
            line(0., 0., 10., 0.),
            line(10., 0., 10., 10.),
            line(10., 10., 0., 10.),
            line(0., 10., 0., 0.),
        ];
        let boundary = src.clone();
        let mut dot = line(5., 5., 5., 5.);
        dot.dot = true;
        src.push(dot);
        let mut session = InkSession::new(&src, vec![0.4], 0.025, 0.1, 1., 1.).unwrap();
        assert_ne!(session.compare(&boundary).unwrap().status, "passed");
    }
    #[test]
    fn zero_allowances_accept_only_unchanged_ink_in_this_fixture() {
        let src = vec![line(0., 0., 2., 0.)];
        let mut session = InkSession::new(&src, vec![0.4], 0.025, 0., 0., 0.).unwrap();
        assert_eq!(session.compare(&src).unwrap().status, "passed");
        assert_ne!(
            session
                .compare(&[line(0., 0.000001, 2., 0.000001)])
                .unwrap()
                .status,
            "passed"
        );
    }

    #[test]
    fn near_duplicate_extra_ink_cannot_hide_behind_an_exact_match() {
        let src = vec![line(1., 1., 2., 1.)];
        let candidate = vec![line(1., 1. + 1e-9, 2., 1. + 1e-9), src[0].clone()];
        let mut session = InkSession::new(&src, vec![0.4], 0.025, 0., 0., 0.).unwrap();
        let result = session.compare(&candidate).unwrap();
        assert!(result.pens[0].added_upper > 0.);
        assert_ne!(result.status, "passed");
    }
    #[test]
    fn vector_intervals_enclose_the_analytic_blank_strip() {
        let src = vec![line(0., 0., 10., 0.), line(0., 1., 10., 1.)];
        let mut candidate = src.clone();
        candidate.push(line(5., 0., 5., 1.));
        // The exact new footprint is a 0.4 by 0.6 mm rectangle. Its
        // midpoint is 0.3 mm from the original round-nib footprint.
        let mut pass = InkSession::new(&src, vec![0.4], 0.025, 0.301 / 0.4, 1., 1.).unwrap();
        let result = pass.compare(&candidate).unwrap();
        assert_eq!(result.status, "passed");
        let p = &result.pens[0];
        assert!(p.added_lower <= 0.24 && p.added_upper >= 0.24);
        assert!(p.added_upper - p.added_lower < 0.001);
        let mut fail = InkSession::new(&src, vec![0.4], 0.025, 0.299 / 0.4, 1., 1.).unwrap();
        assert_ne!(fail.compare(&candidate).unwrap().status, "passed");
    }
}
