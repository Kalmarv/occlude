import type { Camera3 } from 'occlude/src/three/camera.js';
import type { CameraCommitRequest, RenderClient, RenderReply } from '../workerClient.js';
import { orbitCamera3, zoomCamera3, switchProjection3 } from './orbit.js';

/** One request in flight, one latest camera: drag bursts cannot build a queue.
 * Every completion names its originating execution and local view revision. */
export class ConstructionPanel3 {
  private readonly panel = document.createElement('section');
  private readonly canvas = document.createElement('canvas');
  private readonly toggle = document.createElement('button');
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
  constructor(private client: RenderClient, bench: HTMLElement, hud: HTMLElement, commit: (request: CameraCommitRequest) => Promise<void>) {
    this.panel.id = 'construction-pane'; this.panel.hidden = true;
    this.canvas.id = 'construction-canvas'; this.canvas.setAttribute('aria-label','3D construction view');
    this.toggle.textContent = '3D'; this.toggle.hidden = true; this.toggle.setAttribute('aria-pressed','false');
    this.toggle.onclick = () => { this.panel.hidden = !this.panel.hidden; this.toggle.setAttribute('aria-pressed',String(!this.panel.hidden)); if (!this.panel.hidden) this.schedule(); };
    hud.prepend(this.toggle);
    const toolbar = document.createElement('div'); toolbar.className = 'construction-toolbar';
    this.scenes.setAttribute('aria-label','3D scene');
    this.scenes.onchange = () => {
      if(this.camera)this.exploration.set(this.selectedScene,this.camera);
      this.selectedScene=Number(this.scenes.value);
      this.camera=this.exploration.get(this.selectedScene)??this.reply?.construction[this.selectedScene]?.camera;
      this.note.textContent='Drag to orbit · scroll to zoom · click a face to inspect';this.syncControls();this.schedule();
    };
    const reset = document.createElement('button'); reset.textContent = 'Reset camera'; reset.onclick = () => { this.camera=this.reply?.construction[this.selectedScene]?.camera;this.exploration.delete(this.selectedScene);this.syncControls();this.schedule(); };
    const copy = document.createElement('button'); copy.textContent = 'Copy camera'; copy.title = 'Copy this view’s camera values for your sketch';
    copy.onclick = () => { if(this.camera) void navigator.clipboard.writeText(JSON.stringify(this.camera,null,2)).then(()=>{this.note.textContent='Camera copied. Paste it into the sketch to change the drawing.';}).catch(error=>{this.note.textContent=String(error);}); };
    this.commitButton.textContent = 'Commit view';
    this.commitButton.onclick = async () => {
      if (!this.reply || !this.camera) return;
      const request = { executionId: this.reply.executionId, planHash: this.reply.plan.planHash, scene: Number(this.scenes.value), camera: this.camera };
      this.commitButton.disabled = true;
      this.note.textContent = 'Committing vector drawing…';
      try {
        await commit(request);
        this.note.textContent = 'View committed. Camera saved in sketch configuration; save or download the sketch to keep it with your project.';
      } catch (error) { this.note.textContent = String(error); }
      finally { this.commitButton.disabled = false; }
    };
    this.projection.setAttribute('aria-label','Projection');
    for(const [value,text] of [['orthographic','Orthographic'],['perspective','Perspective']]){
      const option=document.createElement('option');option.value=value;option.textContent=text;this.projection.append(option);
    }
    this.projection.onchange=()=>{if(!this.camera)return;try{this.camera=switchProjection3(this.camera,this.projection.value as Camera3['kind']);this.syncControls();this.schedule();}catch(error){this.note.textContent=String(error);this.syncControls();}};
    this.scale.type='number';this.scale.step='any';this.scale.style.width='5.5em';
    this.scale.onchange=()=>{
      if(!this.camera)return;
      const value=this.scale.valueAsNumber;
      if(!Number.isFinite(value)||value<=0||(this.camera.kind==='perspective'&&value>=180)){this.note.textContent='Enter a positive span, or a vertical FOV between 0 and 180 degrees.';this.syncControls();return;}
      this.camera=this.camera.kind==='orthographic'?{...this.camera,span:value}:{...this.camera,fovDegrees:value};this.schedule();
    };
    this.scaleLabel.append(this.scale);
    toolbar.append(this.scenes,this.projection,this.scaleLabel,reset,copy,this.commitButton);
    const label = document.createElement('p'); label.className = 'construction-hint'; label.textContent = 'Construction preview · Commit view updates paper and exports';
    this.note.className = 'construction-pick';
    this.panel.append(toolbar,this.canvas,label,this.note); bench.append(this.panel);
    new ResizeObserver(() => { if (!this.panel.hidden) this.schedule(); }).observe(this.canvas);
    let drag: { x: number; y: number; distance: number } | undefined;
    this.canvas.onpointerdown = event => { if(event.button!==0)return; this.canvas.setPointerCapture(event.pointerId); drag={x:event.clientX,y:event.clientY,distance:0}; };
    this.canvas.onpointermove = event => {
      if (!drag || !this.camera) return;
      const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
      drag.x=event.clientX;drag.y=event.clientY;drag.distance+=Math.hypot(dx,dy);
      if(dx||dy){this.camera=orbitCamera3(this.camera,-dx*.008,dy*.008);this.schedule();}
    };
    this.canvas.onpointerup = event => {
      const click=drag&&drag.distance<3; drag=undefined;
      if(click)void this.pick(event.clientX,event.clientY);
    };
    this.canvas.onpointercancel = () => { drag=undefined; };
    this.canvas.onwheel = event => { event.preventDefault(); if(this.camera){this.camera=zoomCamera3(this.camera,Math.exp(Math.max(-1,Math.min(1,event.deltaY*.001))));this.syncControls();this.schedule();} };
  }
  onRender(reply: RenderReply): void {
    const selected = Math.min(Number(this.scenes.value) || 0, Math.max(0, reply.construction.length - 1));
    this.reply=reply; this.revision++; this.dirty=false;
    this.toggle.hidden=!reply.construction.length;
    this.scenes.replaceChildren(...reply.construction.map((scene,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=`Scene ${i+1} · ${scene.triangles} triangles`;return option;}));
    this.scenes.value=String(selected);
    this.selectedScene=selected;this.exploration.clear();
    this.camera=reply.construction[selected]?.camera; this.syncControls();
    if(!this.camera){this.panel.hidden=true;this.toggle.setAttribute('aria-pressed','false');}
    this.note.textContent='Drag to orbit · scroll to zoom · click a face to inspect';
    if(!this.panel.hidden)this.schedule();
  }
  private syncControls(): void {
    if(!this.camera)return;
    this.projection.value=this.camera.kind;
    const perspective=this.camera.kind==='perspective';
    this.scaleLabel.replaceChildren(perspective?'FOV ° ':'Span ',this.scale);
    this.scale.setAttribute('aria-label',perspective?'Vertical FOV (degrees)':'Orthographic span');
    this.scale.title=perspective?'Vertical field of view in degrees':'Vertical span in scene units';
    this.scale.min='0';if(perspective)this.scale.max='180';else this.scale.removeAttribute('max');
    this.scale.value=String(Number((this.camera.kind==='perspective'?this.camera.fovDegrees:this.camera.span).toPrecision(8)));
  }
  private request() {
    if(!this.reply||!this.camera)return;
    const bounds=this.canvas.getBoundingClientRect(),ratio=Math.min(2,devicePixelRatio);
    return { executionId:this.reply.executionId,scene:Number(this.scenes.value),camera:this.camera,width:Math.max(1,Math.min(4096,Math.round(bounds.width*ratio))),height:Math.max(1,Math.min(4096,Math.round(bounds.height*ratio))),revision:this.revision };
  }
  private schedule(): void { this.revision++;this.dirty=true;void this.draw(); }
  private async draw(): Promise<void> {
    if(this.busy||!this.dirty||this.panel.hidden)return;
    const request=this.request();if(!request)return;
    this.busy=true;this.dirty=false;
    try {
      const result=await this.client.construction(request);
      if(result.bitmap){
        if(request.revision===this.revision&&!this.panel.hidden){
          this.canvas.width=request.width;this.canvas.height=request.height;
          this.canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(result.bitmap);
          this.canvas.dataset.revision=String(result.revision);
        }else result.bitmap.close();
      }
    }catch(error){if(request.revision===this.revision)this.note.textContent=String(error);}
    finally{this.busy=false;if(this.dirty)void this.draw();}
  }
  private async pick(x:number,y:number):Promise<void>{
    const request=this.request();if(!request)return;
    const bounds=this.canvas.getBoundingClientRect();
    try{
      const result=await this.client.construction({...request,pick:{x:(x-bounds.left)/bounds.width,y:(y-bounds.top)/bounds.height}});
      if(request.revision!==this.revision)return;
      this.note.textContent=result.pick?`${result.pick.objectId} / ${result.pick.faceId} · ${JSON.stringify(result.pick.attributes)}`:'No face at this point';
    }catch(error){if(request.revision===this.revision)this.note.textContent=String(error);}
  }
}
