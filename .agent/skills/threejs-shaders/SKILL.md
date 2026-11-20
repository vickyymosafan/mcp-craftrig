---
name: threejs-shaders
description: Implement and inspect production-grade Three.js scenes, sculpted multi-part 3D geometry, curved linework, PBR materials, WebGL shaders, GPU performance, and resource lifecycle.
compatibility: Works with Agent Skills-compatible hosts and the Craftrig MCP server.
---

# Three.js & 3D Craft Engineering (Production Standards)

## Core Philosophy: Sculptural Detail & Physical Realism
Clean Architecture and performance budgets are **NEVER an excuse for flat 2D cutouts, jagged polygons, boxy primitives, or placeholder shapes**. A production 3D web experience must show authentic domain anatomy, smooth Bezier/spline curvature, crisp linework and seams, multi-layered PBR materials with studio IBL, calibrated tonal contrast, and 60 FPS stability.

---

## 1. Domain-Accurate Multi-Part Silhouette Decomposition
- **Zero Placeholder Reuse:** Never render a generic fallback shape for unrelated categories (for example, never render a flat T-shirt silhouette on a Footwear/Sneaker card). Inspect the item category/spec and sculpt a **multi-part `THREE.Group`** with at least **5–10 distinct structural sub-parts**:
  - **Footwear / Sneakers:** Curved outsole with tread profile, beveled midsole wedge, contoured toe-cap curve, sculpted vamp & quarter panels, padded collar & heel counter, tongue, metallic eyelets, and `TubeGeometry` crossed laces.
  - **Garments / Outerwear / Shirts:** Lofted 3D torso volume with chest/waist/hem taper (never a flat extruded cardboard polygon), curved set-in or raglan sleeves, layered collar/lapel fold, front placket with 3D buttons/snaps, beveled pocket flaps, and stitched seam curves.
  - **Hardware / Product / Architecture:** Chamfered housings, recessed grilles/vents, knurled dials (`LatheGeometry`), transmissive lenses (`MeshPhysicalMaterial`), and precision fasteners.
- **Auto-Frame Every Model:** Compute `new THREE.Box3().setFromObject(modelGroup)` and center/scale the model to occupy **68–78%** of the viewport cleanly with zero edge clipping.

---

## 2. Curves, Bevels, Organic Volume & Crisp Linework
Reject straight-line low-poly corners (`lineTo` silhouettes and sharp default boxes):
1. **Smooth 2D-to-3D Profiles (`Shape` + `ExtrudeGeometry`):**
   Use `bezierCurveTo()`, `quadraticCurveTo()`, and `splineThru()` with `curveSegments: 32–48` and chamfered bevels:
   ```javascript
   const shape = new THREE.Shape();
   shape.moveTo(0, 0);
   shape.bezierCurveTo(0.4, 0.05, 0.75, 0.25, 0.85, 0.65);

   const geom = new THREE.ExtrudeGeometry(shape, {
     depth: 0.12,
     steps: 2,
     curveSegments: 36,
     bevelEnabled: true,
     bevelSegments: 5,
     bevelSize: 0.025,
     bevelThickness: 0.025
   });
   ```
2. **Lathed Rotational Precision (`LatheGeometry`):**
   Build collars, cuffs, lenses, vessels, and heels by revolving smooth spline `Vector2` profiles with `32–64` radial segments.
3. **3D Piping, Seams, Laces & Cables (`CatmullRomCurve3` + `TubeGeometry`):**
   ```javascript
   const seamCurve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.5);
   const seamGeom = new THREE.TubeGeometry(seamCurve, 48, 0.008, 10, false);
   ```
4. **Organic Drape & Fold Sculpting (`BufferGeometry` + `computeVertexNormals`):**
   For cloth, leather, or organic forms, subdivide lofted surfaces and apply subtle deterministic fold/drape displacement along gravity and seam lines, then call `geometry.computeVertexNormals()` for smooth specular roll-off.
