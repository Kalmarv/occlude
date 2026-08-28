//! Toolpath routing passes between chain merging and emission.
//!
//! HARD CONSTRAINT: no pass may draw the same ink twice. Euler routing uses
//! trail decomposition (every edge traversed exactly once — never
//! Eulerianized by duplicating edges), and bridging only spans GAPS smaller
//! than the nib, never overlaps.
//!
//! - `euler_chains` (pre-tour): treat a pen's strokes as a graph — split
//!   strokes where another stroke's endpoint touches them (within
//!   `join_eps`), then walk each connected component in the minimum number
//!   of continuous trails, max(1, odd-degree-nodes / 2). A hatch line
//!   ending on an outline becomes a junction the pen can route through
//!   instead of lifting. Output is flattened (line prims): junction
//!   splitting needs polylines, and the toolpath emitter flattens anyway.
//! - `bridge_chains` (post-tour): consecutive chains whose travel gap is
//!   below `max_gap` (≤ half the nib) are joined pen-down — the nib is
//!   physically wider than the gap, so the bridge is invisible and a full
//!   lift/settle/travel/drop cycle disappears.

use crate::gcode::Chain;
use crate::primitive::{Line, Primitive};
use crate::vec2::Vec2;
use std::collections::HashMap;

/// Join consecutive chains separated by less than `max_gap` (mm). Chains
/// must already be in plot order (post-tour, one pen).
pub fn bridge_chains(chains: Vec<Chain>, max_gap: f64) -> Vec<Chain> {
    let mut out: Vec<Chain> = Vec::with_capacity(chains.len());
    for chain in chains {
        match out.last_mut() {
            Some(prev)
                if !prev.dot && !chain.dot && prev.end().dist(chain.start()) <= max_gap =>
            {
                let gap = prev.end().dist(chain.start());
                if gap > 1e-9 {
                    prev.prims.push(Primitive::Line(Line::new(prev.end(), chain.start())));
                }
                prev.prims.extend(chain.prims);
            }
            _ => out.push(chain),
        }
    }
    out
}

/// One flattened stroke plus bookkeeping for junction cuts.
struct Poly {
    pts: Vec<Vec2>,
    /// (segment index, parameter, point) cut requests from touching strokes.
    cuts: Vec<(usize, f64, Vec2)>,
}

fn flatten_chain(chain: &Chain, tolerance: f64) -> Vec<Vec2> {
    let mut all: Vec<Vec2> = Vec::new();
    let mut pts: Vec<Vec2> = Vec::new();
    for prim in &chain.prims {
        pts.clear();
        prim.flatten(tolerance, &mut pts);
        let skip = usize::from(!all.is_empty());
        all.extend(pts.iter().skip(skip));
    }
    all
}

/// Simple uniform grid over segments for endpoint-touch queries.
struct SegGrid {
    cell: f64,
    cells: HashMap<(i64, i64), Vec<(usize, usize)>>, // (poly, seg)
}

impl SegGrid {
    fn new(cell: f64) -> SegGrid {
        SegGrid { cell, cells: HashMap::new() }
    }
    fn key(&self, p: Vec2) -> (i64, i64) {
        ((p.x / self.cell).floor() as i64, (p.y / self.cell).floor() as i64)
    }
    fn add(&mut self, poly: usize, seg: usize, a: Vec2, b: Vec2) {
        let (x0, x1) = ((a.x.min(b.x) / self.cell).floor() as i64, (a.x.max(b.x) / self.cell).floor() as i64);
        let (y0, y1) = ((a.y.min(b.y) / self.cell).floor() as i64, (a.y.max(b.y) / self.cell).floor() as i64);
        for gx in x0..=x1 {
            for gy in y0..=y1 {
                self.cells.entry((gx, gy)).or_default().push((poly, seg));
            }
        }
    }
    fn near(&self, p: Vec2) -> impl Iterator<Item = (usize, usize)> + '_ {
        let (gx, gy) = self.key(p);
        (-1..=1).flat_map(move |dx| (-1..=1).map(move |dy| (gx + dx, gy + dy)))
            .filter_map(|k| self.cells.get(&k))
            .flatten()
            .copied()
    }
}

