import { sketch, append, thicken, fill, polygon, smooth, force, mul } from 'occlude';
import type { Material } from 'occlude';
/** User regression: seed 185591647, paper 304.8 × 304.8 mm, Studio hop pen. */
export default sketch({ aspect: [1, 1], margin: 5, seed: 185591647 }, (t) => {
  const { rect, bounds } = t;
  const b = bounds();
  const size = 50;
  const init = rect(b.cx-size/2,b.cy-size/2,size,size);
  const subdivide = (thisSize:number,nextMaterial:Material,level:number):Material => {
    if(level<0)return nextMaterial;
    const shapes=nextMaterial.along().map(station=>rect(station.x-thisSize/4,station.y-thisSize/4,thisSize/2,thisSize/2));
    return subdivide(thisSize/2,shapes.reduce((m,shape)=>append(m,t.material(shape)),nextMaterial),level-1);
  };
  const widtha=t.rnd(1),widthb=t.rnd(1);
  const yeboi=thicken(subdivide(size,t.material(init),2),{radius:p=>t.map(Math.hypot(p.x-50,p.y-50),0,50,widtha,widthb)});
  const steps=Math.round(t.rnd(10)),rest=t.rnd(10),pushA=t.rnd(-1,1);
  const moved=yeboi.steps(steps,(current,next)=>{
    const push=force.attract(current,{radius:rest,excludeConnected:true,strength:rest/5});
    next.move(current.points, p=>mul(push(p),pushA));
  });
  return [t.group({pen:'hop'},smooth(10,polygon(moved,{fill:fill('contour')})))];
});
