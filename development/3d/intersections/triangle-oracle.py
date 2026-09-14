"""Independent Fraction oracle: collect contained vertices and edge crossings,
then take their convex hull. The runtime kernel instead clips polygons and
intersects plane-cut intervals. No Occlude imports or production predicates.
"""
from fractions import Fraction as F
from math import gcd, lcm
import json, random, sys

def sub(a,b): return tuple(x-y for x,y in zip(a,b))
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def cross(a,b): return (a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
def normal(t): return cross(sub(t[1],t[0]),sub(t[2],t[0]))
def turn(a,b,c,k):
    x,y=[i for i in range(3) if i!=k]
    return (b[x]-a[x])*(c[y]-a[y])-(b[y]-a[y])*(c[x]-a[x])
def inside(p,t):
    n=normal(t)
    if dot(n,sub(p,t[0])): return False
    k=max(range(3),key=lambda i:abs(n[i]));orientation=turn(*t,k)
    return all(turn(t[i],t[(i+1)%3],p,k)*orientation>=0 for i in range(3))
def encoded(values):
    d=lcm(*(v.denominator for v in values));nums=[v.numerator*(d//v.denominator) for v in values]
    g=gcd(*nums);return [str(v//g) for v in nums]
def encpoint(p): return encoded([*p,F(1)])
def encplane(t):
    n=normal(t);v=[*n,-dot(n,t[0])]
    if next(x for x in v if x)!=abs(next(x for x in v if x)):v=[-x for x in v]
    return encoded(v)
def hull(points,k):
    axes=[i for i in range(3) if i!=k];points=sorted(points,key=lambda p:tuple(p[i] for i in axes))
    def half(rows):
        out=[]
        for p in rows:
            while len(out)>=2 and turn(out[-2],out[-1],p,k)<=0:out.pop()
            out.append(p)
        return out
    result=half(points)[:-1]+half(list(reversed(points)))[:-1]
    if not result:return points[:1]
    first=min(range(len(result)),key=lambda i:result[i]);return result[first:]+result[:first]
def contact(a,b):
    a,b=[tuple(tuple(F(x) for x in p) for p in t) for t in [a,b]]
    na,nb=normal(a),normal(b)
    if not any(na) or not any(nb):raise ValueError('degenerate')
    coplanar=not any(cross(na,nb)) and dot(na,sub(b[0],a[0]))==0
    points={p for p in a if inside(p,b)}|{p for p in b if inside(p,a)}
    for source,target in [(a,b),(b,a)]:
        n=normal(target)
        for i in range(3):
            p,q=source[i],source[(i+1)%3];direction=sub(q,p);den=dot(n,direction)
            if not den:continue
            t=dot(n,sub(target[0],p))/den
            if 0<=t<=1:
                hit=tuple(x+t*d for x,d in zip(p,direction))
                if inside(hit,target):points.add(hit)
    if coplanar:
        k=max(range(3),key=lambda i:abs(na[i]));x,y=[i for i in range(3) if i!=k]
        for i in range(3):
            p,q=a[i],a[(i+1)%3];d=sub(q,p)
            for j in range(3):
                r,s=b[j],b[(j+1)%3];e=sub(s,r);delta=sub(r,p);den=d[x]*e[y]-d[y]*e[x]
                if not den:continue
                t=(delta[x]*e[y]-delta[y]*e[x])/den;u=(delta[x]*d[y]-delta[y]*d[x])/den
                if 0<=t<=1 and 0<=u<=1:points.add(tuple(v+t*w for v,w in zip(p,d)))
    if not points:return None
    if len(points)==1:return {'kind':'point','coplanar':coplanar,'points':[encpoint(next(iter(points)))]}
    ordered=hull(points,max(range(3),key=lambda i:abs(na[i]))) if coplanar else [min(points),max(points)]
    if len(ordered)<=2:return {'kind':'segment','coplanar':coplanar,'points':[encpoint(p) for p in sorted(ordered)]}
    return {'kind':'area','coplanar':True,'points':[encpoint(p) for p in ordered],'plane':encplane(a)}

def fixtures():
    rng=random.Random(731);rows=[]
    for mode in range(3):
        count=0
        while count<100:
            a=[[rng.randrange(-4,5) for _ in range(3)] for _ in range(3)]
            b=[[rng.randrange(-4,5) for _ in range(3)] for _ in range(3)]
            if mode==1:
                axis=count%3
                for p in a+b:p[axis]=0
            if mode==2:
                for p in a:p[2]=0
                for p in b:p[0]=1
            scale=[1,2.0**-300,2.0**300][count%3]
            a,b=[[[x*scale for x in p] for p in t] for t in [a,b]]
            try:expected=contact(a,b)
            except ValueError:continue
            rows.append({'id':f'{mode}-{count}','a':a,'b':b,'expected':expected});count+=1
    return rows
if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--fixtures':print(json.dumps(fixtures(),separators=(',',':')))
    else:
        data=json.load(sys.stdin);print(json.dumps(contact(data['a'],data['b'])))
