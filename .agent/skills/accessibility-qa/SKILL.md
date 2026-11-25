---
name: accessibility-qa
description: Audit web accessibility including keyboard, semantic structure, focus, contrast, zoom, reduced motion, and assistive technology semantics.
compatibility: Works with Agent Skills-compatible hosts and the Craftrig MCP server.
---

# Accessibility QA

1. Run `localhost_audit_visual_a11y` across every route and every user-enabled theme (`light` and/or `dark` per `DESIGN.md`) to execute automated `@axe-core/playwright` (`wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa`), alpha-composited contrast checks, target size checks, occlusion hit-testing, and `ariaSnapshot` capture.
2. Inspect semantic landmarks, heading order, form labels, names, roles, and accessible states using both the captured `ariaSnapshot` and live DOM.
3. Navigate with keyboard only. Verify visible focus ($\ge 3:1$ indicator contrast), logical order, escape behavior, and no keyboard traps.
4. Verify WCAG 2.2 contrast using rendered foreground/background pairs across **both** light and dark modes (including micro-components: badges, pills, captions, placeholders, and inverted contrast bands). Explicitly inspect every `axe-core` `incomplete` item (e.g. text over gradients, images, or WebGL canvases).
5. Do not convey status by color alone.
6. Test zoom to 200%, narrow viewport reflow, and interactive target size (WCAG 2.2 SC 2.5.8: $\ge 24\times 24\text{px}$ desktop, $\ge 44\times 44\text{px}$ touch).
7. Test `prefers-reduced-motion` (`testReducedMotion: true`) and ensure essential content never stays stuck at `opacity: 0` or `visibility: hidden`.
8. Inspect accessible names for icon-only controls and meaningful alternatives for images.
9. Use automated checks as a mandatory baseline gate, never as proof of full conformance alone; supplement with manual keyboard & visual inspection.
10. Record tool/version, tested color schemes, route, viewport, findings, evidence IDs, and manual checks.
