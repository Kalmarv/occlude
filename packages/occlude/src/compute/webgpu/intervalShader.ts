/** 96-byte pair: a,b and four planes, each vec4f. 16-byte result:
 * lo, hi, uncertainty flag, nonempty flag. No atomic append or overflow. */
export const intervalShader = /* wgsl */ `
struct Pair { a: vec4f, b: vec4f, planes: array<vec4f, 4> }
@group(0) @binding(0) var<storage, read> pairs: array<Pair>;
@group(0) @binding(1) var<storage, read_write> result: array<vec4f>;
@compute @workgroup_size(64)
fn classify(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= arrayLength(&pairs)) { return; }
  let pair = pairs[k];
  var lo = 0.0; var hi = 1.0; var uncertain = 0.0; var nonempty = 1.0; var endpointError = 0.0;
  for (var i = 0u; i < 4u; i++) {
    let p = pair.planes[i];
    let a = vec4f(pair.a.xyz, 1.0); let b = vec4f(pair.b.xyz, 1.0);
    let va = dot(p, a); let vb = dot(p, b);
    // 32 f32 unit roundoffs cover packing plus dot/subtract rounding.
    // Degenerate/near-zero products are conservatively sent to f64.
    let ea = max(dot(abs(p), abs(a)) * 0.000001907348633, 1e-30);
    let eb = max(dot(abs(p), abs(b)) * 0.000001907348633, 1e-30);
    // One end on the plane within its error, the other certainly outside:
    // this half-space can hide at most a sliver at that end, no longer than
    // ea / (ea + |vb|) of the segment. Under the caller's parameter tolerance
    // (pair.a.w) such a sliver is dropped like every other sub-tolerance run,
    // so the pair is empty and certain; a longer possible sliver is refined.
    if (abs(va) <= ea && vb < -eb) { if (ea / (ea + abs(vb)) <= pair.a.w) { nonempty = 0.0; break; } uncertain = 1.0; }
    if (abs(vb) <= eb && va < -ea) { if (eb / (eb + abs(va)) <= pair.a.w) { nonempty = 0.0; break; } uncertain = 1.0; }
    if (abs(va) <= ea || abs(vb) <= eb) { uncertain = 1.0; }
    if ((i == 3u && va <= 0.0 && vb <= 0.0) || (va < 0.0 && vb < 0.0)) { nonempty = 0.0; }
    if ((va < 0.0) != (vb < 0.0)) {
      let denominator = va - vb;
      let t = va / denominator;
      let error = (ea + abs(t) * (ea + eb)) / max(abs(denominator) - ea - eb, 1e-30);
      endpointError = max(endpointError, error);
      if (error > pair.a.w) { uncertain = 1.0; }
      if (va < 0.0) { lo = max(lo, t); } else { hi = min(hi, t); }
      
    }
  }
  if (abs(hi - lo) <= 2.0 * endpointError) { uncertain = 1.0; }
  if (lo >= hi) { nonempty = 0.0; }
  result[k] = vec4f(lo, hi, uncertain, nonempty);
}
`;
