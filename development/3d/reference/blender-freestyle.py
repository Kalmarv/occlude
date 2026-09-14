"""Independent behavioral reference via Blender's public Python API; no engine code copied."""
import bpy, json, math, sys
from pathlib import Path
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view
args = sys.argv[sys.argv.index('--') + 1:]
inputs, output = map(Path, args)
assert bpy.app.version == (5, 2, 1), bpy.app.version_string
fixtures = json.loads(inputs.read_text())
result = {'version': bpy.app.version_string, 'buildHash': bpy.app.build_hash.decode(), 'cases': []}
for case in fixtures:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    collection = bpy.data.collections.new('Sources'); scene.collection.children.link(collection)
    for source in case['objects']:
        mesh = bpy.data.meshes.new(source['id'])
        mesh.from_pydata(source['positions'], [], source['polygons']); mesh.update()
        obj = bpy.data.objects.new(source['id'], mesh); collection.objects.link(obj)
        marks = {tuple(sorted(edge)) for edge in source.get('marked', [])}
        if marks:
            attribute = mesh.attributes.new('freestyle_edge', 'BOOLEAN', 'EDGE')
            for edge in mesh.edges: attribute.data[edge.index].value = tuple(sorted(edge.vertices)) in marks
    c = case['camera']
    data = bpy.data.cameras.new('Camera'); camera = bpy.data.objects.new('Camera', data); scene.collection.objects.link(camera)
    camera.location = c['eye']; camera.rotation_euler = (Vector(c['target']) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    data.clip_start = c['near']; data.clip_end = c['far']
    if c['kind'] == 'orthographic': data.type = 'ORTHO'; data.ortho_scale = c['span']
    else: data.type = 'PERSP'; data.sensor_fit = 'VERTICAL'; data.angle = math.radians(c['fovDegrees'])
    scene.camera = camera; scene.render.resolution_x = 512; scene.render.resolution_y = 512; scene.render.resolution_percentage = 100
    scene.render.engine = 'CYCLES'; scene.cycles.samples = 1
    scene.render.use_freestyle = True
    settings = bpy.context.view_layer.freestyle_settings
    settings.mode = 'SCRIPT'; settings.use_culling = False
    settings.use_suggestive_contours = False; settings.use_ridges_and_valleys = False
    settings.use_material_boundaries = False; settings.use_smoothness = False
    settings.crease_angle = math.radians(179)
    style = bpy.data.texts.load(str(Path(__file__).with_name('freestyle-capture.py')))
    settings.modules.new().script = style
    for visibility in case['visibility']:
        bpy.app.driver_namespace['reference_config'] = {'features': case['features'], 'visibility': visibility}
        bpy.app.driver_namespace['reference_strokes'] = []
        bpy.ops.render.render()
        strokes = bpy.app.driver_namespace['reference_strokes']
        assert strokes, (case['id'], visibility, 'Freestyle produced no strokes; inspect style errors')
        segments = [segment for stroke in strokes for segment in stroke['segments']]
        result['cases'].append({'id': case['id'], 'visibility': visibility, 'segments': segments, 'strokes': strokes})
output.write_text(json.dumps(result, indent=2) + '\n')
print('FREESTYLE_REFERENCE_CASES', len(result['cases']))
