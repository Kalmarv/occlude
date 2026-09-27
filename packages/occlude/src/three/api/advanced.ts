/** Advanced access shares the existing renderer and modeling kernels: the
 * explicit 3D stage (surfaces, line-art scenes, classification and stroke
 * construction) that the `occlude/3d` words are built on. */
export {lineArt3} from '../scene.js';
export {featureSnapshot3,FeatureKind3} from '../features/snapshot.js';
export {classifySceneCpu3,classifySceneGpu3,candidatePairs3} from '../visibility/scene.js';
export {constructStrokes3,FeatureSelection3} from '../strokes/construct.js';
export {surface3,box3} from '../geometry/surface.js';
export type {FaceMeasure3} from '../geometry/model.js';
export {section3} from '../curves/section.js';
export {hatch3} from '../curves/hatch.js';
export {projectedLines} from './projected.js';
export type {Surface3,SurfaceCorner3,Attributes3} from '../geometry/surface.js';
export type {SceneCompute3,LineArtScene3,LineArtOptions3} from '../scene.js';
export type {ClassifiedScene3,ClassifiedFeature3} from '../visibility/scene.js';
export type {SurfaceObject3,WireObject3,Feature3} from '../features/snapshot.js';
export type {Camera3,PaperFrame3} from '../camera.js';
export type {LineSet3,Stroke3,StrokeReference3} from '../strokes/construct.js';
export type {SurfaceQueryInput3,SurfaceQueryResult3,ModelingStats3,ModelingProgress3,ProgressListener3} from '../modeling.js';
export type {RayQuery3,NearestQuery3,SurfaceHit3} from '../queries/surface.js';
export type {SectionPlane3,SurfaceCurves3,SurfaceCurveSegment3,SurfaceCurvePoint3} from '../curves/section.js';
export type {HatchFamily3,HatchSource3} from '../curves/hatch.js';
export type {StageEvent3,StageListener3} from '../resolve.js';
export {SurfaceQueries3,prepareSurfaceQueries3} from '../queries/surface.js';
export {GpuSurfaceQueries3} from '../../compute/webgpu/queries.js';
export {GpuSceneCompute3} from '../../compute/webgpu/scene.js';
export {GpuIntervals3} from '../../compute/webgpu/interval.js';
export {cameraFrame3} from '../camera.js';
export {hiddenInterval3,occlusionVolume3,unionIntervals3,visibleIntervals3} from '../visibility/interval.js';

export type {PhaseTimings3,Phase3} from '../timing.js';

export {SurfaceCurves} from './supported.js';
export {surfaceBinding3,surfaceCurveNetwork3} from '../curves/network.js';
export type {SurfaceBinding3,SurfaceCurveNetwork3,SurfaceCurveNetworkInput3,SurfaceCurveBudget3} from '../curves/network.js';
export { surfaceOf } from '../geometry/value.js';
