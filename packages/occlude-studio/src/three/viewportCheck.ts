import { cameraFrame3, toCamera3, type Camera3 } from 'occlude/src/three/camera.js';
import type { Triangle3, Vec3 } from 'occlude/src/three/math.js';
import { GpuViewport3 } from 'occlude/src/compute/webgpu/viewport.js';
import { GpuWorldViewport3 } from 'occlude/src/compute/webgpu/worldViewport.js';

/** Independent CPU camera/clipping path versus retained GPU projection.
 * Compare surface interiors and wire neighborhoods, allowing raster edge ties. */
export async function verifyWorldViewport3(device:GPUDevice,format:GPUTextureFormat){
  const width=256,height=192,results=[];
  const source:Triangle3[]=[[[-1,-1,-3],[1,-1,-3],[0,1,-3]],[[-1.4,-.7,-.5],[-.7,-.7,-4],[-1,1,-4]]];
  const wires:readonly(readonly[Vec3,Vec3])[]=[[[-2,0,-2],[2,0,-2]],[[-1,.4,-.25],[1,.4,-5]],[[-1,-.5,-3],[1,-.5,-10]]];
  for(const [name,perspective,scale,offset] of [['orthographic',false,1,[0,0,0]],['perspective',true,1,[0,0,0]],['translated',true,1,[1e9,-2e9,3e9]],['tiny',true,1e-9,[0,0,0]]] as const){
    const world=(p:Vec3):Vec3=>p.map((v,k)=>v*scale+offset[k]) as unknown as Vec3;
    const base={eye:world([0,0,0]),target:world([0,0,-1]),up:[0,1,0] as Vec3,near:scale,far:8*scale};
    const camera:Camera3=perspective?{...base,kind:'perspective',fovDegrees:60}:{...base,kind:'orthographic',span:4*scale};
    const frame=cameraFrame3(camera,{x:0,y:0,width,height}),triangles=source.map(t=>t.map(world) as unknown as Triangle3),edges=wires.map(w=>w.map(world) as unknown as readonly[Vec3,Vec3]);
    const aCanvas=new OffscreenCanvas(width,height),bCanvas=new OffscreenCanvas(width,height);
    const reference=new GpuViewport3(device,aCanvas,format),retained=new GpuWorldViewport3(device,bCanvas,format);
    try{
      await retained.ready;
      reference.draw(frame,triangles.map(t=>t.map(p=>toCamera3(frame,p)) as unknown as Triangle3),edges.map(w=>w.map(p=>toCamera3(frame,p)) as unknown as readonly[Vec3,Vec3]));
      retained.draw(frame,triangles,edges);await device.queue.onSubmittedWorkDone();
      const pixels=(canvas:OffscreenCanvas)=>{const bitmap=canvas.transferToImageBitmap(),copy=new OffscreenCanvas(width,height),ctx=copy.getContext('2d')!;ctx.drawImage(bitmap,0,0);bitmap.close();return ctx.getImageData(0,0,width,height).data;};
      const a=pixels(aCanvas),b=pixels(bCanvas),kind=(data:Uint8ClampedArray,index:number)=>data[index*4]>230?0:data[index*4]<100?2:1;
      let interior=0,mismatch=0,wirePixels=0,wireMisses=0;
      for(let y=1;y<height-1;y++)for(let x=1;x<width-1;x++){
        const index=y*width+x,k=kind(a,index);let same=true,nearWire=false;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const i=index+dy*width+dx;same&&=kind(a,i)===k;nearWire||=kind(b,i)===2;}
        if(same){interior++;if(kind(b,index)!==k)mismatch++;}
        if(k===2){wirePixels++;if(!nearWire)wireMisses++;}
      }
      if(interior<1000||mismatch/interior>.001||wirePixels<50||wireMisses/wirePixels>.01)throw new Error(`${name} retained viewport mismatch: ${mismatch}/${interior} interiors, ${wireMisses}/${wirePixels} wire pixels`);
      results.push({name,interiorPixels:interior,mismatches:mismatch,wirePixels,wireMisses});
    }finally{reference.dispose();retained.dispose();}
  }
  return results;
}
