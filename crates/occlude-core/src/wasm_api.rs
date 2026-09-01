//! WASM boundary. One call per render with the whole recording buffer — no
//! per-shape FFI (spec, Layer 1). Thin bindgen wrappers only: the buffer
//! protocol (strides, decoding, validation) lives in `scene.rs`, shared
//! with the native replay/profiling harness.

use crate::gcode::{export_gcode, MachineProfile};
use crate::pipeline::{render, Pen};
use crate::scene::{
    decode_prims, decode_render_input, encode_render_output, FRAG_STRIDE, PRIM_STRIDE,
};
use crate::svg::{to_svg, SvgOptions};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct RenderResult {
    prims: Vec<f64>,
    frags: Vec<f64>,
    stats: Vec<f64>,
    ghost: Vec<f64>,
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
    /// Debug-ghost geometry (post-modified, pre-occlusion); empty unless
    /// requested. Same PRIM encoding as `prims`.
    #[wasm_bindgen(getter)]
    pub fn ghost(&self) -> Vec<f64> {
        self.ghost.clone()
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
    debug_ghost: u32,
) -> Result<RenderResult, JsValue> {
    let input = decode_render_input(
        prims, contours, shapes_u32, shapes_f64, mods, field_data, fill_params, clip_list,
        clips_u32, pens_json, paper, seed, coarsen, debug_ghost,
    )
    .map_err(|e| JsValue::from_str(&e))?;
    let out = encode_render_output(&render(&input));
    Ok(RenderResult {
        prims: out.prims,
        frags: out.frags,
        ghost: out.ghost,
        stats: out.stats,
    })
}

fn decode_frags(prims: &[f64], frags: &[f64]) -> Result<Vec<crate::fragment::Frag>, JsValue> {
    if prims.len() % PRIM_STRIDE != 0 || frags.len() % FRAG_STRIDE != 0 {
        return Err(JsValue::from_str(
            "prim/frag buffer not a multiple of the stride",
        ));
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
                bridge: false,
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
        return Err(JsValue::from_str(
            "png dimensions/scale must be finite and positive",
        ));
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
        // Consecutive chains with sub-nib gaps draw through instead of
        // lifting; the nib hides the bridge.
        let chains = crate::route::bridge_chains(chains, pens[pi].width.max(0.05) * 0.5);
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
