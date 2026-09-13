import type { Camera3 } from 'occlude/src/three/camera.js';
import type { RenderClient, RenderReply } from '../workerClient.js';
import { orbitCamera3, zoomCamera3 } from './orbit.js';

/** One request in flight, one latest camera: drag bursts cannot build a queue.
 * Every completion names its originating execution and local view revision. */
export class ConstructionPanel3 {
  private readonly panel = document.createElement('section');
  private readonly canvas = document.createElement('canvas');
  private readonly toggle = document.createElement('button');
  private readonly scenes = document.createElement('select');
  private readonly note = document.createElement('p');
  private reply?: RenderReply;
  private camera?: Camera3;
  private revision = 0;
  private busy = false;
  private dirty = false;
  constructor(private client: RenderClient, bench: HTMLElement, hud: HTMLElement) {
    this.panel.id = 'construction-pane'; this.panel.hidden = true;
    this.canvas.id = 'construction-canvas'; this.canvas.setAttribute('aria-label','3D construction view');
    this.toggle.textContent = '3D'; this.toggle.hidden = true; this.toggle.setAttribute('aria-pressed','false');
    this.toggle.onclick = () => { this.panel.hidden = !this.panel.hidden; this.toggle.setAttribute('aria-pressed',String(!this.panel.hidden)); if (!this.panel.hidden) this.schedule(); };
    hud.prepend(this.toggle);
    const toolbar = document.createElement('div'); toolbar.className = 'construction-toolbar';
    this.scenes.setAttribute('aria-label','3D scene');
    this.scenes.onchange = () => { this.camera = this.reply?.construction[Number(this.scenes.value)]?.camera; this.note.textContent = 'Drag to orbit · scroll to zoom · click a face to inspect'; this.schedule(); };
    const reset = document.createElement('button'); reset.textContent = 'Reset camera'; reset.onclick = () => this.scenes.onchange?.(new Event('change'));
    const copy = document.createElement('button'); copy.textContent = 'Copy camera'; copy.title = 'Copy this view’s camera values for your sketch';
    copy.onclick = () => { if(this.camera) void navigator.clipboard.writeText(JSON.stringify(this.camera,null,2)).then(()=>{this.note.textContent='Camera copied. Paste it into the sketch to change the drawing.';}).catch(error=>{this.note.textContent=String(error);}); };
    toolbar.append(this.scenes,reset,copy);
    const label = document.createElement('p'); label.className = 'construction-hint'; label.textContent = 'Construction preview · paper and exports use the sketch camera';
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
    this.canvas.onwheel = event => { event.preventDefault(); if(this.camera){this.camera=zoomCamera3(this.camera,Math.exp(Math.max(-1,Math.min(1,event.deltaY*.001))));this.schedule();} };
  }
  onRender(reply: RenderReply): void {
    this.reply=reply; this.revision++; this.dirty=false;
    this.toggle.hidden=!reply.construction.length;
    this.scenes.replaceChildren(...reply.construction.map((scene,i)=>{const option=document.createElement('option');option.value=String(i);option.textContent=`Scene ${i+1} · ${scene.triangles} triangles`;return option;}));
    this.camera=reply.construction[0]?.camera;
    if(!this.camera){this.panel.hidden=true;this.toggle.setAttribute('aria-pressed','false');}
    this.note.textContent='Drag to orbit · scroll to zoom · click a face to inspect';
    if(!this.panel.hidden)this.schedule();
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
