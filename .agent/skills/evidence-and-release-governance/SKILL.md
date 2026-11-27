---
name: evidence-and-release-governance
description: Maintain auditable evidence, quality checkpoint status, release readiness, handoff, and human approval boundaries.
compatibility: Works with Agent Skills-compatible hosts and the Craftrig MCP server.
---

# Evidence & Release Governance

1. Every claim of completion must point to a real artifact or reproducible command result.
2. Store evidence with plan/task IDs, timestamp, commit/build identifier, route, viewport, browser, tool version, and actor.
3. PASS requires evidence. BLOCKED explains the missing prerequisite. NOT_APPLICABLE requires a rationale.
4. Invalidate evidence when source, dependencies, environment, browser profile, or relevant configuration changes.
5. Do not let the implementation agent be the sole verifier of its own changes.
6. Evaluate every required quality checkpoint before release.
7. Prepare a decision packet with changed files, test results, screenshots, known issues, risk, rollback plan, required approvals, and a Conventional Commits 1.0.0 commit message summarizing the changes (`craftrig_prepare_commit_message` / gate output).
8. Do not run `git push`, deploy, or perform external side effects without explicit user authorization.
