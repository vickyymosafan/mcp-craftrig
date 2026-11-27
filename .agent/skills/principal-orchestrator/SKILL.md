---
name: principal-orchestrator
description: Own the end-to-end engineering workflow. Use this when a user request spans multiple workstreams, requires agent delegation, or needs evidence-backed completion.
compatibility: Works with Agent Skills-compatible hosts. Host-native subagent execution is required for true parallel delegation; MCP tools persist task state and evidence.
---

# Principal Orchestrator

## Mission
Own the task graph and final synthesis. Do not implement every workstream yourself when host-native subagents are available.

## Blueprint Autopilot workflow (preferred for full projects)
1. **No blueprint yet?** Call `craftrig_start_blueprint_interview` (default `mode: "deep"`). It scans the repository first to pre-fill detectable stack/routes, then returns 2–4 adaptive questions per round with recommended defaults. Relay `questions[]` to the user via host UI, submit answers via `craftrig_answer_blueprint_questions`, resolve any Blueprint Linter contradictions, and get quick approval on the generated `blueprint.md`.
2. **Blueprint ready?** Call `craftrig_ingest_blueprint` (using `blueprintId` or `markdown`) to compile ALL phases into a token-efficient Multi-Phase DAG. Unneeded skills (e.g. `threejs-shaders`, `backend-implementation`, `motion-animation`) are explicitly skipped to save tokens.
3. **Run the `craftrig_autopilot_next` loop until `state === "done"` or `"needs_human"`**:
   - `state === "verify"`: Run `deterministicChecks` directly with MCP/CLI tools (0 subagent LLM tokens). Only spawn a targeted 1-skill repair subagent if a check fails.
   - `state === "dispatch"` or `"repair"`: Claim `dispatchWave` via `craftrig_claim_ready_batch` and spawn parallel host subagents ONLY for `mode === "subagent"` tasks. Each subagent reads ONLY its compact `packetUri` and its single `primarySkill` file — never load skipped skills.
   - Pass structured `handoff` (`summary`, `changedFiles`, `contracts`, `decisions`, `testsRun`) to `craftrig_complete_task` so downstream phases receive compact contracts instead of raw transcripts.
   - Do NOT stop after landing page or Phase 1 — complete every phase through final quality gate and REQ-ID traceability verification.
4. On crash or restart, call `craftrig_autopilot_resume` to recover expired leases and continue from the exact active wave.
5. After completion, report the automatic `fileSyncAudit` (verified files on disk + warn the user NOT to click Overwrite on stale/unsaved editor tabs — close with Don't Save or run `File: Revert File`) AND include the generated Conventional Commits 1.0.0 git message (`conventionalCommit.fullMessage`) in your final output without running `git push`. Optionally call `craftrig_archive_plan` to Brotli-compress state and run storage maintenance. Never push or deploy without explicit user authorization.

## Legacy single-request workflow
1. Read `AGENTS.md`, `docs/PRINCIPAL_DEVELOPMENT.md`, `docs/ARCHITECTURE.md`, and the relevant project contracts before planning.
2. Inspect the repository and identify its source of truth. Do not assume framework, commands, folder structure, or test strategy.
3. Create an execution plan with `craftrig_create_execution_plan`.
4. Repeatedly call `craftrig_get_ready_tasks`. Claim each task with `craftrig_claim_task` before delegating it.
5. Delegate independent ready tasks to host-native subagents. Each subagent receives only its task packet, relevant Skills, file ownership, acceptance criteria, and required evidence.
6. Allow parallel work only when dependencies and file ownership do not conflict. Use a single integration owner for shared files.
7. Require every subagent to return changed files, decisions, tests, evidence IDs, risks, and unresolved issues.
8. Complete tasks through `craftrig_complete_task`. A task requiring evidence cannot be completed without evidence IDs.
9. For UI work, start or identify the local dev server and run responsive-first localhost inspection before other visual dimensions.
10. When a defect is found, delegate diagnosis and repair, then independently rerun browser tests. Never trust the repair agent's self-attestation.
11. Evaluate the quality gate with `craftrig_evaluate_quality_gate`. Do not claim PASS while required checkpoints remain pending, failed, blocked, or unsupported by evidence.
12. Prepare a human-readable decision packet and ALWAYS report the automatic `fileSyncAudit` (verified files on disk + DO NOT click Overwrite warning for stale editor tabs) AND include a Conventional Commits 1.0.0 git message summarizing the changes (via `craftrig_evaluate_quality_gate` or `craftrig_prepare_commit_message`). Never run `git push`, deploy, mutate production data, or trigger external side effects without explicit authorization.

## Delegation contract
Use host-native subagent spawning when available. The MCP server stores task state and evidence; it does not silently create LLM sessions. If the host cannot spawn subagents, execute ready tasks sequentially and disclose the limitation.

Every delegated task packet must contain:
- plan ID and task ID
- objective and acceptance criteria
- dependency results
- assigned file/path ownership
- relevant Skill IDs
- relevant module IDs
- allowed MCP tools
- required tests and evidence
- prohibited actions

## Parallelism rules
- Delegate only tasks returned by `craftrig_get_ready_tasks`.
- Never give two agents write ownership over the same file at the same time.
- Keep parallel groups bounded by `CRAFTRIG_MAX_PARALLEL_TASKS`.
- Merge work through an integration task; rerun affected tests after integration.
- Cancel stale tasks when the source requirement changes.

## Truthfulness rules
A build, test, browser inspection, or security audit is complete only when it was actually run and its output was recorded. Distinguish PASS, FAIL, BLOCKED, and NOT APPLICABLE. Never fabricate screenshots, test results, commits, or file paths.
