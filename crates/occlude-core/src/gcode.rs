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
    /// Preserve deliberate run boundaries through generic gap bridging.
    pub ordered: bool,
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
            ordered: self.ordered,
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
    let mine: Vec<&Frag> = frags.iter().filter(|f| f.pen == pen && f.run.is_none()).collect();
    let mut chains: Vec<Chain> = Vec::new();
    let mut pieces: Vec<Option<Chain>> = mine
        .iter()
        .map(|f| {
            Some(Chain {
                prims: vec![f.geom],
                dot: f.dot,
                pen,
                ordered: false,
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
        // Backward: collect the pieces that lead INTO the start, then splice
        // once. Prepending per piece copied the whole chain each time —
        // quadratic in chain length, and a streamline is thousands of pieces
        // (the 2026-09-06 27s "Simulate does nothing" on a flow portrait).
        let mut before: Vec<Primitive> = Vec::new(); // reversed order, reversed prims
        let mut head = chain.start();
        loop {
            let k = key(head);
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
            head = other.start();
            // Push in reverse so one final reverse restores plot order.
            before.extend(other.prims.into_iter().rev());
        }
        if !before.is_empty() {
            before.reverse();
            before.extend(std::mem::take(&mut chain.prims));
            chain.prims = before;
        }
        chains.push(chain);
    }
    // Repeated junction coordinates are meaningful in generated runs. Assemble
    // by traversal position, never through the endpoint map used above.
    let mut ordered: Vec<_> = frags.iter().filter(|f| f.pen == pen && f.run.is_some()).collect();
    ordered.sort_by(|a,b| {
        let (ra,rb) = (a.run.unwrap(),b.run.unwrap());
        a.shape.cmp(&b.shape).then(ra.id.cmp(&rb.id)).then(ra.start.total_cmp(&rb.start))
    });
    let mut previous: Option<&Frag> = None;
    for f in ordered {
        let r = f.run.unwrap();
        let continues = previous.is_some_and(|p| {
            let prev = p.run.unwrap();
            !p.dot && !f.dot && p.shape == f.shape && prev.id == r.id
                && (prev.end-r.start).abs() <= 1e-12
                && p.geom.end().dist(f.geom.start()) <= 1e-8
        });
        if continues { chains.last_mut().unwrap().prims.push(f.geom); }
        else { chains.push(Chain { prims: vec![f.geom], dot: f.dot, pen, ordered: true }); }
        previous = Some(f);
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
    // Nearest neighbour over a uniform grid of chain endpoints: each step
    // searches rings of cells outward from the pen and stops as soon as the
    // best candidate is closer than the next ring can be. A linear scan was
    // O(n²) — 17s native on a 41k-chain flow portrait (2026-09-06). Ties
    // break on the lowest chain index, then forward before reversed, so the
    // result is a pure function of the input order.
    let mut ordered: Vec<Chain> = Vec::with_capacity(n);
    let mut pos = Vec2::ZERO;
    let mut remaining: Vec<Option<Chain>> = std::mem::take(&mut chains).into_iter().map(Some).collect();
    let ends: Vec<(Vec2, Vec2)> = remaining
        .iter()
        .map(|c| {
            let c = c.as_ref().unwrap();
            (c.start(), c.end())
        })
        .collect();
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for (a, b) in &ends {
        for p in [a, b] {
            minx = minx.min(p.x);
            miny = miny.min(p.y);
            maxx = maxx.max(p.x);
            maxy = maxy.max(p.y);
        }
    }
    let span_x = (maxx - minx).max(1e-9);
    let span_y = (maxy - miny).max(1e-9);
    // ~2 chains per cell on average — but never finer than the long axis
    // split into 2n cells: when every endpoint lies on one line (a row of
    // exact circles all start at angle 0) the box has no area and the cell
    // collapsed to microns, and the ring walk below became quadratic in
    // the number of rings (minutes for twelve circles). The search stops
    // exactly, so the cell size never changes the order it finds.
    let cell = ((span_x * span_y) / (n as f64 / 2.0))
        .sqrt()
        .max(span_x.max(span_y) / (2.0 * n as f64))
        .max(1e-6);
    let cols = ((span_x / cell).floor() as usize + 1).max(1);
    let rows = ((span_y / cell).floor() as usize + 1).max(1);
    let cell_of = |p: Vec2| -> (usize, usize) {
        (
            (((p.x - minx) / cell).floor() as usize).min(cols - 1),
            (((p.y - miny) / cell).floor() as usize).min(rows - 1),
        )
    };
    let mut grid: Vec<Vec<u32>> = vec![Vec::new(); cols * rows];
    for (i, (a, b)) in ends.iter().enumerate() {
        let ca = cell_of(*a);
        let cb = cell_of(*b);
        grid[ca.1 * cols + ca.0].push(i as u32);
        if cb != ca {
            grid[cb.1 * cols + cb.0].push(i as u32);
        }
    }
    let max_ring = cols.max(rows);
    for _ in 0..n {
        // Pen position → grid cell (clamped: the pen may sit outside the bbox).
        let px = (((pos.x - minx) / cell).floor()).clamp(0.0, (cols - 1) as f64) as i64;
        let py = (((pos.y - miny) / cell).floor()).clamp(0.0, (rows - 1) as f64) as i64;
        // Distance from the pen to the nearest point of the clamped cell:
        // ring r's cells are at least (r - 1) cells + that away.
        let outside = {
            let cx0 = minx + px as f64 * cell;
            let cy0 = miny + py as f64 * cell;
            let dx = (cx0 - pos.x).max(pos.x - (cx0 + cell)).max(0.0);
            let dy = (cy0 - pos.y).max(pos.y - (cy0 + cell)).max(0.0);
            dx.hypot(dy)
        };
        let mut best: (f64, usize, bool) = (f64::INFINITY, usize::MAX, false);
        let mut consider = |i: usize, rev: bool, d: f64, best: &mut (f64, usize, bool)| {
            let better = d < best.0
                || (d == best.0 && (i < best.1 || (i == best.1 && !rev && best.2)));
            if better {
                *best = (d, i, rev);
            }
        };
        let mut r: i64 = 0;
        loop {
            let ring_min = if r == 0 { 0.0 } else { ((r - 1) as f64) * cell + outside };
            if best.0 <= ring_min || r as usize > max_ring {
                break;
            }
            for cy in (py - r).max(0)..=(py + r).min(rows as i64 - 1) {
                let edge_row = cy == py - r || cy == py + r;
                let mut cx = px - r;
                while cx <= px + r {
                    if cx >= 0 && cx < cols as i64 {
                        for &i in &grid[cy as usize * cols + cx as usize] {
                            let i = i as usize;
                            if remaining[i].is_none() {
                                continue;
                            }
                            let (a, b) = ends[i];
                            consider(i, false, a.dist(pos), &mut best);
                            consider(i, true, b.dist(pos), &mut best);
                        }
                    }
                    // Interior rows only visit the ring's two edge columns.
                    cx += if edge_row || r == 0 { 1 } else { 2 * r };
                }
            }
            r += 1;
        }
        let c = remaining[best.1].take().unwrap();
        let c = if best.2 { c.reversed() } else { c };
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
}

/// One G-code job per pen present in the PLANNED chains (`plan::plan_chains`
/// or a range of it), in plan order — this encodes the plan, it never plans.
pub fn export_gcode(chains: &[Chain], pens: &[Pen], profile: &MachineProfile) -> Vec<GcodeJob> {
    let mut jobs = Vec::new();
    for (pi, pen) in pens.iter().enumerate() {
        let mine: Vec<Chain> = chains.iter().filter(|c| c.pen == pi as u32).cloned().collect();
        if mine.is_empty() {
            continue;
        }
        jobs.push(emit_pen_job(pi as u32, pen, &mine, profile));
    }
    jobs
}

/// Pen names go into G-code comment lines: strip newlines (line
/// injection) and characters G-code comments can't hold.
fn comment_safe(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_control() || c == '(' || c == ')' || c == ';' {
                '_'
            } else {
                c
            }
        })
        .collect()
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

    let _ = writeln!(g, "; occlude — pen {} ({})", pi, comment_safe(&pen.name));
    let _ = writeln!(g, "G21 ; mm");
    let _ = writeln!(g, "G90 ; absolute");
    up(&mut g);

    let mut ink = 0.0;
    let mut travel = 0.0;
    let mut pos = Vec2::ZERO;
    for chain in chains {
        let s = chain.start();
        travel += pos.dist(s);
        let _ = writeln!(g, "G0 X{:.3} Y{:.3} F{:.0}", s.x, s.y, profile.travel_feed);
        down(&mut g);
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
    // The return-home move is real travel: count it in the stats.
    travel += pos.dist(Vec2::ZERO);
    let _ = writeln!(g, "G0 X0 Y0 F{:.0}", profile.travel_feed);
    let _ = writeln!(g, "; end pen {}", pi);

    // No time estimate here: plot time has ONE model (estimatePlanMs, over
    // the toolpath) — a second constant-feed formula drifted from it.
    GcodeJob {
        pen: pi,
        pen_name: pen.name.clone(),
        gcode: g,
        ink_mm: ink,
        travel_mm: travel,
    }
}
