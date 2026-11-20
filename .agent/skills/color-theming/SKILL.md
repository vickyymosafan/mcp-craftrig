---
name: color-theming
description: Create and verify semantic color systems, algorithmic palettes, light/dark themes, color contrast, and gamut behavior.
compatibility: Works with Agent Skills-compatible hosts and the Craftrig MCP server.
---

# Color & Theming

1. Extract current brand colors and existing tokens before proposing a palette, and read `DESIGN.md` (`themeMode`, `sectionPolarity`, `lightCanvasTone`).
2. Separate primitive/reference colors, semantic tokens, and component usage.
3. Use semantic roles such as surface, elevated surface, text, muted text, border, primary, success, warning, danger, focus, and badge/pill pairs (`--badge-bg`, `--badge-fg`, `--badge-border`).
4. Prefer OKLCH for perceptually-oriented ramps when supported by the product's browser and build targets; validate gamut and fallback output.
5. Support flexible polarity cleanly via CSS `color-scheme` + `light-dark()` (or Tailwind v4 `@custom-variant dark` + scoped semantic variables):
   - When `sectionPolarity` is `follow-active-theme`, never hardcode always-dark or always-light blocks; every section flips cohesively with the active theme.
   - When `sectionPolarity` is `contrast-bands` / `always-dark-media-showcase` / `always-light-reading`, isolate the inverted section using an explicit surface scope (e.g. `color-scheme: dark` / `[data-surface="dark"]`) that rebinds **all** semantic foreground, border, and micro-component tokens inside it. Never let global light-mode ink leak onto an inverted dark container (or vice-versa).
6. Design light and dark schemes independently and test every foreground/background pair in every user-enabled scheme.
7. Verify WCAG 2.2 contrast with the rendered colors (and check APCA Lc for small/dark-on-dark UI): normal text 4.5:1, large text 3:1, and required non-text UI information/borders 3:1.
8. Never communicate status using color alone.
9. Test gradients, overlays, opacity, badges/pills, placeholders, charts, disabled states, focus rings, selection, and HUDs over images or WebGL/3D canvases.
10. Keep the project palette free of pink by default (follow user choice if explicitly requested). Preferred families: charcoal, black, gray, white, navy, blue, sage, earthy green, brown, cream; lime/orange as justified accents.
11. Do not call a palette accessible until all enabled schemes (`light` and/or `dark`) are measured via `localhost.audit_visual_a11y` (0 `violations`, and every `incomplete` contrast item manually/pixel-verified) and evidence is recorded.
