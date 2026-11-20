---
name: motion-animation
description: Plan, implement, audit, and optimize purposeful animation, interaction physics, gesture behavior, reduced motion, and 60 FPS frame performance.
compatibility: Works with Agent Skills-compatible hosts and the Craftrig MCP server.
---

# Motion & Animation Engineering (Production Standards)

## Core Philosophy: Purposeful Physics & Micro-Polish
Motion must serve product usability, provide tactile feedback, and enhance visual delight. Avoid gratuitous, slow, or distracting animations that delay user interaction.

---

## 1. Modern Motion Tokens & Physics
Use snappy, modern spring-like easing curves instead of generic linear or standard CSS `ease`:
```css
:root {
  /* Premium snappy easing (Apple / Linear standard) */
  --ease-snappy: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-smooth: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);

  --duration-fast: 150ms;
  --duration-normal: 250ms;
  --duration-smooth: 400ms;
}
```

---

## 2. Interactive Micro-Interactions
1. **Button Hover & Press Feedback:**
   ```css
   .interactive-btn {
     transition: transform var(--duration-fast) var(--ease-snappy),
                 box-shadow var(--duration-fast) var(--ease-snappy);
   }
   .interactive-btn:hover {
     transform: translateY(-1px);
   }
   .interactive-btn:active {
     transform: translateY(1px) scale(0.98);
   }
   ```
2. **Pulsating Beacon Status Loops:**
   ```css
   @keyframes beaconPulse {
     0%, 100% { opacity: 1; transform: scale(1); }
     50% { opacity: 0.4; transform: scale(0.8); }
   }
   ```

---

## 3. Fast-Path Compositor Scrolling & Scroll-Driven Animations
1. **Never use `body { overflow-x: hidden }`:**
   Setting `overflow-x: hidden` on `body` or `html` forces Chromium to establish a non-fast-path scrolling root, causing severe scroll stutter. Always use `overflow: clip` or `overflow-x: clip` to eliminate horizontal scrollbars without breaking native compositor thread scrolling.
2. **Off-Thread CSS Scroll-Driven Animations:**
   Never use JavaScript `window.addEventListener('scroll', ...)` or heavy JS animation libraries for scroll reveals. Use native CSS Scroll-Driven Animations:
   ```css
   @keyframes scrollReveal {
     from { opacity: 0; transform: translateY(24px); }
     to { opacity: 1; transform: translateY(0); }
   }
   .reveal-on-scroll {
     animation: scrollReveal linear both;
     animation-timeline: view();
     animation-range: entry 10% cover 30%;
   }
   ```
3. **GPU Fillrate Budget (Glassmorphism):**
   Stacked `backdrop-filter: blur(...)` across multiple scrolling cards or grid items exhausts GPU fillrate and drops frames. Limit `backdrop-filter` to fixed navigation headers or modal overlays; use semi-translucent solid tokens (`rgba(15, 23, 42, 0.85)`) for repeating cards.

---

## 4. Performance & 60-120 FPS Frame Budget
- Stick strictly to GPU-accelerated compositor properties: `transform` and `opacity`.
- Never animate `width`, `height`, `top`, `left`, `margin`, or `padding` in loops, as they trigger expensive layout reflows and frame drops.
- Always pause continuous canvas animation loops (such as Three.js, WebGL, or Canvas2D) when off-screen using `IntersectionObserver`:
  ```javascript
  const observer = new IntersectionObserver(([entry]) => {
    isCanvasVisible = entry.isIntersecting;
    if (isCanvasVisible) requestAnimationFrame(renderLoop);
  });
  observer.observe(canvasElement);
  ```
- In Three.js / WebGL, never allocate new geometries or re-upload dynamic vertex buffers (`geometry.attributes.position.needsUpdate = true`) during active scroll events.

---

## 5. Accessibility & Reduced Motion
Always provide an accessible fallback for users with vestibular or motion sensitivity:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```
