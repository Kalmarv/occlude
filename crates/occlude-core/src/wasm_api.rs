//! WASM boundary. One call per render with the whole recording buffer — no
//! per-shape FFI (spec, Layer 1).
//!
//! ## Buffer protocol (all little-endian typed arrays from JS)
//!
//! `prims: Float64Array`, stride 9 per primitive:
//!   [kind, ...8 params]
//!   kind 0 line:  p0x p0y p1x p1y  _ _ _ _
//!   kind 1 arc:   cx cy r start sweep  _ _ _
//!   kind 2 cubic: p0x p0y c0x c0y c1x c1y p1x p1y
//!
//! `contours: Uint32Array`, stride 2: [prim_start, prim_count]
//!
//! `shapes_u32: Uint32Array`, stride 12:
//!   [contour_start, contour_count, flags, stroke_pen+1, fill_pen+1,
//!    fill_kind, clip_start, clip_count, fill_start, fill_count,
//!    mod_start, mod_count]
//!   flags: bit0 closed, bit1 convex, bit2 even-odd winding
//!   fill_kind: 0 none, 1 hatch, 2 stipple, 3 custom
//!   hatch:   fill params = fill_count triplets (angle°, spacing, offset)
//!            starting at fill_params[fill_start]
//!   stipple: fill params = (density, min_dist)
//!   custom:  [fill_start, fill_start+fill_count) is a range of PRIMS
//!            (custom fill geometry recorded straight into the prim table)
//!   mod_start/mod_count: this shape's modifier program — mod_count
//!            instructions starting at f64 offset mod_start in `mods`.
//!
//! `shapes_f64: Float64Array`, stride 1: [z]
//!
//! `mods: Float64Array` — the modifier tape. Each instruction is
//!   [opcode, field_mask, ...params] with a fixed param count per opcode;
//!   field_mask bit k set means param k is an index into `fields` instead
//!   of a literal. Opcodes (post-stage):
//!     1 decimate: params [stroke_p, fill_p]
//!     2 wobble:   params [amp_mm, wavelength_mm] (wavelength never a field)
//!     3 dash:     params [len_mm, gap_mm, offset_mm]
//!   Opcodes (pre-stage — deform contours before the solve):
//!     4 smooth:   params [passes]
//!     5 roughen:  params [amp_mm, detail_mm]
//!     6 deform:   params [dx_field, dy_field, detail_mm] (dx/dy always
//!                 field refs; mask bits 0 and 1 must be set)
//!
//! `fields: Float64Array` — rasterised scalar fields, concatenated:
//!   each field is [w, h, x0, y0, dx, dy, ...w*h row-major samples] in
//!   paper mm; `Param::Field(i)` refers to the i-th field in order.
//!
//! `clip_list: Uint32Array`: clip region indices, sliced per shape by
//!   clip_start/clip_count.
//!
//! `clips_u32: Uint32Array`, stride 3: [contour_start, contour_count, flags]
//!
//! Output `frags: Float64Array`, stride 6:
//!   [origin_prim, t0, t1, pen, shape, flags(bit0 dot)]
//! plus the full primitive table (input prims + generated fill prims) in the
//! same stride-9 encoding, so the preview can draw exact curves.

use crate::bbox::BBox;
use crate::fill::{FillKind, HatchPass};
use crate::gcode::{export_gcode, MachineProfile};
use crate::modifier::{FieldGrid, Modifier, Param};
use crate::pipeline::{render, ClipDef, Pen, RenderInput, ShapeRec};
use crate::primitive::{Arc, Cubic, Line, Primitive};
use crate::region::WindingRule;
use crate::svg::{to_svg, SvgOptions};
use crate::vec2::v;
use wasm_bindgen::prelude::*;

pub const PRIM_STRIDE: usize = 9;
pub const FRAG_STRIDE: usize = 6;
pub const SHAPE_U32_STRIDE: usize = 12;

