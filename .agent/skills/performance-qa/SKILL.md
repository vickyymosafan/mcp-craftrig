---
name: performance-qa
description: Measure browser runtime, loading, rendering, network, memory and 3D/GPU performance with repeatable evidence.
compatibility: Works with Agent Skills-compatible hosts and the Principal Agentic Engineering Harness MCP server.
---

# Performance QA

1. Define target devices, network conditions, route scope, and user-critical journeys.
2. Separate build-time, network, main-thread, rendering, image/font, and GPU bottlenecks.
3. Capture baseline before optimizing.
4. Inspect console, failed requests, resource loading, long tasks, layout shifts, and frame behavior.
5. Audit Fast-Path Compositor Scrolling:
   - Ensure `body` and `html` do NOT have `overflow-x: hidden`. Enforce `overflow-x: clip`.
   - Ensure repeating grid/card elements do NOT stack heavy `backdrop-filter: blur(...)` to prevent GPU fillrate exhaustion.
   - Verify scroll-reveal animations utilize native CSS Scroll-Driven Animations (`animation-timeline: view()`) rather than main-thread JS listeners.
6. Prefer profiling evidence over blanket rules. Do not assume transform/opacity guarantees performance or that `will-change` is free.
7. For 3D / WebGL:
   - Inspect draw calls, geometry, textures, shader complexity, render targets, frame time, and disposal.
   - Verify the `requestAnimationFrame` render loop pauses via `IntersectionObserver` when the canvas is scrolled out of the viewport.
   - Ensure vertex buffers (`needsUpdate = true`) are not being dynamically re-uploaded during scroll events.
8. Re-run identical conditions after the patch and compare before/after results.
9. Record browser version, device profile, throttling, commit, measurement method, and residual variance.
