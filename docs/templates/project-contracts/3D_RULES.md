# 3D and Shader Rules

Use this contract only when a project includes Three.js, WebGL or WebGPU.

- Runtime and renderer version: TBD
- Scene units / scale convention: TBD
- Camera, auto-framing (Box3), and navigation model: TBD
- Geometry craft standard (multi-part decomposition, Bezier/spline curvature, bevels, TubeGeometry/Line2 detail; no flat 2D placeholder cutouts): TBD
- Lighting and PBR material system (RoomEnvironment/PMREM IBL, 3-point rig, MeshPhysicalMaterial sheen/clearcoat, procedural textures with SRGB/NoColorSpace discipline): TBD
- Asset formats, compression and loading budget: TBD
- Shader language / target profile: TBD
- GPU and memory budget by device class: TBD
- Reduced-motion and non-3D fallback: TBD

## Lifecycle
- Dispose geometries, materials, textures, PMREM render targets, and listeners when no longer used.
- Handle context loss and recovery where applicable.
- Keep scene, animation and scroll state deterministic enough for reproducible inspection.

## Verification
- Capture shader compilation and runtime errors.
- Inspect rendered screenshots to confirm 3D silhouette fidelity per item category, smooth curvature, crisp seam/edge linework, and clear tonal separation against both light and dark card surfaces.
- Test scroll/interaction states and viewport changes.
- Record FPS/frame-time and memory evidence on supported device classes.
- Verify fallback when GPU features are unavailable or too expensive.