/// Decode one shape's modifier program from the tape. Fails loudly on an
/// unknown opcode — a positional misread must never render as garbage.
fn decode_modifiers(mods: &[f64], start: usize, count: usize) -> Result<Vec<Modifier>, String> {
    let mut out = Vec::with_capacity(count);
    let mut i = start;
    for _ in 0..count {
        let op = *mods.get(i).ok_or("modifier tape truncated")? as u32;
        let mask = *mods.get(i + 1).ok_or("modifier tape truncated")? as u32;
        let nparams = match op {
            1 | 2 | 5 => 2,
            4 => 1,
            3 | 6 => 3,
            _ => return Err(format!("unknown modifier opcode {op}")),
        };
        let param = |k: usize| -> Result<Param, String> {
            let raw = *mods.get(i + 2 + k).ok_or("modifier tape truncated")?;
            Ok(if mask & (1 << k) != 0 {
                Param::Field(raw as u32)
            } else {
                Param::Lit(raw)
            })
        };
        let lit = |k: usize, what: &str| -> Result<f64, String> {
            param(k)?.literal().ok_or(format!("{what} cannot be a field"))
        };
        out.push(match op {
            1 => Modifier::Decimate {
                stroke: param(0)?,
                fill: param(1)?,
            },
            2 => Modifier::Wobble {
                amp: param(0)?,
                wavelength: lit(1, "wobble wavelength")?,
            },
            3 => Modifier::Dash {
                len: lit(0, "dash length")?,
                gap: lit(1, "dash gap")?,
                offset: lit(2, "dash offset")?,
            },
            4 => Modifier::Smooth {
                passes: (lit(0, "smooth passes")? as u32).min(8),
            },
            5 => Modifier::Roughen {
                amp: param(0)?,
                detail: lit(1, "roughen detail")?,
            },
            _ => Modifier::Deform {
                dx: param(0)?,
                dy: param(1)?,
                detail: lit(2, "deform detail")?,
            },
        });
        i += 2 + nparams;
    }
    Ok(out)
}

/// Decode the concatenated field rasters buffer.
fn decode_fields(fields: &[f64]) -> Result<Vec<FieldGrid>, String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < fields.len() {
        if i + 6 > fields.len() {
            return Err("field buffer truncated".into());
        }
        let (w, h) = (fields[i] as usize, fields[i + 1] as usize);
        let n = w * h;
        if i + 6 + n > fields.len() {
            return Err("field samples truncated".into());
        }
        out.push(FieldGrid {
            w,
            h,
            x0: fields[i + 2],
            y0: fields[i + 3],
            dx: fields[i + 4],
            dy: fields[i + 5],
            samples: fields[i + 6..i + 6 + n].to_vec(),
        });
        i += 6 + n;
    }
    Ok(out)
}

fn decode_prim(row: &[f64]) -> Primitive {
    match row[0] as u32 {
        0 => Primitive::Line(Line::new(v(row[1], row[2]), v(row[3], row[4]))),
        1 => Primitive::Arc(Arc::new(v(row[1], row[2]), row[3], row[4], row[5])),
        _ => Primitive::Cubic(Cubic::new(
            v(row[1], row[2]),
            v(row[3], row[4]),
            v(row[5], row[6]),
            v(row[7], row[8]),
        )),
    }
}

fn encode_prim(p: &Primitive, out: &mut Vec<f64>) {
    match p {
        Primitive::Line(l) => {
            out.extend_from_slice(&[0.0, l.p0.x, l.p0.y, l.p1.x, l.p1.y, 0.0, 0.0, 0.0, 0.0])
        }
        Primitive::Arc(a) => out.extend_from_slice(&[
            1.0, a.center.x, a.center.y, a.r, a.start, a.sweep, 0.0, 0.0, 0.0,
        ]),
        Primitive::Cubic(c) => out.extend_from_slice(&[
            2.0, c.p0.x, c.p0.y, c.c0.x, c.c0.y, c.c1.x, c.c1.y, c.p1.x, c.p1.y,
        ]),
    }
}

fn decode_prims(prims: &[f64]) -> Vec<Primitive> {
    prims.chunks_exact(PRIM_STRIDE).map(decode_prim).collect()
}

fn contours_of(
    contour_start: usize,
    contour_count: usize,
    contours: &[u32],
    table: &[Primitive],
) -> Result<Vec<Vec<Primitive>>, String> {
    let end = contour_start
        .checked_add(contour_count)
        .filter(|&e| e * 2 <= contours.len())
        .ok_or("contour range out of bounds")?;
    (contour_start..end)
        .map(|ci| {
            let ps = contours[ci * 2] as usize;
            let pc = contours[ci * 2 + 1] as usize;
            let pe = ps.checked_add(pc).filter(|&e| e <= table.len())
                .ok_or("contour primitive range out of bounds")?;
            Ok(table[ps..pe].to_vec())
        })
        .collect()
}

