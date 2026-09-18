import type {Vec3} from '../math.js';
import type {AssetPixels} from '../../imageAsset.js';
import {dot3,unit3,finite3} from '../math.js';
import {clampSetting} from '../degenerate.js';

/** Tone convention for surface drawing: 0 is light (no hatch), 1 is dark
 * (full requested coverage). Built-in recipes are data, so a batched GPU
 * evaluation and the CPU reference below compute the same formula. */
export interface LightRecipe3 {
  readonly kind:'light';
  /** Unit vector pointing TOWARD the light, in the stated space. */
  readonly direction:Vec3;
  /** Illumination of a surface facing away from the light, 0..1. */
  readonly ambient:number;
  /** Response of illumination to the cosine term. */
  readonly ramp:'linear'|'smooth';
  /** World uses the placed geometric normal; model uses the prototype normal. */
  readonly space:'world'|'model';
  /** Lowest tone anywhere: lit faces keep this much hatch. */
  readonly floor:number;
}
export interface ImageRecipe3 {
  readonly kind:'image';
  readonly name:string;
  /** Already footprint-filtered pixels; sampling is bilinear. */
  readonly pixels:AssetPixels;
  readonly channel:'lum'|'dark'|'a';
  /** Where UV (0,0) lies on the image. */
  readonly origin:'bottom-left'|'top-left';
  readonly wrap:'clamp'|'repeat';
  /** Box half-size of the prefilter, in chart units. */
  readonly area:number;
  readonly uvAttribute:string;
}
export type ToneRecipe3=LightRecipe3|ImageRecipe3;
const recipes=new WeakMap<object,ToneRecipe3>();
export function registerToneRecipe3<F extends object>(field:F,recipe:ToneRecipe3):F{recipes.set(field,recipe);return field;}
/** A user callback without a registered recipe is arbitrary JS: CPU only. */
export function toneRecipe3(field:unknown):ToneRecipe3|undefined{return typeof field==='function'||typeof field==='object'&&field?recipes.get(field as object):undefined;}

export type LightDirection3=Vec3|'up'|'down'|'x'|'y'|'z';
export function lightRecipe3(options:{direction:LightDirection3;ambient?:number;ramp?:'linear'|'smooth';space?:'world'|'model';floor?:number}):LightRecipe3 {
  const named:Record<string,Vec3>={up:[0,0,1],down:[0,0,-1],x:[1,0,0],y:[0,1,0],z:[0,0,1]};
  const direction:Vec3|undefined=typeof options.direction==='string'?named[options.direction]:options.direction;
  if(!direction)throw new Error('light direction must be a vector or up/down/x/y/z');
  finite3(direction);
  // A light pointing nowhere lights nothing: every normal reads as turned away
  // and the tone comes out flat.
  const ramp=options.ramp??'linear',space=options.space??'world';
  const floor=clampSetting(options.floor,0,1,0,'light floor'),ambient=clampSetting(options.ambient,0,1,0.15,'light ambient');
  if(ramp!=='linear'&&ramp!=='smooth')throw new Error('light ramp must be linear or smooth');
  if(space!=='world'&&space!=='model')throw new Error('light space must be world or model');
  return Object.freeze({kind:'light',direction:Object.freeze(direction.some(n=>n!==0)?unit3(direction):[0,0,0]) as Vec3,ambient,ramp,space,floor});
}
/** CPU reference. Illumination is ambient plus the ramped cosine; tone is its
 * complement. A face turned away from the light reaches 1 - ambient. */
export function lightTone3(normal:Vec3,recipe:LightRecipe3):number {
  const cosine=Math.max(0,dot3(normal,recipe.direction));
  const response=recipe.ramp==='smooth'?cosine*cosine*(3-2*cosine):cosine;
  const illumination=recipe.ambient+(1-recipe.ambient)*response;
  return recipe.floor+(1-recipe.floor)*Math.min(1,Math.max(0,1-illumination));
}
/** Rec. 709 luminance with integer weights, so a white pixel is exactly 255
 * and `dark` is exactly zero there (the float coefficients sum to 1 - 1e-16). */
