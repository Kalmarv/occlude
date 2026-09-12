use super::BBox;
#[cfg(test)]
use super::Vec2;
use crate::index::SpatialIndex;
use std::collections::BTreeMap;

/// A single surviving loop at each level gives an unambiguous family. Each
/// next loop is scanned once, split at its nearest exact primitive projection,
/// and traversed completely from that one entry/exit portal. Branching levels
/// use an indexed local pass; no all-pairs graph or repeated lap is introduced.
pub(super) fn join(
    mut rings: Vec<Vec<super::Primitive>>,
    levels: &[usize],
    spacing: f64,
    certify: &dyn Fn(&super::Primitive) -> bool,
    diagnostics: &mut super::Diagnostics,
) -> Vec<Vec<super::Primitive>> {
    use super::{Line, Primitive};
    let mut order: Vec<_> = (0..rings.len()).collect();
    order.sort_by_key(|&i| levels[i]);
    if order.windows(2).any(|p| levels[p[0]] == levels[p[1]]) {
        return join_branching_families(rings, levels, spacing, certify, diagnostics, 32_768);
    }
    let mut result = Vec::new();
    let mut run: Vec<Primitive> = Vec::new();
    let mut previous_level = None;
    for i in order {
        let ring = std::mem::take(&mut rings[i]);
        if ring.is_empty() {
            continue;
        }
        if let Some(previous) = run.last() {
            let portal = previous.end();
            let mut closest = (f64::INFINITY, 0, 0.);
            for (j, p) in ring.iter().enumerate() {
                let (t, q) = super::super::closest(p, portal);
                let distance = portal.dist(q);
                if distance < closest.0 {
                    closest = (distance, j, t);
                }
            }
            if previous_level == levels[i].checked_sub(1) && closest.0 <= 2. * spacing {
                let entered = super::super::enter_loop(&ring, closest.1, closest.2);
                let connector = Primitive::Line(Line::new(portal, entered[0].start()));
                diagnostics.connector_tests += 1;
                if certify(&connector) {
                    if connector.length() > 0. {
                        run.push(connector);
                        diagnostics.connectors += 1;
                    }
                    run.extend(entered);
                    previous_level = Some(levels[i]);
                    continue;
                }
            }
            result.push(std::mem::take(&mut run));
        }
        run = ring;
        previous_level = Some(levels[i]);
    }
    if !run.is_empty() {
        result.push(run);
    }
    result
}

/// Index only the next level's primitives, then release that index. Portals
/// propagate forward, so an entered loop always exits at the same point after
/// one complete lap. At splits, one child continues; the others start runs.
fn join_branching_families(
    mut rings: Vec<Vec<super::Primitive>>,
    levels: &[usize],
    spacing: f64,
    certify: &dyn Fn(&super::Primitive) -> bool,
    diagnostics: &mut super::Diagnostics,
    portal_budget: usize,
) -> Vec<Vec<super::Primitive>> {
    use super::{Line, Primitive};
    let mut groups = BTreeMap::<usize, Vec<usize>>::new();
    for (i, &level) in levels.iter().enumerate() {
        if !rings[i].is_empty() {
            groups.entry(level).or_default().push(i);
        }
    }
    let mut portals = vec![(0usize, 0.0_f64); rings.len()];
    let mut predecessor = vec![false; rings.len()];
    let mut successor = vec![None; rings.len()];
    let mut hits = Vec::new();
    let mut work = 0usize;
    let mut visited_portals = 0usize;
    // Running out of routing work leaves additional complete runs, never
    // incomplete coverage. The cutoff is deterministic, not elapsed time.
    'levels: for (&level, parents) in &groups {
        let Some(children) = groups.get(&(level + 1)) else {
            continue;
        };
        let mut entries = Vec::new();
        let mut boxes = Vec::new();
        for &child in children {
            for (segment, p) in rings[child].iter().enumerate() {
                entries.push((child, segment));
                boxes.push(p.bbox());
            }
        }
        let index = SpatialIndex::build(&boxes);
        for &parent in parents {
            // Routing adds optional ink only: residual coverage was resolved
            // before this pass. Bound portal searches as well as projections,
            // so hundreds of thousands of tiny loops cannot spend the browser
            // deadline on otherwise cheap individual connector certificates.
            if visited_portals == portal_budget {
                break 'levels;
            }
            visited_portals += 1;
            let ring = &rings[parent];
            let (segment, t) = portals[parent];
            // Match enter_loop's actual last primitive, including floating
            // endpoint evaluation, rather than invent a nearly shared point.
            let last = if t > 0. {
                ring[segment].sub(0., t)
            } else {
                ring[(segment + ring.len() - 1) % ring.len()]
            };
            let from = last.end();
            let heading = super::super::tangent(&last, 1.).normalized();
            index.query(
                &BBox::from_points(&[from]).expanded(2. * spacing),
                &mut hits,
            );
            let mut candidates = Vec::new();
            for &id in &hits {
                work += 1;
                if work > 8_000_000 {
                    break 'levels;
                }
                let (child, segment) = entries[id as usize];
                if predecessor[child] {
                    continue;
                }
                let p = rings[child][segment];
                let (t, _) = super::super::closest(&p, from);
                let first = if t < 1. {
                    p.sub(t, 1.)
                } else {
                    rings[child][(segment + 1) % rings[child].len()]
                };
                let to = first.start();
                let distance = from.dist(to);
                if distance > 2. * spacing {
                    continue;
                }
                let direction = (to - from).normalized();
                let turn = 2.
                    - heading.dot(direction)
                    - direction.dot(super::super::tangent(&first, 0.).normalized());
                candidates.push((distance, turn, child, segment, t, to));
            }
            candidates.sort_by(|a, b| {
                a.0.total_cmp(&b.0)
                    .then(a.1.total_cmp(&b.1))
                    .then(a.2.cmp(&b.2))
                    .then(a.3.cmp(&b.3))
                    .then(a.4.total_cmp(&b.4))
            });
            for (_, _, child, segment, t, to) in candidates.into_iter().take(64) {
                let connector = Primitive::Line(Line::new(from, to));
                diagnostics.connector_tests += 1;
                if !certify(&connector) {
                    continue;
                }
                portals[child] = (segment, t);
                predecessor[child] = true;
                successor[parent] = Some((child, connector));
                if connector.length() > 0. {
                    diagnostics.connectors += 1;
                }
                break;
            }
        }
    }
    let mut result = Vec::new();
    for ids in groups.values() {
        for &root in ids {
            if predecessor[root] {
                continue;
            }
            let mut run = Vec::new();
            let mut current = root;
            loop {
                let (segment, t) = portals[current];
                let mut lap = enter_owned(std::mem::take(&mut rings[current]), segment, t);
                if run.is_empty() {
                    run = lap;
                } else {
                    run.append(&mut lap);
                }
                let Some((next, connector)) = successor[current] else {
                    break;
                };
                if connector.length() > 0. {
                    run.push(connector);
                }
                current = next;
            }
            result.push(run);
        }
    }
    result
}