5. **Crisp Architectural & Tailoring Linework (`Line2` / `LineMaterial`):**
   Standard `THREE.Line` is locked to 1px on most GPUs. For dashed top-stitching, precision contours, or subtle technical callouts, use `Line2` + `LineGeometry` + `LineMaterial` (`three/addons/lines/`):
   ```javascript
   import { Line2 } from 'three/addons/lines/Line2.js';
   import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
   import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

   const lineMat = new LineMaterial({
     color: 0xc5a87a,
     linewidth: 1.75,
     dashed: true,
     dashSize: 0.04,
     gapSize: 0.025,
     alphaToCoverage: true
   });
   lineMat.resolution.set(container.clientWidth, container.clientHeight); // Must update on resize
   ```
   Use `new THREE.EdgesGeometry(geometry, 28)` only for intentional crisp crease edges, never as a flat wireframe crutch.

---

## 3. Studio IBL Environment & PBR Material Depth
Directional lights alone flatten dark materials and erase subtle form. Always pair physical lighting with **Image-Based Lighting (IBL)**:

1. **Renderer & Studio IBL (`RoomEnvironment` + `PMREMGenerator`):**
   ```javascript
   import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

   const renderer = new THREE.WebGLRenderer({
     canvas: canvasElement,
     antialias: true,
     alpha: true,
     powerPreference: 'high-performance'
   });
   renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
   renderer.setSize(container.clientWidth, container.clientHeight);
   renderer.toneMapping = THREE.ACESFilmicToneMapping;
   renderer.toneMappingExposure = 1.05;
   renderer.outputColorSpace = THREE.SRGBColorSpace;
   renderer.shadowMap.enabled = true;
   renderer.shadowMap.type = THREE.PCFSoftShadowMap;

   const pmremGenerator = new THREE.PMREMGenerator(renderer);
   const envScene = new RoomEnvironment();
   const envRT = pmremGenerator.fromScene(envScene, 0.04);
   scene.environment = envRT.texture;
   envScene.dispose();
   pmremGenerator.dispose(); // Dispose generator immediately after baking
   ```
2. **3-Point Key / Fill / Rim Rig + Grounding:**
   - **Key Light:** Warm or neutral directional light (`castShadow = true`, `shadow.mapSize.set(1024, 1024)`, `shadow.bias = -0.0005`, `shadow.normalBias = 0.0005`).
   - **Fill Light:** Soft cool/neutral `HemisphereLight` or opposite directional fill so shadows retain readable detail.
   - **Rim Light:** Back-angled edge light to carve dark silhouettes (such as obsidian wool or black leather) cleanly away from the background!
   - **Grounding:** Use a `ShadowMaterial` plane (`opacity: 0.25–0.45`) beneath the object so it sits anchored in space without hiding light-mode card backgrounds.
3. **Material Calibration with `MeshPhysicalMaterial`:**
   - **Wool / Twill / Poplin Fabric:** `sheen: 0.85`, `sheenRoughness: 0.65`, `sheenColor` (subtle warm or platinum rim highlight), `roughness: 0.85`, `metalness: 0.0`.
   - **Full-Grain Leather / Matte Rubber:** `roughness: 0.42`, `clearcoat: 0.2`, `clearcoatRoughness: 0.38`, `specularIntensity: 0.65`.
   - **Brushed Brass / Anodized Hardware:** `metalness: 0.95`, `roughness: 0.24`, `anisotropy: 0.7`, `envMapIntensity: 1.2`.
   - **Optical Glass / Transmissive Detail:** `transmission: 0.9`, `ior: 1.5`, `thickness: 0.25`, `roughness: 0.08`.
4. **Value & Color Separation:**
   Never paint all sub-parts a single flat hex color. Separate **body**, **lining/trim**, **top-stitching**, **sole/base**, and **hardware** with distinct tonal value (`ΔL >= 12%`) or distinct roughness/sheen contrast—especially on dark/black items (e.g. `#15181C` body vs `#272C33` lapel/pocket trim vs `#B89B6E` stitch/hardware) and light/ivory items (e.g. `#F4F1EA` poplin vs `#E3DDD0` inner collar shadow vs `#8C7756` stitch).

