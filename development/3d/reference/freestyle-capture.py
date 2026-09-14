"""Independently authored Freestyle API selection/export instrumentation."""
import bpy, math
from freestyle.types import Operators, StrokeShader, UnaryPredicate1D, Nature
from freestyle.predicates import TrueUP1D, QuantitativeInvisibilityUP1D
from freestyle.shaders import ConstantThicknessShader, ConstantColorShader

config = bpy.app.driver_namespace['reference_config']
flags = {'boundary': Nature.BORDER, 'silhouette': Nature.SILHOUETTE, 'crease': Nature.CREASE, 'marked': Nature.EDGE_MARK}
mask = flags[config['features'][0]]
for feature in config['features'][1:]: mask |= flags[feature]
visible = QuantitativeInvisibilityUP1D(0)

class SelectReference(UnaryPredicate1D):
    def __call__(self, edge):
        return bool(edge.nature & mask) and (visible(edge) if config['visibility'] == 'visible' else not visible(edge))

class CaptureReference(StrokeShader):
    def shade(self, stroke):
        vertices = list(stroke)
        points = [[v.point.x * 100 / 512, (512 - v.point.y) * 100 / 512] for v in vertices]
        segments = [[a, b] for a, b in zip(points, points[1:]) if math.dist(a, b) > 1e-8]
        bpy.app.driver_namespace['reference_strokes'].append({
            'segments': segments,
            'widthsMm': [sum(v.attribute.thickness) * 100 / 512 for v in vertices],
            'colors': [list(v.attribute.color) for v in vertices],
        })

Operators.select(SelectReference())
Operators.create(TrueUP1D(), [ConstantThicknessShader(0.3 * 512 / 100), ConstantColorShader(0.2, 0.4, 0.6, 1), CaptureReference()])
