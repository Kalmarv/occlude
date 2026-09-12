//! Exact distance levels for a circular component. Sending a native circle
//! through a segment diagram would multiply every level by its tessellation
//! count, even though its distance field and every inset are known analytically.
use super::*;

pub(super) fn generate(
    component: &Shape<f64>,
    width: f64,
    spacing: f64,
    eps: f64,
    budget: usize,
) -> Result<Option<Generated>, String> {
    if component.ccw_plines.len() != 1 || !component.cw_plines.is_empty() {
        return Ok(None);
    }
    let source = primitives(&component.ccw_plines[0].polyline);
    let Some(Primitive::Arc(first_arc)) = source.first() else {
        return Ok(None);
    };
    let center = first_arc.center;
    let radius = first_arc.r;
    if !center.is_finite() || !radius.is_finite() || radius <= 0. {
        return Err("contour: invalid circular boundary".into());
    }
    let tolerance = (64. * f64::EPSILON * center.x.abs().max(center.y.abs()).max(radius).max(1.))
        .min(eps / 128.);
    let mut turn = 0.;
    for (p, next) in source
        .iter()
        .zip(source.iter().cycle().skip(1))
        .take(source.len())
    {
        let Primitive::Arc(a) = p else {
            return Ok(None);
        };
        if !a.center.is_finite() || !a.r.is_finite() || !a.sweep.is_finite() {
            return Err("contour: nonfinite circular boundary".into());
        }
        if a.center.dist(center) > tolerance
            || (a.r - radius).abs() > tolerance
            || a.sweep.signum() != first_arc.sweep.signum()
            || a.eval(1.).dist(next.start()) > tolerance
        {
            return Ok(None);
        }
        turn += a.sweep;
    }
    if (turn.abs() - std::f64::consts::TAU).abs() > 1e-12 {
        return Ok(None);
    }
    let first = (width / 2. - eps / 2.).max(width / 4.);
    let count = ((radius - first) / spacing).ceil().max(0.);
    if !count.is_finite() || count >= usize::MAX as f64 {
        return Err("contour: circular levels exceed geometry budget".into());
    }
    let mut n = count as usize;
    if n > 0 && radius - first - (n - 1) as f64 * spacing <= eps / 64. {
        n -= 1;
    }
    if n == 0 && spacing > width {
        return Ok(None);
    } // existing sparse fallback
    let last_radius = if n == 0 {
        0.
    } else {
        radius - first - (n - 1) as f64 * spacing
    };
    let tap = spacing <= width && (n == 0 || last_radius > width / 2. - eps / 4.);
    let joins = n.saturating_sub(1);
    let required = n
        .checked_mul(2)
        .and_then(|n| n.checked_add(joins))
        .and_then(|n| n.checked_add(tap as usize));
    if required.is_none_or(|n| n > budget) {
        return Err("contour: circular ink exceeds geometry budget".into());
    }
    let mut result = Generated::default();
    let mut run: Vec<Primitive> = Vec::with_capacity(required.unwrap());
    for k in 0..n {
        let r = radius - first - k as f64 * spacing;
        let a = Primitive::Arc(Arc::new(center, r, 0., std::f64::consts::PI));
        let b = Primitive::Arc(Arc::new(
            center,
            r,
            std::f64::consts::PI,
            std::f64::consts::PI,
        ));
        if let Some(previous) = run.last() {
            run.push(Primitive::Line(Line::new(previous.end(), a.start())));
            result.diagnostics.connectors += 1;
        }
        run.extend([a, b]);
    }
    if !run.is_empty() {
        result.runs.push(run);
    }
    if tap {
        result.cleanup_runs.insert(result.runs.len());
        result
            .runs
            .push(vec![Primitive::Line(Line::new(center, center))]);
        result.diagnostics.residual_patches = 1;
    }
    result.diagnostics.levels = n;
    result.diagnostics.contours = n;
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn disc(radius: f64) -> Shape<f64> {
        let source = Region::new(
            vec![vec![Primitive::Arc(Arc::new(
                v(150., 150.),
                radius,
                0.,
                std::f64::consts::TAU,
            ))]],
            WindingRule::NonZero,
            true,
        );
        visible_components(&source, &[], &[], 0.0005)
            .unwrap()
            .remove(0)
    }
    #[test]
    fn fine_pen_large_disc_keeps_native_arcs_and_bounded_output() {
        let radius = 140.;
        let width = 0.01;
        let spacing = 0.009;
        let out = generate(
            &disc(radius),
            width,
            spacing,
            error_budget(width, spacing).unwrap(),
            MAX_PRIMITIVES,
        )
        .unwrap()
        .unwrap();
        assert!(out.runs.len() <= 2);
        assert!(
            out.runs
                .iter()
                .flatten()
                .filter(|p| matches!(p, Primitive::Arc(_)))
                .count()
                > 30_000
        );
        assert!(
            count_prims(&out.runs) < 50_000,
            "no per-level polygon tessellation"
        );
        for run in &out.runs {
            for pair in run.windows(2) {
                assert!(pair[0].end().dist(pair[1].start()) < 1e-10);
            }
        }
    }
    #[test]
    fn two_primitive_budget_accepts_one_complete_loop() {
        let out = generate(&disc(1.), 2., 1.8, 0.01, 2).unwrap().unwrap();
        assert_eq!(count_prims(&out.runs), 2);
        assert!(generate(&disc(1.), 2., 1.8, 0.01, 1).is_err());
    }
}
