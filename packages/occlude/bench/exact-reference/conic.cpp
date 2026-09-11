// Independent, development-only CGAL adapter. CGAL is not linked into occlude.
// Input: one envelope (ax ay bx by ra rb) per line, using round-trip decimals.
#include <CGAL/Cartesian.h>
#include <CGAL/CORE_algebraic_number_traits.h>
#include <CGAL/Arr_conic_traits_2.h>
#include <CGAL/Arrangement_2.h>
#include <iostream>
#include <iomanip>
#include <array>
#include <vector>
using NT = CGAL::CORE_algebraic_number_traits;
using Q = NT::Rational;
using E = NT::Algebraic;
using RK = CGAL::Cartesian<Q>;
using AK = CGAL::Cartesian<E>;
using Traits = CGAL::Arr_conic_traits_2<RK, AK, NT>;
using Arr = CGAL::Arrangement_2<Traits>;
using Point = Traits::Point_2;
int main() {
  CORE::setFpFilterFlag(false);
  Traits traits;
  Arr arr(&traits);
  const auto make_curve=traits.construct_curve_2_object();
  std::vector<std::array<Q,6>> hulls;
  std::vector<Traits::Curve_2> curves;
  double ax0, ay0, bx0, by0, ra0, rb0;
  while (std::cin >> ax0 >> ay0 >> bx0 >> by0 >> ra0 >> rb0) {
    Q ax(ax0),ay(ay0),bx(bx0),by(by0),ra(ra0),rb(rb0);
    hulls.push_back({ax,ay,bx,by,ra,rb});
    for(auto disc : {std::array<Q,3>{ax,ay,ra},std::array<Q,3>{bx,by,rb}}) if(disc[2]>0) {
      const Q cx=disc[0],cy=disc[1],radius=disc[2];
      const RK::Circle_2 circle(RK::Point_2(cx,cy),radius*radius);
      const std::array<Point,4> points={Point(E(cx+radius),E(cy)),Point(E(cx),E(cy+radius)),Point(E(cx-radius),E(cy)),Point(E(cx),E(cy-radius))};
      for(int i=0;i<4;i++)curves.push_back(make_curve(circle,CGAL::COUNTERCLOCKWISE,points[i],points[(i+1)%4]));
    }
    Q dx=bx-ax,dy=by-ay,dr=rb-ra,l2=dx*dx+dy*dy,A=l2-dr*dr;
    if (A<=0) continue;
    // A|x-a|² - (d·(x-a)+ra*dr)² - A ra² = 0:
    // the two tangent supports, with rational polynomial coefficients.
    Q h=ra*dr-dx*ax-dy*ay;
    Q r=A-dx*dx,s=A-dy*dy,t=-2*dx*dy;
    Q u=-2*A*ax-2*dx*h,v=-2*A*ay-2*dy*h;
    Q w=A*(ax*ax+ay*ay-ra*ra)-h*h;
    for (int side : {-1,1}) {
      E nx=(-E(dr*dx)-side*sqrt(E(A))*E(dy))/E(l2);
      E ny=(-E(dr*dy)+side*sqrt(E(A))*E(dx))/E(l2);
      Point p(E(ax)+E(ra)*nx,E(ay)+E(ra)*ny);
      Point q(E(bx)+E(rb)*nx,E(by)+E(rb)*ny);
      if (CGAL::sign(nx*nx+ny*ny-1)!=CGAL::ZERO || CGAL::sign(nx*E(dx)+ny*E(dy)+E(dr))!=CGAL::ZERO) return 2;
      curves.push_back(make_curve(r,s,t,u,v,w,CGAL::COLLINEAR,p,q));
    }
  }

  CGAL::insert(arr,curves.begin(),curves.end());
  if (!arr.is_valid()) return 3;
  size_t boundary=0;
  for(auto edge=arr.edges_begin();edge!=arr.edges_end();++edge) {
    const auto& cv=edge->curve();
    E x=(edge->source()->point().x()+edge->target()->point().x())/2;
    E y=(edge->source()->point().y()+edge->target()->point().y())/2;
    E nx,ny;
    if(cv.orientation()!=CGAL::COLLINEAR){
      E cx=-E(cv.u())/(2*E(cv.r())),cy=-E(cv.v())/(2*E(cv.r()));
      E r2=cx*cx+cy*cy-E(cv.w())/E(cv.r());
      E vx=x-cx,vy=y-cy,f=sqrt(r2/(vx*vx+vy*vy));
      x=cx+vx*f;y=cy+vy*f;nx=x-cx;ny=y-cy;
    }else{
      nx=edge->target()->point().y()-edge->source()->point().y();
      ny=edge->source()->point().x()-edge->target()->point().x();
    }
    bool positive=false,negative=false;
    for(const auto& h:hulls){
      E qx=x-E(h[0]),qy=y-E(h[1]),dx=E(h[2]-h[0]),dy=E(h[3]-h[1]),dr=E(h[5]-h[4]),ra=E(h[4]);
      E A=dx*dx+dy*dy-dr*dr,D=qx*dx+qy*dy+ra*dr,C=qx*qx+qy*qy-ra*ra;
      E value,gx,gy;
      if(A>0&&D>0&&D<A){value=A*C-D*D;gx=A*qx-D*dx;gy=A*qy-D*dy;}
      else if(A-2*D<0){value=A-2*D+C;gx=qx-dx;gy=qy-dy;}
      else{value=C;gx=qx;gy=qy;}
      if(value<0){positive=negative=true;break;}
      if(value==0){E slope=gx*nx+gy*ny;if(slope<0)positive=true;if(slope>0)negative=true;}
    }
    if(positive!=negative)boundary++;
  }
  std::cout << "{\"vertices\":" << arr.number_of_vertices() << ",\"edges\":" << arr.number_of_edges() << ",\"faces\":" << arr.number_of_faces() << ",\"boundary\":" << boundary << "}\n";
}