const LUM=(d:Uint8ClampedArray,o:number)=>(2126*d[o]+7152*d[o+1]+722*d[o+2])/10000;
/** Box prefilter through a summed-area table, so footprint filtering happens
 * once per recipe and both evaluation paths sample identical pixels. Half-size
 * is in pixels per axis; zero returns the source pixels unchanged. */
export function prefilterPixels3(pixels:AssetPixels,radiusX:number,radiusY:number):AssetPixels {
  const rx=Math.round(radiusX),ry=Math.round(radiusY);
  if(!Number.isSafeInteger(rx)||!Number.isSafeInteger(ry)||rx<0||ry<0)throw new Error('image prefilter radius must be a nonnegative pixel count');
  if(!rx&&!ry)return pixels;
  const {width:w,height:h,data}=pixels,W1=w+1,out=new Uint8ClampedArray(data.length);
  for(let c=0;c<4;c++){
    const sat=new Float64Array(W1*(h+1));
    for(let y=0;y<h;y++){let row=0;for(let x=0;x<w;x++){row+=data[(y*w+x)*4+c];sat[(y+1)*W1+x+1]=sat[y*W1+x+1]+row;}}
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const x0=Math.max(0,x-rx),x1=Math.min(w,x+rx+1),y0=Math.max(0,y-ry),y1=Math.min(h,y+ry+1);
      out[(y*w+x)*4+c]=(sat[y1*W1+x1]-sat[y1*W1+x0]-sat[y0*W1+x1]+sat[y0*W1+x0])/((x1-x0)*(y1-y0));
    }
  }
  return {width:w,height:h,data:out};
}
function wrapCoordinate(value:number,wrap:'clamp'|'repeat'):number {
  if(wrap==='repeat'){const r=value%1;return r<0?r+1:r;}
  return Math.min(1,Math.max(0,value));
}
/** CPU reference for chart image sampling: pixel centers sit at (i+0.5)/w,
 * bilinear between the four nearest centers, edge pixels clamped. */
export function imageValue3(uv:readonly [number,number],recipe:ImageRecipe3):number {
  const px=recipe.pixels,u=wrapCoordinate(uv[0],recipe.wrap),v=wrapCoordinate(uv[1],recipe.wrap);
  const fx=Math.min(px.width-1,Math.max(0,u*px.width-0.5)),row=recipe.origin==='bottom-left'?1-v:v;
  const fy=Math.min(px.height-1,Math.max(0,row*px.height-0.5));
  const x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(px.width-1,x0+1),y1=Math.min(px.height-1,y0+1),tx=fx-x0,ty=fy-y0;
  const read=(x:number,y:number)=>{const o=(y*px.width+x)*4;return recipe.channel==='a'?px.data[o+3]:LUM(px.data,o);};
  const raw=(read(x0,y0)*(1-tx)*(1-ty)+read(x1,y0)*tx*(1-ty)+read(x0,y1)*(1-tx)*ty+read(x1,y1)*tx*ty)/255;
  return recipe.channel==='dark'?1-raw:raw;
}
/** Shared quantization contract for nested acceptance decisions. A value
 * closer than one quantum to its threshold is ambiguous on any backend and is
 * settled by the CPU reference, so f32 evaluation never flips a decision. */
export const TONE_QUANTUM=2**-10;
/** A tone the field could not answer reads as unpainted. */
export function decideTone3(tone:number,threshold:number):'accept'|'reject'|'ambiguous' {
  if(!Number.isFinite(tone))return 'reject';
  const gap=tone-threshold;
  return Math.abs(gap)<TONE_QUANTUM?'ambiguous':gap>=0?'accept':'reject';
}
