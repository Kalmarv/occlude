//! Export: merge fragments into chains, tour per pen, flatten, emit G-code.
//!
//! 1. Merge fragments sharing endpoints (occlusion often splits a line and
//!    leaves both halves visible as separate fragments).
//! 2. Group by pen.
//! 3. Tour per pen: grid-accelerated nearest-neighbour, then 2-opt with an
//!    iteration budget. Chains may be reversed to reduce pen-up travel.
//! 4. Flatten adaptively: tolerance = min(machine resolution, nib / 4).
//!    Arcs emit G2/G3 when the profile supports it.
//! 5. grbl-flavoured G-code per pen.

use crate::fragment::Frag;
use crate::pipeline::Pen;
use crate::primitive::Primitive;
use crate::vec2::Vec2;
use std::collections::HashMap;
use std::fmt::Write;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MachineProfile {
    /// Bed size in mm.
    pub bed: (f64, f64),
    /// Machine step resolution in mm (flatten tolerance floor).
    pub resolution: f64,
    /// Travel (pen-up) feed, mm/min.
    pub travel_feed: f64,
    /// true: pen via Z moves (pen_down/pen_up are Z heights).
    /// false: pen via M3/M5 spindle commands (pen_down is the S value).
    pub z_mode: bool,
    /// Emit G2/G3 for arcs instead of flattening them.
    pub arc_support: bool,
}

impl Default for MachineProfile {
    fn default() -> MachineProfile {
        MachineProfile {
            bed: (300.0, 218.0),
            resolution: 0.025,
            travel_feed: 6000.0,
            z_mode: true,
            arc_support: false,
        }
    }
}

/// A pen-down run of consecutive primitives (end of one = start of next).
#[derive(Debug, Clone)]
pub struct Chain {
    pub prims: Vec<Primitive>,
    pub dot: bool,
    pub pen: u32,
}

impl Chain {
    pub fn start(&self) -> Vec2 {
        self.prims[0].start()
    }
    pub fn end(&self) -> Vec2 {
        self.prims.last().unwrap().end()
    }
    pub fn reversed(&self) -> Chain {
        Chain {
            prims: self.prims.iter().rev().map(reverse_primitive).collect(),
            dot: self.dot,
            pen: self.pen,
        }
    }
    pub fn ink_length(&self) -> f64 {
        self.prims.iter().map(|p| p.length()).sum()
    }
}

pub fn reverse_primitive(p: &Primitive) -> Primitive {
    match p {
        Primitive::Line(l) => Primitive::Line(crate::primitive::Line::new(l.p1, l.p0)),
        Primitive::Arc(a) => Primitive::Arc(crate::primitive::Arc::new(
            a.center,
            a.r,
            a.start + a.sweep,
            -a.sweep,
        )),
        Primitive::Cubic(c) => {
            Primitive::Cubic(crate::primitive::Cubic::new(c.p1, c.c1, c.c0, c.p0))
        }
    }
}

