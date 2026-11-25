---
name: frontend-implementation
description: Implement responsive, high-craft frontend features using Clean Architecture, modern Bento layouts, micro-interactions, accessibility rules, and maintainable state boundaries.
compatibility: Works with Agent Skills-compatible hosts and the Craftrig MCP server.
---

# Frontend Implementation (High-Craft Production Standards)

## Core Philosophy: High Aesthetic Polish + Clean Architecture
Clean Architecture and anti-slop rules are the architectural foundation, **NEVER an excuse for dry, lifeless, boring B2B gray boxes**. Production web interfaces must match the sensory polish of leading digital products (Linear, Stripe, Apple Pro, Vercel) while maintaining strict semantic accessibility, zero overflow, and modular maintainability.

---

## 1. Asymmetrical Bento Grid Architecture
Avoid repetitive identical card grids. Structure high-impact interfaces using 12-column asymmetric Bento grids:
```css
.bento-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: 1.25rem;
}

/* Feature hierarchy spans */
.col-featured { grid-column: span 7; }
.col-compact  { grid-column: span 5; }
.col-full     { grid-column: span 12; }

@media (max-width: 900px) {
  .col-featured, .col-compact { grid-column: span 12; }
}
```

---

## 2. Micro-Interactions & Ambient Lighting
Bring static cards to life through subtle, physics-driven interactions:
1. **Cursor-Tracking Glow:** Add dynamic radial gradient highlights that track mouse movement on card hover:
   ```css
   .bento-card:hover {
     border-color: rgba(52, 211, 153, 0.35);
     transform: translateY(-2px);
     box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6);
   }
   ```
2. **Spring-Like Micro-Transforms:** Use snappy cubic-bezier curves for buttons and interactive controls:
   ```css
   transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
   ```
3. **Pulsating Live Beacons:** Use soft keyframe scale/opacity loops on status indicators to communicate active runtime state.

---

## 3. Real-Time Canvas & Data Visualizations
Instead of static filler text or fake stock charts, embed live, lightweight canvas visualizers:
- **Telemetry Oscilloscopes:** Animate smooth sine-wave canvas waveforms (e.g., p99 latency streams) capped at 60 FPS.
- **Interactive Node Maps:** Provide clickable cluster or service mesh cards that update active diagnostics without full page reloads.
- **Tabbed Clean Syntax Terminals:** Offer multi-language code tabs (TypeScript, Go, Rust) with distinct syntax highlighting and copy buttons.

---

## 4. Accessible Dual-Polarity Surfaces & Glassmorphism
Whether implementing crisp/warm Light surfaces, deep Obsidian Dark surfaces, or scoped translucent panels:
- Maintain **WCAG AA ($\ge 4.5:1$ normal, $\ge 3:1$ UI) and target AAA ($\ge 7:1$ body)** in **every** enabled theme mode (`light` and/or `dark`) against the actual alpha-composited background.
- Never place low-contrast muted text or bare theme-global ink tokens on translucent cards, badges, or inverted contrast bands. Pair every badge/pill/HUD with surface-scoped `bg` + `fg` + `border` tokens (or `light-dark()`).
- When placing badges, labels, or CTAs over dynamic photography, gradients, or a Three.js `<canvas>`, add a calibrated scrim/backdrop so text contrast stays $\ge 4.5:1$ regardless of underlying scene motion.
- Always provide high-visibility keyboard focus rings:
  ```css
  :focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 3px;
  }
  ```
- Guarantee minimum touch target dimensions of $44 \times 44\text{px}$ on touch viewports and $\ge 24 \times 24\text{px}$ on desktop controls (WCAG 2.2 SC 2.5.8).

---

## 5. Architectural Boundaries & State Colocation
- Keep business logic in `src/domain/` or `src/application/` use-case ports.
- UI components in `src/interfaces/` or `src/frontend/` must only adapt domain entities, never reinvent validation rules inside `onClick` handlers.
- Co-locate component-scoped state near its DOM consumer. Avoid global state stores for transient UI states (e.g., open dropdowns, tab indices).

---

## Verification Evidence
1. **0px Horizontal Overflow:** Verify via `localhost_inspect_responsive` across all 13 standard viewport profiles (320px–1920px).
2. **Dual-Theme Visual & A11y Audit:** Run `localhost_audit_visual_a11y` across every enabled color scheme (`light` / `dark`) and verify 0 `axe-core` violations, 0 invisible/low-contrast elements, 0 occluded controls, and valid `reducedMotion` rendering.
3. **Zero Console Errors:** Zero unhandled promise rejections or deprecated API warnings in browser inspector logs.
4. **Evidence Artifacts:** Record full-page Light & Dark screenshots, ARIA snapshots, and JSON audit summaries under `.harness/evidence/`.
