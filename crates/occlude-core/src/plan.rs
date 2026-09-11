//! The ordered drawing plan — ONE resolved merge → tour → bridge that every
//! consumer (SVG, G-code, toolpath, simulation, plotting, estimates) reads
//! instead of planning again.
//!
//! Order of operations: solve the full drawing (visibility, finishing) →
//! merge, tour and bridge per pen → materialize this plan → select a range
//! of it → derive representations. Selection never re-plans: a range is a
//! contiguous slice of the same chains in the same order and direction.
//!
//! The canonical timeline is pen by pen, in pen index order — that IS the
//! machine's actual order (there is no pen changer: one pen per run).
//!
//! Wire format (`encode_plan`), one `Vec<f64>`, exact and lossless:
//!   [schema = 1, n_chains,
//!    per chain: pen, dot(0|1), n_prims,
//!      per prim: kind, params…] with
//!      kind 0 = Line   x0 y0 x1 y1
//!      kind 1 = Arc    cx cy r start sweep
//!      kind 2 = Cubic  x0 y0 c0x c0y c1x c1y x1 y1
//! Native arcs and cubics survive, so the exact SVG/G-code paths keep them.

use crate::fragment::Frag;
use crate::gcode::{merge_chains, tour, Chain};
use crate::pipeline::Pen;
use crate::primitive::{Arc, Cubic, Line, Primitive};
use crate::route::bridge_chains;
use crate::vec2::{v, Vec2};

pub const PLAN_SCHEMA: f64 = 1.0;

/// Sub-nib gap a pen draws through instead of lifting, by default: half
/// the nib. `bridge` overrides it for every pen: `Some(0.0)` never
/// bridges, `Some(g)` bridges gaps up to `g` mm, `None` is the default.
pub fn bridge_gap(pen: &Pen, bridge: Option<f64>) -> f64 {
    match bridge {
        Some(g) => g.max(0.0),
        None => pen.width.max(0.05) * 0.5,
    }
}

/// The path-optimization inputs of a plan — the only knobs planning has.
#[derive(Debug, Clone, Copy)]
pub struct PlanOptions {
    /// 2-opt iteration budget for the tour; 0 keeps nearest-neighbour order.
    pub tour_budget: usize,
    /// Bridge gap override, see `bridge_gap`.
    pub bridge: Option<f64>,
}

impl Default for PlanOptions {
    fn default() -> PlanOptions {
        PlanOptions { tour_budget: 200_000, bridge: None }
    }
}

/// The full plan: for each pen in index order, merge → tour → bridge.
pub fn plan_chains(frags: &[Frag], pens: &[Pen], tour_budget: usize) -> Vec<Chain> {
    plan_chains_with(frags, pens, PlanOptions { tour_budget, bridge: None })
}

pub fn plan_chains_with(frags: &[Frag], pens: &[Pen], opts: PlanOptions) -> Vec<Chain> {
    let mut out: Vec<Chain> = Vec::new();
    for (pi, pen) in pens.iter().enumerate() {
        let chains = {
            let _z = crate::profile::zone("p1 merge");
            merge_chains(frags, pi as u32)
        };
        if chains.is_empty() {
            continue;
        }
        let chains = {
            let _z = crate::profile::zone("p2 tour");
            tour(chains, opts.tour_budget)
        };
        let _z = crate::profile::zone("p3 bridge");
        out.extend(bridge_chains(chains, bridge_gap(pen, opts.bridge)));
    }
    out
}

pub fn encode_plan(chains: &[Chain]) -> Vec<f64> {
    let _z = crate::profile::zone("p4 encode");
    let mut out: Vec<f64> = vec![PLAN_SCHEMA, chains.len() as f64];
    for c in chains {
        out.push(c.pen as f64);
        out.push(if c.dot { 1.0 } else { 0.0 });
        out.push(c.prims.len() as f64);
        for p in &c.prims {
            match p {
                Primitive::Line(l) => out.extend([0.0, l.p0.x, l.p0.y, l.p1.x, l.p1.y]),
                Primitive::Arc(a) => out.extend([1.0, a.center.x, a.center.y, a.r, a.start, a.sweep]),
                Primitive::Cubic(k) => out.extend([
                    2.0, k.p0.x, k.p0.y, k.c0.x, k.c0.y, k.c1.x, k.c1.y, k.p1.x, k.p1.y,
                ]),
            }
        }
    }
    out
}