fn seg_project(p: Vec2, a: Vec2, b: Vec2) -> (f64, Vec2) {
    let d = b - a;
    let l2 = d.dot(d);
    let t = if l2 > 0.0 { ((p - a).dot(d) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (t, a + d * t)
}

/// Route one pen's chains through their junction graph. Dots pass through.
/// `join_eps` is the touch tolerance: strokes whose endpoints come within
/// it of another stroke are considered to meet there (the endpoint snaps
/// onto the touched stroke, moving ink at most `join_eps` — keep it at or
/// below half the nib). Values below the snap grid disable the pass.
pub fn euler_chains(chains: Vec<Chain>, join_eps: f64, tolerance: f64) -> Vec<Chain> {
    if join_eps < 1e-4 || chains.len() <= 1 {
        return chains;
    }
    let pen = chains[0].pen;
    let mut dots: Vec<Chain> = Vec::new();
    let mut polys: Vec<Poly> = Vec::new();
    for chain in chains {
        if chain.dot {
            dots.push(chain);
        } else {
            let pts = flatten_chain(&chain, tolerance);
            if pts.len() >= 2 {
                polys.push(Poly { pts, cuts: Vec::new() });
            }
        }
    }

    // Index all segments, then record where each stroke's endpoints touch
    // OTHER strokes. The endpoint snaps to the nearest touched point.
    let mut grid = SegGrid::new(join_eps.max(0.5));
    for (pi, poly) in polys.iter().enumerate() {
        for s in 1..poly.pts.len() {
            grid.add(pi, s - 1, poly.pts[s - 1], poly.pts[s]);
        }
    }
    let mut snaps: Vec<(usize, bool, Vec2)> = Vec::new(); // (poly, is_end, new point)
    let mut cuts: Vec<(usize, usize, f64, Vec2)> = Vec::new();
    for (pi, poly) in polys.iter().enumerate() {
        for (is_end, ep) in [(false, poly.pts[0]), (true, *poly.pts.last().unwrap())] {
            let mut best: Option<(f64, usize, usize, f64, Vec2)> = None;
            for (oi, seg) in grid.near(ep) {
                if oi == pi {
                    continue;
                }
                let a = polys[oi].pts[seg];
                let b = polys[oi].pts[seg + 1];
                let (t, proj) = seg_project(ep, a, b);
                let d = ep.dist(proj);
                if d <= join_eps && best.map_or(true, |(bd, ..)| d < bd) {
                    best = Some((d, oi, seg, t, proj));
                }
            }
            if let Some((_, oi, seg, t, proj)) = best {
                snaps.push((pi, is_end, proj));
                cuts.push((oi, seg, t, proj));
            }
        }
    }
    for (pi, is_end, p) in snaps {
        if is_end {
            *polys[pi].pts.last_mut().unwrap() = p;
        } else {
            polys[pi].pts[0] = p;
        }
    }
    for (oi, seg, t, p) in cuts {
        polys[oi].cuts.push((seg, t, p));
    }

    // Split polylines at their cut points → edges of the graph.
    let mut edges: Vec<Vec<Vec2>> = Vec::new();
    for poly in &mut polys {
        poly.cuts.sort_by(|a, b| (a.0, a.1).partial_cmp(&(b.0, b.1)).unwrap());
        let mut cur: Vec<Vec2> = vec![poly.pts[0]];
        let mut cut_iter = poly.cuts.iter().peekable();
        for s in 1..poly.pts.len() {
            while let Some(&&(seg, _, p)) = cut_iter.peek() {
                if seg != s - 1 {
                    break;
                }
                cut_iter.next();
                if p.dist(*cur.last().unwrap()) > 1e-9 {
                    cur.push(p);
                }
                if cur.len() >= 2 {
                    edges.push(std::mem::replace(&mut cur, vec![p]));
                } else {
                    cur = vec![p];
                }
            }
            if poly.pts[s].dist(*cur.last().unwrap()) > 1e-9 {
                cur.push(poly.pts[s]);
            }
        }
        if cur.len() >= 2 {
            edges.push(cur);
        }
    }

    // Node ids by quantized position (snapped coordinates are exact, so a
    // tight grid suffices).
    let q = 1e-6;
    let mut node_of: HashMap<(i64, i64), usize> = HashMap::new();
    let mut node_id = |p: Vec2, n: &mut usize| -> usize {
        *node_of
            .entry(((p.x / q).round() as i64, (p.y / q).round() as i64))
            .or_insert_with(|| {
                let id = *n;
                *n += 1;
                id
            })
    };
    let mut n_nodes = 0usize;
    let ends: Vec<(usize, usize)> = edges
        .iter()
        .map(|e| {
            let a = node_id(e[0], &mut n_nodes);
            let b = node_id(*e.last().unwrap(), &mut n_nodes);
            (a, b)
        })
        .collect();

    // Adjacency: node → (edge id, forward?).
    let mut adj: Vec<Vec<(usize, bool)>> = vec![Vec::new(); n_nodes];
    for (ei, &(a, b)) in ends.iter().enumerate() {
        adj[a].push((ei, true));
        adj[b].push((ei, false));
    }
    let mut used = vec![false; edges.len()];
    let degree: Vec<usize> = adj.iter().map(Vec::len).collect();

    // Trail decomposition in two phases. A stack-splicing Hierholzer is
    // only valid with 0 or 2 odd nodes, so instead:
    // 1. Plain greedy walks from odd nodes (no splicing) — each walk ends
    //    at another odd node by parity and retires both.
    // 2. The remainder has all-even degree: extract cycles, then splice
    //    each cycle into a trail (or earlier cycle) at a genuinely shared
    //    node, rotating the cycle to start there. Continuity is preserved
    //    by construction; a cycle sharing no node is its own component and
    //    stays a standalone closed trail.
    let mut cursor: Vec<usize> = vec![0; n_nodes];
    let mut rem = degree.clone();
    let node_before = |step: &(usize, bool)| if step.1 { ends[step.0].0 } else { ends[step.0].1 };
    let walk = |start: usize,
                used: &mut Vec<bool>,
                cursor: &mut Vec<usize>,
                rem: &mut Vec<usize>|
     -> Vec<(usize, bool)> {
        let mut node = start;
        let mut trail: Vec<(usize, bool)> = Vec::new();
        loop {
            let mut advanced = false;
            while cursor[node] < adj[node].len() {
                let (ei, fwd) = adj[node][cursor[node]];
                cursor[node] += 1;
                if used[ei] {
                    continue;
                }
                used[ei] = true;
                rem[ends[ei].0] -= 1;
                rem[ends[ei].1] -= 1;
                trail.push((ei, fwd));
                node = if fwd { ends[ei].1 } else { ends[ei].0 };
                advanced = true;
                break;
            }
            if !advanced {
                return trail;
            }
        }
    };

    // Each walk starts at a node whose REMAINING degree is odd, and by
    // parity ends at another such node — retiring exactly two per trail.
    // (Restarting from an already-evened node would mint new odd ends and
    // overshoot the bound.)
    let mut trails: Vec<Vec<(usize, bool)>> = Vec::new();
    while let Some(start) = (0..n_nodes).find(|&n| rem[n] % 2 == 1) {
        let t = walk(start, &mut used, &mut cursor, &mut rem);
        if t.is_empty() {
            break; // defensive: parity says this can't happen
        }
        trails.push(t);
    }
    let mut cycles: Vec<Vec<(usize, bool)>> = Vec::new();
    for start in 0..n_nodes {
        loop {
            let t = walk(start, &mut used, &mut cursor, &mut rem);
            if t.is_empty() {
                break;
            }
            cycles.push(t);
        }
    }
    // Splice cycles wherever they share a node with an accepted trail;
    // repeat until no pass makes progress (cycle→cycle→trail chains).
    loop {
        let before = cycles.len();
        if before == 0 {
            break;
        }
        cycles.retain(|cycle| {
            let cycle_nodes: Vec<usize> = cycle.iter().map(node_before).collect();
            for trail in trails.iter_mut() {
                for pos in 0..=trail.len() {
                    let at = if pos < trail.len() {
                        node_before(&trail[pos])
                    } else if let Some(last) = trail.last() {
                        if last.1 { ends[last.0].1 } else { ends[last.0].0 }
                    } else {
                        continue;
                    };
                    if let Some(rot) = cycle_nodes.iter().position(|&n| n == at) {
                        let mut rotated = cycle.clone();
                        rotated.rotate_left(rot);
                        trail.splice(pos..pos, rotated);
                        return false; // spliced — drop from cycles
                    }
                }
            }
            true
        });
        if cycles.len() == before {
            break;
        }
    }
    // Whatever couldn't splice is a standalone closed component.
    trails.extend(cycles);

    let mut out: Vec<Chain> = trails
        .into_iter()
        .map(|t| realize(&edges, &t))
        .map(|pts| Chain {
            prims: pts
                .windows(2)
                .filter(|w| w[0].dist(w[1]) > 1e-9)
                .map(|w| Primitive::Line(Line::new(w[0], w[1])))
                .collect(),
            dot: false,
            pen,
        })
        .filter(|c| !c.prims.is_empty())
        .collect();
    out.extend(dots);
    out
}

/// Expand a trail of (edge, direction) into its point sequence.
fn realize(edges: &[Vec<Vec2>], trail: &[(usize, bool)]) -> Vec<Vec2> {
    let mut pts: Vec<Vec2> = Vec::new();
    for &(ei, fwd) in trail {
        let e = &edges[ei];
        let iter: Box<dyn Iterator<Item = &Vec2>> =
            if fwd { Box::new(e.iter()) } else { Box::new(e.iter().rev()) };
        for p in iter {
            if pts.last().map_or(true, |l| l.dist(*p) > 1e-9) {
                pts.push(*p);
            }
        }
    }
    pts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line_chain(pen: u32, pts: &[(f64, f64)]) -> Chain {
        Chain {
            prims: pts
                .windows(2)
                .map(|w| {
                    Primitive::Line(Line::new(
                        crate::vec2::v(w[0].0, w[0].1),
                        crate::vec2::v(w[1].0, w[1].1),
                    ))
                })
                .collect(),
            dot: false,
            pen,
        }
    }

    fn total_ink(chains: &[Chain]) -> f64 {
        chains.iter().map(Chain::ink_length).sum()
    }

    #[test]
    fn bridge_joins_sub_nib_gaps_only() {
        let chains = vec![
            line_chain(0, &[(0.0, 0.0), (10.0, 0.0)]),
            line_chain(0, &[(10.1, 0.0), (20.0, 0.0)]), // 0.1mm gap → bridge
            line_chain(0, &[(25.0, 0.0), (30.0, 0.0)]), // 5mm gap → keep lift
        ];
        let out = bridge_chains(chains, 0.15);
        assert_eq!(out.len(), 2);
        // The bridge itself is drawn: total ink grows by exactly the gap.
        assert!((total_ink(&out) - (10.0 + 0.1 + 9.9 + 5.0)).abs() < 1e-6);
    }

    #[test]
    fn euler_routes_t_junctions_into_fewer_strokes() {
        // An E shape: a spine with three teeth (two at the spine ends, one
        // mid-spine 0.02mm shy of touching) — 4 strokes today.
        let chains = vec![
            line_chain(0, &[(0.0, 0.0), (0.0, 30.0)]),
            line_chain(0, &[(0.0, 0.0), (10.0, 0.0)]),
            line_chain(0, &[(0.02, 15.0), (10.0, 15.0)]), // 0.02mm shy → joins
            line_chain(0, &[(0.0, 30.0), (10.0, 30.0)]),
        ];
        let before_ink = total_ink(&chains);
        let out = euler_chains(chains, 0.05, 0.01);
        // 4 odd-degree nodes (junction at y=15 and the three tooth tips)
        // → 2 trails (was 4 strokes).
        assert_eq!(out.len(), 2);
        // No double drawing: ink is preserved within the snap distance.
        assert!((total_ink(&out) - before_ink).abs() < 0.1);
    }

    #[test]
    fn euler_closes_a_loop_of_fragments_into_one_stroke() {
        // Four sides of a square as separate strokes sharing corners:
        // all nodes even → a single circuit.
        let chains = vec![
            line_chain(0, &[(0.0, 0.0), (10.0, 0.0)]),
            line_chain(0, &[(10.0, 0.0), (10.0, 10.0)]),
            line_chain(0, &[(10.0, 10.0), (0.0, 10.0)]),
            line_chain(0, &[(0.0, 10.0), (0.0, 0.0)]),
        ];
        let out = euler_chains(chains, 0.05, 0.01);
        assert_eq!(out.len(), 1);
        assert!((total_ink(&out) - 40.0).abs() < 1e-6);
        assert!(out[0].start().dist(out[0].end()) < 1e-6);
    }

    #[test]
    fn euler_never_duplicates_ink() {
        // Dense grid: 5 horizontals × 5 verticals crossing (crossings are
        // NOT junctions — only endpoint touches are). Endpoint-touching
        // frame around it. Ink before == ink after.
        let mut chains = vec![line_chain(0, &[(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0), (0.0, 0.0)])];
        for i in 1..4 {
            let y = i as f64 * 10.0;
            chains.push(line_chain(0, &[(0.0, y), (40.0, y)])); // ends touch frame
        }
        let before = total_ink(&chains);
        let out = euler_chains(chains, 0.05, 0.01);
        assert!((total_ink(&out) - before).abs() < 0.1);
    }

    #[test]
    fn tiny_join_eps_disables_the_pass() {
        let chains = vec![
            line_chain(0, &[(0.0, 0.0), (10.0, 0.0)]),
            line_chain(0, &[(5.0, 0.0), (5.0, 10.0)]),
        ];
        let out = euler_chains(chains.clone(), 0.0, 0.01);
        assert_eq!(out.len(), chains.len());
    }
}