#[wasm_bindgen]
pub struct RenderResult {
    prims: Vec<f64>,
    frags: Vec<f64>,
    stats: Vec<f64>,
}

#[wasm_bindgen]
impl RenderResult {
    #[wasm_bindgen(getter)]
    pub fn prims(&self) -> Vec<f64> {
        self.prims.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn frags(&self) -> Vec<f64> {
        self.frags.clone()
    }
    /// [shapes_in, culled_off_paper, culled_contained, clean, fragments,
    ///  fill_prims]
    #[wasm_bindgen(getter)]
    pub fn stats(&self) -> Vec<f64> {
        self.stats.clone()
    }
}

#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn wasm_render(
    prims: &[f64],
    contours: &[u32],
    shapes_u32: &[u32],
    shapes_f64: &[f64],
    mods: &[f64],
    field_data: &[f64],
    fill_params: &[f64],
    clip_list: &[u32],
    clips_u32: &[u32],
    pens_json: &str,
    paper: &[f64],
    seed: u32,
    coarsen: f64,
) -> Result<RenderResult, JsValue> {
    let err = |m: &str| JsValue::from_str(m);
    if prims.len() % PRIM_STRIDE != 0 {
        return Err(err("prims buffer not a multiple of the stride"));
    }
    if shapes_u32.len() % SHAPE_U32_STRIDE != 0 {
        return Err(err("shapes_u32 buffer not a multiple of the stride"));
    }
    if clips_u32.len() % 3 != 0 || contours.len() % 2 != 0 {
        return Err(err("clip/contour buffer not a multiple of the stride"));
    }
    if prims.iter().any(|v| !v.is_finite()) {
        return Err(err("non-finite value in prims buffer"));
    }
    if paper.iter().any(|v| !v.is_finite()) {
        return Err(err("non-finite paper bounds"));
    }
    let table = decode_prims(prims);
    let pens: Vec<Pen> = serde_json::from_str(pens_json)
        .map_err(|e| JsValue::from_str(&format!("bad pens json: {e}")))?;
    let fields = decode_fields(field_data).map_err(|e| JsValue::from_str(&e))?;

    let n = shapes_u32.len() / SHAPE_U32_STRIDE;
    if shapes_f64.len() < n {
        return Err(err("shapes_f64 shorter than shape count"));
    }
    let mut shapes = Vec::with_capacity(n);
    for i in 0..n {
        let s = &shapes_u32[i * SHAPE_U32_STRIDE..(i + 1) * SHAPE_U32_STRIDE];
        let flags = s[2];
        let closed = flags & 1 != 0;
        let winding = if flags & 4 != 0 {
            WindingRule::EvenOdd
        } else {
            WindingRule::NonZero
        };
        if s[4] == 0 && (1..=3).contains(&s[5]) {
            return Err(err("fill kind set without a fill pen"));
        }
        let fill = match s[5] {
            1 => {
                let start = s[8] as usize;
                let count = s[9] as usize;
                if start.checked_add(count.checked_mul(3).ok_or(err("hatch params overflow"))?)
                    .filter(|&e| e <= fill_params.len())
                    .is_none()
                {
                    return Err(err("hatch params out of bounds"));
                }
                let passes = (0..count)
                    .map(|k| HatchPass {
                        angle: fill_params[start + k * 3],
                        spacing: fill_params[start + k * 3 + 1],
                        offset: fill_params[start + k * 3 + 2],
                    })
                    .collect();
                Some((s[4] - 1, FillKind::Hatch(passes)))
            }
            2 => {
                let start = s[8] as usize;
                if start + 2 > fill_params.len() {
                    return Err(err("stipple params out of bounds"));
                }
                Some((
                    s[4] - 1,
                    FillKind::Stipple {
                        density: fill_params[start],
                        min_dist: fill_params[start + 1],
                    },
                ))
            }
            3 => {
                let start = s[8] as usize;
                let count = s[9] as usize;
                let end = start.checked_add(count).filter(|&e| e <= table.len())
                    .ok_or(err("custom fill prims out of bounds"))?;
                Some((s[4] - 1, FillKind::Custom(table[start..end].to_vec())))
            }
            4 => Some((s[4] - 1, FillKind::Mask)),
            _ => None,
        };
        let clip_end = (s[6] as usize)
            .checked_add(s[7] as usize)
            .filter(|&e| e <= clip_list.len())
            .ok_or(err("clip list range out of bounds"))?;
        shapes.push(ShapeRec {
            contours: contours_of(s[0] as usize, s[1] as usize, contours, &table)
                .map_err(|e| JsValue::from_str(&e))?,
            closed,
            convex: flags & 2 != 0,
            winding,
            stroke: if s[3] > 0 { Some(s[3] - 1) } else { None },
            fill,
            z: shapes_f64[i],
            clips: clip_list[s[6] as usize..clip_end].to_vec(),
            modifiers: decode_modifiers(mods, s[10] as usize, s[11] as usize)
                .map_err(|e| JsValue::from_str(&e))?,
        });
    }

    let clips: Vec<ClipDef> = clips_u32
        .chunks_exact(3)
        .map(|c| {
            Ok(ClipDef {
                contours: contours_of(c[0] as usize, c[1] as usize, contours, &table)?,
                winding: if c[2] & 4 != 0 {
                    WindingRule::EvenOdd
                } else {
                    WindingRule::NonZero
                },
                convex: c[2] & 2 != 0,
            })
        })
        .collect::<Result<_, String>>()
        .map_err(|e| JsValue::from_str(&e))?;

    let paper_box = if paper.len() == 4 {
        Some(BBox::new(v(paper[0], paper[1]), v(paper[2], paper[3])))
    } else {
        None
    };

    let out = render(&RenderInput {
        shapes,
        clips,
        pens,
        paper: paper_box,
        seed: seed as u64,
        coarsen,
        fields,
    });

    let mut prims_out = Vec::with_capacity(out.prims.len() * PRIM_STRIDE);
    for p in &out.prims {
        encode_prim(p, &mut prims_out);
    }
    let mut frags_out = Vec::with_capacity(out.frags.len() * FRAG_STRIDE);
    for f in &out.frags {
        frags_out.extend_from_slice(&[
            f.origin as f64,
            f.t0,
            f.t1,
            f.pen as f64,
            f.shape as f64,
            if f.dot { 1.0 } else { 0.0 },
        ]);
    }
    let s = &out.stats;
    Ok(RenderResult {
        prims: prims_out,
        frags: frags_out,
        stats: vec![
            s.shapes_in as f64,
            s.culled_off_paper as f64,
            s.culled_contained as f64,
            s.clean as f64,
            s.fragments as f64,
            s.fill_prims as f64,
        ],
    })
}

