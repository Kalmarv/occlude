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
    mat = bpy.data.materials.new('Ink'); bpy.data.materials.create_gpencil_data(mat); mat.grease_pencil.color = (0, 0, 0, 1)
    for visibility in case['visibility']:
        gp = bpy.data.grease_pencils.new(visibility); obj = bpy.data.objects.new(visibility, gp); scene.collection.objects.link(obj)
        gp.materials.append(mat); gp.layers.new('Lines', set_active=True).frames.new(1)
        mod = obj.modifiers.new('Line Art', 'LINEART')
        mod.source_type = 'COLLECTION'; mod.source_collection = collection; mod.target_layer = 'Lines'; mod.target_material = mat
        mod.use_contour = bool(set(case['features']) & {'boundary', 'silhouette'})
        mod.use_crease = 'crease' in case['features']; mod.crease_threshold = math.radians(179)
        mod.use_edge_mark = 'marked' in case['features']; mod.use_intersection = False; mod.use_material = False
        mod.use_loose = False; mod.use_cache = False; mod.stroke_depth_offset = 0; mod.chaining_image_threshold = 0
        mod.use_image_boundary_trimming = False; mod.use_clip_plane_boundaries = False
        mod.use_multiple_levels = visibility == 'hidden'; mod.level_start = 1 if visibility == 'hidden' else 0; mod.level_end = 128 if visibility == 'hidden' else 0
        scene.frame_set(1); bpy.context.view_layer.update()
        evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
        segments = []
        for layer in evaluated.data.layers:
            for frame in layer.frames:
                for stroke in frame.drawing.strokes:
                    points = [world_to_camera_view(scene, camera, evaluated.matrix_world @ p.position) for p in stroke.points]
                    pairs = list(zip(points, points[1:]))
                    if stroke.cyclic and len(points) > 1: pairs.append((points[-1], points[0]))
                    for a, b in pairs:
                        segment = [[a.x * 100, (1 - a.y) * 100], [b.x * 100, (1 - b.y) * 100]]
                        if math.dist(*segment) > 1e-8: segments.append(segment)
        result['cases'].append({'id': case['id'], 'visibility': visibility, 'segments': segments})
        bpy.data.objects.remove(obj, do_unlink=True)
output.write_text(json.dumps(result, indent=2) + '\n')
print('REFERENCE_CASES', len(result['cases']))
