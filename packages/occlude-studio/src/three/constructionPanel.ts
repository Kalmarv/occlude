import type { Camera3 } from 'occlude/src/three/camera.js';
import type { CameraCommitRequest, RenderClient, RenderReply } from '../workerClient.js';
import type { Preview } from '../preview.js';
import { icon } from '../icons.js';
import { orbitCamera3, zoomCamera3, panCamera3, presetCamera3, fitCamera3, switchProjection3, carryExploration3, type ViewPreset3 } from './orbit.js';

/** The construction view lives in exactly the sheet's box: a canvas over the
 * paper preview, the model drawn into the scene's own viewport rectangle at
 * the preview's pan and zoom, so switching between sketch and camera moves
 * nothing. Controls follow Blender: drag (or middle drag) orbits, shift+drag
 * pans, ctrl+drag zooms, wheel zooms, shift/ctrl+wheel pan, numpad 1/3/7 are
 * front/right/top (ctrl for the opposite side), 5 toggles projection, 2/4/6/8
 * step-orbit, ctrl+2/4/6/8 pan, Home frames the model. One request in flight,
 * one latest camera: drag bursts cannot build a queue. */
export class ConstructionPanel3 {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly toolbar = document.createElement('div');
  private readonly switch_ = document.createElement('div');
  private readonly sketchButton = document.createElement('button');
  private readonly cameraButton = document.createElement('button');
  private readonly scenes = document.createElement('select');
  private readonly projection = document.createElement('select');
  private readonly scale = document.createElement('input');
  private readonly scaleLabel = document.createElement('label');
  private readonly commitButton = document.createElement('button');
  private readonly note = document.createElement('p');
  private reply?: RenderReply;
  private camera?: Camera3;
  private selectedScene = 0;
  private readonly exploration = new Map<number, Camera3>();
  private revision = 0;
  private busy = false;
  private dirty = false;
  private bitmap?: { image: ImageBitmap; rect: { x: number; y: number; width: number; height: number } };
  constructor(private client: RenderClient, bench: HTMLElement, private preview: Preview, commit: (request: CameraCommitRequest) => Promise<void>) {
    this.canvas.id = 'construction-canvas'; this.canvas.setAttribute('aria-label','3D construction view'); this.canvas.tabIndex = 0; this.canvas.hidden = true;
    this.ctx = this.canvas.getContext('2d')!;
    // The switch: sketch (the drawing) or camera (the model), bottom right.
    this.switch_.className = 'view-switch'; this.switch_.hidden = true; this.switch_.setAttribute('role','group'); this.switch_.setAttribute('aria-label','Sketch or 3D view');
    this.sketchButton.append(icon('edit')); this.sketchButton.title = 'Sketch: the plotted drawing'; this.sketchButton.setAttribute('aria-label','Sketch view');
    this.cameraButton.append(icon('snapshot')); this.cameraButton.title = 'Camera: orbit the model, then commit the view'; this.cameraButton.setAttribute('aria-label','3D camera view');
    this.sketchButton.onclick = () => this.show(false); this.cameraButton.onclick = () => this.show(true);
    this.switch_.append(this.sketchButton, this.cameraButton);
    this.toolbar.className = 'construction-toolbar'; this.toolbar.hidden = true;
    this.scenes.setAttribute('aria-label','3D scene');
    this.scenes.onchange = () => {
      if(this.camera)this.exploration.set(this.selectedScene,this.camera);
      this.selectedScene=Number(this.scenes.value);
      this.camera=this.exploration.get(this.selectedScene)??this.reply?.construction[this.selectedScene]?.camera;
      this.hint();this.syncControls();this.schedule();
    };
    const reset = document.createElement('button'); reset.textContent = 'Reset'; reset.title = 'Back to the sketch’s camera';
    reset.onclick = () => { this.camera=this.reply?.construction[this.selectedScene]?.camera;this.exploration.delete(this.selectedScene);this.syncControls();this.schedule(); };
    const copy = document.createElement('button'); copy.textContent = 'Copy'; copy.title = 'Copy this camera as source for your sketch';
    copy.onclick = () => { if(this.camera) void navigator.clipboard.writeText(cameraSource(this.camera)).then(()=>{this.note.textContent='Camera copied as source.';}).catch(error=>{this.note.textContent=String(error);}); };
    this.commitButton.textContent = 'Commit view'; this.commitButton.title = 'Reclassify the drawing for this camera and write it into the view call';
    this.commitButton.onclick = async () => {
      if (!this.reply || !this.camera) return;
      const request = { executionId: this.reply.executionId, planHash: this.reply.plan.planHash, scene: Number(this.scenes.value), camera: this.camera };
      this.commitButton.disabled = true;
      this.note.textContent = 'Committing vector drawing…';
      try { await commit(request); this.note.textContent = 'View committed and written into the sketch.'; }
      catch (error) { this.note.textContent = String(error); }
      finally { this.commitButton.disabled = false; }
    };
    this.projection.setAttribute('aria-label','Projection');
    for(const [value,text] of [['orthographic','Orthographic'],['perspective','Perspective'],['oblique','Oblique']]){
      const option=document.createElement('option');option.value=value;option.textContent=text;this.projection.append(option);
    }
    this.projection.onchange=()=>{ if(!this.camera)return; try{this.camera=switchProjection3(this.camera,this.projection.value as Camera3['kind']);this.syncControls();this.schedule();}catch(error){this.note.textContent=String(error);this.syncControls();} };
    this.scale.type='number';this.scale.step='any';this.scale.style.width='5.5em';
    this.scale.onchange=()=>{
      if(!this.camera)return;
      const value=this.scale.valueAsNumber;
      if(!Number.isFinite(value)||value<=0||(this.camera.kind!=='orthographic'&&value>=180)){this.note.textContent='Enter a positive span, or a vertical FOV between 0 and 180 degrees.';this.syncControls();return;}
      this.camera=this.camera.kind==='orthographic'?{...this.camera,span:value}:{...this.camera,fovDegrees:value};this.schedule();
    };
    this.scaleLabel.append(this.scale);
    this.toolbar.append(this.scenes,this.projection,this.scaleLabel,reset,copy,this.commitButton);
    this.note.className = 'construction-note'; this.note.hidden = true;
    bench.append(this.canvas,this.toolbar,this.note,this.switch_);
    new ResizeObserver(() => { if (!this.canvas.hidden) this.schedule(); }).observe(this.canvas);
    preview.onViewChange = () => { if (!this.canvas.hidden) this.schedule(); };
    this.bindInput();
  }
  /** Show the model over the sheet, or the drawing. Neither moves the sheet. */
  show(camera: boolean): void {
    this.canvas.hidden = !camera; this.toolbar.hidden = !camera; this.note.hidden = !camera;
    this.cameraButton.setAttribute('aria-pressed',String(camera)); this.sketchButton.setAttribute('aria-pressed',String(!camera));
    if (camera) { this.canvas.focus({ preventScroll: true }); this.schedule(); }
  }
  get visible(): boolean { return !this.canvas.hidden; }
  private hint(): void { this.note.textContent = 'Drag orbits · shift+drag pans · ctrl+drag or wheel zooms · numpad 1/3/7 views, 5 projection, Home frames · click a face to inspect'; }
  onRender(reply: RenderReply): void {
    const selected = Math.min(Number(this.scenes.value) || 0, Math.max(0, reply.construction.length - 1));
    // The viewpoint being explored outlives the result it was found in, as
    // long as the sketch's camera for that scene did not change.
    if(this.camera)this.exploration.set(this.selectedScene,this.camera);
    const kept=carryExploration3(this.exploration,this.reply?.construction.map(s=>s.camera)??[],reply.construction.map(s=>s.camera));
    this.reply=reply; this.revision++; this.dirty=false;
    this.switch_.hidden=!reply.construction.length;
    this.scenes.replaceChildren(...reply.construction.map((scene,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=`Scene ${i+1} · ${scene.triangles} triangles`;return option;}));
    this.scenes.value=String(selected);
    this.selectedScene=selected;this.exploration.clear();for(const [scene,camera] of kept)this.exploration.set(scene,camera);
    this.camera=this.exploration.get(selected)??reply.construction[selected]?.camera; this.syncControls();
    if(!this.camera)this.show(false); else { this.sketchButton.setAttribute('aria-pressed',String(this.canvas.hidden)); this.cameraButton.setAttribute('aria-pressed',String(!this.canvas.hidden)); }
    this.hint();
    if(!this.canvas.hidden)this.schedule();
  }
  private syncControls(): void {
    if(!this.camera)return;
    this.projection.value=this.camera.kind;
    const perspective=this.camera.kind!=='orthographic';
    this.scaleLabel.replaceChildren(perspective?'FOV ° ':'Span ',this.scale);
    this.scale.setAttribute('aria-label',perspective?'Vertical FOV (degrees)':'Orthographic span');
    this.scale.title=perspective?'Vertical field of view in degrees':'Vertical span in scene units';
    this.scale.min='0';if(perspective)this.scale.max='180';else this.scale.removeAttribute('max');
    this.scale.value=String(Number((this.camera.kind==='orthographic'?this.camera.span:this.camera.fovDegrees).toPrecision(8)));
  }
  /** The scene's viewport rectangle on the canvas, in CSS px, following the
   * preview's pan and zoom; the whole sheet when the scene has no viewport. */
  private viewportRect(): { x: number; y: number; width: number; height: number; sheet: { x: number; y: number; width: number; height: number }; color: string } | undefined {
    const view = this.preview.viewTransform(); if (!view.paper) return;
    const scene = this.reply?.construction[this.selectedScene], mm = scene?.viewport ?? { x: 0, y: 0, width: view.paper.w, height: view.paper.h };
    const px = (v: number) => v * view.scale;
    return { x: view.panX + px(mm.x), y: view.panY + px(mm.y), width: px(mm.width), height: px(mm.height), sheet: { x: view.panX, y: view.panY, width: px(view.paper.w), height: px(view.paper.h) }, color: view.color };
  }
  private request() {
    if(!this.reply||!this.camera)return;
    const rect=this.viewportRect(); if(!rect) return;
    const ratio=Math.min(2,devicePixelRatio);
    const width=Math.max(1,Math.min(4096,Math.round(rect.width*ratio))),height=Math.max(1,Math.min(4096,Math.round(rect.height*ratio)));
    return { executionId:this.reply.executionId,scene:Number(this.scenes.value),camera:this.camera,width,height,revision:this.revision,rect };
  }
  private schedule(): void { this.revision++;this.dirty=true;void this.draw(); }
  private async draw(): Promise<void> {
    if(this.busy||!this.dirty||this.canvas.hidden)return;
    const request=this.request();if(!request)return;
    this.busy=true;this.dirty=false;
    try {
      const { rect, ...message } = request;
      const result=await this.client.construction(message);
      if(result.bitmap){
        if(request.revision===this.revision&&!this.canvas.hidden){ this.bitmap?.image.close(); this.bitmap={image:result.bitmap,rect}; this.paint(rect.sheet,rect.color); }
        else result.bitmap.close();
      }
    }catch(error){if(request.revision===this.revision)this.note.textContent=String(error);}
    finally{this.busy=false;if(this.dirty)void this.draw();}
  }
  /** The sheet as the preview paints it, with the model inside its viewport. */
  private paint(sheet: { x: number; y: number; width: number; height: number }, color: string): void {
    const dpr = devicePixelRatio || 1, { clientWidth: w, clientHeight: h } = this.canvas;
    if (this.canvas.width !== Math.round(w*dpr) || this.canvas.height !== Math.round(h*dpr)) { this.canvas.width = Math.max(1,Math.round(w*dpr)); this.canvas.height = Math.max(1,Math.round(h*dpr)); }
    const ctx = this.ctx; ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
    ctx.save(); ctx.shadowColor='rgba(0,0,0,0.55)'; ctx.shadowBlur=18; ctx.shadowOffsetY=6; ctx.fillStyle=color; ctx.fillRect(sheet.x,sheet.y,sheet.width,sheet.height); ctx.restore();
    if (this.bitmap) { const r = this.bitmap.rect; ctx.save(); ctx.imageSmoothingEnabled = true; ctx.drawImage(this.bitmap.image, r.x, r.y, r.width, r.height); ctx.restore(); }
  }
  private bindInput(): void {
    let drag: { x: number; y: number; distance: number; mode: 'orbit'|'pan'|'zoom' } | undefined;
    const c = this.canvas;
    c.onpointerdown = event => {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault(); c.focus({ preventScroll: true }); c.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, distance: 0, mode: event.shiftKey ? 'pan' : event.ctrlKey ? 'zoom' : 'orbit' };
    };
    c.onpointermove = event => {
      if (!drag || !this.camera) return;
      const dx=event.clientX-drag.x, dy=event.clientY-drag.y; drag.x=event.clientX; drag.y=event.clientY; drag.distance+=Math.hypot(dx,dy);
      if (!dx && !dy) return;
      const rect = this.viewportRect(), height = Math.max(1, rect?.height ?? c.clientHeight);
      if (drag.mode === 'orbit') this.camera = orbitCamera3(this.camera, -dx*.008, dy*.008);
      else if (drag.mode === 'pan') this.camera = panCamera3(this.camera, dx/height, -dy/height);
      else this.camera = zoomCamera3(this.camera, Math.exp(dy*.005));
      this.syncControls(); this.schedule();
    };
    c.onpointerup = event => { const click = drag && drag.mode === 'orbit' && drag.distance < 3 && event.button === 0; drag = undefined; if (click) void this.pick(event.clientX, event.clientY); };
    c.onpointercancel = () => { drag = undefined; };
    c.onwheel = event => {
      event.preventDefault(); if (!this.camera) return;
      const step = Math.max(-1, Math.min(1, event.deltaY*.001));
      if (event.shiftKey) this.camera = panCamera3(this.camera, 0, -step*.25);
      else if (event.ctrlKey) this.camera = panCamera3(this.camera, step*.25, 0);
      else this.camera = zoomCamera3(this.camera, Math.exp(step));
      this.syncControls(); this.schedule();
    };
    c.onkeydown = event => {
      if (!this.camera) return;
      const key = event.code.startsWith('Numpad') ? event.code.slice(6) : event.key, ctrl = event.ctrlKey || event.metaKey;
      const presets: Record<string, [ViewPreset3, ViewPreset3]> = { '1': ['front','back'], '3': ['right','left'], '7': ['top','bottom'] };
      const steps: Record<string, [number, number]> = { '4': [Math.PI/12, 0], '6': [-Math.PI/12, 0], '8': [0, -Math.PI/12], '2': [0, Math.PI/12] };
      let next: Camera3 | undefined;
      if (presets[key]) next = presetCamera3(this.camera, presets[key][ctrl ? 1 : 0]);
      else if (steps[key]) next = ctrl ? panCamera3(this.camera, steps[key][0] ? -Math.sign(steps[key][0])*.1 : 0, steps[key][1] ? Math.sign(steps[key][1])*.1 : 0) : orbitCamera3(this.camera, steps[key][0], steps[key][1]);
      else if (key === '5') next = switchProjection3(this.camera, this.camera.kind === 'orthographic' ? 'perspective' : 'orthographic');
      else if (key === 'Home' || key === 'Decimal' || key === '.') { const bounds = this.reply?.construction[this.selectedScene]?.bounds, rect = this.viewportRect(); if (bounds) next = fitCamera3(this.camera, bounds, rect ? rect.width/rect.height : 1); }
      else if (key === '+' || key === 'Add') next = zoomCamera3(this.camera, 1/1.2);
      else if (key === '-' || key === 'Subtract') next = zoomCamera3(this.camera, 1.2);
      if (!next) return;
      event.preventDefault(); this.camera = next; this.syncControls(); this.schedule();
    };
  }
  private async pick(x:number,y:number):Promise<void>{
    const request=this.request();if(!request)return;
    const bounds=this.canvas.getBoundingClientRect(), r=request.rect;
    const nx=(x-bounds.left-r.x)/r.width, ny=(y-bounds.top-r.y)/r.height;
    if (nx<0||nx>1||ny<0||ny>1) { this.note.textContent='Outside the scene viewport'; return; }
    const { rect, ...message } = request;
    try{
      const result=await this.client.construction({...message,pick:{x:nx,y:ny}});
      if(request.revision!==this.revision)return;
      this.note.textContent=result.pick?`${result.pick.objectId} / ${result.pick.faceId} · ${JSON.stringify(result.pick.attributes)}`:'No face at this point';
    }catch(error){if(request.revision===this.revision)this.note.textContent=String(error);}
  }
}
/** The camera as the source an artist writes: a tidy factory call. */
export function cameraSource(camera: Camera3): string {
  const n = (v: number) => String(Number(v.toPrecision(6)));
  const vec = (v: readonly number[]) => `[${v.map(n).join(', ')}]`;
  const up = camera.up && !(camera.up[0] === 0 && camera.up[1] === 0 && camera.up[2] === 1) ? `, up: ${vec(camera.up)}` : '';
  if (camera.kind === 'orthographic') return `orthographic({ eye: ${vec(camera.eye)}, target: ${vec(camera.target)}${up}, span: ${n(camera.span)} })`;
  if (camera.kind === 'oblique') return `oblique({ eye: ${vec(camera.eye)}, target: ${vec(camera.target)}${up}, shift: ${vec(camera.shift)}, fovDegrees: ${n(camera.fovDegrees)} })`;
  return `perspective({ eye: ${vec(camera.eye)}, target: ${vec(camera.target)}${up}, fovDegrees: ${n(camera.fovDegrees)} })`;
}
