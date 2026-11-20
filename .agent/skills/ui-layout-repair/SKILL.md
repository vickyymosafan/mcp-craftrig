---
name: ui-layout-repair
description: Inspect and repair layout defects using screenshots, DOM measurements, design contracts, and minimal maintainable patches.
compatibility: Works with Agent Skills-compatible hosts and the Principal Agentic Engineering Harness MCP server.
---

# UI Layout Repair

1. Start from a reproducible route, viewport, screenshot, and DOM measurement provided by `localhost.inspect_responsive`.
2. When root cause is ambiguous, use the **Hybrid Workflow** with `/chrome-devtools` (`get_css_styles`, `evaluate_script`) to inspect live CSS cascade rules, container queries, flex/grid properties, and computed sizing directly on the target node.
3. Classify the defect: container sizing, grid/flex constraints, overflow, typography, intrinsic media, sticky/fixed positioning, z-index, or content length.
4. Trace the issue to the owning component/token rather than adding arbitrary page-specific overrides.
5. Keep a single writer per file. Coordinate shared component changes through the implementation lead.
6. Apply the smallest coherent patch.
7. Re-run the failing case plus relevant route/viewport regressions with `localhost.inspect_responsive`.
8. Inspect both screenshot and DOM metrics.
9. Update the finding with root cause, changed files, evidence, and residual risk.