/// Merge fragments of one pen into chains by shared endpoints. Greedy and
/// exact: endpoints are quantised to the snap grid so "shared" is a hash hit.
pub fn merge_chains(frags: &[Frag], pen: u32) -> Vec<Chain> {
    let mine: Vec<&Frag> = frags.iter().filter(|f| f.pen == pen).collect();
    let mut chains: Vec<Chain> = Vec::new();
    let mut pieces: Vec<Option<Chain>> = mine
        .iter()
        .map(|f| {
            Some(Chain {
                prims: vec![f.geom],
                dot: f.dot,
                pen,
            })
        })
        .collect();

    let q = 1e-4; // mm; well below the nib, above float noise
    let key = |p: Vec2| -> (i64, i64) { ((p.x / q).round() as i64, (p.y / q).round() as i64) };

    // Endpoint → piece indices (dots excluded).
    let mut by_end: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
    for (i, c) in pieces.iter().enumerate() {
        let c = c.as_ref().unwrap();
        if c.dot {
            continue;
        }
        by_end.entry(key(c.start())).or_default().push(i);
        by_end.entry(key(c.end())).or_default().push(i);
    }

    for i in 0..pieces.len() {
        let Some(mut chain) = pieces[i].take() else {
            continue;
        };
        if chain.dot {
            chains.push(chain);
            continue;
        }
        // Extend forward from the end, then backward from the start.
        loop {
            let k = key(chain.end());
            let Some(cands) = by_end.get(&k) else { break };
            let next = cands.iter().copied().find(|&j| pieces[j].is_some());
            let Some(j) = next else { break };
            let other = pieces[j].take().unwrap();
            let other = if key(other.start()) == k {
                other
            } else {
                other.reversed()
            };
            if key(other.start()) != k {
                pieces[j] = Some(other); // hash collision, not actually adjacent
                break;
            }
            chain.prims.extend(other.prims);
        }
        loop {
            let k = key(chain.start());
            let Some(cands) = by_end.get(&k) else { break };
            let next = cands.iter().copied().find(|&j| pieces[j].is_some());
            let Some(j) = next else { break };
            let other = pieces[j].take().unwrap();
            let other = if key(other.end()) == k {
                other
            } else {
                other.reversed()
            };
            if key(other.end()) != k {
                pieces[j] = Some(other);
                break;
            }
            let mut prims = other.prims;
            prims.extend(std::mem::take(&mut chain.prims));
            chain.prims = prims;
        }
        chains.push(chain);
    }
    chains
}

