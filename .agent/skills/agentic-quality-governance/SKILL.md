---
name: agentic-quality-governance
description: Enforce the 70-module capability model, independent verification, anti-gaming controls, and evidence-backed quality gates.
compatibility: Works with Agent Skills-compatible hosts and the Craftrig MCP server.
---

# Agentic Quality Governance

1. Resolve which modules apply using the task domain and assurance profile.
2. Keep capability modules distinct from agent roles, Skills, and MCP tools.
3. Activate always-on, conditional, and gate-triggered controls according to risk.
4. Deduplicate findings while retaining traceability to source evidence.
5. Use independent evidence methods for important acceptance decisions.
6. Test the harness behavior itself: delegation, tool choice, failure recovery, browser inspection, permissions, budgets, and evidence freshness.
7. Detect verifier gaming and repeated structural churn:
   - Never pass `typography-color` or `accessibility` using `inspect_responsive` alone or a single-theme screenshot when `light-and-dark` / `system-auto` is enabled.
   - Require `localhost_audit_visual_a11y` evidence covering all user-selected color schemes (`light` and/or `dark`) and inspect the smallest micro-UI elements (badges, eyebrow labels, captions, muted text, placeholders, and inverted contrast bands) in every section.
8. Report capability gaps honestly; do not silently mark unsupported checks as passed.
