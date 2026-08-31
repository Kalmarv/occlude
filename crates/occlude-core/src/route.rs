//! Toolpath routing passes between the tour and emission.
//!
//! HARD CONSTRAINT: no pass may draw the same ink twice. Bridging only
//! spans GAPS smaller than the nib, never overlaps.
//!
//! (An Euler junction-chaining pass lived here briefly — measured at −5.6%
//! pen lifts on the sketch corpus and removed as not worth the complexity;
//! fills are inset from outlines by more than nib/2, which caps what
//! junction routing can reach. See `pnpm --filter occlude plotstats` for
//! the measurement tool.)

use crate::gcode::Chain;
use crate::primitive::{Line, Primitive};

/// Join consecutive chains separated by less than `max_gap` (mm) pen-down —
/// the nib is physically wider than the gap, so the bridge is invisible and
/// a full lift/settle/travel/drop cycle disappears. Chains must already be
/// in plot order (post-tour, one pen).
pub fn bridge_chains(chains: Vec<Chain>, max_gap: f64) -> Vec<Chain> {
    let mut out: Vec<Chain> = Vec::with_capacity(chains.len());
    for chain in chains {
        match out.last_mut() {
            Some(prev) if !prev.dot && !chain.dot && prev.end().dist(chain.start()) <= max_gap => {
                let gap = prev.end().dist(chain.start());
                if gap > 1e-9 {
                    prev.prims
                        .push(Primitive::Line(Line::new(prev.end(), chain.start())));
                }
                prev.prims.extend(chain.prims);
            }
            _ => out.push(chain),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vec2::v;

    fn line_chain(pen: u32, pts: &[(f64, f64)]) -> Chain {
        Chain {
            prims: pts
                .windows(2)
                .map(|w| Primitive::Line(Line::new(v(w[0].0, w[0].1), v(w[1].0, w[1].1))))
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
}
