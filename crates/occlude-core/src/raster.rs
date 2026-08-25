//! PNG rasterisation of fragments — the preview a machine can look at.
//!
//! Deliberately simple: fragments are flattened to polylines and stroked by
//! stamping anti-aliased discs at sub-pixel steps (round caps and joins for
//! free, exactly how a pen nib lays ink). Quality is plenty for previews,
//! debugging, and sharing; SVG remains the exact export.

use crate::fragment::Frag;
use crate::pipeline::Pen;
use crate::vec2::Vec2;

pub struct RasterOptions {
    /// Paper size in mm.
    pub width_mm: f64,
    pub height_mm: f64,
    /// Pixels per mm.
    pub scale: f64,
    /// RGB background; None = white.
    pub background: Option<[u8; 3]>,
}

fn parse_hex(color: &str) -> [u8; 3] {
    let c = color.trim_start_matches('#');
    if c.len() == 6 {
        if let Ok(v) = u32::from_str_radix(c, 16) {
            return [(v >> 16) as u8, (v >> 8) as u8, v as u8];
        }
    }
    [17, 17, 17]
}

struct Canvas {
    w: usize,
    h: usize,
    /// RGB, row-major.
    px: Vec<u8>,
}

impl Canvas {
    fn new(w: usize, h: usize, bg: [u8; 3]) -> Canvas {
        let mut px = Vec::with_capacity(w * h * 3);
        for _ in 0..w * h {
            px.extend_from_slice(&bg);
        }
        Canvas { w, h, px }
    }

    /// Stamp an anti-aliased disc of `color` at centre (cx, cy), radius r px.
    fn disc(&mut self, cx: f64, cy: f64, r: f64, color: [u8; 3]) {
        let x0 = ((cx - r - 1.0).floor().max(0.0)) as usize;
        let y0 = ((cy - r - 1.0).floor().max(0.0)) as usize;
        let x1 = ((cx + r + 1.0).ceil().min(self.w as f64 - 1.0)) as usize;
        let y1 = ((cy + r + 1.0).ceil().min(self.h as f64 - 1.0)) as usize;
        if x0 > x1 || y0 > y1 {
            return;
        }
        for y in y0..=y1 {
            for x in x0..=x1 {
                let d = ((x as f64 + 0.5 - cx).powi(2) + (y as f64 + 0.5 - cy).powi(2)).sqrt();
                // 1px anti-aliasing ramp at the rim.
                let cov = (r - d + 0.5).clamp(0.0, 1.0);
                if cov <= 0.0 {
                    continue;
                }
                let i = (y * self.w + x) * 3;
                for k in 0..3 {
                    let old = self.px[i + k] as f64;
                    let new = color[k] as f64;
                    // Ink is opaque: blend only the AA rim, and never
                    // lighten already-inked pixels (overlapping stamps of
                    // the same stroke must not leave seams).
                    let blended = old + (new - old) * cov;
                    self.px[i + k] = blended.min(old.max(new)).max(old.min(new)) as u8;
                }
            }
        }
    }
}

/// Render fragments to an RGB pixel buffer.
pub fn rasterize(frags: &[Frag], pens: &[Pen], opts: &RasterOptions) -> (usize, usize, Vec<u8>) {
    let w = (opts.width_mm * opts.scale).ceil().max(1.0) as usize;
    let h = (opts.height_mm * opts.scale).ceil().max(1.0) as usize;
    let mut canvas = Canvas::new(w, h, opts.background.unwrap_or([255, 255, 255]));
    let mut pts: Vec<Vec2> = Vec::new();
    for f in frags {
        let pen = pens.get(f.pen as usize);
        let color = parse_hex(pen.map(|p| p.color.as_str()).unwrap_or("#111111"));
        let r_px = (pen.map(|p| p.width).unwrap_or(0.3) * 0.5 * opts.scale).max(0.6);
        if f.dot {
            let p = f.geom.start();
            canvas.disc(p.x * opts.scale, p.y * opts.scale, r_px, color);
            continue;
        }
        pts.clear();
        // Flatten to ~quarter-pixel tolerance, stamp along each segment at
        // sub-radius steps so the stroke is solid.
        f.geom.flatten(0.25 / opts.scale, &mut pts);
        for pair in pts.windows(2) {
            let a = pair[0] * opts.scale;
            let b = pair[1] * opts.scale;
            let len = a.dist(b);
            let steps = (len / (r_px * 0.5).max(0.5)).ceil().max(1.0) as usize;
            for s in 0..=steps {
                let p = a.lerp(b, s as f64 / steps as f64);
                canvas.disc(p.x, p.y, r_px, color);
            }
        }
    }
    (w, h, canvas.px)
}

/// Render fragments straight to an encoded PNG.
pub fn to_png(frags: &[Frag], pens: &[Pen], opts: &RasterOptions) -> Vec<u8> {
    let (w, h, px) = rasterize(frags, pens, opts);
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().expect("png header");
        writer.write_image_data(&px).expect("png data");
    }
    out
}