---

## 4. Procedural Micro-Textures (`CanvasTexture` + Color Space Discipline)
Eliminate flat plastic shading by synthesizing lightweight tileable procedural maps (`256×256` or `512×512`) on an offscreen canvas:
- **Fabric Weave / Leather Pebble / Brushed Grain:** Paint fine directional cross-hatch or noise onto a `<canvas>` and wrap with `THREE.CanvasTexture`:
  ```javascript
  const tex = new THREE.CanvasTexture(offscreenCanvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 6);
  tex.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
  // IMPORTANT:
  // Diffuse `map` & `sheenColorMap` -> tex.colorSpace = THREE.SRGBColorSpace;
  // Data maps (`bumpMap`, `normalMap`, `roughnessMap`, `metalnessMap`) -> tex.colorSpace = THREE.NoColorSpace;
  ```

---

## 5. Fluid Inertia Damping & Gesture Protection
- **Smooth Damping:** Never bind rotation directly to raw mouse deltas. Use linear interpolation (lerp) or damped `OrbitControls`:
  ```javascript
  currentRotY += (targetRotY - currentRotY) * 0.08;
  currentRotX += (targetRotX - currentRotX) * 0.08;
  ```
- **Mobile Gesture Protection:** Always set `touch-action: pan-y;` on the canvas element so dragging the 3D model horizontally does NOT block vertical page scrolling.
- **Non-blocking UI Overlays & HUD Contrast:** UI HUD overlays over the 3D canvas must have `pointer-events: none;`, with interactive buttons explicitly set to `pointer-events: auto;`. Every badge, label, or button sitting over a WebGL `<canvas>` must carry an explicit surface-scoped scrim/backdrop (`bg` + `fg` + `border`) with $\ge 4.5:1$ contrast in all enabled color schemes (`light` and/or `dark`), verified via `localhost.audit_visual_a11y`.

---

## 6. Resource Lifecycle & GPU Governance
Never leak WebGL resources or waste mobile battery:
1. **Auto-Throttle on Tab Background:** Halt animation when `document.hidden` is true.
2. **Scroll-Driven Pause:** Use `IntersectionObserver` to halt `requestAnimationFrame` when the canvas scrolls out of viewport.
3. **Exhaustive Memory Cleanup:** On route unmount or `beforeunload`, dispose every geometry, material, texture (`map`, `bumpMap`, `normalMap`, `roughnessMap`, `sheenColorMap`), `envRT` render target, and `renderer`:
   ```javascript
   envRT?.dispose();
   renderer.dispose();
   scene.traverse(object => {
     if (object.geometry) object.geometry.dispose();
     if (object.material) {
       const mats = Array.isArray(object.material) ? object.material : [object.material];
       for (const mat of mats) {
         for (const key of ['map', 'normalMap', 'bumpMap', 'roughnessMap', 'metalnessMap', 'sheenColorMap', 'clearcoatMap']) {
           if (mat[key]) mat[key].dispose();
         }
         mat.dispose();
       }
     }
   });
   ```

---

## Verification Evidence
- **Visual Silhouette & Category Fidelity Check:** Inspect captured Playwright screenshots (`light` & `dark` via `localhost.inspect_responsive` / `localhost.audit_visual_a11y`) to verify every 3D card/scene matches its real domain object (e.g. sneakers show multi-part sole/vamp/laces, garments show sculpted volume/collar/seams/folds—never flat 2D cutouts), shows crisp line/bevel detail, and separates cleanly from the card background.
- **Frame & GPU Budget:** Verify steady 60 FPS behavior, bounded draw calls ($\le 50$ per viewport scene, merging static sub-parts via `mergeGeometries` from `three/addons/utils/BufferGeometryUtils.js` when needed), and zero WebGL context loss or memory leaks.
- **Zero Overflow & HUD Contrast:** Confirm `0px` horizontal overflow and $\ge 4.5:1$ HUD/badge contrast across all enabled color schemes.
