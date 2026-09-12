//! A conforming adaptive mesh for the sampled distance field. Each leaf is
//! triangulated through every vertex on its boundary, including vertices from
//! finer neighbours. Shared crossings are identified by mesh edge and level;
//! coordinate welding is never used to repair cracks.
use super::*;
use std::collections::BTreeMap;
const RES: u32 = 1 << 22;
#[derive(Clone, Copy)]
struct Sample {
    p: Vec2,
    d: f64,
    id: u64,
}
#[derive(Clone, Copy)]
struct Cell {
    x: u32,
    y: u32,
    size: u32,
}
struct Mesh<'a> {
    field: &'a DistanceIndex,
    bbox: BBox,
    samples: HashMap<u64, Sample>,
}
impl Mesh<'_> {
    fn sample(&mut self, x: u32, y: u32) -> Result<Sample, String> {
        let id = x as u64 + y as u64 * (RES as u64 + 1);
        if let Some(&s) = self.samples.get(&id) {
            return Ok(s);
        }
        if self.samples.len() >= MAX_SAMPLES {
            return Err("contour SDF: adaptive sample budget exceeded".into());
        }
        let p = v(
            self.bbox.min.x + self.bbox.width() * x as f64 / RES as f64,
            self.bbox.min.y + self.bbox.height() * y as f64 / RES as f64,
        );
        let s = Sample {
            p,
            d: self.field.signed(p),
            id,
        };
        self.samples.insert(id, s);
        Ok(s)
    }
    fn corners(&mut self, c: Cell) -> Result<[Sample; 4], String> {
        Ok([
            self.sample(c.x, c.y)?,
            self.sample(c.x + c.size, c.y)?,
            self.sample(c.x + c.size, c.y + c.size)?,
            self.sample(c.x, c.y + c.size)?,
        ])
    }
}
fn triangle(
    a: Sample,
    b: Sample,
    c: Sample,
    first: f64,
    spacing: f64,
    graph: &mut Graph,
    levels: &mut usize,
) -> Result<(), String> {
    let lo = a.d.min(b.d).min(c.d);
    let hi = a.d.max(b.d).max(c.d);
    if hi < first {
        return Ok(());
    }
    let k0 = ((lo - first) / spacing).ceil().max(0.0) as usize;
    let k1 = ((hi - first) / spacing).floor() as usize;
    // Output size, rather than an unrelated 4096 level ceiling, bounds fine
    // spacing. This check also bounds pathological floating-point inputs.
    if k1 > MAX_PRIMITIVES {
        return Err("contour SDF: level output budget exceeded".into());
    }
    for k in k0..=k1 {
        let level = first + k as f64 * spacing;
        let mut hits = [0usize; 2];
        let mut n = 0;
        for (mut p, mut q) in [(a, b), (b, c), (c, a)] {
            if (p.d >= level) == (q.d >= level) {
                continue;
            }
            if p.id > q.id {
                std::mem::swap(&mut p, &mut q);
            }
            let t = ((level - p.d) / (q.d - p.d)).clamp(0.0, 1.0);
            hits[n] = graph.vertex((p.id, q.id, k), p.p.lerp(q.p, t));
            n += 1;
        }
        if n == 2 {
            graph.edge(hits[0], hits[1])?;
            *levels = (*levels).max(k + 1);
        }
    }
    Ok(())
}
pub(super) fn contours(
    field: &DistanceIndex,
    width: f64,
    spacing: f64,
    eps: f64,
) -> Result<(Vec<Vec<Primitive>>, usize), String> {
    let _zone = crate::profile::zone("SDF sample and march");
    let bbox = field.nodes[0].bbox.expanded(width / 4.0);
    let mut mesh = Mesh {
        field,
        bbox,
        samples: HashMap::new(),
    };
    let mut stack = vec![Cell {
        x: 0,
        y: 0,
        size: RES,
    }];
    let mut leaves = Vec::new();
    let first = (width / 2.0 - eps / 2.0).max(width / 4.0);
    while let Some(c) = stack.pop() {
        let corners = mesh.corners(c)?;
        let mid = c.size / 2;
        let center = mesh.sample(c.x + mid, c.y + mid)?;
        let half = corners[0].p.dist(corners[2].p) / 2.0;
        // Signed distance is 1-Lipschitz. This cull cannot discard an unseen
        // island or contour, unlike a corner-only sign test.
        if center.d + half < first {
            continue;
        }
        let mids = [
            mesh.sample(c.x + mid, c.y)?,
            mesh.sample(c.x + c.size, c.y + mid)?,
            mesh.sample(c.x + mid, c.y + c.size)?,
            mesh.sample(c.x, c.y + mid)?,
        ];
        let mut error = (center.d - corners.iter().map(|s| s.d).sum::<f64>() / 4.0).abs();
        for i in 0..4 {
            error = error.max((mids[i].d - (corners[i].d + corners[(i + 1) % 4].d) / 2.0).abs());
        }
        // Boundary cells resolve small holes/fingers even if interpolation
        // samples happen to agree. The error test is an adaptive sampling
        // criterion, not a proof of an exact distance interpolant.
        let boundary = field.intersects(BBox::new(corners[0].p, corners[2].p));
        if c.size > 2
            && (error > (width.min(spacing) / 16.0).max(0.025)
                || (boundary
                    && half > width / 4.0
                    && !field.linear_boundary(BBox::new(corners[0].p, corners[2].p))))
        {
            for (x, y) in [
                (c.x + mid, c.y + mid),
                (c.x, c.y + mid),
                (c.x + mid, c.y),
                (c.x, c.y),
            ] {
                stack.push(Cell { x, y, size: mid });
            }
        } else {
            leaves.push(c);
        }
        if leaves.len() + stack.len() > MAX_SAMPLES / 8 {
            return Err("contour SDF: adaptive cell budget exceeded".into());
        }
    }
    // Index leaf corners along mesh rows/columns. Coarse edges use the same
    // subdivisions as adjacent fine edges, so the triangle mesh is conforming.
    let mut rows: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    let mut cols: BTreeMap<u32, Vec<u32>> = BTreeMap::new();
    for c in &leaves {
        for x in [c.x, c.x + c.size] {
            for y in [c.y, c.y + c.size] {
                rows.entry(y).or_default().push(x);
                cols.entry(x).or_default().push(y);
            }
        }
    }
    for values in rows.values_mut().chain(cols.values_mut()) {
        values.sort_unstable();
        values.dedup();
    }
    let mut graph = Graph::new(field, first, spacing, eps);
    let mut levels = 0;
    for c in leaves {
        let center = mesh.sample(c.x + c.size / 2, c.y + c.size / 2)?;
        for side in 0..4 {
            let horizontal = side % 2 == 0;
            let fixed = match side {
                0 => c.y,
                1 => c.x + c.size,
                2 => c.y + c.size,
                _ => c.x,
            };
            let start = if horizontal { c.x } else { c.y };
            let values = if horizontal {
                &rows[&fixed]
            } else {
                &cols[&fixed]
            };
            let i = values.partition_point(|&v| v < start);
            let end = values.partition_point(|&v| v <= start + c.size);
            for pair in values[i..end].windows(2) {
                let sample = |mesh: &mut Mesh<'_>, q| {
                    if horizontal {
                        mesh.sample(q, fixed)
                    } else {
                        mesh.sample(fixed, q)
                    }
                };
                let a = sample(&mut mesh, pair[0])?;
                let b = sample(&mut mesh, pair[1])?;
                triangle(center, a, b, first, spacing, &mut graph, &mut levels)?;
            }
        }
    }
    #[cfg(feature = "profile")]
    eprintln!(
        "SDF adaptive: {} samples, {} raw edges",
        mesh.samples.len(),
        graph.processed
    );
    Ok((graph.runs()?, levels))
}
