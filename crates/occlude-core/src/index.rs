//! Bbox index over opaque regions. Uniform grid by default; BVH when size
//! variance is high (a few huge occluders + many tiny ones make every grid
//! cell list the huge ones).

use crate::bbox::BBox;

pub enum SpatialIndex {
    Grid(UniformGrid),
    Bvh(Bvh),
}

impl SpatialIndex {
    pub fn build(boxes: &[BBox]) -> SpatialIndex {
        if boxes.len() >= 8 {
            let mut areas: Vec<f64> = boxes.iter().map(|b| b.area()).collect();
            areas.sort_by(|a, b| a.total_cmp(b));
            let median = areas[areas.len() / 2].max(1e-12);
            let max = *areas.last().unwrap();
            if max / median > 64.0 {
                return SpatialIndex::Bvh(Bvh::build(boxes));
            }
            // Overlap-depth heuristic: fat boxes that each span many grid
            // cells make every cell list huge and every query re-scan (and
            // sort) the same candidates hundreds of times — 1500 stacked
            // concentric rings turned queries into 99% of a render. When
            // the average box would occupy many cells, the BVH's
            // O(log n + k) wins regardless of size variance.
            let mut bounds = BBox::EMPTY;
            for b in boxes {
                bounds = bounds.union(b);
            }
            if !bounds.is_empty() {
                let n = boxes.len();
                let target = ((n as f64 / 2.0).sqrt().ceil()).clamp(1.0, 256.0);
                let cell_w = (bounds.width() / target).max(1e-9);
                let cell_h = (bounds.height() / target).max(1e-9);
                let avg_cells: f64 = boxes
                    .iter()
                    .map(|b| {
                        ((b.width() / cell_w).ceil() + 1.0) * ((b.height() / cell_h).ceil() + 1.0)
                    })
                    .sum::<f64>()
                    / n as f64;
                if avg_cells > 8.0 {
                    return SpatialIndex::Bvh(Bvh::build(boxes));
                }
            }
        }
        SpatialIndex::Grid(UniformGrid::build(boxes))
    }

    /// Indices of boxes overlapping `query`, in ascending index order.
    pub fn query(&self, query: &BBox, out: &mut Vec<u32>) {
        out.clear();
        match self {
            SpatialIndex::Grid(g) => g.query(query, out),
            SpatialIndex::Bvh(b) => b.query(query, out),
        }
        out.sort_unstable();
        out.dedup();
    }
}

pub struct UniformGrid {
    bounds: BBox,
    cols: usize,
    rows: usize,
    cell_w: f64,
    cell_h: f64,
    cells: Vec<Vec<u32>>,
    boxes: Vec<BBox>,
}

impl UniformGrid {
    pub fn build(boxes: &[BBox]) -> UniformGrid {
        let mut bounds = BBox::EMPTY;
        for b in boxes {
            bounds = bounds.union(b);
        }
        if bounds.is_empty() {
            bounds = BBox::new(crate::vec2::v(0.0, 0.0), crate::vec2::v(1.0, 1.0));
        }
        // ~2 boxes per cell on average.
        let n = boxes.len().max(1);
        let target = ((n as f64 / 2.0).sqrt().ceil() as usize).clamp(1, 256);
        let cols = target;
        let rows = target;
        let cell_w = (bounds.width() / cols as f64).max(1e-9);
        let cell_h = (bounds.height() / rows as f64).max(1e-9);
        let mut grid = UniformGrid {
            bounds,
            cols,
            rows,
            cell_w,
            cell_h,
            cells: vec![Vec::new(); cols * rows],
            boxes: boxes.to_vec(),
        };
        for (i, b) in boxes.iter().enumerate() {
            if b.is_empty() {
                continue;
            }
            let (x0, y0, x1, y1) = grid.cell_range(b);
            for cy in y0..=y1 {
                for cx in x0..=x1 {
                    grid.cells[cy * cols + cx].push(i as u32);
                }
            }
        }
        grid
    }