/// Order chains to minimise pen-up travel: nearest-neighbour from origin,
/// considering both orientations, then 2-opt passes under an iteration
/// budget (deterministic — no wall clock, works in wasm).
pub fn tour(mut chains: Vec<Chain>, budget: usize) -> Vec<Chain> {
    let n = chains.len();
    if n <= 2 {
        return chains;
    }
    // Nearest neighbour.
    let mut ordered: Vec<Chain> = Vec::with_capacity(n);
    let mut pos = Vec2::ZERO;
    let mut remaining: Vec<Chain> = std::mem::take(&mut chains);
    while !remaining.is_empty() {
        let mut best = (0usize, false, f64::INFINITY);
        for (i, c) in remaining.iter().enumerate() {
            let df = c.start().dist(pos);
            if df < best.2 {
                best = (i, false, df);
            }
            let dr = c.end().dist(pos);
            if dr < best.2 {
                best = (i, true, dr);
            }
        }
        let c = remaining.swap_remove(best.0);
        let c = if best.1 { c.reversed() } else { c };
        pos = c.end();
        ordered.push(c);
    }
    // 2-opt on the sequence of chain endpoints.
    let travel = |a: &Chain, b: &Chain| a.end().dist(b.start());
    let mut improved = true;
    let mut iters = 0usize;
    while improved && iters < budget {
        improved = false;
        for i in 0..ordered.len() - 1 {
            for j in i + 1..ordered.len() {
                iters += 1;
                if iters >= budget {
                    break;
                }
                // Reversing segment [i+1..=j]: cost delta on the two cut edges.
                let before = travel(&ordered[i], &ordered[i + 1])
                    + if j + 1 < ordered.len() {
                        travel(&ordered[j], &ordered[j + 1])
                    } else {
                        0.0
                    };
                let after = ordered[i].end().dist(ordered[j].end())
                    + if j + 1 < ordered.len() {
                        ordered[i + 1].start().dist(ordered[j + 1].start())
                    } else {
                        0.0
                    };
                if after + 1e-9 < before {
                    ordered[i + 1..=j].reverse();
                    for c in ordered[i + 1..=j].iter_mut() {
                        *c = c.reversed();
                    }
                    improved = true;
                }
            }
        }
    }
    ordered
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GcodeJob {
    pub pen: u32,
    pub pen_name: String,
    pub gcode: String,
    pub ink_mm: f64,
    pub travel_mm: f64,
    /// Rough plot time estimate in seconds from feeds and pen delays.
    pub est_seconds: f64,
}

/// One G-code job per pen present in the fragment list.
pub fn export_gcode(
    frags: &[Frag],
    pens: &[Pen],
    profile: &MachineProfile,
    tour_budget: usize,
) -> Vec<GcodeJob> {
    let mut jobs = Vec::new();
    for (pi, pen) in pens.iter().enumerate() {
        let chains = merge_chains(frags, pi as u32);
        if chains.is_empty() {
            continue;
        }
        let chains = tour(chains, tour_budget);
        jobs.push(emit_pen_job(pi as u32, pen, &chains, profile));
    }
    jobs
}

fn emit_pen_job(pi: u32, pen: &Pen, chains: &[Chain], profile: &MachineProfile) -> GcodeJob {
    let tol = (profile.resolution).min(pen.width / 4.0).max(1e-4);
    let mut g = String::new();
    let up = |g: &mut String| {
        if profile.z_mode {
            let _ = writeln!(g, "G0 Z{:.3}", pen.pen_up);
        } else {
            let _ = writeln!(g, "M5");
        }
    };
    let down = |g: &mut String| {
        if profile.z_mode {
            let _ = writeln!(g, "G1 Z{:.3} F{:.0}", pen.pen_down, pen.feed);
        } else {
            let _ = writeln!(g, "M3 S{:.0}", pen.pen_down.max(1.0));
        }
        if pen.pen_delay_ms > 0.0 {
            let _ = writeln!(g, "G4 P{:.3}", pen.pen_delay_ms / 1000.0);
        }
    };

    let _ = writeln!(g, "; occlude — pen {} ({})", pi, pen.name);
    let _ = writeln!(g, "G21 ; mm");
    let _ = writeln!(g, "G90 ; absolute");
    up(&mut g);

    let mut ink = 0.0;
    let mut travel = 0.0;
    let mut pos = Vec2::ZERO;
    let mut pen_downs = 0usize;
    for chain in chains {
        let s = chain.start();
        travel += pos.dist(s);
        let _ = writeln!(g, "G0 X{:.3} Y{:.3} F{:.0}", s.x, s.y, profile.travel_feed);
        down(&mut g);
        pen_downs += 1;
        if chain.dot {
            up(&mut g);
            pos = s;
            continue;
        }
        for prim in &chain.prims {
            match prim {
                Primitive::Arc(a) if profile.arc_support => {
                    let e = a.eval(1.0);
                    // Paper space is y-down: positive sweep is screen-CW,
                    // which grbl calls G2.
                    let code = if a.sweep > 0.0 { "G2" } else { "G3" };
                    let _ = writeln!(
                        g,
                        "{} X{:.3} Y{:.3} I{:.3} J{:.3} F{:.0}",
                        code,
                        e.x,
                        e.y,
                        a.center.x - a.eval(0.0).x,
                        a.center.y - a.eval(0.0).y,
                        pen.feed
                    );
                }
                _ => {
                    let mut pts = Vec::new();
                    prim.flatten(tol, &mut pts);
                    for p in pts.iter().skip(1) {
                        let _ = writeln!(g, "G1 X{:.3} Y{:.3} F{:.0}", p.x, p.y, pen.feed);
                    }
                }
            }
        }
        ink += chain.ink_length();
        pos = chain.end();
        up(&mut g);
    }
    let _ = writeln!(g, "G0 X0 Y0 F{:.0}", profile.travel_feed);
    let _ = writeln!(g, "; end pen {}", pi);

    let est_seconds = ink / (pen.feed / 60.0)
        + travel / (profile.travel_feed / 60.0)
        + pen_downs as f64 * (pen.pen_delay_ms / 1000.0 * 2.0 + 0.2);
    GcodeJob {
        pen: pi,
        pen_name: pen.name.clone(),
        gcode: g,
        ink_mm: ink,
        travel_mm: travel,
        est_seconds,
    }
}