pub fn decode_plan(buf: &[f64]) -> Result<Vec<Chain>, String> {
    let mut i = 0usize;
    let mut take = |n: usize| -> Result<&[f64], String> {
        if i + n > buf.len() {
            return Err("plan buffer truncated".into());
        }
        let s = &buf[i..i + n];
        i += n;
        Ok(s)
    };
    let head = take(2)?;
    if head[0] != PLAN_SCHEMA {
        return Err(format!("plan schema {} is not {}", head[0], PLAN_SCHEMA));
    }
    let n = head[1] as usize;
    let mut chains = Vec::with_capacity(n);
    for _ in 0..n {
        let h = take(3)?;
        let pen = h[0] as u32;
        let dot = h[1] != 0.0;
        let np = h[2] as usize;
        let mut prims = Vec::with_capacity(np);
        for _ in 0..np {
            let kind = take(1)?[0];
            let p = match kind as i32 {
                0 => {
                    let q = take(4)?;
                    Primitive::Line(Line::new(v(q[0], q[1]), v(q[2], q[3])))
                }
                1 => {
                    let q = take(5)?;
                    Primitive::Arc(Arc::new(v(q[0], q[1]), q[2], q[3], q[4]))
                }
                2 => {
                    let q = take(8)?;
                    Primitive::Cubic(Cubic::new(
                        v(q[0], q[1]),
                        v(q[2], q[3]),
                        v(q[4], q[5]),
                        v(q[6], q[7]),
                    ))
                }
                k => return Err(format!("plan buffer: unknown primitive kind {k}")),
            };
            prims.push(p);
        }
        if prims.is_empty() {
            return Err("plan buffer: a chain with no primitives".into());
        }
        chains.push(Chain { prims, dot, pen, ordered: false });
    }
    if i != buf.len() {
        return Err("plan buffer: trailing data".into());
    }
    Ok(chains)
}

/// The half-open range `[from, to)` of a plan, validated against its length.
pub fn range(chains: &[Chain], from: usize, to: usize) -> Result<&[Chain], String> {
    if from > to || to > chains.len() {
        return Err(format!(
            "plan range [{from}, {to}) is not within 0..{} in order",
            chains.len()
        ));
    }
    Ok(&chains[from..to])
}

/// Sampled representation for machine execution and estimation: chains in
/// plan order flattened at `tolerance` (mm), layout
/// `[pen, dot, n_points, x0, y0, …]` per chain. Flattening one chain never
/// depends on its neighbours, so the toolpath of a range equals the range of
/// the toolpath.
pub fn toolpath(chains: &[Chain], tolerance: f64) -> Vec<f64> {
    let mut out: Vec<f64> = Vec::new();
    let mut pts: Vec<Vec2> = Vec::new();
    for chain in chains {
        out.push(chain.pen as f64);
        out.push(if chain.dot { 1.0 } else { 0.0 });
        if chain.dot {
            let p = chain.start();
            out.push(1.0);
            out.push(p.x);
            out.push(p.y);
            continue;
        }
        // Consecutive primitives share endpoints: drop each one's duplicated
        // first point.
        let mut all: Vec<Vec2> = Vec::new();
        for prim in &chain.prims {
            pts.clear();
            prim.flatten(tolerance.max(0.01), &mut pts);
            let skip = usize::from(!all.is_empty());
            all.extend(pts.iter().skip(skip));
        }
        out.push(all.len() as f64);
        for p in &all {
            out.push(p.x);
            out.push(p.y);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A row of exact circles: every chain starts and ends at angle 0, so all
    /// endpoints share one y. The tour's grid must not collapse on that
    /// degenerate box (it did: minutes for twelve circles).
    #[test]
    fn tour_terminates_on_collinear_closed_chains() {
        let circles: Vec<Chain> = (0..12)
            .map(|k| {
                let c = v(20.0 + k as f64 * 10.0, 30.0);
                Chain {
                    prims: vec![
                        Primitive::Arc(Arc::new(c, 8.0, 0.0, std::f64::consts::PI)),
                        Primitive::Arc(Arc::new(c, 8.0, std::f64::consts::PI, std::f64::consts::PI)),
                    ],
                    dot: false,
                    pen: 0, ordered: false,
                }
            })
            .collect();
        let t0 = std::time::Instant::now();
        let ordered = tour(circles, 200_000);
        assert_eq!(ordered.len(), 12);
        assert!(t0.elapsed().as_secs_f64() < 1.0, "tour took {:?}", t0.elapsed());
        // nearest first: the leftmost circle is closest to the origin
        assert!((ordered[0].start().x - 28.0).abs() < 1e-9);
    }

    #[test]
    fn plan_round_trips_every_primitive_kind() {
        let chains = vec![
            Chain {
                prims: vec![
                    Primitive::Line(Line::new(v(0.0, 0.0), v(1.0, 0.0))),
                    Primitive::Arc(Arc::new(v(1.0, 1.0), 1.0, -1.5707963267948966, 1.5707963267948966)),
                    Primitive::Cubic(Cubic::new(v(2.0, 1.0), v(3.0, 2.0), v(4.0, 0.0), v(5.0, 1.0))),
                ],
                dot: false,
                pen: 2, ordered: false,
            },
            Chain { prims: vec![Primitive::Line(Line::new(v(7.0, 7.0), v(7.0, 7.0)))], dot: true, pen: 0, ordered: false },
        ];
        let buf = encode_plan(&chains);
        let back = decode_plan(&buf).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].pen, 2);
        assert!(back[1].dot);
        assert_eq!(encode_plan(&back), buf);
        assert!(decode_plan(&buf[..buf.len() - 1]).is_err());
        assert!(range(&chains, 1, 0).is_err());
        assert!(range(&chains, 0, 3).is_err());
        assert_eq!(range(&chains, 1, 2).unwrap().len(), 1);
        assert_eq!(range(&chains, 2, 2).unwrap().len(), 0);
    }
}