fn decode_frags(prims: &[f64], frags: &[f64]) -> Result<Vec<crate::fragment::Frag>, JsValue> {
    if prims.len() % PRIM_STRIDE != 0 || frags.len() % FRAG_STRIDE != 0 {
        return Err(JsValue::from_str("prim/frag buffer not a multiple of the stride"));
    }
    let table = decode_prims(prims);
    frags
        .chunks_exact(FRAG_STRIDE)
        .map(|f| {
            let origin = f[0] as u32;
            let whole = *table
                .get(origin as usize)
                .ok_or_else(|| JsValue::from_str("fragment origin out of bounds"))?;
            Ok(crate::fragment::Frag {
                origin,
                t0: f[1],
                t1: f[2],
                pen: f[3] as u32,
                shape: f[4] as u32,
                dot: f[5] as u32 & 1 != 0,
                geom: whole.sub(f[1], f[2]),
            })
        })
        .collect()
}

/// G-code export. Returns a JSON array of jobs:
/// [{pen, penName, gcode, inkMm, travelMm, estSeconds}]
#[wasm_bindgen]
pub fn wasm_export_gcode(
    prims: &[f64],
    frags: &[f64],
    pens_json: &str,
    profile_json: &str,
    tour_budget: u32,
) -> Result<String, JsValue> {
    let pens: Vec<Pen> = serde_json::from_str(pens_json)
        .map_err(|e| JsValue::from_str(&format!("bad pens json: {e}")))?;
    let profile: MachineProfile = serde_json::from_str(profile_json)
        .map_err(|e| JsValue::from_str(&format!("bad profile json: {e}")))?;
    let frags = decode_frags(prims, frags)?;
    let jobs = export_gcode(&frags, &pens, &profile, tour_budget as usize);
    serde_json::to_string(&jobs).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// PNG export: rasterise fragments at `scale` px/mm. Returns encoded PNG
/// bytes. `background` is a hex colour like "#f6f2ea" (empty = white).
#[wasm_bindgen]
pub fn wasm_export_png(
    prims: &[f64],
    frags: &[f64],
    pens_json: &str,
    width_mm: f64,
    height_mm: f64,
    scale: f64,
    background: Option<String>,
) -> Result<Vec<u8>, JsValue> {
    let pens: Vec<Pen> = serde_json::from_str(pens_json)
        .map_err(|e| JsValue::from_str(&format!("bad pens json: {e}")))?;
    if !(width_mm.is_finite() && height_mm.is_finite() && scale.is_finite())
        || width_mm <= 0.0
        || height_mm <= 0.0
        || scale <= 0.0
    {
        return Err(JsValue::from_str("png dimensions/scale must be finite and positive"));
    }
    if (width_mm * scale) * (height_mm * scale) > 268.0e6 {
        return Err(JsValue::from_str("png too large (over ~256 megapixels)"));
    }
    let frags = decode_frags(prims, frags)?;
    let bg = background.as_deref().filter(|s| !s.is_empty()).map(|s| {
        let c = s.trim_start_matches('#');
        u32::from_str_radix(c, 16)
            .map(|v| [(v >> 16) as u8, (v >> 8) as u8, v as u8])
            .unwrap_or([255, 255, 255])
    });
    Ok(crate::raster::to_png(
        &frags,
        &pens,
        &crate::raster::RasterOptions {
            width_mm,
            height_mm,
            scale,
            background: bg,
        },
    ))
}

/// SVG export (exact curves, no flattening).
#[wasm_bindgen]
pub fn wasm_export_svg(
    prims: &[f64],
    frags: &[f64],
    pens_json: &str,
    width: f64,
    height: f64,
    background: Option<String>,
    only_pen: i32,
) -> Result<String, JsValue> {
    let pens: Vec<Pen> = serde_json::from_str(pens_json)
        .map_err(|e| JsValue::from_str(&format!("bad pens json: {e}")))?;
    let frags = decode_frags(prims, frags)?;
    Ok(to_svg(
        &frags,
        &pens,
        &SvgOptions {
            width,
            height,
            background,
            only_pen: if only_pen >= 0 {
                Some(only_pen as u32)
            } else {
                None
            },
        },
    ))
}

/// Toolpath export for the animated plot preview: chains in ACTUAL plot
/// order (per pen, toured), flattened to polylines.
///
/// Layout: [pen, dot_flag, n_points, x0, y0, x1, y1, …] per chain,
/// concatenated. Travel moves are implicit (gap between one chain's end and
/// the next chain's start).
#[wasm_bindgen]
pub fn wasm_export_toolpath(
    prims: &[f64],
    frags: &[f64],
    pens_json: &str,
    tour_budget: u32,
    tolerance: f64,
) -> Result<Vec<f64>, JsValue> {
    let pens: Vec<Pen> = serde_json::from_str(pens_json)
        .map_err(|e| JsValue::from_str(&format!("bad pens json: {e}")))?;
    let frags = decode_frags(prims, frags)?;
    let mut out: Vec<f64> = Vec::new();
    let mut pts: Vec<crate::vec2::Vec2> = Vec::new();
    for pi in 0..pens.len() {
        let chains = crate::gcode::merge_chains(&frags, pi as u32);
        if chains.is_empty() {
            continue;
        }
        let chains = crate::gcode::tour(chains, tour_budget as usize);
        for chain in chains {
            out.push(pi as f64);
            out.push(if chain.dot { 1.0 } else { 0.0 });
            pts.clear();
            if chain.dot {
                let p = chain.start();
                out.push(1.0);
                out.push(p.x);
                out.push(p.y);
                continue;
            }
            // Flatten the whole chain; consecutive primitives share endpoints,
            // so drop each primitive's duplicated first point.
            let mut all: Vec<crate::vec2::Vec2> = Vec::new();
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
    }
    Ok(out)
}