/// Match enter_loop's endpoint evaluations while transferring the original
/// storage. Large branching fills should not keep a second copy of every lap.
fn enter_owned(mut ring: Vec<super::Primitive>, segment: usize, t: f64) -> Vec<super::Primitive> {
    let p = ring[segment];
    if t < 1. {
        ring.rotate_left(segment);
        ring[0] = p.sub(t, 1.);
        if t > 0. {
            ring.push(p.sub(0., t));
        }
    } else {
        let n = ring.len();
        ring.rotate_left((segment + 1) % n);
        ring[n - 1] = p.sub(0., t);
    }
    ring
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::primitive::{Line, Primitive};
    fn ring(points: &[[f64; 2]]) -> Vec<Primitive> {
        points
            .iter()
            .zip(points.iter().cycle().skip(1))
            .take(points.len())
            .map(|(a, b)| {
                Primitive::Line(Line::new(
                    Vec2 { x: a[0], y: a[1] },
                    Vec2 { x: b[0], y: b[1] },
                ))
            })
            .collect()
    }
    #[test]
    fn exhausted_routing_budget_preserves_every_unjoined_lap() {
        let rings = vec![
            ring(&[[0., 0.], [10., 0.], [10., 10.], [0., 10.]]),
            ring(&[[1., 1.], [4., 1.], [4., 4.], [1., 4.]]),
            ring(&[[6., 6.], [9., 6.], [9., 9.], [6., 9.]]),
        ];
        let mut diagnostics = super::super::Diagnostics::default();
        let result = join_branching_families(
            rings.clone(),
            &[0, 1, 1],
            1.,
            &|_| panic!("no certificate after budget"),
            &mut diagnostics,
            0,
        );
        assert_eq!(result.len(), rings.len());
        for (actual, expected) in result.iter().zip(&rings) {
            assert_eq!(actual.len(), expected.len());
            for (a, b) in actual.iter().zip(expected) {
                assert_eq!(a.start(), b.start());
                assert_eq!(a.end(), b.end());
                assert_eq!(a.length(), b.length());
            }
            assert_eq!(
                actual.first().unwrap().start(),
                actual.last().unwrap().end()
            );
        }
        assert_eq!(diagnostics.connectors, 0);
        assert_eq!(diagnostics.connector_tests, 0);
    }

    #[test]
    fn split_families_draw_each_lap_once_and_keep_one_portal() {
        let rings = vec![
            ring(&[[0., 2.], [0., 0.], [10., 0.], [10., 4.], [0., 4.]]),
            ring(&[[1., 1.], [4., 1.], [4., 3.], [1., 3.]]),
            ring(&[[6., 1.], [9., 1.], [9., 3.], [6., 3.]]),
            ring(&[[1.5, 1.3], [3.5, 1.3], [3.5, 2.7], [1.5, 2.7]]),
            ring(&[[6.5, 1.3], [8.5, 1.3], [8.5, 2.7], [6.5, 2.7]]),
        ];
        let original: f64 = rings.iter().flatten().map(Primitive::length).sum();
        let mut diagnostics = super::super::Diagnostics::default();
        let result = join(rings, &[0, 1, 1, 2, 2], 1., &|_| true, &mut diagnostics);
        assert_eq!(result.len(), 2, "the unselected child starts its own run");
        assert_eq!(diagnostics.connectors, 3);
        for run in &result {
            for pair in run.windows(2) {
                assert_eq!(pair[0].end(), pair[1].start());
            }
        }
        // One horizontal connection into the middle of the left edge, one
        // horizontal continuation, and one diagonal on the separate branch.
        let connectors = 1. + 0.5 + 0.5_f64.hypot(0.3);
        let actual: f64 = result.iter().flatten().map(Primitive::length).sum();
        assert!(
            (actual - original - connectors).abs() < 1e-10,
            "no extra partial or full lap: {actual} vs {original}+{connectors}"
        );
    }
}
