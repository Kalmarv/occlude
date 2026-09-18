import {describe,expect,it} from 'vitest';
import {assetTable,compileSketch,sketch} from '../src/index.js';
import {image} from '../src/imageAsset.js';
import {plane} from '../src/three/api/index.js';
import {toneRecipe3,imageValue3,prefilterPixels3} from '../src/three/surface/tone.js';
import {surfaceLocation3} from '../src/three/geometry/location.js';

// A 2x2 image: top row dark/bright, bottom row mid/alpha-only.
const w=2,h=2,data=new Uint8ClampedArray(w*h*4);
data.set([0,0,0,255],0);data.set([255,255,255,255],4);data.set([128,128,128,255],8);data.set([255,255,255,64],12);
const assets=assetTable([['tone.png',{pixels:{width:w,height:h,data}}]]);
const at=(uv:readonly [number,number])=>({uv});

describe('image chart bridge',()=>{
  it('samples chart coordinates with a bottom-left origin by default and registers a recipe',()=>{
    const img=image(assets,'tone.png'),lum=img.surface(),dark=img.surface({channel:'dark'}),top=img.surface({origin:'top-left'});
    expect(toneRecipe3(lum)?.kind).toBe('image');
    // Pixel centers: (0.25,0.75) is the top-left pixel with v up.
    expect(lum(at([.25,.75]))).toBe(0);expect(lum(at([.75,.75]))).toBeCloseTo(1,12);
    expect(lum(at([.25,.25]))).toBeCloseTo(128/255,9);
    expect(dark(at([.25,.75]))).toBe(1);
    expect(top(at([.25,.25]))).toBe(0);
    expect(img.surface({channel:'a'})(at([.75,.25]))).toBeCloseTo(64/255,9);
    // Between centers the value is bilinear; edges clamp, repeat wraps.
    expect(lum(at([.5,.75]))).toBeCloseTo(.5,9);
    expect(lum(at([-3,.75]))).toBe(0);expect(img.surface({wrap:'repeat'})(at([1.75,.75]))).toBeCloseTo(1,12);
    expect(()=>lum({})).toThrow('chart coordinates');
    expect(()=>img.surface({channel:'edge' as never})).toThrow('channel');
    // An out-of-range half-size reads as the nearest size inside the chart.
    expect(img.surface({area:2})(at([.5,.75]))).toBe(img.surface({area:1})(at([.5,.75])));
    expect(()=>img.surface({area:'big' as never})).toThrow('area');
  });
  it('prefilters once so footprint averaging is part of the recipe',()=>{
    const img=image(assets,'tone.png'),blurred=img.surface({area:.5});
    const recipe=toneRecipe3(blurred)!;if(recipe.kind!=='image')throw new Error('expected an image recipe');expect(recipe.area).toBe(.5);
    // A half-chart box covers every pixel: all samples equal the mean luminance.
    // Prefiltered pixels are stored as 8-bit values, so the mean rounds once.
    const mean=(0+255+128+255)/4/255;
    expect(Math.abs(blurred(at([.25,.75]))-mean)).toBeLessThan(1/255);expect(blurred(at([.75,.25]))).toBe(blurred(at([.25,.75])));
    const same=prefilterPixels3({width:w,height:h,data},0,0);expect(same.data).toBe(data);
    expect(imageValue3([.25,.75],{...recipe,pixels:{width:w,height:h,data}})).toBe(0);
  });
  it('reads the location context produced by ordinary surface sampling',()=>{
    const img=image(assets,'tone.png'),lum=img.surface();
    const sheet=plane(2),location=surfaceLocation3(sheet.surface,0,[1/3,1/3,1/3]);
    expect(location.uv).toBeDefined();
    expect(Number.isFinite(lum(location))).toBe(true);
    // A toolkit image carries the same bridge inside a sketch.
    let value=NaN;
    compileSketch(sketch({},t=>{value=t.image('tone.png').surface({channel:'dark'})(location);return null;}),{paper:{w:100,h:100},assets});
    expect(value).toBeCloseTo(1-lum(location),12);
  });
});
