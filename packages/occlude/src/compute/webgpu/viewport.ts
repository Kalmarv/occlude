/// <reference types="@webgpu/types" />
import { clipSegment3, clipTriangle3, projectCamera3, type CameraFrame3 } from '../../three/camera.js';
import { lerp3, type Triangle3, type Vec3 } from '../../three/math.js';

const shader = /* wgsl */ `
struct Vertex { @builtin(position) p: vec4f, @location(0) color: vec3f }
@vertex fn vertex(@location(0) p: vec3f, @location(1) color: vec3f) -> Vertex { return Vertex(vec4f(p, 1.0), color); }
@fragment fn fragment(v: Vertex) -> @location(0) vec4f { return vec4f(v.color, 1.0); }
`;
/** Construction preview only; raster pixels never become committed vectors.
 * Accepts camera-space triangles and wires from an explicit render snapshot. */
export class GpuViewport3 {
  private context: GPUCanvasContext;
  private pipeline: GPURenderPipeline;
  private depth: GPUTexture | null = null;
  private vertices: GPUBuffer | null = null;
  private vertexBytes = 0;
  private width = 0;
  private height = 0;
  constructor(private device: GPUDevice, private canvas: HTMLCanvasElement | OffscreenCanvas, format: GPUTextureFormat) {
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null;
    if (!context) throw new Error('WebGPU canvas context unavailable');
    this.context = context;
    context.configure({ device, format, alphaMode: 'opaque' });
    const module = device.createShaderModule({ code: shader });
    this.pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vertex', buffers: [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }] }, fragment: { module, entryPoint: 'fragment', targets: [{ format }] }, primitive: { topology: 'triangle-list', cullMode: 'none' }, depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' } });
  }
  draw(frame: CameraFrame3, triangles: readonly Triangle3[], wires: readonly (readonly [Vec3, Vec3])[]): void {
    const values: number[] = [];
    const append = (p: Vec3, color: Vec3) => values.push(...p, ...color);
    for (const triangle of triangles) for (const clipped of clipTriangle3(triangle, frame.camera.near, frame.camera.far)) {
      for (const p of clipped) append(projectCamera3(frame, p), [0.72, 0.78, 0.82]);
    }
    // Portable stroke quads, never native wide lines. Screen width only affects preview.
    for (const [a, b] of wires) {
      const range = clipSegment3(a, b, frame.camera.near, frame.camera.far);
      if (!range) continue;
      const p = projectCamera3(frame, lerp3(a, b, range[0])), q = projectCamera3(frame, lerp3(a, b, range[1]));
      const dx = (q[0] - p[0]) * this.canvas.width, dy = (q[1] - p[1]) * this.canvas.height;
      const length = Math.hypot(dx, dy); if (!length) continue;
      const nx = -dy / length * 2 / this.canvas.width, ny = dx / length * 2 / this.canvas.height;
      const v: Vec3[] = [[p[0] + nx, p[1] + ny, p[2]], [p[0] - nx, p[1] - ny, p[2]], [q[0] + nx, q[1] + ny, q[2]], [q[0] - nx, q[1] - ny, q[2]]];
      for (const i of [0, 1, 2, 2, 1, 3]) append(v[i], [0.07, 0.12, 0.18]);
    }
    const data = new Float32Array(values);
    if (data.byteLength > this.vertexBytes) {
      this.vertices?.destroy(); this.vertexBytes = Math.max(24, data.byteLength);
      this.vertices = this.device.createBuffer({ size: this.vertexBytes, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (data.length) this.device.queue.writeBuffer(this.vertices!, 0, data);
    if (!this.depth || this.width !== this.canvas.width || this.height !== this.canvas.height) {
      this.depth?.destroy(); this.width = this.canvas.width; this.height = this.canvas.height;
      this.depth = this.device.createTexture({ size: [this.width, this.height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: [0.96, 0.95, 0.92, 1], loadOp: 'clear', storeOp: 'store' }], depthStencilAttachment: { view: this.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    pass.setPipeline(this.pipeline);
    if (data.length) { pass.setVertexBuffer(0, this.vertices!); pass.draw(data.length / 6); }
    pass.end(); this.device.queue.submit([encoder.finish()]);
  }
  dispose(): void { this.vertices?.destroy(); this.depth?.destroy(); this.context.unconfigure(); }
}