    fn cell_range(&self, b: &BBox) -> (usize, usize, usize, usize) {
        let clampx = |v: f64| {
            (((v - self.bounds.min.x) / self.cell_w) as isize).clamp(0, self.cols as isize - 1)
                as usize
        };
        let clampy = |v: f64| {
            (((v - self.bounds.min.y) / self.cell_h) as isize).clamp(0, self.rows as isize - 1)
                as usize
        };
        (
            clampx(b.min.x),
            clampy(b.min.y),
            clampx(b.max.x),
            clampy(b.max.y),
        )
    }

    fn query(&self, q: &BBox, out: &mut Vec<u32>) {
        if !self.bounds.overlaps(q) {
            return;
        }
        let (x0, y0, x1, y1) = self.cell_range(q);
        for cy in y0..=y1 {
            for cx in x0..=x1 {
                for &i in &self.cells[cy * self.cols + cx] {
                    if self.boxes[i as usize].overlaps(q) {
                        out.push(i);
                    }
                }
            }
        }
    }
}

pub struct Bvh {
    nodes: Vec<BvhNode>,
    boxes: Vec<BBox>,
    order: Vec<u32>,
}

struct BvhNode {
    bbox: BBox,
    /// Leaf: (start, count) into `order`; internal: children are
    /// (self_index + 1) and `right`.
    right: u32,
    start: u32,
    count: u32,
}

impl Bvh {
    pub fn build(boxes: &[BBox]) -> Bvh {
        let mut order: Vec<u32> = (0..boxes.len() as u32).collect();
        let mut bvh = Bvh {
            nodes: Vec::with_capacity(boxes.len() * 2),
            boxes: boxes.to_vec(),
            order: Vec::new(),
        };
        if !boxes.is_empty() {
            bvh.build_node(&mut order, 0, boxes.len());
            // `order` is baked into the leaves via start/count over this vec.
            bvh.order = order;
        }
        bvh
    }

    fn build_node(&mut self, order: &mut [u32], start: usize, _len: usize) -> u32 {
        let node_idx = self.nodes.len() as u32;
        let mut bbox = BBox::EMPTY;
        for &i in order.iter() {
            bbox = bbox.union(&self.boxes[i as usize]);
        }
        if order.len() <= 4 {
            self.nodes.push(BvhNode {
                bbox,
                right: 0,
                start: start as u32,
                count: order.len() as u32,
            });
            return node_idx;
        }
        // Split on the wider axis at the median of centers.
        let wide_x = bbox.width() >= bbox.height();
        order.sort_by(|&a, &b| {
            let ca = self.boxes[a as usize].center();
            let cb = self.boxes[b as usize].center();
            let (va, vb) = if wide_x { (ca.x, cb.x) } else { (ca.y, cb.y) };
            va.total_cmp(&vb)
        });
        let mid = order.len() / 2;
        self.nodes.push(BvhNode {
            bbox,
            right: 0,
            start: u32::MAX,
            count: 0,
        });
        let (left_slice, right_slice) = order.split_at_mut(mid);
        self.build_node(left_slice, start, mid);
        let right_idx = self.build_node(right_slice, start + mid, right_slice.len());
        self.nodes[node_idx as usize].right = right_idx;
        node_idx
    }

    fn query(&self, q: &BBox, out: &mut Vec<u32>) {
        if self.nodes.is_empty() {
            return;
        }
        let mut stack = vec![0u32];
        while let Some(ni) = stack.pop() {
            let node = &self.nodes[ni as usize];
            if !node.bbox.overlaps(q) {
                continue;
            }
            if node.start != u32::MAX {
                for k in node.start..node.start + node.count {
                    let i = self.order[k as usize];
                    if self.boxes[i as usize].overlaps(q) {
                        out.push(i);
                    }
                }
            } else {
                stack.push(ni + 1);
                stack.push(node.right);
            }
        }
    }
}
