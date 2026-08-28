//! occlude-core: exact hidden-line-removal geometry for pen plotters.
//!
//! `fill` means fill: filled shapes hide what is beneath them. The core
//! computes the exact visible strokes (fragments of the original primitives,
//! cut at true intersection parameters) and only flattens at export.

pub mod bbox;
pub mod cleanup;
pub mod clip;
pub mod fill;
pub mod fragment;
pub mod gcode;
pub mod index;
pub mod intersect;
pub mod pipeline;
pub mod poly;
pub mod primitive;
pub mod raster;
pub mod region;
pub mod rng;
pub mod route;
pub mod snap;
pub mod svg;
pub mod vec2;

pub mod modifier;
pub mod profile;
#[cfg(feature = "wasm")]
pub mod wasm_api;
