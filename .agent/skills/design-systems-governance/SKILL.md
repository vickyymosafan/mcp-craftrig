---
name: design-systems-governance
description: Extract, define, and enforce a single source of truth for design tokens, reusable components, variants, states, and themes.
compatibility: Works with Agent Skills-compatible hosts and the Craftrig MCP server.
---

# Design Systems Governance

1. Inspect the existing repository and rendered interface before creating tokens.
2. Extract primitive tokens, semantic tokens, and component-level usage as separate layers.
3. Keep one canonical token source. Components consume semantic tokens rather than hardcoded color and spacing values.
4. Document component anatomy, variants, size, states, responsive behavior, accessibility behavior, and allowed composition.
5. Define light/dark modes independently; never assume a simple color inversion is correct.
6. Implement flexible theme switching and surface isolation cleanly:
   - Use CSS `color-scheme` + `light-dark()` for native adaptive tokens, or Tailwind v4 `@theme` + `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));` with an inline anti-FOUC script supporting `light`, `dark`, and `system` (`prefers-color-scheme`) when `themeToggle` is `three-way-system`.
   - Enforce a **Surface Isolation Contract**: any section that intentionally diverges from the page theme (only when `sectionPolarity` allows it) must declare an explicit surface scope (`[data-surface="dark"]` / `color-scheme: dark` or `[data-surface="light"]`) that redefines all semantic foreground, border, and badge/chip tokens. Ban bare global ink classes inside inverted containers.
7. Record theme ownership, token deprecation, migration, and impact.
8. Detect token drift and duplicated components.
9. Promote patterns to shared components only when repetition and semantics justify it.
10. Keep design-system changes reviewable and regression-tested across all enabled themes via `localhost_audit_visual_a11y`.

Reference provenance: Extract DESIGN.md, Expo Design System, Theme Factory, Hue, UI UX Pro Max, Material UI Theming.
