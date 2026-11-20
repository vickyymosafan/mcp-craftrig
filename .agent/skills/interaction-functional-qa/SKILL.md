---
name: interaction-functional-qa
description: Test functional UI behaviors in a local browser using explicit scenarios and safe interaction steps.
compatibility: Works with Agent Skills-compatible hosts and the Craftrig MCP server.
---

# Interaction & Functional QA

1. Derive scenarios from requirements and component contracts.
2. Cover initial, loading, empty, populated, error, disabled, success, focus, hover, and active states where applicable.
3. Use `localhost.run_interaction_scenario` with explicit selectors and bounded actions.
4. Prefer role/label/test-id selectors over brittle positional CSS selectors.
5. Do not trigger payment, deletion, external submission, email, logout, or other destructive side effects unless `allowRiskyActions` is explicitly approved and the environment is isolated.
6. Verify navigation destination, expected state changes, keyboard interactions (`Tab`, `Enter`, `Escape`), visible focus rings, and form validation.
7. When `themeToggle` is enabled (`three-way-system` or `two-way-toggle`), verify switching Light ↔ Dark (and System where applicable) updates rendered surfaces cleanly and persists across reload without FOUC or broken micro-component contrast.
8. Verify interactive targets meet minimum sizing ($\ge 24\times 24\text{px}$ desktop, $\ge 44\times 44\text{px}$ touch) and are not occluded by overlays or canvases (`localhost.audit_visual_a11y`).
9. Record screenshots, step outcomes, console errors, and any setup assumptions.
10. A visible control is not functional until its actual behavior is verified.
